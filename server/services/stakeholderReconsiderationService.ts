/**
 * Stakeholder reconsideration engine (runtime plan §3.5, contract §3.1).
 *
 * When a player contacts a stakeholder who has scheduled injects that have not fired yet, ONE
 * model call produces both the in-character reply and a verdict per pending inject
 * (keep / modify / delay / cancel). Verdicts are enforced server-side against the persuadability
 * table and the resolution-criteria threshold before they are stored; the scheduler honours the
 * latest stored verdict at fire time.
 */
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getSessionScenarioId, getScenarioSnapshot } from '../lib/scenarioCache.js';
import {
  ALLOWED_VERDICTS,
  MAX_DELAY_MINUTES,
  criteriaThreshold,
  type Stakeholder,
  type Verdict,
  type TeamIdentity,
} from '../lib/stakeholderContract.js';
import { findById } from './stakeholderService.js';
import type { ConversationRow } from './stakeholderReplyService.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PendingInject {
  id: string;
  title: string;
  content: string;
  type: string;
  trigger_time_minutes: number | null;
  delivery_config: Record<string, unknown>;
}

export interface StoredVerdict {
  inject_id: string;
  stakeholder_id: string;
  verdict: Verdict;
  reason: string;
  criteria_met: number[];
  modified_content: string | null;
  delay_minutes: number | null;
  credited_team: string | null;
  contributing_teams: string[];
  created_at: string;
}

export interface ReplyPlan {
  should_reply: boolean;
  text: string;
  subject?: string;
  delay_seconds: number;
}

interface RawVerdict {
  inject_id?: unknown;
  verdict?: unknown;
  reason?: unknown;
  criteria_met?: unknown;
  modified_content?: unknown;
  delay_minutes?: unknown;
}

/** What the reconsideration engine actively judges for a stakeholder (base or latent, §5). */
export interface EffectiveGrievance {
  grievance: string;
  resolution_criteria: string[];
  persuadability: Stakeholder['persuadability'];
  hard_constraints: string[];
  source: 'base' | `decision:${string}`;
}

// ─── Pending injects ─────────────────────────────────────────────────────────

async function publishedAndCancelledSets(
  sessionId: string,
): Promise<{ published: Set<string>; cancelled: Set<string> }> {
  const { data } = await supabaseAdmin
    .from('session_events')
    .select('event_type, metadata')
    .eq('session_id', sessionId)
    .in('event_type', ['inject', 'inject_cancelled']);
  const published = new Set<string>();
  const cancelled = new Set<string>();
  for (const row of data ?? []) {
    const r = row as { event_type: string; metadata: { inject_id?: string } | null };
    const id = r.metadata?.inject_id;
    if (!id) continue;
    (r.event_type === 'inject' ? published : cancelled).add(id);
  }
  return { published, cancelled };
}

/** Scheduled injects authored by this stakeholder that have neither fired nor been cancelled. */
export async function getPendingInjects(
  sessionId: string,
  stakeholderId: string,
): Promise<PendingInject[]> {
  const scenarioId = await getSessionScenarioId(sessionId);
  if (!scenarioId) return [];

  const { data, error } = await supabaseAdmin
    .from('scenario_injects')
    .select('id, title, content, type, trigger_time_minutes, delivery_config, session_id')
    .eq('scenario_id', scenarioId)
    .or(`session_id.is.null,session_id.eq.${sessionId}`)
    .eq('delivery_config->>stakeholder_id', stakeholderId);
  if (error) {
    logger.warn({ error, sessionId, stakeholderId }, 'getPendingInjects: query failed');
    return [];
  }

  const { published, cancelled } = await publishedAndCancelledSets(sessionId);
  return (data ?? [])
    .filter((row) => !published.has(row.id as string) && !cancelled.has(row.id as string))
    .map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      content: String(row.content ?? ''),
      type: String(row.type ?? ''),
      trigger_time_minutes:
        typeof row.trigger_time_minutes === 'number' ? row.trigger_time_minutes : null,
      delivery_config: ((row.delivery_config as Record<string, unknown> | null) ?? {}) as Record<
        string,
        unknown
      >,
    }));
}

// ─── Verdict storage ─────────────────────────────────────────────────────────

export async function getLatestVerdict(
  sessionId: string,
  injectId: string,
): Promise<StoredVerdict | null> {
  const { data } = await supabaseAdmin
    .from('inject_verdicts')
    .select('*')
    .eq('session_id', sessionId)
    .eq('inject_id', injectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    inject_id: String(data.inject_id),
    stakeholder_id: String(data.stakeholder_id),
    verdict: data.verdict as Verdict,
    reason: String(data.reason ?? ''),
    criteria_met: Array.isArray(data.criteria_met) ? (data.criteria_met as number[]) : [],
    modified_content: (data.modified_content as string | null) ?? null,
    delay_minutes: (data.delay_minutes as number | null) ?? null,
    credited_team: (data.credited_team as string | null) ?? null,
    contributing_teams: (data.contributing_teams as string[] | null) ?? [],
    created_at: String(data.created_at),
  };
}

async function storeVerdicts(
  sessionId: string,
  stakeholderId: string,
  verdicts: Array<Omit<StoredVerdict, 'created_at' | 'stakeholder_id'>>,
): Promise<StoredVerdict[]> {
  if (verdicts.length === 0) return [];
  const rows = verdicts.map((v) => ({
    session_id: sessionId,
    inject_id: v.inject_id,
    stakeholder_id: stakeholderId,
    verdict: v.verdict,
    reason: v.reason,
    criteria_met: v.criteria_met,
    modified_content: v.modified_content,
    delay_minutes: v.delay_minutes,
    credited_team: v.credited_team,
    contributing_teams: v.contributing_teams,
  }));
  const { data, error } = await supabaseAdmin.from('inject_verdicts').insert(rows).select('*');
  if (error) {
    logger.warn({ error, sessionId, stakeholderId }, 'Failed to store inject verdicts');
    return [];
  }
  const stored = (data ?? []).map((d) => ({
    inject_id: String(d.inject_id),
    stakeholder_id: String(d.stakeholder_id),
    verdict: d.verdict as Verdict,
    reason: String(d.reason ?? ''),
    criteria_met: Array.isArray(d.criteria_met) ? (d.criteria_met as number[]) : [],
    modified_content: (d.modified_content as string | null) ?? null,
    delay_minutes: (d.delay_minutes as number | null) ?? null,
    credited_team: (d.credited_team as string | null) ?? null,
    contributing_teams: (d.contributing_teams as string[] | null) ?? [],
    created_at: String(d.created_at),
  }));

  // Trainer visibility even for `keep` (runtime plan §3.5).
  for (const v of stored) {
    await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: 'stakeholder_verdict',
      description: `Stakeholder ${stakeholderId} verdict on inject: ${v.verdict} — ${v.reason}`,
      actor_id: null,
      metadata: { ...v, source: 'stakeholder' },
    });
  }
  return stored;
}

// ─── Effective grievance (base today; §5 swaps in latent grievances) ─────────

export async function getEffectiveGrievance(
  sessionId: string,
  stakeholder: Stakeholder,
): Promise<EffectiveGrievance> {
  try {
    const { data } = await supabaseAdmin
      .from('stakeholder_state')
      .select('active_decision_key')
      .eq('session_id', sessionId)
      .eq('stakeholder_id', stakeholder.id)
      .maybeSingle();
    const key = (data?.active_decision_key as string | null) ?? null;
    const latent = key ? stakeholder.latent_grievances?.[key] : undefined;
    if (key && latent) {
      return {
        grievance: latent.grievance,
        resolution_criteria: latent.resolution_criteria,
        persuadability: latent.persuadability,
        hard_constraints: latent.hard_constraints,
        source: `decision:${key}`,
      };
    }
  } catch {
    /* stakeholder_state does not exist until migration 203 — base grievance applies */
  }
  return {
    grievance: stakeholder.grievance,
    resolution_criteria: stakeholder.resolution_criteria,
    persuadability: stakeholder.persuadability,
    hard_constraints: stakeholder.hard_constraints,
    source: 'base',
  };
}

// ─── Enforcement (never trust the model) ─────────────────────────────────────

export function enforceVerdict(
  raw: RawVerdict,
  pending: PendingInject,
  eff: EffectiveGrievance,
): Omit<StoredVerdict, 'created_at' | 'stakeholder_id' | 'credited_team' | 'contributing_teams'> {
  const allowed = ALLOWED_VERDICTS[eff.persuadability];
  const total = eff.resolution_criteria.length;
  const criteriaMet = Array.isArray(raw.criteria_met)
    ? Array.from(
        new Set(
          (raw.criteria_met as unknown[])
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= total),
        ),
      )
    : [];
  const modified = typeof raw.modified_content === 'string' ? raw.modified_content.trim() : '';
  const modifyOk =
    modified.length > 0 && modified.length <= Math.max(400, pending.content.length * 2);
  let verdict: Verdict = (['keep', 'modify', 'delay', 'cancel'] as Verdict[]).includes(
    raw.verdict as Verdict,
  )
    ? (raw.verdict as Verdict)
    : 'keep';
  let reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : '';

  const downgrade = (why: string) => {
    verdict = modifyOk ? 'modify' : 'keep';
    reason = `${reason ? `${reason} ` : ''}[${why}]`.trim();
  };

  if (!allowed.has(verdict))
    downgrade(`${verdict} not permitted at persuadability ${eff.persuadability}`);
  if (verdict === 'cancel' && eff.hard_constraints.length > 0)
    downgrade('hard constraints forbid cancel');
  if (verdict === 'cancel' && criteriaMet.length < criteriaThreshold(eff.persuadability, total)) {
    downgrade(`only ${criteriaMet.length}/${total} criteria met`);
  }
  if (verdict === 'modify' && !modifyOk) {
    verdict = 'keep';
    reason = `${reason ? `${reason} ` : ''}[modify without usable content]`.trim();
  }

  let delayMinutes: number | null = null;
  if (verdict === 'delay') {
    const d = Math.round(Number(raw.delay_minutes));
    delayMinutes = Number.isFinite(d) ? Math.min(MAX_DELAY_MINUTES, Math.max(1, d)) : 5;
  }
  if (!reason) reason = verdict === 'keep' ? 'Concern not addressed' : 'Judged from conversation';

  return {
    inject_id: pending.id,
    verdict,
    reason,
    criteria_met: criteriaMet,
    modified_content: verdict === 'modify' ? modified : null,
    delay_minutes: delayMinutes,
  };
}

// ─── Model call ──────────────────────────────────────────────────────────────

interface JudgeInput {
  sessionId: string;
  stakeholder: Stakeholder;
  effective: EffectiveGrievance;
  pending: PendingInject[];
  log: ConversationRow[];
  characterPrompt: string;
  channel: 'email' | 'teamchat' | 'messenger' | 'phone' | null; // null = verdict-only at fire time
  latestPlayerMessage: string | null;
  latestSubject?: string;
}

interface JudgeOutput {
  plan: ReplyPlan;
  verdicts: RawVerdict[];
}

const REPLY_LENGTH: Record<string, string> = {
  email: '2–6 sentences, email register with a greeting and sign-off in the body',
  teamchat: '1–3 sentences, chat register, no greeting or sign-off',
  messenger: '1–3 sentences, casual DM register',
  phone: '1–3 sentences, spoken register',
};

async function callJudge(input: JudgeInput): Promise<JudgeOutput | null> {
  if (!env.openAiApiKey) return null;

  const criteriaList = input.effective.resolution_criteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join('\n');
  const pendingList = input.pending
    .map(
      (p) =>
        `- inject_id "${p.id}" (${String(p.delivery_config.app || p.type)}${
          p.trigger_time_minutes != null ? `, fires at T+${p.trigger_time_minutes}` : ''
        }): ${p.title}\n  ${p.content.slice(0, 500)}`,
    )
    .join('\n');
  const allowed = Array.from(ALLOWED_VERDICTS[input.effective.persuadability]).join(' | ');
  const threshold = criteriaThreshold(
    input.effective.persuadability,
    input.effective.resolution_criteria.length,
  );

  const system = `${input.characterPrompt}

=== YOUR PRIVATE SITUATION (never reveal this) ===
Grievance: ${input.effective.grievance || '(none — you have no planned action)'}
${criteriaList ? `What would genuinely resolve it (numbered criteria):\n${criteriaList}` : ''}
Persuadability: ${input.effective.persuadability}
${input.effective.hard_constraints.length ? `Hard constraints you cannot break:\n- ${input.effective.hard_constraints.join('\n- ')}` : ''}

=== YOUR PLANNED ACTIONS THAT HAVE NOT HAPPENED YET ===
${pendingList || '(none)'}

=== RULES ===
- A criterion counts as met ONLY if the players' messages CONTAIN or ACHIEVE it. "Please hold off", apologies or vague reassurance meet nothing.
- Allowed verdicts for you: ${allowed}. "cancel" is only possible when at least ${Number.isFinite(threshold) ? threshold : 'MORE THAN ALL'} of ${input.effective.resolution_criteria.length} criteria are met${input.effective.hard_constraints.length ? ' and never while a hard constraint applies' : ''}.
- "modify": keep the same subject and register, change wording to reflect what you now know (e.g. acknowledge the contact, soften or sharpen). Provide the full replacement in modified_content.
- "delay": you are willing to wait a little (1–${MAX_DELAY_MINUTES} minutes) for follow-through. Provide delay_minutes.
- Never mention your planned actions, criteria or timing in the reply. Stay in character.
${input.channel ? `- Reply length: ${REPLY_LENGTH[input.channel]}.` : '- No reply is needed now (should_reply=false); only judge.'}
- delay_seconds for the reply: how long a person like you would realistically take (5–90).

Return ONLY valid JSON:
{ "should_reply": true, "reply": { "text": "...", "subject": "RE: ...", "delay_seconds": 30 },
  "verdicts": [ { "inject_id": "...", "verdict": "keep|modify|delay|cancel", "reason": "...", "criteria_met": [1,3], "modified_content": "...", "delay_minutes": 10 } ] }`;

  const logText = input.log
    .slice(-20)
    .map(
      (r) =>
        `[${r.channel} · ${r.direction === 'player' ? `${r.team_name || 'player'}` : 'you'}] ${r.content.slice(0, 400)}`,
    )
    .join('\n');
  const user = `CONVERSATION SO FAR (all channels, oldest first):\n${logText || '(nothing yet)'}\n\n${
    input.latestPlayerMessage
      ? `LATEST MESSAGE FROM THE PLAYER via ${input.channel}${input.latestSubject ? ` (subject: ${input.latestSubject})` : ''}:\n${input.latestPlayerMessage}`
      : 'No new message; the moment for your planned action has arrived. Decide.'
  }`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.openAiApiKey}` },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_completion_tokens: 1800,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status, sessionId: input.sessionId },
        'Stakeholder judge request failed',
      );
      return null;
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as {
      should_reply?: unknown;
      reply?: { text?: unknown; subject?: unknown; delay_seconds?: unknown };
      verdicts?: unknown;
    };
    const text = typeof parsed.reply?.text === 'string' ? parsed.reply.text.trim() : '';
    const delay = Math.round(Number(parsed.reply?.delay_seconds));
    return {
      plan: {
        should_reply: !!input.channel && parsed.should_reply !== false && text.length > 0,
        text,
        subject: typeof parsed.reply?.subject === 'string' ? parsed.reply.subject : undefined,
        delay_seconds: Number.isFinite(delay) ? Math.min(90, Math.max(5, delay)) : 30,
      },
      verdicts: Array.isArray(parsed.verdicts) ? (parsed.verdicts as RawVerdict[]) : [],
    };
  } catch (err) {
    logger.warn({ err, sessionId: input.sessionId }, 'Stakeholder judge call failed');
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface DecideContext {
  sessionId: string;
  stakeholder: Stakeholder;
  characterPrompt: string;
  log: ConversationRow[];
  channel: 'email' | 'teamchat' | 'messenger' | 'phone';
  latestPlayerMessage: string;
  latestSubject?: string;
  teamIdentity: TeamIdentity | null;
}

/**
 * One call → reply + verdicts. Verdicts are enforced and stored; the reply plan is returned for
 * the channel adapter to persist. Never throws.
 */
export async function decideAndReply(
  ctx: DecideContext,
): Promise<{ plan: ReplyPlan; verdicts: StoredVerdict[] }> {
  const fallback: ReplyPlan = { should_reply: false, text: '', delay_seconds: 30 };
  try {
    const pending = await getPendingInjects(ctx.sessionId, ctx.stakeholder.id);
    const effective = await getEffectiveGrievance(ctx.sessionId, ctx.stakeholder);
    const out = await callJudge({
      sessionId: ctx.sessionId,
      stakeholder: ctx.stakeholder,
      effective,
      pending,
      log: ctx.log,
      characterPrompt: ctx.characterPrompt,
      channel: ctx.channel,
      latestPlayerMessage: ctx.latestPlayerMessage,
      latestSubject: ctx.latestSubject,
    });
    if (!out) return { plan: fallback, verdicts: [] };

    const contributing = Array.from(
      new Set(
        ctx.log.filter((r) => r.direction === 'player' && r.team_name).map((r) => r.team_name!),
      ),
    );
    const enforced = out.verdicts
      .map((raw) => {
        const target = pending.find((p) => p.id === String(raw.inject_id ?? ''));
        if (!target) return null;
        return {
          ...enforceVerdict(raw, target, effective),
          credited_team: ctx.teamIdentity?.team_name ?? null,
          contributing_teams: contributing,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const stored = await storeVerdicts(ctx.sessionId, ctx.stakeholder.id, enforced);
    return { plan: out.plan, verdicts: stored };
  } catch (err) {
    logger.warn(
      { err, sessionId: ctx.sessionId, stakeholderId: ctx.stakeholder.id },
      'decideAndReply failed',
    );
    return { plan: fallback, verdicts: [] };
  }
}

/** Verdict-only evaluation at fire time (player wrote, stakeholder has not replied yet). */
export async function judgeAtFireTime(
  sessionId: string,
  stakeholder: Stakeholder,
  inject: PendingInject,
  log: ConversationRow[],
  characterPrompt: string,
): Promise<StoredVerdict | null> {
  try {
    const effective = await getEffectiveGrievance(sessionId, stakeholder);
    const out = await callJudge({
      sessionId,
      stakeholder,
      effective,
      pending: [inject],
      log,
      characterPrompt,
      channel: null,
      latestPlayerMessage: null,
    });
    if (!out) return null;
    const raw =
      out.verdicts.find((v) => String(v.inject_id ?? '') === inject.id) ?? out.verdicts[0];
    if (!raw) return null;
    const lastPlayer = [...log].reverse().find((r) => r.direction === 'player');
    const contributing = Array.from(
      new Set(log.filter((r) => r.direction === 'player' && r.team_name).map((r) => r.team_name!)),
    );
    const [stored] = await storeVerdicts(sessionId, stakeholder.id, [
      {
        ...enforceVerdict(raw, inject, effective),
        credited_team: lastPlayer?.team_name ?? null,
        contributing_teams: contributing,
      },
    ]);
    return stored ?? null;
  } catch (err) {
    logger.warn({ err, sessionId, injectId: inject.id }, 'judgeAtFireTime failed');
    return null;
  }
}

// ─── Scheduler hook ──────────────────────────────────────────────────────────

export type FireTimeDecision =
  | { action: 'publish' }
  | { action: 'skip'; reason: 'cancelled' | 'delayed' }
  | { action: 'publish_modified'; injectId: string };

async function hasEvent(sessionId: string, eventType: string, injectId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('session_events')
    .select('id')
    .eq('session_id', sessionId)
    .eq('event_type', eventType)
    .eq('metadata->>inject_id', injectId)
    .limit(1);
  return !!data && data.length > 0;
}

/**
 * Called by the inject scheduler before publishing an inject that carries a `stakeholder_id`.
 * Honours the latest stored verdict; when there is none but the stakeholder has been written to,
 * judges once now. Records events and heat-meter credit. Never throws; defaults to publish.
 */
export async function decideAtFireTime(
  session: {
    id: string;
    scenario_id: string | null;
    trainer_id: string | null;
    start_time?: string | null;
  },
  inject: PendingInject & {
    severity?: string | null;
    inject_scope?: string | null;
    target_teams?: string[] | null;
  },
  elapsedMinutes: number,
): Promise<FireTimeDecision> {
  if (!env.enableStakeholderEngine) return { action: 'publish' };
  const stakeholderId = String(inject.delivery_config?.stakeholder_id ?? '');
  if (!stakeholderId || !session.scenario_id) return { action: 'publish' };

  try {
    const stakeholder = await findById(session.scenario_id, stakeholderId);
    if (!stakeholder) {
      logger.warn(
        { sessionId: session.id, injectId: inject.id, stakeholderId },
        'Inject references unknown stakeholder_id; publishing as ordinary inject',
      );
      return { action: 'publish' };
    }

    let verdict = await getLatestVerdict(session.id, inject.id);
    if (!verdict) {
      const { getConversationLog, buildCharacterPrompt } =
        await import('./stakeholderReplyService.js');
      const log = await getConversationLog(session.id, stakeholderId);
      if (log.some((r) => r.direction === 'player')) {
        const snapshot = await getScenarioSnapshot(session.scenario_id);
        const prompt = buildCharacterPrompt(stakeholder, log, {
          description: snapshot?.description ?? '',
          org_name: String(snapshot?.initial_state.org_name ?? ''),
          fact_sheet:
            (snapshot?.initial_state.fact_sheet as Record<string, unknown> | undefined) ?? null,
        });
        verdict = await judgeAtFireTime(session.id, stakeholder, inject, log, prompt);
      }
    }
    if (!verdict || verdict.verdict === 'keep') return { action: 'publish' };

    const creditTeam = async () => {
      if (!verdict?.credited_team) return;
      try {
        const { updateTeamHeatMeter } = await import('./heatMeterService.js');
        await updateTeamHeatMeter(session.id, verdict.credited_team, 'good');
      } catch {
        /* non-critical */
      }
    };

    if (verdict.verdict === 'cancel') {
      await supabaseAdmin.from('session_events').insert({
        session_id: session.id,
        event_type: 'inject_cancelled',
        description: `Inject withdrawn by ${stakeholder.name}: ${inject.title} — ${verdict.reason}`,
        actor_id: null,
        metadata: {
          inject_id: inject.id,
          stakeholder_id: stakeholderId,
          stakeholder_name: stakeholder.name,
          reason: verdict.reason,
          credited_team: verdict.credited_team,
          contributing_teams: verdict.contributing_teams,
          criteria_met: verdict.criteria_met,
          cancelled_at: new Date().toISOString(),
          source: 'stakeholder',
        },
      });
      await creditTeam();
      logger.info(
        { sessionId: session.id, injectId: inject.id, stakeholderId },
        'Stakeholder cancelled inject',
      );
      return { action: 'skip', reason: 'cancelled' };
    }

    if (verdict.verdict === 'delay') {
      const until =
        (inject.trigger_time_minutes ?? 0) + (verdict.delay_minutes ?? MAX_DELAY_MINUTES);
      if (elapsedMinutes < until) {
        if (!(await hasEvent(session.id, 'inject_delayed', inject.id))) {
          await supabaseAdmin.from('session_events').insert({
            session_id: session.id,
            event_type: 'inject_delayed',
            description: `${stakeholder.name} is holding "${inject.title}" for ${verdict.delay_minutes} min — ${verdict.reason}`,
            actor_id: null,
            metadata: {
              inject_id: inject.id,
              stakeholder_id: stakeholderId,
              stakeholder_name: stakeholder.name,
              delay_minutes: verdict.delay_minutes,
              until_minute: until,
              reason: verdict.reason,
              credited_team: verdict.credited_team,
              source: 'stakeholder',
            },
          });
        }
        return { action: 'skip', reason: 'delayed' };
      }
      return { action: 'publish' };
    }

    // modify → runtime copy with the new content; original recorded as cancelled (reason: modified)
    const { data: copy, error } = await supabaseAdmin
      .from('scenario_injects')
      .insert({
        scenario_id: session.scenario_id,
        session_id: session.id,
        type: inject.type,
        title: inject.title,
        content: verdict.modified_content ?? inject.content,
        severity: inject.severity ?? 'medium',
        inject_scope: inject.inject_scope ?? 'universal',
        target_teams: inject.target_teams ?? null,
        trigger_time_minutes: inject.trigger_time_minutes,
        delivery_config: { ...inject.delivery_config, modified_from: inject.id },
        ai_generated: true,
        generation_source: 'stakeholder_modified',
      })
      .select('id')
      .single();
    if (error || !copy) {
      logger.warn(
        { error, sessionId: session.id, injectId: inject.id },
        'Failed to create modified inject; publishing original',
      );
      return { action: 'publish' };
    }
    await supabaseAdmin.from('session_events').insert([
      {
        session_id: session.id,
        event_type: 'inject_cancelled',
        description: `Inject replaced by ${stakeholder.name}'s revised version: ${inject.title}`,
        actor_id: null,
        metadata: {
          inject_id: inject.id,
          stakeholder_id: stakeholderId,
          reason: 'modified',
          replaced_by: copy.id,
          credited_team: verdict.credited_team,
          source: 'stakeholder',
        },
      },
      {
        session_id: session.id,
        event_type: 'inject_modified',
        description: `${stakeholder.name} revised "${inject.title}" — ${verdict.reason}`,
        actor_id: null,
        metadata: {
          inject_id: copy.id,
          original_inject_id: inject.id,
          stakeholder_id: stakeholderId,
          stakeholder_name: stakeholder.name,
          reason: verdict.reason,
          credited_team: verdict.credited_team,
          contributing_teams: verdict.contributing_teams,
          criteria_met: verdict.criteria_met,
          source: 'stakeholder',
        },
      },
    ]);
    await creditTeam();
    return { action: 'publish_modified', injectId: String(copy.id) };
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id, injectId: inject.id },
      'decideAtFireTime failed; publishing',
    );
    return { action: 'publish' };
  }
}
