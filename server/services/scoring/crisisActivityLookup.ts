/**
 * Loads the rows charter detection and SOP timing need in order to apply
 * `isCrisisActivity`. With both feature flags off, nothing here is called.
 */

import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import {
  isPeaceSchemaMissing,
  markPeaceColumnsMissing,
  peaceColumnsMissing,
} from '../../lib/peaceSchema.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import {
  isNamedTopicColumnMissing,
  noteTopicSchemaMissing,
  topicSchemaMissing,
} from '../topic/topicColumns.js';
import {
  buildContentIndex,
  contentRefsFromChannels,
  contentRefsFromPosts,
  inPeaceWindow,
  type ContentIndex,
  type PeaceSourceRow,
  type PlayerTopicSource,
  type ScoringFlags,
} from './crisisActivityCore.js';

/** One page of a flag-on read. PostgREST's default cap is 1000. */
export const CRISIS_READ_PAGE = 1000;
/** Five pages, then stop. Unbounded session reads fail open past the default cap. */
export const CRISIS_READ_MAX_ROWS = 5000;

export function scoringFlagsFromEnv(): ScoringFlags {
  return {
    peace: env.enablePeacePeriod,
    topic: env.enableTopicAwareReplies,
    attribution: env.teamScorePostAttributionFix,
  };
}

interface QueryError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

interface QueryResult {
  data: unknown;
  error: QueryError | null;
}

function asRecords(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Drops peace or topic columns the database rejected, and warns once through
 * the existing migration markers. Returns null when the error is something else.
 */
export function dropUnavailableColumns(columns: string, error: unknown): string | null {
  const list = columns
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
  let next = list;
  if (isPeaceSchemaMissing(error)) {
    next = next.filter(
      (column) => column !== 'peace_ref' && column !== 'opened_at' && column !== 'peace_seconds',
    );
    markPeaceColumnsMissing();
  } else if (isNamedTopicColumnMissing(error)) {
    next = next.filter((column) => !column.startsWith('topic_'));
    noteTopicSchemaMissing();
  } else {
    return null;
  }
  if (next.length === list.length) return null;
  return next.join(', ');
}

export async function selectTolerant(
  run: (columns: string) => PromiseLike<QueryResult>,
  columns: string,
): Promise<Record<string, unknown>[]> {
  let current = columns;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await run(current);
    if (!result.error) return asRecords(result.data);
    const narrower = dropUnavailableColumns(current, result.error);
    if (!narrower) {
      logger.warn(
        { err: result.error, event: 'crisis_activity_read_failed' },
        'Crisis-activity read failed',
      );
      return [];
    }
    current = narrower;
  }
  return [];
}

interface SessionQuery extends PromiseLike<QueryResult> {
  eq(column: string, value: string): SessionQuery;
  in(column: string, values: readonly string[]): SessionQuery;
  not(column: string, operator: string, value: null): SessionQuery;
  gte(column: string, value: string): SessionQuery;
  lt(column: string, value: string): SessionQuery;
  order(column: string, options: { ascending: boolean }): SessionQuery;
  range(from: number, to: number): SessionQuery;
}

function sessionQuery(table: string, columns: string, sessionId: string): SessionQuery {
  return supabaseAdmin
    .from(table)
    .select(columns)
    .eq('session_id', sessionId) as unknown as SessionQuery;
}

function withoutKnownMissing(columns: string): string {
  let list = columns
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
  if (peaceColumnsMissing()) {
    list = list.filter(
      (column) => column !== 'peace_ref' && column !== 'opened_at' && column !== 'peace_seconds',
    );
  }
  if (topicSchemaMissing()) list = list.filter((column) => !column.startsWith('topic_'));
  return list.join(', ');
}

/** Ordered pages. `bound` is a created_at window, applied before the page. */
async function readSessionPages(
  table: string,
  columns: string,
  sessionId: string,
  bound?: { gte?: string | null; lt?: string | null },
  restrict?: (query: SessionQuery) => SessionQuery,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cols = withoutKnownMissing(columns);
  for (let from = 0; from < CRISIS_READ_MAX_ROWS; from += CRISIS_READ_PAGE) {
    const page = await selectTolerant((active) => {
      let query = sessionQuery(table, active, sessionId);
      if (restrict) query = restrict(query);
      if (bound?.gte) query = query.gte('created_at', bound.gte);
      if (bound?.lt) query = query.lt('created_at', bound.lt);
      return query
        .order('created_at', { ascending: true })
        .range(from, from + CRISIS_READ_PAGE - 1);
    }, cols);
    rows.push(...page);
    cols = withoutKnownMissing(cols);
    if (page.length < CRISIS_READ_PAGE) break;
  }
  return rows;
}

export async function loadContentIndex(sessionId: string): Promise<ContentIndex> {
  const [posts, emails, messages] = await Promise.all([
    readSessionPages(
      'social_posts',
      'id, user_id, reply_to_post_id, created_at, topic_class, topic_kind',
      sessionId,
    ),
    readSessionPages('sim_emails', 'id, sent_by_player_id, created_at, topic_class', sessionId),
    readSessionPages('sim_direct_messages', 'id, created_at, topic_class', sessionId),
  ]);
  return buildContentIndex([
    ...contentRefsFromPosts(
      posts.map((row) => ({
        id: String(row.id ?? ''),
        user_id: text(row.user_id),
        reply_to_post_id: text(row.reply_to_post_id),
        created_at: text(row.created_at) ?? '',
        topic_class: row.topic_class,
        topic_kind: row.topic_kind,
      })),
    ),
    ...contentRefsFromChannels(
      'email',
      emails.map((row) => ({
        id: String(row.id ?? ''),
        created_at: text(row.created_at) ?? '',
        topic_class: row.topic_class,
        player_id: text(row.sent_by_player_id),
      })),
    ),
    ...contentRefsFromChannels(
      'dm',
      messages.map((row) => ({
        id: String(row.id ?? ''),
        created_at: text(row.created_at) ?? '',
        topic_class: row.topic_class,
      })),
    ),
  ]);
}

const SKIP_PEACE_ACTIONS = new Set([
  'dm_sent',
  'post_created',
  'reply_posted',
  'email_sent',
  'content_graded',
]);

export async function loadPeaceActivityRows(
  sessionId: string,
  clock: { openedAt: string | null; crisisStart: string | null },
): Promise<PeaceSourceRow[]> {
  const window =
    clock.openedAt && clock.crisisStart ? { gte: clock.openedAt, lt: clock.crisisStart } : null;
  if (!window) return [];
  const [posts, emails, messages, actions] = await Promise.all([
    readSessionPages(
      'social_posts',
      'id, user_id, author_display_name, author_type, content, reply_to_post_id, created_at, peace_ref, topic_class',
      sessionId,
      window,
    ),
    readSessionPages(
      'sim_emails',
      'id, sent_by_player_id, from_name, subject, body_text, created_at, topic_class',
      sessionId,
      window,
      (query) => query.not('sent_by_player_id', 'is', null),
    ),
    readSessionPages(
      'sim_direct_messages',
      'id, sender_type, sender_display_name, content, created_at, topic_class',
      sessionId,
      window,
      (query) => query.eq('sender_type', 'player'),
    ),
    readSessionPages(
      'player_actions',
      'id, player_id, action_type, content, created_at',
      sessionId,
      window,
    ),
  ]);

  const rows: PeaceSourceRow[] = [];
  for (const post of posts) {
    const at = text(post.created_at);
    if (!at) continue;
    rows.push({
      at,
      kind: post.reply_to_post_id ? 'comment' : 'post',
      author: text(post.author_display_name) ?? 'Unknown',
      content: text(post.content) ?? '',
      topic_class: text(post.topic_class),
      peaceRef: text(post.peace_ref),
    });
  }
  for (const email of emails) {
    if (!text(email.sent_by_player_id)) continue;
    const at = text(email.created_at);
    if (!at) continue;
    const subject = text(email.subject);
    rows.push({
      at,
      kind: 'email',
      author: text(email.from_name) ?? 'Unknown',
      content: subject
        ? `${subject}\n${text(email.body_text) ?? ''}`
        : (text(email.body_text) ?? ''),
      topic_class: text(email.topic_class),
    });
  }
  for (const message of messages) {
    if (message.sender_type !== 'player') continue;
    const at = text(message.created_at);
    if (!at) continue;
    rows.push({
      at,
      kind: 'dm',
      author: text(message.sender_display_name) ?? 'Unknown',
      content: text(message.content) ?? '',
      topic_class: text(message.topic_class),
    });
  }

  const peaceActions = actions.filter((action) => {
    const at = text(action.created_at);
    return !!at && inPeaceWindow(at, clock.openedAt, clock.crisisStart, null);
  });
  const actionIds = peaceActions
    .map((action) => text(action.player_id))
    .filter((id): id is string => !!id);
  const names = new Map<string, string>();
  if (actionIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('user_profiles')
      .select('id, full_name')
      .in('id', Array.from(new Set(actionIds)));
    for (const profile of data || []) {
      names.set(String(profile.id), String(profile.full_name || 'Unknown'));
    }
  }
  for (const action of peaceActions) {
    const type = text(action.action_type);
    const at = text(action.created_at);
    const playerId = text(action.player_id);
    if (!type || !at || !playerId || SKIP_PEACE_ACTIONS.has(type)) continue;
    rows.push({
      at,
      kind: 'action',
      author: names.get(playerId) ?? 'Unknown',
      content: text(action.content) || type.replace(/_/g, ' '),
    });
  }
  return rows;
}

export async function loadPlayerTopicSources(sessionId: string): Promise<PlayerTopicSource[]> {
  const [posts, emails, messages] = await Promise.all([
    readSessionPages(
      'social_posts',
      'id, author_display_name, content, reply_to_post_id, created_at, topic_class, author_type',
      sessionId,
      undefined,
      (query) => query.in('author_type', ['player', 'official_account']),
    ),
    readSessionPages(
      'sim_emails',
      'id, sent_by_player_id, from_name, subject, body_text, created_at, topic_class',
      sessionId,
      undefined,
      (query) => query.not('sent_by_player_id', 'is', null),
    ),
    readSessionPages(
      'sim_direct_messages',
      'id, sender_type, sender_display_name, content, created_at, topic_class',
      sessionId,
      undefined,
      (query) => query.eq('sender_type', 'player'),
    ),
  ]);
  const sources: PlayerTopicSource[] = [];
  for (const post of posts) {
    if (!post.reply_to_post_id) continue;
    if (post.author_type !== 'player' && post.author_type !== 'official_account') continue;
    const at = text(post.created_at);
    if (!at) continue;
    sources.push({
      kind: 'comment',
      at,
      who: text(post.author_display_name) ?? 'Unknown',
      content: text(post.content) ?? '',
      topic_class: text(post.topic_class),
    });
  }
  for (const email of emails) {
    if (!text(email.sent_by_player_id)) continue;
    const at = text(email.created_at);
    if (!at) continue;
    const subject = text(email.subject);
    sources.push({
      kind: 'email',
      at,
      who: text(email.from_name) ?? 'Unknown',
      content: subject
        ? `${subject} ${text(email.body_text) ?? ''}`
        : (text(email.body_text) ?? ''),
      topic_class: text(email.topic_class),
    });
  }
  for (const message of messages) {
    if (message.sender_type !== 'player') continue;
    const at = text(message.created_at);
    if (!at) continue;
    sources.push({
      kind: 'dm',
      at,
      who: text(message.sender_display_name) ?? 'Unknown',
      content: text(message.content) ?? '',
      topic_class: text(message.topic_class),
    });
  }
  return sources;
}
