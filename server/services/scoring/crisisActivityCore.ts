/**
 * Crisis-activity rules for scores and the after-action report.
 * No database access. The truth table is `isCrisisActivity`.
 */

import { isOnOrAfterCrisis } from '../../lib/sessionPhase.js';
import { isCrisisActivity, type PostKind, type TopicLabel } from '../topic/topicPromptCore.js';

export interface ScoringFlags {
  peace: boolean;
  topic: boolean;
  attribution: boolean;
}

/** Filters run when either feature that produces peace rows or topic labels is on. */
export function crisisFiltersActive(flags: Pick<ScoringFlags, 'peace' | 'topic'>): boolean {
  return flags.peace || flags.topic;
}

export const MASTER_POST_GRADE_SELECT = 'id, posted_by_user_id, sop_compliance_score';
export const MASTER_EMAIL_GRADE_SELECT = 'id, sent_by_player_id, sop_compliance_score';

/** Master's peace-on grade selects (created_at, no topic columns). */
export const PEACE_POST_GRADE_SELECT = `${MASTER_POST_GRADE_SELECT}, created_at`;
export const PEACE_EMAIL_GRADE_SELECT = `${MASTER_EMAIL_GRADE_SELECT}, created_at`;

export interface PostGradePlan {
  select: string;
  authorTypes: readonly ['player'] | readonly ['player', 'official_account'];
}

/**
 * Column list and author filter for team-score post grades.
 * All flags off returns the master select and `author_type = player`.
 */
export function postGradePlan(flags: ScoringFlags): PostGradePlan {
  if (!flags.peace && !flags.topic && !flags.attribution) {
    return { select: MASTER_POST_GRADE_SELECT, authorTypes: ['player'] };
  }
  const columns = ['id'];
  if (flags.attribution) columns.push('user_id', 'author_type');
  columns.push('posted_by_user_id', 'sop_compliance_score');
  if (crisisFiltersActive(flags)) columns.push('created_at');
  return {
    select: columns.join(', '),
    authorTypes: flags.attribution ? ['player', 'official_account'] : ['player'],
  };
}

export function emailGradeSelect(flags: Pick<ScoringFlags, 'peace' | 'topic'>): string {
  if (!crisisFiltersActive(flags)) return MASTER_EMAIL_GRADE_SELECT;
  return PEACE_EMAIL_GRADE_SELECT;
}

const TOPIC_LABELS = new Set<TopicLabel>([
  'on_topic',
  'bridge',
  'off_topic',
  'crisis',
  'unclassified',
]);

export function coerceTopicLabel(value: unknown): TopicLabel {
  return typeof value === 'string' && TOPIC_LABELS.has(value as TopicLabel)
    ? (value as TopicLabel)
    : 'unclassified';
}

/** Missing kind is crisis. DMs and emails have no kind and use this default. */
export function coercePostKind(value: unknown): PostKind {
  return value === 'normal' ? 'normal' : 'crisis';
}

export function rowCountsAsCrisisActivity(input: {
  filtersActive: boolean;
  createdAt?: string | null;
  startTime?: string | null;
  label?: unknown;
  postKind?: unknown;
}): boolean {
  if (!input.filtersActive) return true;
  const phase = isOnOrAfterCrisis(input.createdAt, input.startTime) ? 'crisis' : 'peace';
  return isCrisisActivity({
    phase,
    label: coerceTopicLabel(input.label),
    postKind: coercePostKind(input.postKind),
  });
}

export interface GradeAuthor {
  author_type?: string | null;
  user_id?: string | null;
  posted_by_user_id?: string | null;
}

function idOf(value: string | null | undefined): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Who a graded post belongs to.
 * With the fix off, only `posted_by_user_id` counts (today's team-score query).
 * With the fix on, a player post uses `user_id` and a page post uses `posted_by_user_id`.
 */
export function attributedPlayerId(row: GradeAuthor, attributionFix: boolean): string | null {
  if (!attributionFix) return idOf(row.posted_by_user_id);
  if (row.author_type === 'official_account') return idOf(row.posted_by_user_id);
  if (row.author_type === 'player') return idOf(row.user_id);
  return null;
}

export interface ContentRef {
  table: 'post' | 'email' | 'dm';
  id: string;
  playerId: string | null;
  parentId: string | null;
  createdAt: string;
  label: unknown;
  postKind: unknown;
}

export interface ContentIndex {
  byKey: Map<string, ContentRef>;
  replies: ContentRef[];
}

export function contentKey(table: ContentRef['table'], id: string): string {
  return `${table}:${id}`;
}

export function buildContentIndex(rows: readonly ContentRef[]): ContentIndex {
  const byKey = new Map<string, ContentRef>();
  const replies: ContentRef[] = [];
  for (const row of rows) {
    byKey.set(contentKey(row.table, row.id), row);
    if (row.table === 'post' && row.parentId) replies.push(row);
  }
  return { byKey, replies };
}

export const EMPTY_CONTENT_INDEX: ContentIndex = buildContentIndex([]);

/** A recorded action and the row it created are written in the same request. */
export const ACTION_CONTENT_MATCH_MS = 120_000;

export interface ActionRef {
  action_type: string;
  player_id: string;
  target_id: string | null;
  created_at: string;
}

const POST_TARGET_ACTIONS = new Set([
  'post_created',
  'post_liked',
  'post_flagged',
  'post_reposted',
]);
const EMAIL_TARGET_ACTIONS = new Set(['email_sent', 'email_read']);
const DM_TARGET_ACTIONS = new Set(['dm_sent', 'dm_read']);

export function resolveActionContent(action: ActionRef, index: ContentIndex): ContentRef | null {
  if (POST_TARGET_ACTIONS.has(action.action_type) && action.target_id) {
    return index.byKey.get(contentKey('post', action.target_id)) ?? null;
  }
  if (EMAIL_TARGET_ACTIONS.has(action.action_type) && action.target_id) {
    return index.byKey.get(contentKey('email', action.target_id)) ?? null;
  }
  if (DM_TARGET_ACTIONS.has(action.action_type) && action.target_id) {
    return index.byKey.get(contentKey('dm', action.target_id)) ?? null;
  }
  if (action.action_type !== 'reply_posted' || !action.target_id) return null;
  const at = Date.parse(action.created_at);
  let best: { row: ContentRef; delta: number } | null = null;
  for (const row of index.replies) {
    if (row.parentId !== action.target_id || row.playerId !== action.player_id) continue;
    const delta = Math.abs(Date.parse(row.createdAt) - at);
    if (!Number.isFinite(delta) || delta > ACTION_CONTENT_MATCH_MS) continue;
    if (!best || delta < best.delta) best = { row, delta };
  }
  return best?.row ?? null;
}

/** Charter and SOP share this. Unresolved actions keep today's unclassified treatment. */
export function actionCountsAsCrisisActivity(
  action: ActionRef,
  index: ContentIndex,
  startTime: string | null,
  filtersActive: boolean,
): boolean {
  if (!filtersActive) return true;
  const content = resolveActionContent(action, index);
  return rowCountsAsCrisisActivity({
    filtersActive: true,
    createdAt: action.created_at,
    startTime,
    label: content?.label,
    postKind: content?.postKind,
  });
}

export interface RawPost {
  id: string;
  user_id?: string | null;
  reply_to_post_id?: string | null;
  created_at: string;
  topic_class?: unknown;
  topic_kind?: unknown;
}

/** A reply takes the parent post's kind. The reply's own kind is the fallback. */
export function contentRefsFromPosts(posts: readonly RawPost[]): ContentRef[] {
  const kindById = new Map(posts.map((post) => [post.id, post.topic_kind]));
  return posts.map((post) => ({
    table: 'post',
    id: post.id,
    playerId: idOf(post.user_id),
    parentId: idOf(post.reply_to_post_id),
    createdAt: post.created_at,
    label: post.topic_class,
    postKind: post.reply_to_post_id
      ? (kindById.get(post.reply_to_post_id) ?? post.topic_kind)
      : post.topic_kind,
  }));
}

export function contentRefsFromChannels(
  table: 'email' | 'dm',
  rows: readonly {
    id: string;
    created_at: string;
    topic_class?: unknown;
    player_id?: string | null;
  }[],
): ContentRef[] {
  return rows.map((row) => ({
    table,
    id: row.id,
    playerId: idOf(row.player_id),
    parentId: null,
    createdAt: row.created_at,
    label: row.topic_class,
    postKind: 'crisis',
  }));
}

export function crisisEventMinute(
  iso: string | null | undefined,
  startMs: number | null,
  options: { peace: boolean; round: 'floor' | 'round' },
): number | null {
  if (typeof iso !== 'string' || startMs == null) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  if (options.peace && at < startMs) return null;
  const raw = (at - startMs) / 60000;
  const value = options.round === 'round' ? Math.round(raw) : Math.floor(raw);
  return Math.max(0, value);
}

export function openedMinute(
  iso: string | null | undefined,
  openedMs: number | null,
): number | null {
  if (typeof iso !== 'string' || openedMs == null) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((at - openedMs) / 60000));
}

export function onCrisisTimeline(
  iso: string | null | undefined,
  startMs: number | null,
  peace: boolean,
): boolean {
  if (!peace || startMs == null || typeof iso !== 'string') return true;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return true;
  return at >= startMs;
}

/** Peace feed rows, plus player activity from room open until crisis start. */
export function inPeaceWindow(
  at: string,
  openedAt: string | null,
  crisisStart: string | null,
  peaceRef?: string | null,
): boolean {
  if (peaceRef) return true;
  if (!openedAt || !crisisStart) return false;
  const time = Date.parse(at);
  const open = Date.parse(openedAt);
  const start = Date.parse(crisisStart);
  if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(start)) return false;
  return time >= open && time < start;
}

export interface PeaceSourceRow {
  at: string;
  kind: 'post' | 'comment' | 'email' | 'dm' | 'action';
  author: string;
  content: string;
  topic_class?: string | null;
  peaceRef?: string | null;
}

export interface BeforeCrisisItem {
  minute_from_open: number | null;
  kind: PeaceSourceRow['kind'];
  author: string;
  content: string;
  topic_class?: string;
  unscored: true;
}

export interface BeforeCrisisSection {
  unscored: true;
  opened_at: string | null;
  crisis_start: string | null;
  minutes_before_crisis: number | null;
  items: BeforeCrisisItem[];
}

const PEACE_ITEM_CAP = 80;
const PEACE_TEXT_CAP = 240;

function storedLabel(value: string | null | undefined): string | undefined {
  if (!value || value === 'unclassified') return undefined;
  return value;
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildBeforeCrisisSection(input: {
  openedAt: string | null;
  crisisStart: string | null;
  rows: readonly PeaceSourceRow[];
}): BeforeCrisisSection | null {
  const openedMs = input.openedAt ? Date.parse(input.openedAt) : Number.NaN;
  const startMs = input.crisisStart ? Date.parse(input.crisisStart) : Number.NaN;
  const items: BeforeCrisisItem[] = [];
  for (const row of input.rows) {
    if (!inPeaceWindow(row.at, input.openedAt, input.crisisStart, row.peaceRef)) continue;
    const label = storedLabel(row.topic_class);
    items.push({
      minute_from_open: openedMinute(row.at, Number.isFinite(openedMs) ? openedMs : null),
      kind: row.kind,
      author: row.author || 'Unknown',
      content: clip(row.content, PEACE_TEXT_CAP),
      ...(label ? { topic_class: label } : {}),
      unscored: true,
    });
  }
  if (items.length === 0) return null;
  items.sort((left, right) => (left.minute_from_open ?? 0) - (right.minute_from_open ?? 0));
  const minutesBefore =
    Number.isFinite(openedMs) && Number.isFinite(startMs)
      ? Math.max(0, Math.round((startMs - openedMs) / 60000))
      : null;
  return {
    unscored: true,
    opened_at: input.openedAt,
    crisis_start: input.crisisStart,
    minutes_before_crisis: minutesBefore,
    items: items.slice(0, PEACE_ITEM_CAP),
  };
}

export interface PlayerTopicSource {
  kind: 'comment' | 'email' | 'dm';
  at: string;
  who: string;
  content: string;
  topic_class?: string | null;
}

export interface PlayerTopicLabel {
  kind: PlayerTopicSource['kind'];
  minute: number | null;
  who: string;
  topic_class: string;
  content: string;
}

/** Labels that were actually stored. Omitted entirely when none exist. */
export function playerTopicLabels(
  rows: readonly PlayerTopicSource[],
  startMs: number | null,
  peace: boolean,
): PlayerTopicLabel[] {
  const labels: PlayerTopicLabel[] = [];
  for (const row of rows) {
    const label = storedLabel(row.topic_class);
    if (!label) continue;
    const minute = crisisEventMinute(row.at, startMs, { peace, round: 'floor' });
    if (peace && minute == null) continue;
    labels.push({
      kind: row.kind,
      minute,
      who: row.who || 'Unknown',
      topic_class: label,
      content: clip(row.content, 160),
    });
  }
  return labels;
}
