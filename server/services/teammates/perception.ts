import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { getScenarioSnapshot } from '../../lib/scenarioCache.js';
import { getPlayerTeamContext } from '../teamCharterService.js';
import { getIntelManifest, type IntelManifestEntry } from '../intelSharingService.js';
import {
  type BotApi,
  type ChatMessage,
  type DmThread,
  type Draft,
  type FeedPost,
  type NewsArticle,
  type SimEmail,
  type TeamAssignment,
} from './apiClient.js';
import { type BotMemory, extractCommitments, rememberGrade } from './memory.js';
import type { BotParams } from './intellect.js';
import type { TeamCharterView } from './types.js';

/**
 * Perception: everything a bot reads before it decides (docs/ai-teammate-bots-plan.md §7).
 *
 * Reads go through the bot's own JWT so the server's visibility rules apply. The
 * only service-role reads are things a human has on paper anyway (the fact sheet,
 * the scenario clock) plus — at high intellect only — the hidden charter timings.
 */

export interface TaggedPost extends FeedPost {
  tags: string[];
  harmful: boolean;
  /** Someone on my team (or I) already replied / flagged / disputed it. */
  handledByTeam: boolean;
  ageMinutes: number;
}

export interface FactSheet {
  orgName: string;
  confirmed: string[];
  unconfirmed: string[];
  guidelines: string[];
}

export interface Gauges {
  public_trust: number | null;
  community_safety: number | null;
  narrative_control: number | null;
  escalation_risk: number | null;
  sentiment_score: number | null;
}

export interface Teammate {
  user_id: string;
  full_name: string;
  team_name: string | null;
  address: string;
  isMe: boolean;
}

export interface Situation {
  now: number;
  elapsedMinutes: number;
  me: {
    userId: string;
    displayName: string;
    handle: string;
    address: string;
    teamName: string | null;
    isPageHolder: boolean;
    pageHandle: string | null;
    pageName: string | null;
  };
  charter: TeamCharterView | null;
  facts: FactSheet;
  feed: TaggedPost[];
  harmful: TaggedPost[];
  needsResponse: TaggedPost[];
  emails: {
    unanswered: SimEmail[];
    unread: SimEmail[];
    intel: SimEmail[];
    all: SimEmail[];
  };
  dms: DmThread[];
  chat: {
    teamChannelId: string | null;
    allTeamsChannelId: string | null;
    recent: ChatMessage[];
    mentions: ChatMessage[];
    nudges: ChatMessage[];
  };
  drafts: {
    toReview: Draft[];
    mine: Draft[];
    approvedUnpublished: Draft[];
    changesRequested: Draft[];
  };
  news: NewsArticle[];
  gauges: Gauges;
  officialStatements: FeedPost[];
  lastOfficialStatementAt: number | null;
  teammates: Teammate[];
  /** Members of every team (for intel relay and escalation targets). */
  teams: Map<string, Teammate[]>;
  publicVoiceTeam: string | null;
  /** Intel emails I hold that another staffed team needs (from the scenario's intel manifest). */
  intelToRelay: Array<{ email: SimEmail; entry: IntelManifestEntry; recipients: Teammate[] }>;
}

const HARMFUL_KEYS = [
  'is_misinformation',
  'misinformation',
  'is_false_claim',
  'is_hate_speech',
  'hate_speech',
  'is_incitement',
  'incites_violence',
  'is_harmful_narrative',
  'is_inflammatory',
  'inflammatory',
  'is_racist',
  'is_organized_pressure',
  'threatening',
];

export function harmfulFlags(post: { content_flags: Record<string, unknown> | null }): string[] {
  const f = post.content_flags ?? {};
  return HARMFUL_KEYS.filter((k) => Boolean(f[k]));
}

export function isMisinfo(post: { content_flags: Record<string, unknown> | null }): boolean {
  const f = post.content_flags ?? {};
  return Boolean(f.is_misinformation || f.misinformation || f.is_false_claim);
}

export function isHate(post: { content_flags: Record<string, unknown> | null }): boolean {
  const f = post.content_flags ?? {};
  return Boolean(
    f.is_hate_speech || f.hate_speech || f.is_incitement || f.incites_violence || f.is_racist,
  );
}

/** Same derivation as routes/socialMedia.ts + socialMessenger.ts. */
export function handleFor(fullName: string): string {
  return `@${fullName.replace(/[@.\s+,]/g, '_').toLowerCase()}`;
}

/** Same derivation as playerDirectoryService.ts (without collision suffixing). */
export function simAddressFor(fullName: string): string {
  const cleaned = fullName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '.');
  return `${cleaned || 'player'}@crisisresponse.sim`;
}

// ---------------------------------------------------------------------------
// Cached per-session context (scenario-level things that do not change per turn)
// ---------------------------------------------------------------------------

export interface SessionContext {
  sessionId: string;
  scenarioId: string;
  startTime: number | null;
  facts: FactSheet;
  loadedAt: number;
}

const sessionCtxCache = new Map<string, SessionContext>();
const SESSION_CTX_TTL_MS = 5 * 60_000;

export async function loadSessionContext(sessionId: string): Promise<SessionContext | null> {
  const cached = sessionCtxCache.get(sessionId);
  if (cached && Date.now() - cached.loadedAt < SESSION_CTX_TTL_MS) return cached;
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, start_time')
      .eq('id', sessionId)
      .maybeSingle();
    if (!session?.scenario_id) return null;
    const snapshot = await getScenarioSnapshot(String(session.scenario_id));
    const facts = factSheetFrom(snapshot?.initial_state ?? {});
    const ctx: SessionContext = {
      sessionId,
      scenarioId: String(session.scenario_id),
      startTime: session.start_time ? new Date(String(session.start_time)).getTime() : null,
      facts,
      loadedAt: Date.now(),
    };
    sessionCtxCache.set(sessionId, ctx);
    return ctx;
  } catch (err) {
    logger.warn({ err, sessionId }, 'teammates: session context load failed');
    return null;
  }
}

export function forgetSessionContext(sessionId: string): void {
  sessionCtxCache.delete(sessionId);
}

function flatten(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((i) =>
      typeof i === 'string'
        ? i
        : typeof i === 'object' && i !== null
          ? String(
              (i as Record<string, unknown>).claim ??
                (i as Record<string, unknown>).fact ??
                (i as Record<string, unknown>).text ??
                (i as Record<string, unknown>).statement ??
                JSON.stringify(i),
            )
          : String(i),
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

export function factSheetFrom(initialState: Record<string, unknown>): FactSheet {
  const fs = (initialState.fact_sheet ?? {}) as Record<string, unknown>;
  const rg = (initialState.research_guidelines ?? {}) as Record<string, unknown>;
  const perTeam = Array.isArray(rg.per_team) ? (rg.per_team as Array<Record<string, unknown>>) : [];
  const guidelines = perTeam
    .flatMap((t) =>
      Array.isArray(t.guidelines) ? (t.guidelines as Array<Record<string, unknown>>) : [],
    )
    .map((g) => String(g.best_practice ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    orgName: String(initialState.org_name ?? initialState.organisation_name ?? 'the organisation'),
    confirmed: flatten(fs.confirmed_facts).slice(0, 20),
    unconfirmed: flatten(fs.unconfirmed_claims ?? fs.false_claims).slice(0, 20),
    guidelines,
  };
}

// ---------------------------------------------------------------------------
// Charter
// ---------------------------------------------------------------------------

export async function loadCharter(
  sessionId: string,
  userId: string,
  knowsRubric: boolean,
): Promise<TeamCharterView | null> {
  const ctx = await getPlayerTeamContext(sessionId, userId);
  if (!ctx) return null;
  const charter = ctx.charter;
  return {
    team_name: ctx.team_name,
    function_key: ctx.function_key,
    org_key: ctx.org_key,
    mission: charter?.mission ?? '',
    responsibilities: charter?.responsibilities ?? [],
    out_of_lane: charter?.out_of_lane ?? [],
    tasks: (charter?.expected_actions ?? []).map((a) => a.description),
    expected_actions: knowsRubric
      ? (charter?.expected_actions ?? []).map((a) => ({
          action_id: a.action_id,
          description: a.description,
          detection_action_type: a.detection_action_type,
          timing_benchmark_minutes: a.timing_benchmark_minutes,
          weight: a.weight,
          tier: a.tier,
        }))
      : [],
    can_post_publicly: charter?.can_post_publicly ?? false,
    scoring_rubric: knowsRubric ? (charter?.scoring_rubric ?? '') : '',
  };
}

// ---------------------------------------------------------------------------
// Situation
// ---------------------------------------------------------------------------

export interface PerceiveInput {
  api: BotApi;
  userId: string;
  displayName: string;
  memory: BotMemory;
  params: BotParams;
  charter: TeamCharterView | null;
  sessionCtx: SessionContext;
  /** Team member ids that count as "my team" for handled-by-team checks. */
  teamMemberIds?: Set<string>;
}

export async function perceive(input: PerceiveInput): Promise<Situation> {
  const { api, userId, displayName, memory, charter, sessionCtx } = input;
  const now = Date.now();
  const elapsedMinutes = sessionCtx.startTime
    ? Math.max(0, Math.floor((now - sessionCtx.startTime) / 60_000))
    : 0;

  const [posts, emails, dmThreads, channels, drafts, state, news, pages, assignments] =
    await Promise.all([
      api.posts(),
      api.emails(),
      api.dmThreads(),
      api.channels(),
      api.drafts(),
      api.socialState(),
      api.news(),
      api.pages(),
      api.teamAssignments(),
    ]);

  const teamName = charter?.team_name ?? null;
  const handle = handleFor(displayName);
  const address = simAddressFor(displayName);

  // Teams and teammates.
  const teams = new Map<string, Teammate[]>();
  const teammates: Teammate[] = [];
  for (const a of assignments as TeamAssignment[]) {
    const name = a.user?.full_name ?? 'Player';
    const t: Teammate = {
      user_id: a.user_id,
      full_name: name,
      team_name: a.team_name,
      address: simAddressFor(name),
      isMe: a.user_id === userId,
    };
    teammates.push(t);
    const list = teams.get(a.team_name) ?? [];
    list.push(t);
    teams.set(a.team_name, list);
  }
  const teamMemberIds =
    input.teamMemberIds ??
    new Set((teams.get(teamName ?? '') ?? []).map((t) => t.user_id).concat([userId]));

  // Page control.
  const myPage = pages.find((p) => (p.controllers ?? []).includes(userId)) ?? null;
  const pageHandle = myPage?.x_twitter?.page_handle ?? myPage?.facebook?.page_handle ?? null;
  const protagonistHandles = new Set(
    pages
      .filter((p) => (p.role ?? 'protagonist') === 'protagonist')
      .flatMap((p) => [p.x_twitter?.page_handle, p.facebook?.page_handle])
      .filter((h): h is string => Boolean(h)),
  );

  // Feed.
  const repliesByTeam = new Set<string>();
  for (const p of posts) {
    if (p.reply_to_post_id && p.user_id && teamMemberIds.has(p.user_id)) {
      repliesByTeam.add(p.reply_to_post_id);
    }
  }
  const tagged: TaggedPost[] = posts
    .filter((p) => !p.reply_to_post_id || (p.requires_response && !p.responded_at))
    .map((p) => {
      const flags = harmfulFlags(p);
      const harmful = flags.length > 0;
      const handledByTeam =
        repliesByTeam.has(p.id) || memory.handled.has(p.id) || Boolean(p.responded_at);
      const tags: string[] = [];
      if (isMisinfo(p)) tags.push('FALSE-CLAIM');
      if (isHate(p)) tags.push('HATE');
      if (harmful && !isMisinfo(p) && !isHate(p)) tags.push('HOSTILE');
      if (p.requires_response && !p.responded_at) tags.push('NEEDS-RESPONSE');
      if (handledByTeam) tags.push('HANDLED-BY-TEAM');
      if (p.author_type === 'official_account' && protagonistHandles.has(p.author_handle))
        tags.push('OUR-PAGE');
      if (p.author_type === 'official_account' && !protagonistHandles.has(p.author_handle))
        tags.push('RIVAL-PAGE');
      if (p.user_id && teamMemberIds.has(p.user_id) && p.author_type === 'player')
        tags.push('TEAMMATE');
      return {
        ...p,
        tags,
        harmful,
        handledByTeam,
        ageMinutes: Math.max(0, Math.floor((now - new Date(p.created_at).getTime()) / 60_000)),
      };
    });

  const byRecency = (a: FeedPost, b: FeedPost) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  const feed = tagged
    .filter((p) => p.platform === 'x_twitter' || p.platform === 'facebook')
    .sort(byRecency)
    .slice(0, 40);
  const harmful = tagged
    .filter((p) => p.harmful && !p.handledByTeam && !p.tags.includes('OUR-PAGE'))
    .sort((a, b) => (b.virality_score ?? 0) - (a.virality_score ?? 0));
  const needsResponse = tagged.filter(
    (p) => p.requires_response && !p.responded_at && !p.handledByTeam,
  );

  const officialStatements = posts
    .filter(
      (p) =>
        p.author_type === 'official_account' &&
        protagonistHandles.has(p.author_handle) &&
        !p.reply_to_post_id,
    )
    .sort(byRecency);
  const lastOfficialStatementAt = officialStatements[0]
    ? new Date(officialStatements[0].created_at).getTime()
    : null;

  // Emails: inbound to me that I have not answered, sorted by priority then age.
  const repliedTo = new Set(
    emails
      .filter((e) => e.sent_by_player_id === userId && e.replied_to_id)
      .map((e) => e.replied_to_id!),
  );
  const inboundToMe = emails.filter((e) => {
    if (e.sent_by_player_id === userId) return false;
    if (e.direction === 'inbound') return true;
    // Another player's mail addressed to me.
    return Array.isArray(e.recipient_user_ids) && e.recipient_user_ids.includes(userId);
  });
  const isIntel = (e: SimEmail) =>
    e.email_category === 'intel' ||
    (Array.isArray(e.target_teams) && e.target_teams.length > 0 && Boolean(e.inject_id));
  const priorityRank = (e: SimEmail) =>
    e.priority === 'urgent' || e.priority === 'high' ? 0 : e.priority === 'normal' ? 1 : 2;
  const unanswered = inboundToMe
    .filter((e) => !repliedTo.has(e.id) && !memory.repliedEmails.has(e.id))
    .filter((e) => (e.from_address ?? '').toLowerCase() !== 'system@sim.local')
    .sort((a, b) => {
      const p = priorityRank(a) - priorityRank(b);
      return p !== 0 ? p : new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  const unread = inboundToMe.filter((e) => !e.is_read && !memory.readEmails.has(e.id));
  const intel = inboundToMe.filter(isIntel);

  // DMs: threads whose latest message is not from me (or my page).
  const dms = dmThreads.filter((t) => {
    const last = t.latest_message;
    if (!last) return false;
    const fromMe =
      last.sender_handle === handle || (pageHandle && last.sender_handle === pageHandle);
    if (fromMe) return false;
    if (memory.repliedThreads.has(t.thread_id)) {
      // Answered before; only re-open if the counterpart wrote again since.
      return t.unread_count > 0;
    }
    return true;
  });

  // Chat.
  const teamChannel = channels.find((c) => c.type === 'team' && c.team_name === teamName) ?? null;
  const allTeams = channels.find((c) => c.type === 'inter_agency') ?? null;
  const [teamMsgs, allMsgs] = await Promise.all([
    teamChannel ? api.channelMessages(teamChannel.id, 30) : Promise.resolve([] as ChatMessage[]),
    allTeams ? api.channelMessages(allTeams.id, 15) : Promise.resolve([] as ChatMessage[]),
  ]);
  const recent = [...teamMsgs, ...allMsgs]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-30);
  const firstName = displayName.split(/\s+/)[0]?.toLowerCase() ?? '';
  const mentions = recent.filter((m) => {
    if (m.sender_id === userId || memory.seenChat.has(m.id)) return false;
    const c = (m.content ?? '').toLowerCase();
    return (
      c.includes(displayName.toLowerCase()) ||
      (firstName.length > 2 && new RegExp(`\\b${escapeRe(firstName)}\\b`).test(c)) ||
      (teamName ? c.includes(`@${teamName.toLowerCase()}`) : false) ||
      /\?\s*$/.test(c.trim())
    );
  });
  const nudges = recent.filter(
    (m) =>
      !memory.seenChat.has(m.id) &&
      m.sender_id !== userId &&
      (m.sender?.role === 'trainer' || m.sender?.role === 'admin') &&
      (m.content ?? '').toLowerCase().includes(firstName),
  );

  // Drafts.
  const toReview = drafts.filter(
    (d) => d.status === 'in_review' && d.author_id !== userId && d.team_name === teamName,
  );
  const mine = drafts.filter((d) => d.author_id === userId);
  const approvedUnpublished = mine.filter(
    (d) => d.status === 'approved' && !memory.handled.has(`published:${d.id}`),
  );
  const changesRequested = mine.filter((d) => d.status === 'changes_requested');

  // News (unread by me, tracked in memory).
  const unreadNews = news.filter((n) => !memory.readNews.has(n.id)).slice(0, 10);

  const g = state as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const gauges: Gauges = {
    public_trust: num(g.public_trust),
    community_safety: num(g.community_safety),
    narrative_control: num(g.narrative_control),
    escalation_risk: num(g.escalation_risk),
    sentiment_score: num(g.sentiment_score),
  };

  const publicVoiceTeam =
    charter?.can_post_publicly && teamName
      ? teamName
      : (Array.from(teams.keys()).find((t) => /communication/i.test(t)) ?? null);

  // Intel relay candidates: inject emails I hold whose manifest entry names a staffed team.
  const intelToRelay: Situation['intelToRelay'] = [];
  try {
    const manifest = await getIntelManifest(sessionCtx.scenarioId);
    if (manifest.length > 0) {
      const forwarded = new Set(
        emails
          .filter((e) => e.sent_by_player_id === userId)
          .map((e) => (e as SimEmail & { forwarded_email_id?: string | null }).forwarded_email_id)
          .filter((id): id is string => Boolean(id)),
      );
      for (const email of inboundToMe) {
        if (!email.inject_id || forwarded.has(email.id) || memory.handled.has(`fwd:${email.id}`))
          continue;
        const entry = manifest.find((m) => m.source_inject_id === email.inject_id);
        if (!entry) continue;
        const recipients = entry.needed_by
          .flatMap((t) => teams.get(t) ?? [])
          .filter((m) => !m.isMe);
        if (recipients.length > 0) intelToRelay.push({ email, entry, recipients });
      }
    }
  } catch (err) {
    logger.debug({ err }, 'teammates: intel manifest unavailable');
  }

  if (!memory.seeded) await seedMemory(api, userId, memory, officialStatements, emails);

  // Fold in grades that landed on my posts since the last turn (feedback loop, §9.3).
  for (const p of posts) {
    if (p.user_id !== userId || memory.gradedPostIds.has(p.id)) continue;
    const g = p.sop_compliance_score as { overall?: unknown; improvements?: unknown } | null;
    if (!g || typeof g.overall !== 'number') continue;
    memory.gradedPostIds.add(p.id);
    rememberGrade(memory, {
      overall: g.overall,
      improvements: Array.isArray(g.improvements) ? g.improvements.map(String).slice(0, 4) : [],
      at: new Date(p.created_at).getTime(),
      kind: p.post_format === 'official_statement' ? 'statement' : 'post',
    });
  }

  return {
    now,
    elapsedMinutes,
    me: {
      userId,
      displayName,
      handle,
      address,
      teamName,
      isPageHolder: Boolean(myPage),
      pageHandle,
      pageName: myPage?.display_name ?? null,
    },
    charter,
    facts: sessionCtx.facts,
    feed,
    harmful,
    needsResponse,
    emails: { unanswered, unread, intel, all: emails },
    dms,
    chat: {
      teamChannelId: teamChannel?.id ?? null,
      allTeamsChannelId: allTeams?.id ?? null,
      recent,
      mentions,
      nudges,
    },
    drafts: { toReview, mine, approvedUnpublished, changesRequested },
    news: unreadNews,
    gauges,
    officialStatements,
    lastOfficialStatementAt,
    teammates,
    teams,
    publicVoiceTeam,
    intelToRelay,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rebuild memory from the database after a restart so a bot never re-publishes
 * a statement or re-answers an email it already handled.
 */
async function seedMemory(
  api: BotApi,
  userId: string,
  memory: BotMemory,
  officialStatements: FeedPost[],
  emails: SimEmail[],
): Promise<void> {
  memory.seeded = true;
  try {
    const activity = await api.myActivity();
    for (const p of activity.posts) {
      memory.handled.add(p.id);
      const at = new Date(p.created_at).getTime();
      memory.lastPostAt = Math.max(memory.lastPostAt, at);
      if (p.author_type === 'official_account' && p.post_format === 'official_statement') {
        memory.statements.push({ at, text: p.content });
        memory.lastStatementAt = Math.max(memory.lastStatementAt, at);
      }
    }
    for (const a of activity.actions) if (a.target_id) memory.handled.add(a.target_id);
    for (const s of officialStatements) {
      if (s.posted_by_user_id === userId && !memory.statements.some((x) => x.text === s.content)) {
        const at = new Date(s.created_at).getTime();
        memory.statements.push({ at, text: s.content });
        memory.lastStatementAt = Math.max(memory.lastStatementAt, at);
      }
    }
    memory.statements.sort((a, b) => a.at - b.at);
    for (const st of memory.statements)
      memory.commitments.push(...extractCommitments(st.text, st.at));
    for (const e of emails) {
      if (e.sent_by_player_id === userId && e.replied_to_id)
        memory.repliedEmails.add(e.replied_to_id);
    }
  } catch (err) {
    logger.debug({ err, userId }, 'teammates: memory seed failed (non-critical)');
  }
}
