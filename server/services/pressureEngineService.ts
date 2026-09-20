import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { triggerNPCReactions } from './npcReactionService.js';
import {
  callSocialCrisisAI,
  normalizeOrgPages,
  type OrgConfig,
  type PagePosture,
} from './socialCrisisGeneratorService.js';
import {
  getScenarioSnapshot,
  getSessionScenarioId,
  type ScenarioSnapshot,
} from '../lib/scenarioCache.js';
import { emitSessionEvent } from './decisions/sessionEventEmitter.js';

async function getScenarioForSession(sessionId: string): Promise<ScenarioSnapshot | null> {
  const scenarioId = await getSessionScenarioId(sessionId);
  return scenarioId ? getScenarioSnapshot(scenarioId) : null;
}

/**
 * Pressure engine (docs/pressure-organisations-plan.md §6.3 / §12).
 *
 * Runs the AI pages that are NOT competitors: unions, regulators, NGOs, community groups,
 * political actors (register statutory / advocacy / grassroots / political) and AI-operated
 * protagonist offices (register `aligned`). Each tick, per page: read progress (was the
 * spokesperson engaged? did HQ publish? was a stand-down signal met? did a detected decision
 * touch its targets?), pick a move by register, post AS the page. Trainer-seized pages are
 * skipped. `chooseMove` is pure and unit-tested.
 */

export type PressureMove =
  | 'statement'
  | 'demand_with_deadline'
  | 'escalate_rung'
  | 'acknowledge_progress'
  | 'correct_record'
  | 'stand_down'
  | 'aligned_holding_statement'
  | 'aligned_follow_hq'
  | 'aligned_clarify'
  | 'skip';

export interface PageProgress {
  /** Minutes since this page last posted (Infinity = never). */
  minutesSinceLastPost: number;
  /** Escalation rung already reached (0 = nothing posted yet). */
  rung: number;
  /** Highest rung available (posture.escalation_ladder.length). */
  maxRung: number;
  /** A player engaged the spokesperson (email / chat / call) at least once. */
  spokespersonContacted: boolean;
  /** Latest reconsideration verdict on the spokesperson's planned action, if any. */
  latestVerdict: 'cancel' | 'modify' | 'delay' | 'keep' | null;
  /** HQ (a protagonist page this page targets / follows) has published since the crisis began. */
  hqPublished: boolean;
  /** A protagonist statement contradicts a confirmed fact (something to correct). */
  contradictionSeen: boolean;
  /** This page already stood down once (never twice). */
  stoodDown: boolean;
  /** Recent detected executive decision touching this page's targets. */
  decisionTouched: boolean;
  escalationRisk: number;
}

/** Cadence by register: minutes between posts when ignored / when engaged. */
const CADENCE: Record<PagePosture['register'], { ignored: number; engaged: number }> = {
  statutory: { ignored: 12, engaged: 18 },
  advocacy: { ignored: 8, engaged: 14 },
  grassroots: { ignored: 9, engaged: 15 },
  political: { ignored: 10, engaged: 16 },
  aligned: { ignored: 10, engaged: 20 },
};

/** Pure: the next move for a page given its register and progress. */
export function chooseMove(register: PagePosture['register'], p: PageProgress): PressureMove {
  const cadence = CADENCE[register];
  const gap = p.spokespersonContacted ? cadence.engaged : cadence.ignored;
  const hot = p.escalationRisk >= 60 ? 0.75 : 1;
  if (p.minutesSinceLastPost < gap * hot) return 'skip';

  if (register === 'aligned') {
    if (p.contradictionSeen) return 'aligned_clarify';
    if (p.hqPublished) return p.rung === 0 || p.rung === 1 ? 'aligned_follow_hq' : 'skip';
    // HQ silent past the leak clock: the office speaks first — the training beat.
    return p.rung === 0 ? 'aligned_holding_statement' : 'skip';
  }

  // Stand-down: engaged, and the judge withdrew or softened the planned action.
  if (
    !p.stoodDown &&
    p.spokespersonContacted &&
    (p.latestVerdict === 'cancel' || p.latestVerdict === 'modify')
  ) {
    return 'stand_down';
  }
  if (p.stoodDown) return 'skip';
  if (register === 'statutory' && p.contradictionSeen && p.rung > 0) return 'correct_record';
  if (p.rung === 0) return 'statement';
  if (p.spokespersonContacted && p.latestVerdict === 'delay') return 'acknowledge_progress';
  if (p.decisionTouched && p.rung < p.maxRung) return 'escalate_rung';
  if (p.rung === 1) return 'demand_with_deadline';
  if (p.rung < p.maxRung) return 'escalate_rung';
  return 'skip';
}

interface PageRow {
  org_key: string;
  platform: string;
  page_name: string;
  page_handle: string;
  role: string;
  control_mode: string;
  spokesperson_stakeholder_id?: string | null;
  register?: string | null;
  operation?: string | null;
}

let pageColumnsSupported: boolean | null = null;

async function loadEnginePages(sessionId: string): Promise<PageRow[]> {
  if (pageColumnsSupported !== false) {
    const { data, error } = await supabaseAdmin
      .from('sim_org_pages')
      .select(
        'org_key, platform, page_name, page_handle, role, control_mode, spokesperson_stakeholder_id, register, operation',
      )
      .eq('session_id', sessionId)
      .eq('control_mode', 'ai')
      .in('role', ['pressure', 'protagonist']);
    if (!error) {
      pageColumnsSupported = true;
      return (data || []) as PageRow[];
    }
    if (/column .* does not exist|could not find/i.test(error.message || '')) {
      logger.error(
        'sim_org_pages lacks migration 205 columns — pressure engine limited to scenario config',
      );
      pageColumnsSupported = false;
    } else {
      logger.warn({ error }, 'pressure engine: page load failed');
      return [];
    }
  }
  const { data } = await supabaseAdmin
    .from('sim_org_pages')
    .select('org_key, platform, page_name, page_handle, role, control_mode')
    .eq('session_id', sessionId)
    .eq('control_mode', 'ai')
    .eq('role', 'protagonist');
  return (data || []) as PageRow[];
}

export async function runPressureEngine(sessionId: string, elapsedMinutes: number): Promise<void> {
  if (!env.openAiApiKey) return;
  if (elapsedMinutes < 8) return;

  const pageRows = await loadEnginePages(sessionId);
  if (pageRows.length === 0) return;

  const { data: sessionRow } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state')
    .eq('id', sessionId)
    .single();
  if (!sessionRow?.scenario_id) return;
  const scenario = await getScenarioForSession(sessionId);
  const initialState = (scenario?.initial_state as Record<string, unknown>) || {};
  const configs = normalizeOrgPages(initialState.org_page as Record<string, unknown> | undefined);
  const configByKey = new Map(configs.map((c) => [c.org_key, c]));
  const socialState =
    ((sessionRow.current_state as Record<string, unknown>)?.social_state as Record<
      string,
      unknown
    >) || {};
  const escalationRisk = Number(socialState.escalation_risk ?? 25);

  // Group by org; only pages with a posture (pressure or aligned) belong to this engine.
  const orgKeys = Array.from(new Set(pageRows.map((r) => r.org_key)));
  for (const orgKey of orgKeys) {
    const cfg = configByKey.get(orgKey);
    if (!cfg || !cfg.posture) continue;
    if (cfg.role === 'protagonist' && cfg.operation !== 'ai') continue;
    const rows = pageRows.filter((r) => r.org_key === orgKey);
    try {
      await runPage(
        sessionId,
        sessionRow.scenario_id,
        elapsedMinutes,
        cfg,
        rows,
        initialState,
        escalationRisk,
      );
    } catch (err) {
      logger.warn({ err, sessionId, orgKey }, 'pressure engine: page tick failed');
    }
  }
}

async function runPage(
  sessionId: string,
  scenarioId: string,
  elapsedMinutes: number,
  cfg: OrgConfig,
  rows: PageRow[],
  initialState: Record<string, unknown>,
  escalationRisk: number,
): Promise<void> {
  const posture = cfg.posture!;
  const handles = rows.map((r) => r.page_handle);

  // Progress signals
  const [{ data: ownPosts }, { data: standDownEvents }, { data: hqPosts }] = await Promise.all([
    supabaseAdmin
      .from('social_posts')
      .select('id, created_at, content')
      .eq('session_id', sessionId)
      .in('author_handle', handles)
      .is('reply_to_post_id', null)
      .order('created_at', { ascending: false })
      .limit(10),
    supabaseAdmin
      .from('session_events')
      .select('id, event_type, metadata')
      .eq('session_id', sessionId)
      .in('event_type', ['pressure_stand_down', 'antagonist_post'])
      .order('created_at', { ascending: false })
      .limit(50),
    protagonistPostsSince(sessionId, posture.targets_org_keys),
  ]);
  const own = ownPosts || [];
  const rung = own.length; // scheduled statements count as rungs already climbed
  const lastAt = own[0]?.created_at ? new Date(String(own[0].created_at)).getTime() : null;
  const minutesSinceLastPost = lastAt ? Math.max(0, (Date.now() - lastAt) / 60000) : Infinity;

  const stoodDown = (standDownEvents || []).some(
    (e) =>
      e.event_type === 'pressure_stand_down' &&
      (e.metadata as { org_key?: string })?.org_key === cfg.org_key,
  );

  let spokespersonContacted = false;
  let latestVerdict: PageProgress['latestVerdict'] = null;
  const spokespersonId =
    cfg.spokesperson_stakeholder_id ||
    rows.find((r) => r.spokesperson_stakeholder_id)?.spokesperson_stakeholder_id ||
    null;
  if (spokespersonId) {
    const { wasContacted } = await import('./stakeholderReplyService.js');
    spokespersonContacted = await wasContacted(sessionId, spokespersonId).catch(() => false);
    const { data: verdicts } = await supabaseAdmin
      .from('session_events')
      .select('metadata, created_at')
      .eq('session_id', sessionId)
      .eq('event_type', 'stakeholder_verdict')
      .order('created_at', { ascending: false })
      .limit(40);
    const mine = (verdicts || []).find(
      (v) => (v.metadata as { stakeholder_id?: string })?.stakeholder_id === spokespersonId,
    );
    const verdict = (mine?.metadata as { verdict?: string } | undefined)?.verdict;
    if (verdict === 'cancel' || verdict === 'modify' || verdict === 'delay' || verdict === 'keep')
      latestVerdict = verdict;
  }

  const decisionTouched = await recentDecisionTouching(sessionId, posture.targets_org_keys);
  const factSheet = (initialState.fact_sheet as { confirmed_facts?: string[] } | undefined) || {};
  const contradictionSeen = false; // v1: correction relies on the judge; kept as a hook

  const progress: PageProgress = {
    minutesSinceLastPost,
    rung,
    maxRung: Math.max(1, posture.escalation_ladder.length),
    spokespersonContacted,
    latestVerdict,
    hqPublished: (hqPosts || []).length > 0,
    contradictionSeen,
    stoodDown,
    decisionTouched,
    escalationRisk,
  };
  const move = chooseMove(posture.register, progress);
  if (move === 'skip') return;

  const platform =
    rows.some((r) => r.platform === 'x_twitter') &&
    (posture.register === 'statutory' || Math.random() < 0.5)
      ? 'x_twitter'
      : rows[0].platform;
  const ident = rows.find((r) => r.platform === platform) || rows[0];
  const hqLine = (hqPosts || [])
    .slice(0, 3)
    .map((p) => `- ${String(p.content).slice(0, 200)}`)
    .join('\n');
  const registerVoice: Record<PagePosture['register'], string> = {
    statutory: 'formal, procedural, cites process and law, never speculates, never mocks',
    advocacy: 'members/victims first, specific harms, demands consultation and remedies',
    grassroots: 'local and human; organises; factual but emotional',
    political: 'accountability register; questions to ministers; calls for inquiry',
    aligned:
      'measured corporate voice of a local office; consistent with headquarters; never contradicts HQ; never speculates',
  };
  const moveBrief: Record<Exclude<PressureMove, 'skip'>, string> = {
    statement: `First public statement: state the mandate and the situation as you see it; set out the demands.`,
    demand_with_deadline: `Repeat the top demand with a concrete deadline (hours), note the absence of a satisfactory response.`,
    escalate_rung: `Climb to the next rung of your ladder: "${posture.escalation_ladder[Math.min(rung, posture.escalation_ladder.length - 1)]}". Announce it as a decision taken.`,
    acknowledge_progress: `Acknowledge that the organisation has engaged; hold the demands but soften the tone; give them a short window.`,
    correct_record: `Correct the record: point at the discrepancy between what the organisation said and the confirmed facts, procedurally.`,
    stand_down: `Stand down: state that engagement has taken place, that commitments were received, and that you will monitor delivery. Name what was committed.`,
    aligned_holding_statement: `Local holding statement: acknowledge the situation at this site, say the team is working with headquarters and that an update follows; no admissions, no speculation.`,
    aligned_follow_hq: `Local update that mirrors headquarters' published line (below) for this site's audience, adding one local detail.`,
    aligned_clarify: `Local clarification correcting an inaccurate claim about this site, factual and short.`,
  };
  const result = await callSocialCrisisAI(
    `You run the official social media account of "${cfg.display_name}" (${ident.page_handle}) in a crisis simulation. Register: ${posture.register} — ${registerVoice[posture.register]}.
Mandate: ${posture.mandate}
Demands: ${posture.demands.join(' | ') || '(none — aligned office)'}
Stand-down signals: ${posture.stand_down_signals.join(' | ')}
Confirmed facts (never contradict): ${(factSheet.confirmed_facts || []).slice(0, 6).join('; ') || '(none)'}
${hqLine ? `Headquarters' published line:\n${hqLine}` : 'Headquarters has not published anything yet.'}

MOVE: ${moveBrief[move]}
Write ONE ${platform === 'facebook' ? 'Facebook post (2-4 sentences)' : 'X post (<= 260 characters, 0-2 hashtags)'} in character. Never mock, never sell, never amplify rumour.
Return ONLY valid JSON: { "content": "..." }`,
    `Elapsed: T+${Math.round(elapsedMinutes)} min. Escalation risk ${escalationRisk}. Write the post.`,
    700,
    0.7,
  );
  const content = String(result?.content || '').trim();
  if (!content) return;

  let pageCountry: string | null = null;
  try {
    const { orgCountryForPage } = await import('./orgRegistryService.js');
    pageCountry = await orgCountryForPage(scenarioId, cfg.org_key);
  } catch {
    /* single-country */
  }
  const { data: post, error } = await supabaseAdmin
    .from('social_posts')
    .insert({
      session_id: sessionId,
      platform,
      author_handle: ident.page_handle,
      author_display_name: ident.page_name,
      author_type: 'official_account',
      content,
      hashtags: (content.match(/#\w+/g) || []) as string[],
      sentiment: move === 'stand_down' || move.startsWith('aligned') ? 'neutral' : 'negative',
      content_flags: { is_organized_pressure: posture.register !== 'aligned' },
      virality_score: posture.register === 'statutory' ? 70 : 55,
      posted_by_display_name: posture.register === 'aligned' ? 'Office AI' : 'Pressure AI',
      ...(pageCountry ? { country: pageCountry } : {}),
    })
    .select()
    .single();
  if (error || !post) {
    logger.warn({ error, sessionId, orgKey: cfg.org_key }, 'pressure post insert failed');
    return;
  }
  await emitSessionEvent(
    sessionId,
    move === 'stand_down' ? 'pressure_stand_down' : 'pressure_post',
    'antagonist_post',
    {
      description: `${cfg.display_name} (${posture.register}) — ${move}`,
      metadata: {
        org_key: cfg.org_key,
        move,
        register: posture.register,
        elapsed_minutes: elapsedMinutes,
        post_id: post.id,
      },
    },
  );
  getWebSocketService().broadcastToSession(sessionId, {
    type: 'social_post.created',
    data: { post },
    timestamp: new Date().toISOString(),
  });
  void triggerNPCReactions(sessionId, post as Record<string, unknown>).catch(() => undefined);
  logger.info(
    { sessionId, orgKey: cfg.org_key, move, register: posture.register },
    'pressure engine posted',
  );
}

async function protagonistPostsSince(
  sessionId: string,
  targetOrgKeys: string[],
): Promise<{ data: Array<{ content: string; created_at: string }> | null }> {
  if (targetOrgKeys.length === 0) return { data: [] };
  const { data: pages } = await supabaseAdmin
    .from('sim_org_pages')
    .select('page_handle')
    .eq('session_id', sessionId)
    .in('org_key', targetOrgKeys);
  const handles = (pages || []).map((p) => String(p.page_handle));
  if (handles.length === 0) return { data: [] };
  const { data } = await supabaseAdmin
    .from('social_posts')
    .select('content, created_at')
    .eq('session_id', sessionId)
    .in('author_handle', handles)
    .eq('is_branded_history', false)
    .is('reply_to_post_id', null)
    .order('created_at', { ascending: false })
    .limit(5);
  return { data: (data || []) as Array<{ content: string; created_at: string }> };
}

async function recentDecisionTouching(
  sessionId: string,
  targetOrgKeys: string[],
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('session_decisions')
    .select('org_key, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(5);
  return (data || []).some((d) => targetOrgKeys.includes(String(d.org_key)));
}

/** At session start: protagonist orgs with no assigned players become AI-operated (pressure plan §12). */
export async function flipUnstaffedOrgsToAi(sessionId: string): Promise<string[]> {
  const scenario = await getScenarioForSession(sessionId);
  const is = (scenario?.initial_state as Record<string, unknown>) || {};
  const registry =
    (is.orgs as Array<{
      org_key: string;
      side: string;
      operation?: string;
      display_name: string;
    }>) || [];
  const protagonists = registry.filter((o) => o.side === 'protagonist' && o.operation !== 'ai');
  if (protagonists.length <= 1) return [];
  const { data: teams } = await supabaseAdmin
    .from('session_teams')
    .select('team_name, user_id')
    .eq('session_id', sessionId);
  const { data: scenarioTeams } = await supabaseAdmin
    .from('scenario_teams')
    .select('team_name, org_key')
    .eq('scenario_id', scenario?.id as string);
  const staffedTeams = new Set((teams || []).map((t) => String(t.team_name)));
  const flipped: string[] = [];
  for (const org of protagonists) {
    const orgTeams = (scenarioTeams || [])
      .filter((t) => t.org_key === org.org_key)
      .map((t) => String(t.team_name));
    if (orgTeams.length === 0) continue;
    if (orgTeams.some((t) => staffedTeams.has(t))) continue;
    const { error } = await supabaseAdmin
      .from('sim_org_pages')
      .update({ control_mode: 'ai' })
      .eq('session_id', sessionId)
      .eq('org_key', org.org_key)
      .eq('role', 'protagonist');
    if (!error) {
      flipped.push(org.org_key);
      await emitSessionEvent(sessionId, 'decision_propagated', 'trainer_alert', {
        description: `${org.display_name} has no players — operated by AI for this session`,
        metadata: { kind: 'org_ai_operated', org_key: org.org_key },
      });
    }
  }
  return flipped;
}
