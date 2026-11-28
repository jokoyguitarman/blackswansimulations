/**
 * Which peace-feed rows are due. No database access.
 *
 * `seconds` is the session's peace length (`start_time - opened_at`), not the
 * feed's authored length. A post or comment past `seconds - PEACE_OFFSET_TAIL_SECONDS`
 * is skipped, not clamped, so a shortened peace does not publish the tail as one burst.
 * Comment rows use `${postRef}#${index}` as their peace_ref (the index in that
 * post's comments array), so a later tick can publish a comment whose parent
 * is already in the feed.
 * The author resolvers run once; the plan carries whatever they return.
 */

import { PEACE_OFFSET_TAIL_SECONDS, type PeaceFeedAuthor, type PeaceFeedPost } from '../../../shared/peaceFeed.js';

export interface PlannedPeacePost<A> {
  kind: 'post';
  peaceRef: string;
  offsetSeconds: number;
  platform: string;
  postFormat: string;
  content: string;
  mediaDescription: string;
  author: A;
}

export interface PlannedPeaceComment<A> {
  kind: 'comment';
  peaceRef: string;
  parentRef: string;
  offsetSeconds: number;
  platform: string;
  content: string;
  author: A;
}

export type PlannedPeaceItem<A> = PlannedPeacePost<A> | PlannedPeaceComment<A>;

export function peaceCommentRef(postRef: string, index: number): string {
  return `${postRef}#${index}`;
}

/** Latest offset that still belongs in the peace. Offsets above this are skipped. */
export function peaceOffsetLimit(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, seconds - PEACE_OFFSET_TAIL_SECONDS);
}

/**
 * Length the lane measures offsets against. The live peace is
 * `start_time - opened_at`. A feed that never stored `seconds` falls back to
 * that window, then to the default, and never to 0.
 */
export function peaceWindowSeconds(input: {
  openedAtMs: number;
  startTime?: string | null;
  feedSeconds?: number | null;
  fallbackSeconds: number;
}): number {
  const startMs = input.startTime ? Date.parse(input.startTime) : Number.NaN;
  if (Number.isFinite(input.openedAtMs) && Number.isFinite(startMs) && startMs > input.openedAtMs) {
    return Math.round((startMs - input.openedAtMs) / 1000);
  }
  if (typeof input.feedSeconds === 'number' && Number.isFinite(input.feedSeconds) && input.feedSeconds > 0) {
    return input.feedSeconds;
  }
  return input.fallbackSeconds;
}

export function planPeacePublications<A>(input: {
  posts: readonly PeaceFeedPost[];
  seconds: number;
  openedAtMs: number;
  now: number;
  already: ReadonlySet<string>;
  postAuthor: (author: PeaceFeedAuthor) => A | null;
  commentAuthor: (handle: string) => A | null;
}): { publish: PlannedPeaceItem<A>[]; skippedPastTail: string[]; skippedUnresolved: string[] } {
  const limit = peaceOffsetLimit(input.seconds);
  const publish: PlannedPeaceItem<A>[] = [];
  const skippedPastTail: string[] = [];
  const skippedUnresolved: string[] = [];
  const parents = new Set<string>();

  for (const post of input.posts) {
    const postRef = post.ref;
    if (!postRef) continue;
    if (input.already.has(postRef)) parents.add(postRef);

    const postPastTail = !Number.isFinite(post.offset_seconds) || post.offset_seconds > limit;
    if (postPastTail) {
      if (!input.already.has(postRef)) skippedPastTail.push(postRef);
    } else if (!input.already.has(postRef)) {
      const due = input.openedAtMs + post.offset_seconds * 1000 <= input.now;
      if (due) {
        const author = input.postAuthor(post.author);
        if (!author) {
          skippedUnresolved.push(postRef);
        } else {
          parents.add(postRef);
          publish.push({
            kind: 'post',
            peaceRef: postRef,
            offsetSeconds: post.offset_seconds,
            platform: post.platform,
            postFormat: post.post_format || 'text',
            content: post.content,
            mediaDescription: post.media_description || '',
            author,
          });
        }
      }
    }

    (post.comments ?? []).forEach((comment, index) => {
      const peaceRef = peaceCommentRef(postRef, index);
      if (input.already.has(peaceRef)) return;
      if (!Number.isFinite(comment.offset_seconds) || comment.offset_seconds > limit) {
        skippedPastTail.push(peaceRef);
        return;
      }
      if (!parents.has(postRef)) return;
      if (input.openedAtMs + comment.offset_seconds * 1000 > input.now) return;
      const author = input.commentAuthor(comment.author_handle);
      if (!author) {
        skippedUnresolved.push(peaceRef);
        return;
      }
      publish.push({
        kind: 'comment',
        peaceRef,
        parentRef: postRef,
        offsetSeconds: comment.offset_seconds,
        platform: post.platform,
        content: comment.content,
        author,
      });
    });
  }

  return { publish, skippedPastTail, skippedUnresolved };
}
