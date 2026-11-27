/**
 * Attribution, window maths and comms_state aggregation. No database access.
 * WP3 reads `comms_state`; this module does not add condition keys.
 */

export interface JudgementCriterion {
  id?: string;
  met?: boolean;
  evidence?: string | null;
}

export interface JudgementAsk {
  id?: string;
  answered?: boolean;
}

export interface JudgementV1 {
  v?: number;
  addresses_inject?: boolean;
  relevance?: number;
  criteria?: JudgementCriterion[];
  asks_answered?: JudgementAsk[];
  tone?: string;
  tone_confidence?: number;
  passed?: boolean;
  tone_ok?: boolean;
  scores?: Record<string, number>;
  factual_errors?: string[];
  risky_admissions?: string[];
  commitments?: string[];
  summary?: string;
  rubric_source?: 'authored' | 'generic';
  criteria_text?: string[];
}

export interface CommsDelivery {
  delivery_id: string;
  inject_id: string;
  inject_key: string;
  channel: string;
  delivered_minute: number;
  recipient_teams: string[];
  session_wide: boolean;
  stakeholder_id: string | null;
  call_state: string | null;
  call_group_id: string | null;
  attempt_no: number;
  chain_root_delivery_id?: string | null;
  chain_root_key: string | null;
  chain_step: number | null;
  urgency: string | null;
  mood_rung: string | null;
  opened_minute: number | null;
  first_response_minute: number | null;
  first_response_team: string | null;
  /**
   * Earliest response minute per team. An empty string is a sender with no team.
   * `first_response_*` above is the session-wide first.
   */
  first_response_by_team: Record<string, number>;
  responses: Array<{
    minute: number;
    team: string | null;
    user_id: string | null;
    is_bot: boolean;
    attribution: string;
    judgement_status: string;
    judgement: JudgementV1 | null;
    meta?: Record<string, unknown>;
  }>;
}

export interface StakeholderContactSummary {
  first_minute: number;
  channels: string[];
}

export interface ActionCountBucket {
  action_type: string;
  /** Slug of team_at_action. Null when the action had no team. */
  team_slug: string | null;
  count: number;
  first_minute: number;
}

export interface CommsState {
  by_key: Record<string, CommsDelivery[]>;
  generated_at_minute: number;
  truncated: boolean;
  /**
   * False when `sim_calls` does not exist. Unset means the caller handed in
   * deliveries directly (tests) and call keys may be evaluated.
   */
  calls_available?: boolean;
  stakeholder_contacts?: Record<string, StakeholderContactSummary>;
  /** Latest reconsideration verdict per stakeholder. */
  stakeholder_verdicts?: Record<string, string>;
  /** First session minute an email_sent reached this stakeholder. */
  email_sent_minutes?: Record<string, number>;
  action_counts?: ActionCountBucket[];
  /**
   * False when the action, email, or contact read failed or the table is missing.
   * Unset means the read succeeded, or the caller supplied the facts directly.
   */
  action_facts_known?: boolean;
  email_facts_known?: boolean;
  contact_facts_known?: boolean;
  /** True when a read hit its cap, so absence cannot be proved. */
  action_counts_truncated?: boolean;
  email_facts_truncated?: boolean;
  contact_facts_truncated?: boolean;
}

export const COMMS_DELIVERY_CAP = 2000;
export const COMMS_RESPONSE_CAP = 5000;

export interface ChatAttributionMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  reply_to: string | null;
  created_at: string;
  sender_team: string | null;
  is_trainer: boolean;
}

export interface OpenChatDelivery {
  id: string;
  ref_id: string;
  chat_channel_id: string;
  delivered_at: string;
  delivered_minute: number;
  recipient_teams: string[];
  recipient_user_ids: string[] | null;
  response_window_minutes: number | null;
  first_response_at: string | null;
  /** Teams, or `user:<id>` when the sender had no team, that already responded. */
  responded_teams?: readonly string[] | null;
}

export type ChatAttribution = 'chat_reply_to' | 'chat_heuristic';

export const REPLY_TO_MUST_BE_IN_CHANNEL = 'reply_to must be a message in this channel';

/**
 * A reply is accepted only when the referenced message exists in this channel.
 * A missing row and a row in another channel are the same rejection: the foreign
 * key would otherwise accept any chat_messages id.
 */
export function replyToChannelDecision(
  referenced: { channel_id: string } | null,
  channelId: string,
): { ok: true } | { ok: false; error: typeof REPLY_TO_MUST_BE_IN_CHANNEL } {
  if (referenced?.channel_id === channelId) return { ok: true };
  return { ok: false, error: REPLY_TO_MUST_BE_IN_CHANNEL };
}

/** Trainers and admins are not players, matching chat_message_sent recording. */
export function actorRoleSkipsResponse(role: string | null | undefined): boolean {
  return role === 'trainer' || role === 'admin';
}

/** Team name, or `user:<id>` when the player is not on a team. */
export function responseTeamKey(
  teamName: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  if (teamName) return teamName;
  if (userId) return `user:${userId}`;
  return null;
}

export function sessionMinuteAt(startTime: string | null | undefined, atIso: string): number {
  if (!startTime) return 0;
  const start = Date.parse(startTime);
  const at = Date.parse(atIso);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((at - start) / 60000));
}

export function emptyCommsState(elapsedMinutes: number): CommsState {
  return { by_key: {}, generated_at_minute: elapsedMinutes, truncated: false };
}

function isRecipient(
  users: string[] | null | undefined,
  teams: readonly string[] | undefined,
  senderId: string,
  senderTeam: string | null,
): boolean {
  const teamList = teams ?? [];
  const userList = users ?? [];
  if (userList.length === 0 && teamList.length === 0) return true;
  if (users?.includes(senderId)) return true;
  if (senderTeam && teamList.includes(senderTeam)) return true;
  return false;
}

function teamAlreadyResponded(
  responded: readonly string[] | null | undefined,
  senderTeam: string | null,
  senderId: string,
): boolean {
  const key = responseTeamKey(senderTeam, senderId);
  if (!key || !responded || responded.length === 0) return false;
  return responded.includes(key);
}

function inDeliveryWindow(
  deliveredMinute: number,
  messageMinute: number,
  responseWindowMinutes: number | null,
  defaultWindowMinutes: number | null,
): boolean {
  if (messageMinute < deliveredMinute) return false;
  const window = responseWindowMinutes ?? defaultWindowMinutes;
  if (window == null) return true;
  return messageMinute - deliveredMinute <= window;
}

function deliveredBefore(deliveredAt: string, createdAt: string): boolean {
  const delivered = Date.parse(deliveredAt);
  const created = Date.parse(createdAt);
  if (!Number.isFinite(delivered) || !Number.isFinite(created)) return false;
  return delivered < created;
}

function byRecency<T extends { delivered_at: string; delivered_minute: number; id: string }>(
  a: T,
  b: T,
): number {
  const ta = Date.parse(a.delivered_at);
  const tb = Date.parse(b.delivered_at);
  const aTime = Number.isFinite(ta) ? ta : a.delivered_minute;
  const bTime = Number.isFinite(tb) ? tb : b.delivered_minute;
  if (aTime !== bTime) return bTime - aTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Which open chat delivery a player message answers.
 * An explicit reply wins. Otherwise the most recent in-window delivery this sender
 * may answer. A later message from a team that already answered is still recorded
 * against that delivery; `first_response_*` is updated only while it is null.
 */
export function attributeChatResponse(args: {
  message: ChatAttributionMessage;
  openDeliveries: OpenChatDelivery[];
  messageMinute: number;
  defaultWindowMinutes: number;
}): Array<{ deliveryId: string; attribution: ChatAttribution }> {
  const { message, openDeliveries, messageMinute, defaultWindowMinutes } = args;
  if (message.is_trainer) return [];

  if (message.reply_to) {
    const explicit = openDeliveries.find(
      (delivery) =>
        delivery.ref_id === message.reply_to && delivery.chat_channel_id === message.channel_id,
    );
    if (explicit) return [{ deliveryId: explicit.id, attribution: 'chat_reply_to' }];
  }

  const candidates = openDeliveries.filter(
    (delivery) =>
      delivery.chat_channel_id === message.channel_id &&
      deliveredBefore(delivery.delivered_at, message.created_at) &&
      inDeliveryWindow(
        delivery.delivered_minute,
        messageMinute,
        delivery.response_window_minutes,
        defaultWindowMinutes,
      ) &&
      isRecipient(
        delivery.recipient_user_ids,
        delivery.recipient_teams,
        message.sender_id,
        message.sender_team,
      ),
  );
  if (candidates.length === 0) return [];

  const unanswered = candidates.filter(
    (delivery) =>
      !teamAlreadyResponded(delivery.responded_teams, message.sender_team, message.sender_id),
  );
  const pool = (unanswered.length > 0 ? unanswered : candidates).slice().sort(byRecency);
  const chosen = pool[0];
  if (!chosen) return [];
  return [{ deliveryId: chosen.id, attribution: 'chat_heuristic' }];
}

export interface DmDelivery {
  id: string;
  delivered_at: string;
  delivered_minute: number;
  response_window_minutes: number | null;
  recipient_teams: string[];
  recipient_user_ids: string[] | null;
  responded_teams?: readonly string[] | null;
  chat_channel_id?: string | null;
  thread_id?: string | null;
}

/**
 * NPC-DM and Messenger: the first player message after a delivery in that channel
 * or thread. One message can be the first response to every still-unanswered
 * delivery that precedes it. Later messages are not attributed again.
 */
export function attributeDmResponses(args: {
  message: {
    id: string;
    sender_id: string;
    created_at: string;
    sender_team: string | null;
    is_trainer: boolean;
  };
  deliveries: DmDelivery[];
  messageMinute: number;
  chatChannelId?: string | null;
  threadId?: string | null;
}): Array<{ deliveryId: string; attribution: 'dm_thread' }> {
  const { message, deliveries, messageMinute } = args;
  if (message.is_trainer) return [];
  const matched: Array<{ deliveryId: string; attribution: 'dm_thread' }> = [];
  for (const delivery of deliveries) {
    if (args.threadId && delivery.thread_id !== args.threadId) continue;
    if (args.chatChannelId && delivery.chat_channel_id !== args.chatChannelId) continue;
    if (!deliveredBefore(delivery.delivered_at, message.created_at)) continue;
    if (
      !inDeliveryWindow(
        delivery.delivered_minute,
        messageMinute,
        delivery.response_window_minutes,
        null,
      )
    ) {
      continue;
    }
    if (
      !isRecipient(
        delivery.recipient_user_ids,
        delivery.recipient_teams,
        message.sender_id,
        message.sender_team,
      )
    ) {
      continue;
    }
    if (teamAlreadyResponded(delivery.responded_teams, message.sender_team, message.sender_id)) {
      continue;
    }
    matched.push({ deliveryId: delivery.id, attribution: 'dm_thread' });
  }
  return matched;
}

export interface EmailLink {
  id: string;
  thread_id: string | null;
  replied_to_id: string | null;
}

/** Walk `thread_id`, then `replied_to_id`, to the thread root. Cycles stop at the start. */
export function resolveEmailRootId(emails: readonly EmailLink[], startId: string): string {
  const byId = new Map(emails.map((email) => [email.id, email]));
  const seen = new Set<string>();
  let current = startId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const row = byId.get(current);
    if (!row) return current;
    if (row.thread_id && row.thread_id !== current) {
      current = row.thread_id;
      continue;
    }
    if (row.replied_to_id && row.replied_to_id !== current) {
      current = row.replied_to_id;
      continue;
    }
    return current;
  }
  return current || startId;
}

export function matchEmailDelivery(
  deliveries: readonly { id: string; thread_id: string | null; ref_id: string }[],
  resolvedThreadId: string,
  repliedToId: string,
): string | null {
  const byThread = deliveries.find(
    (delivery) => delivery.thread_id != null && delivery.thread_id === resolvedThreadId,
  );
  if (byThread) return byThread.id;
  const byRef = deliveries.find(
    (delivery) => delivery.ref_id === repliedToId || delivery.ref_id === resolvedThreadId,
  );
  return byRef?.id ?? null;
}

export interface LedgerDeliveryRow {
  id: string;
  inject_id: string;
  inject_key: string;
  channel: string;
  delivered_minute: number;
  delivered_at?: string | null;
  recipient_teams?: string[] | null;
  recipient_user_ids?: string[] | null;
  stakeholder_id?: string | null;
  call_state?: string | null;
  call_group_id?: string | null;
  attempt_no?: number | null;
  chain_root_delivery_id?: string | null;
  chain_root_key?: string | null;
  chain_step?: number | null;
  urgency?: string | null;
  mood_rung?: string | null;
  first_opened_at?: string | null;
  first_response_minute?: number | null;
  first_response_team?: string | null;
}

export interface LedgerResponseRow {
  delivery_id: string;
  response_minute: number;
  team_name?: string | null;
  user_id?: string | null;
  is_bot?: boolean | null;
  attribution: string;
  judgement_status?: string | null;
  judgement?: unknown;
  responded_at?: string | null;
  meta?: unknown;
}

function asJudgement(value: unknown): JudgementV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JudgementV1;
}

function responseMeta(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function newestFirst<T extends { at?: string | null; minute: number; id: string }>(
  a: T,
  b: T,
): number {
  const ta = a.at ? Date.parse(a.at) : NaN;
  const tb = b.at ? Date.parse(b.at) : NaN;
  const aTime = Number.isFinite(ta) ? ta : a.minute;
  const bTime = Number.isFinite(tb) ? tb : b.minute;
  if (aTime !== bTime) return bTime - aTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function openedMinute(
  row: LedgerDeliveryRow,
  sessionStartedAt: string | null | undefined,
): number | null {
  if (!row.first_opened_at) return null;
  if (sessionStartedAt) return sessionMinuteAt(sessionStartedAt, row.first_opened_at);
  if (!row.delivered_at) return null;
  const delta = Date.parse(row.first_opened_at) - Date.parse(row.delivered_at);
  if (!Number.isFinite(delta)) return null;
  return row.delivered_minute + Math.floor(delta / 60000);
}

export function buildCommsState(args: {
  deliveries: readonly LedgerDeliveryRow[];
  responses: readonly LedgerResponseRow[];
  elapsedMinutes: number;
  sessionStartedAt?: string | null;
  countBots?: boolean;
  deliveryCap?: number;
  responseCap?: number;
}): CommsState {
  const deliveryCap = args.deliveryCap ?? COMMS_DELIVERY_CAP;
  const responseCap = args.responseCap ?? COMMS_RESPONSE_CAP;
  const countBots = args.countBots !== false;
  let truncated = false;

  const deliveries = args.deliveries
    .map((row) => ({ row, at: row.delivered_at, minute: row.delivered_minute, id: row.id }))
    .sort(newestFirst);
  const keptDeliveries =
    deliveries.length > deliveryCap ? deliveries.slice(0, deliveryCap) : deliveries;
  if (deliveries.length > deliveryCap) truncated = true;
  const deliveryIds = new Set(keptDeliveries.map((item) => item.row.id));

  const rankedResponses = args.responses
    .map((row, index) => ({
      row,
      at: row.responded_at,
      minute: row.response_minute,
      id: `${row.delivery_id}:${index}`,
    }))
    .sort(newestFirst);
  const cappedResponses =
    rankedResponses.length > responseCap ? rankedResponses.slice(0, responseCap) : rankedResponses;
  if (rankedResponses.length > responseCap) truncated = true;
  const keptResponses = cappedResponses.filter((item) => countBots || item.row.is_bot !== true);

  const byDelivery = new Map<string, LedgerResponseRow[]>();
  for (const item of keptResponses) {
    if (!deliveryIds.has(item.row.delivery_id)) continue;
    const list = byDelivery.get(item.row.delivery_id) ?? [];
    list.push(item.row);
    byDelivery.set(item.row.delivery_id, list);
  }

  const built: CommsDelivery[] = keptDeliveries.map(({ row }) => {
    const responsesForDelivery = (byDelivery.get(row.id) ?? [])
      .slice()
      .sort((a, b) => a.response_minute - b.response_minute);
    const firstResponseByTeam: Record<string, number> = {};
    let firstMinute: number | null = null;
    let firstTeam: string | null = null;
    for (const response of responsesForDelivery) {
      const teamKey = response.team_name ?? '';
      const previous = firstResponseByTeam[teamKey];
      if (previous == null || response.response_minute < previous) {
        firstResponseByTeam[teamKey] = response.response_minute;
      }
      if (firstMinute == null || response.response_minute < firstMinute) {
        firstMinute = response.response_minute;
        firstTeam = response.team_name ?? null;
      }
    }
    if (
      countBots &&
      truncated &&
      row.first_response_minute != null &&
      (firstMinute == null || row.first_response_minute < firstMinute)
    ) {
      firstMinute = row.first_response_minute;
      firstTeam = row.first_response_team ?? null;
    }
    const users = row.recipient_user_ids;
    const teams = row.recipient_teams ?? [];
    return {
      delivery_id: row.id,
      inject_id: row.inject_id,
      inject_key: row.inject_key,
      channel: row.channel,
      delivered_minute: row.delivered_minute,
      recipient_teams: teams,
      session_wide: (users == null || users.length === 0) && teams.length === 0,
      stakeholder_id: row.stakeholder_id ?? null,
      call_state: row.call_state ?? null,
      call_group_id: row.call_group_id ?? null,
      attempt_no: row.attempt_no ?? 1,
      chain_root_delivery_id: row.chain_root_delivery_id ?? null,
      chain_root_key: row.chain_root_key ?? null,
      chain_step: row.chain_step ?? null,
      urgency: row.urgency ?? null,
      mood_rung: row.mood_rung ?? null,
      opened_minute: openedMinute(row, args.sessionStartedAt),
      first_response_minute: firstMinute,
      first_response_team: firstTeam,
      first_response_by_team: firstResponseByTeam,
      responses: responsesForDelivery.map((response) => {
        const meta = responseMeta(response.meta);
        return {
          minute: response.response_minute,
          team: response.team_name ?? null,
          user_id: response.user_id ?? null,
          is_bot: response.is_bot === true,
          attribution: response.attribution,
          judgement_status: response.judgement_status ?? 'pending',
          judgement: asJudgement(response.judgement),
          ...(meta ? { meta } : {}),
        };
      }),
    };
  });

  const by_key: Record<string, CommsDelivery[]> = {};
  for (const delivery of built) {
    (by_key[delivery.inject_key] ??= []).push(delivery);
    if (delivery.chain_root_key && delivery.chain_root_key !== delivery.inject_key) {
      (by_key[delivery.chain_root_key] ??= []).push(delivery);
    }
  }
  for (const list of Object.values(by_key)) {
    list.sort(
      (a, b) =>
        a.delivered_minute - b.delivered_minute || a.delivery_id.localeCompare(b.delivery_id),
    );
  }

  return { by_key, generated_at_minute: args.elapsedMinutes, truncated };
}
