/**
 * Peace feed stored on initial_state.peace_period (peace-period spec §5.5).
 * Types and limits only. The checker lives in the server core.
 */

export const PEACE_POST_MIN = 10;
export const PEACE_POST_MAX = 24;
export const PEACE_COMMENT_MAX = 3;
export const PEACE_PERSONA_MIN = 6;
export const PEACE_PAGE_POST_MIN = 2;
export const PEACE_PERIOD_DEFAULT_SECONDS = 300;
export const PEACE_PERIOD_MAX_SECONDS = 900;
/** A post or comment must land at least this long before crisis start. */
export const PEACE_OFFSET_TAIL_SECONDS = 30;
/** Cap on leak terms kept from one model reply. */
export const PEACE_LEAK_TERM_CAP = 40;

export interface PeaceFeedComment {
  author_handle: string;
  content: string;
  offset_seconds: number;
}

export interface PeacePageAuthor {
  kind: 'page';
  org_key: string;
  platform: string;
}

export interface PeacePersonaAuthor {
  kind: 'persona';
  handle: string;
}

export type PeaceFeedAuthor = PeacePageAuthor | PeacePersonaAuthor;

export interface PeaceFeedPost {
  ref: string;
  author: PeaceFeedAuthor;
  platform: string;
  post_format: string;
  content: string;
  media_description: string;
  offset_seconds: number;
  comments: PeaceFeedComment[];
}

export interface PeaceFeed {
  version: 1;
  /** Length of the peace period. The editor's seconds field. */
  seconds: number;
  /**
   * Editor off switch. `false` keeps the posts but the peace lane must not run.
   * Omitted on a stored feed means on.
   */
  enabled: boolean;
  leak_terms: string[];
  posts: PeaceFeedPost[];
}
