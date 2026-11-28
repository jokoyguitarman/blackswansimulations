/**
 * Which peace-feed rows are due. No database access.
 *
 * A post or comment whose offset is past `seconds - PEACE_OFFSET_TAIL_SECONDS`
 * is skipped, not clamped. The editor can shorten `seconds` after generation;
 * clamping would publish that tail as one burst. A skipped row never appears.
 * Comment rows use `${postRef}#${index}` as their peace_ref (the index in that
 * post's comments array), so a later tick can publish a comment whose parent
 * is already in the feed.
 */

import { PEACE_OFFSET_TAIL_SECONDS, type PeaceFeedAuthor, type PeaceFeedPost } from '../../../shared/peaceFeed.js';

export interface PlannedPeacePost {
  kind: 'post';
  peaceRef: string;
  offsetSeconds: number;
  platform: string;
  postFormat: string;
  content: string;
  mediaDescription: string;
  author: PeaceFeedAuthor;
}

export interface PlannedPeaceComment {
  kind: 'comment';
  peaceRef: string;
  parentRef: string;
  offsetSeconds: number;
  platform: string;
  content: string;
  authorHandle: string;
}

export type PlannedPeaceItem = PlannedPeacePost | PlannedPeaceComment;

export function peaceCommentRef(postRef: string, index: number): string {
  return `${postRef}#${index}`;
}

/** Latest offset that still belongs in the peace. Offsets above this are skipped. */
export function peaceOffsetLimit(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, seconds - PEACE_OFFSET_TAIL_SECONDS);
}

export function planPeacePublications(input: {
  posts: readonly PeaceFeedPost[];
  seconds: number;
  openedAtMs: number;
  now: number;
  already: ReadonlySet<string>;
  postAuthorResolved: (author: PeaceFeedAuthor) => boolean;
  commentAuthorResolved: (handle: string) => boolean;
}): { publish: PlannedPeaceItem[]; skippedPastTail: string[]; skippedUnresolved: string[] } {
  const limit = peaceOffsetLimit(input.seconds);
  const publish: PlannedPeaceItem[] = [];
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
        if (!input.postAuthorResolved(post.author)) {
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
            author: post.author,
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
      if (!input.commentAuthorResolved(comment.author_handle)) {
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
        authorHandle: comment.author_handle,
      });
    });
  }

  return { publish, skippedPastTail, skippedUnresolved };
}
