/**
 * Peace feed shape, leak check and prompt (peace-period spec §5.5, WP2).
 * No database and no AI client. WP3 and WP4 import `matchesLeakTerms`.
 */

import {
  PEACE_COMMENT_MAX,
  PEACE_LEAK_TERM_CAP,
  PEACE_OFFSET_TAIL_SECONDS,
  PEACE_PAGE_POST_MIN,
  PEACE_PERIOD_DEFAULT_SECONDS,
  PEACE_PERIOD_MAX_SECONDS,
  PEACE_PERSONA_MIN,
  PEACE_POST_MAX,
  PEACE_POST_MIN,
  type PeaceFeed,
  type PeaceFeedAuthor,
  type PeaceFeedComment,
  type PeaceFeedPost,
} from '../../../shared/peaceFeed.js';

export {
  PEACE_COMMENT_MAX,
  PEACE_LEAK_TERM_CAP,
  PEACE_OFFSET_TAIL_SECONDS,
  PEACE_PAGE_POST_MIN,
  PEACE_PERIOD_DEFAULT_SECONDS,
  PEACE_PERIOD_MAX_SECONDS,
  PEACE_PERSONA_MIN,
  PEACE_POST_MAX,
  PEACE_POST_MIN,
  type PeaceFeed,
  type PeaceFeedAuthor,
  type PeaceFeedComment,
  type PeaceFeedPost,
  type PeacePageAuthor,
  type PeacePersonaAuthor,
} from '../../../shared/peaceFeed.js';

export const PEACE_ORDINARY_LIFE_RULE =
  'Posts must be about ordinary life and ordinary business. Do not hint at, foreshadow or allude to the crisis.';

/** Shared with the leak-term-only prompt so a brief edit does not ask for posts. */
export const PEACE_LEAK_TERM_ONLY =
  'The crisis brief is given only so you can list leak_terms. Never use those terms, or the crisis, in a post or comment.';

export const PEACE_LEAK_TERM_RULE =
  'leak_terms are the short words and phrases a reader would recognise as the crisis (product, incident, injury, recall). They are matched whole-word, so prefer the specific phrase.';

export const PEACE_LEAK_TERM_SOURCE_HEADER =
  'LEAK TERM SOURCE (use this only to choose leak_terms. Do not mention, hint at, foreshadow or allude to any of it in posts or comments):';

export const PEACE_FEED_EMPTY_WARNING =
  'Peace feed could not be generated — the scenario compiles without one.';

export interface PeacePersona {
  handle: string;
  type?: string;
  normal_interests?: string[];
}

export interface PeacePage {
  org_key: string;
  role: 'protagonist' | 'antagonist' | 'pressure';
  /** Player-run protagonist page. AI-operated offices are not playable. */
  playable: boolean;
  platform: string;
  handle: string;
  name?: string;
  bio?: string;
  /** Last few branded-history posts, most recent first, for voice. */
  recent_posts?: string[];
}

export interface PeaceCast {
  personas: PeacePersona[];
  pages: PeacePage[];
}

export type PeaceFeedIssueCode =
  | 'count'
  | 'protagonist'
  | 'rival'
  | 'pressure'
  | 'personas'
  | 'offset'
  | 'comments'
  | 'interests'
  | 'leak'
  | 'author'
  | 'seconds'
  | 'leak_terms'
  | 'shape';

export interface PeaceFeedIssue {
  code: PeaceFeedIssueCode;
  message: string;
  /** Set when the issue belongs to one post and that post can be dropped. */
  ref?: string;
}

export interface PeaceFeedPromptInput {
  cast: PeaceCast;
  /** Used only to derive leak_terms. Must not be echoed in posts. */
  crisisBrief: string;
  seconds: number;
  errors?: PeaceFeedIssue[];
}

const POST_DROP_CODES = new Set<PeaceFeedIssueCode>([
  'offset',
  'comments',
  'interests',
  'leak',
  'author',
  'shape',
]);

const WORD_EDGE = String.raw`[^\p{L}\p{N}_]`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive whole word or phrase. "recall" does not match "recalling"
 * or "precall". "battery fire" matches that phrase with flexible whitespace.
 * "V15" does not match "V150".
 */
export function matchesLeakTerms(text: string, terms: readonly string[]): boolean {
  if (!text || terms.length === 0) return false;
  const hay = text.normalize('NFKC');
  for (const term of terms) {
    const trimmed = term.normalize('NFKC').trim();
    if (!trimmed) continue;
    const body = trimmed
      .split(/\s+/)
      .map(escapeRegExp)
      .join(String.raw`\s+`);
    const re = new RegExp(`(?:^|${WORD_EDGE})${body}(?=$|${WORD_EDGE})`, 'iu');
    if (re.test(hay)) return true;
  }
  return false;
}

export function canonicalHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

export function canonicalPlatform(platform: string): string {
  const value = platform
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (value === 'fb' || value === 'facebook') return 'facebook';
  if (value === 'x' || value === 'twitter' || value === 'x_twitter' || value === 'xtwitter') {
    return 'x_twitter';
  }
  return value;
}

function sameHandle(left: string, right: string): boolean {
  return canonicalHandle(left).toLowerCase() === canonicalHandle(right).toLowerCase();
}

function personaByHandle(cast: PeaceCast, handle: string): PeacePersona | undefined {
  return cast.personas.find((persona) => sameHandle(persona.handle, handle));
}

function pageByKey(cast: PeaceCast, orgKey: string, platform: string): PeacePage | undefined {
  const key = orgKey.trim().toLowerCase();
  const plat = canonicalPlatform(platform);
  return cast.pages.find(
    (page) =>
      page.org_key.trim().toLowerCase() === key && canonicalPlatform(page.platform) === plat,
  );
}

function pageByHandle(cast: PeaceCast, handle: string): PeacePage | undefined {
  return cast.pages.find((page) => sameHandle(page.handle, handle));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clampSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  const base = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  if (base < 0) return 0;
  if (base > PEACE_PERIOD_MAX_SECONDS) return PEACE_PERIOD_MAX_SECONDS;
  return base;
}

function integerOffset(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
}

function cleanTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(trimmed);
  }
  return terms.slice(0, PEACE_LEAK_TERM_CAP);
}

function resolveAuthor(raw: unknown, cast: PeaceCast): PeaceFeedAuthor | null {
  if (typeof raw === 'string') {
    const persona = personaByHandle(cast, raw);
    return persona ? { kind: 'persona', handle: persona.handle } : null;
  }
  const record = asRecord(raw);
  if (!record) return null;
  const kind = typeof record.kind === 'string' ? record.kind : '';
  const handle = typeof record.handle === 'string' ? record.handle : '';
  const orgKey = typeof record.org_key === 'string' ? record.org_key : '';
  const platform = typeof record.platform === 'string' ? record.platform : '';
  if (kind === 'page' || (!kind && orgKey)) {
    const page = pageByKey(cast, orgKey, platform);
    if (!page) return null;
    return { kind: 'page', org_key: page.org_key, platform: canonicalPlatform(page.platform) };
  }
  if (handle) {
    const persona = personaByHandle(cast, handle);
    if (persona) return { kind: 'persona', handle: persona.handle };
    const page = pageByHandle(cast, handle);
    if (page)
      return { kind: 'page', org_key: page.org_key, platform: canonicalPlatform(page.platform) };
  }
  return null;
}

function resolveCommentAuthor(handle: string, cast: PeaceCast): string | null {
  const persona = personaByHandle(cast, handle);
  if (persona) return persona.handle;
  const page = pageByHandle(cast, handle);
  return page ? page.handle : null;
}

function unwrapFeed(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (Array.isArray(record.posts)) return record;
  const nested = asRecord(record.peace_period) ?? asRecord(record.feed);
  if (nested && Array.isArray(nested.posts)) return nested;
  return record;
}

export interface NormalisePeaceFeedOptions {
  seconds?: number;
  enabled?: boolean;
}

/**
 * Resolves authors against the cast, sorts by offset and caps the list at 24.
 * Returns null when the value is not a feed object.
 */
export function normalisePeaceFeed(
  raw: unknown,
  cast: PeaceCast,
  options: NormalisePeaceFeedOptions = {},
): PeaceFeed | null {
  const record = unwrapFeed(raw);
  if (!record || !Array.isArray(record.posts)) return null;
  const seconds = clampSeconds(options.seconds ?? record.seconds, PEACE_PERIOD_DEFAULT_SECONDS);
  const enabled =
    typeof options.enabled === 'boolean'
      ? options.enabled
      : typeof record.enabled === 'boolean'
        ? record.enabled
        : true;

  const parsed: PeaceFeedPost[] = [];
  for (const entry of record.posts) {
    const post = asRecord(entry);
    if (!post || typeof post.content !== 'string' || !post.content.trim()) continue;
    const offset = integerOffset(post.offset_seconds);
    const author = resolveAuthor(post.author, cast);
    const platformRaw =
      typeof post.platform === 'string'
        ? post.platform
        : author?.kind === 'page'
          ? author.platform
          : 'facebook';
    const comments: PeaceFeedComment[] = [];
    if (Array.isArray(post.comments)) {
      for (const item of post.comments) {
        const comment = asRecord(item);
        if (!comment || typeof comment.content !== 'string' || !comment.content.trim()) continue;
        const commentOffset = integerOffset(comment.offset_seconds);
        const handle = typeof comment.author_handle === 'string' ? comment.author_handle : '';
        const resolved = resolveCommentAuthor(handle, cast);
        comments.push({
          author_handle: resolved ?? canonicalHandle(handle || '@unknown'),
          content: comment.content.trim(),
          offset_seconds: commentOffset ?? Number.NaN,
        });
      }
    }
    comments.sort((a, b) => a.offset_seconds - b.offset_seconds);
    parsed.push({
      ref: typeof post.ref === 'string' ? post.ref.trim() : '',
      author: author ?? {
        kind: 'persona',
        handle: canonicalHandle(
          typeof asRecord(post.author)?.handle === 'string'
            ? String(asRecord(post.author)?.handle)
            : '@unknown',
        ),
      },
      platform: canonicalPlatform(platformRaw || 'facebook'),
      post_format:
        typeof post.post_format === 'string' && post.post_format.trim()
          ? post.post_format.trim()
          : 'text',
      content: post.content.trim(),
      media_description:
        typeof post.media_description === 'string' ? post.media_description.trim() : '',
      offset_seconds: offset ?? Number.NaN,
      comments,
    });
  }

  parsed.sort((a, b) => a.offset_seconds - b.offset_seconds || a.ref.localeCompare(b.ref));
  const capped = parsed.slice(0, PEACE_POST_MAX);
  const seen = new Set<string>();
  capped.forEach((post, index) => {
    const wanted = post.ref && !seen.has(post.ref) ? post.ref : `P${index + 1}`;
    post.ref = seen.has(wanted) ? `P${index + 1}` : wanted;
    seen.add(post.ref);
  });

  return {
    version: 1,
    seconds,
    enabled,
    leak_terms: cleanTerms(record.leak_terms),
    posts: capped,
  };
}

function offsetWindow(seconds: number): { min: number; max: number } {
  return { min: 0, max: seconds - PEACE_OFFSET_TAIL_SECONDS };
}

function authorResolves(author: PeaceFeedAuthor, cast: PeaceCast): boolean {
  if (author.kind === 'page') return !!pageByKey(cast, author.org_key, author.platform);
  return !!personaByHandle(cast, author.handle);
}

function textsOf(post: PeaceFeedPost): string[] {
  return [post.content, post.media_description, ...post.comments.map((comment) => comment.content)];
}

export function feedContainsLeak(feed: Pick<PeaceFeed, 'leak_terms' | 'posts'>): boolean {
  return feed.posts.some((post) =>
    textsOf(post).some((text) => matchesLeakTerms(text, feed.leak_terms)),
  );
}

/** A feed that may be written onto initial_state: at least one post, and no leak term. */
export function usablePeaceFeed(value: unknown): PeaceFeed | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const feed = value as PeaceFeed;
  if (!Array.isArray(feed.posts) || feed.posts.length === 0) return null;
  if (!Array.isArray(feed.leak_terms)) return null;
  if (feedContainsLeak(feed)) return null;
  return feed;
}

function checkFeedDocument(feed: PeaceFeed, issues: PeaceFeedIssue[]): void {
  if (feed.version !== 1) {
    issues.push({ code: 'shape', message: 'version must be 1' });
  }
  if (feed.leak_terms.length === 0) {
    issues.push({
      code: 'leak_terms',
      message: 'leak_terms must list the words and phrases that would reveal the crisis',
    });
  }
  if (feed.seconds < PEACE_OFFSET_TAIL_SECONDS) {
    issues.push({
      code: 'seconds',
      message: `seconds must be at least ${PEACE_OFFSET_TAIL_SECONDS}`,
    });
  }
  if (feed.posts.length < PEACE_POST_MIN || feed.posts.length > PEACE_POST_MAX) {
    issues.push({
      code: 'count',
      message: `the feed needs ${PEACE_POST_MIN} to ${PEACE_POST_MAX} posts, not ${feed.posts.length}`,
    });
  }
}

function checkOnePost(
  feed: PeaceFeed,
  cast: PeaceCast,
  post: PeaceFeedPost,
  issues: PeaceFeedIssue[],
  seenRefs: Set<string>,
): void {
  const window = offsetWindow(feed.seconds);
  if (!post.ref || seenRefs.has(post.ref)) {
    issues.push({
      code: 'shape',
      ref: post.ref,
      message: `post ${post.ref || '(missing)'} needs a unique ref`,
    });
  }
  seenRefs.add(post.ref);
  if (!authorResolves(post.author, cast)) {
    issues.push({
      code: 'author',
      ref: post.ref,
      message: `post ${post.ref} author does not match a page or persona`,
    });
  }
  if (
    !Number.isFinite(post.offset_seconds) ||
    post.offset_seconds < window.min ||
    post.offset_seconds > window.max
  ) {
    issues.push({
      code: 'offset',
      ref: post.ref,
      message: `post ${post.ref} offset must be between ${window.min} and ${window.max} seconds`,
    });
  }
  if (post.comments.length > PEACE_COMMENT_MAX) {
    issues.push({
      code: 'comments',
      ref: post.ref,
      message: `post ${post.ref} has ${post.comments.length} comments; the maximum is ${PEACE_COMMENT_MAX}`,
    });
  }
  for (const comment of post.comments) {
    if (!resolveCommentAuthor(comment.author_handle, cast)) {
      issues.push({
        code: 'author',
        ref: post.ref,
        message: `a comment on ${post.ref} is by ${comment.author_handle}, who is not in the cast`,
      });
    }
    if (
      !Number.isFinite(comment.offset_seconds) ||
      comment.offset_seconds < window.min ||
      comment.offset_seconds > window.max
    ) {
      issues.push({
        code: 'offset',
        ref: post.ref,
        message: `a comment on ${post.ref} is outside ${window.min} to ${window.max} seconds`,
      });
    }
  }
  if (textsOf(post).some((text) => matchesLeakTerms(text, feed.leak_terms))) {
    issues.push({
      code: 'leak',
      ref: post.ref,
      message: `post ${post.ref} uses a leak term`,
    });
  }
  if (post.author.kind === 'persona') {
    const persona = personaByHandle(cast, post.author.handle);
    const interests = (persona?.normal_interests ?? [])
      .map((interest) => interest.trim())
      .filter(Boolean);
    if (!persona || interests.length === 0 || !matchesLeakTerms(post.content, interests)) {
      issues.push({
        code: 'interests',
        ref: post.ref,
        message: `post ${post.ref} by ${post.author.handle} must be about their normal interests`,
      });
    }
  }
}

function pagePostCount(feed: PeaceFeed, orgKey: string, platform: string): number {
  return feed.posts.filter(
    (post) =>
      post.author.kind === 'page' &&
      post.author.org_key === orgKey &&
      canonicalPlatform(post.author.platform) === canonicalPlatform(platform),
  ).length;
}

function hasPageRole(feed: PeaceFeed, cast: PeaceCast, role: 'antagonist' | 'pressure'): boolean {
  return feed.posts.some((post) => {
    if (post.author.kind !== 'page') return false;
    return pageByKey(cast, post.author.org_key, post.author.platform)?.role === role;
  });
}

function representedPersonas(feed: PeaceFeed, cast: PeaceCast): number {
  const represented = new Set<string>();
  for (const post of feed.posts) {
    if (post.author.kind === 'persona') {
      const persona = personaByHandle(cast, post.author.handle);
      if (persona) represented.add(persona.handle.toLowerCase());
    }
    for (const comment of post.comments) {
      const persona = personaByHandle(cast, comment.author_handle);
      if (persona) represented.add(persona.handle.toLowerCase());
    }
  }
  return represented.size;
}

function checkCoverage(feed: PeaceFeed, cast: PeaceCast, issues: PeaceFeedIssue[]): void {
  for (const page of cast.pages) {
    if (!page.playable || page.role !== 'protagonist') continue;
    const count = pagePostCount(feed, page.org_key, page.platform);
    if (count < PEACE_PAGE_POST_MIN) {
      issues.push({
        code: 'protagonist',
        message: `${page.org_key} on ${canonicalPlatform(page.platform)} needs at least ${PEACE_PAGE_POST_MIN} posts, not ${count}`,
      });
    }
  }
  if (
    cast.pages.some((page) => page.role === 'antagonist') &&
    !hasPageRole(feed, cast, 'antagonist')
  ) {
    issues.push({ code: 'rival', message: 'a rival page must post at least once' });
  }
  if (cast.pages.some((page) => page.role === 'pressure') && !hasPageRole(feed, cast, 'pressure')) {
    issues.push({ code: 'pressure', message: 'a pressure page must post at least once' });
  }
  const needed =
    cast.personas.length >= PEACE_PERSONA_MIN ? PEACE_PERSONA_MIN : cast.personas.length;
  const found = representedPersonas(feed, cast);
  if (found < needed) {
    issues.push({
      code: 'personas',
      message: `at least ${needed} distinct personas must appear; ${found} do`,
    });
  }
}

/** Every rule in §5.5. An empty list means the feed may be stored. */
export function checkPeaceFeed(feed: PeaceFeed, cast: PeaceCast): PeaceFeedIssue[] {
  const issues: PeaceFeedIssue[] = [];
  checkFeedDocument(feed, issues);
  const seenRefs = new Set<string>();
  for (const post of feed.posts) {
    checkOnePost(feed, cast, post, issues, seenRefs);
  }
  checkCoverage(feed, cast, issues);
  return issues;
}

/** Posts named by a per-post failure, plus any post that still matches a leak term. */
export function dropOffendingPosts(feed: PeaceFeed, issues: PeaceFeedIssue[]): PeaceFeed {
  const refs = new Set(
    issues
      .filter((issue) => issue.ref && POST_DROP_CODES.has(issue.code))
      .map((issue) => issue.ref),
  );
  const posts = feed.posts.filter((post) => {
    if (refs.has(post.ref)) return false;
    return !textsOf(post).some((text) => matchesLeakTerms(text, feed.leak_terms));
  });
  return { ...feed, posts };
}

export function buildPeaceFeedPrompt(input: PeaceFeedPromptInput): {
  system: string;
  user: string;
} {
  const maxOffset = Math.max(0, input.seconds - PEACE_OFFSET_TAIL_SECONDS);
  const system = [
    'You write the pre-crisis social feed for a crisis-simulation scenario.',
    PEACE_ORDINARY_LIFE_RULE,
    PEACE_LEAK_TERM_ONLY,
    `Return JSON: { "leak_terms": string[], "posts": [ { "ref": "P1", "author": { "kind": "page", "org_key": "...", "platform": "facebook"|"x_twitter" } | { "kind": "persona", "handle": "@..." }, "platform": "facebook"|"x_twitter", "post_format": "text", "content": "...", "media_description": "", "offset_seconds": number, "comments": [ { "author_handle": "@...", "content": "...", "offset_seconds": number } ] } ] }`,
    `Write ${PEACE_POST_MIN} to ${PEACE_POST_MAX} posts. Every offset is an integer from 0 to ${maxOffset}. At most ${PEACE_COMMENT_MAX} comments on a post.`,
    'Every playable protagonist page listed below needs at least 2 posts on that platform. Rival pages and pressure pages must each appear at least once. At least 6 distinct personas appear as authors or commenters, or every persona when the cast is smaller.',
    "A persona post must be about that persona's normal_interests. Page posts sound like that page's branded history.",
    PEACE_LEAK_TERM_RULE,
  ].join('\n');

  const personas = input.cast.personas
    .map((persona) => {
      const interests = (persona.normal_interests ?? []).filter(Boolean).join(', ') || '(none)';
      return `- ${persona.handle} (${persona.type || 'persona'}) interests: ${interests}`;
    })
    .join('\n');
  const pages = input.cast.pages
    .map((page) => {
      const voice = (page.recent_posts ?? [])
        .slice(0, 3)
        .map((post) => `"${post}"`)
        .join(' | ');
      const quota = page.playable ? 'playable protagonist, at least 2 posts' : page.role;
      return `- ${page.org_key} ${canonicalPlatform(page.platform)} ${page.handle} (${page.name || page.org_key}, ${quota})${page.bio ? ` bio: ${page.bio}` : ''}${voice ? ` recent: ${voice}` : ''}`;
    })
    .join('\n');
  const errors =
    input.errors && input.errors.length > 0
      ? `\n\nThe previous draft failed these checks. Fix them without mentioning the crisis:\n${input.errors.map((issue) => `- ${issue.message}`).join('\n')}`
      : '';
  const user = [
    'CAST',
    'Personas:',
    personas || '(none)',
    'Pages:',
    pages || '(none)',
    '',
    PEACE_LEAK_TERM_SOURCE_HEADER,
    input.crisisBrief.trim() || '(no brief)',
    errors,
  ].join('\n');
  return { system, user };
}

/** The leak-term sentences of {@link buildPeaceFeedPrompt}, with no post request. */
export function buildPeaceLeakTermsPrompt(crisisBrief: string): { system: string; user: string } {
  return {
    system: [PEACE_LEAK_TERM_ONLY, PEACE_LEAK_TERM_RULE, 'Return JSON: { "leak_terms": string[] }.'].join(
      '\n',
    ),
    user: [PEACE_LEAK_TERM_SOURCE_HEADER, crisisBrief.trim() || '(no brief)'].join('\n'),
  };
}

export function leakTermsFromReply(raw: unknown): string[] {
  const record = unwrapFeed(raw) ?? asRecord(raw);
  if (!record) return [];
  return cleanTerms(record.leak_terms);
}

export interface PeaceAddedPostsPrompt {
  cast: PeaceCast;
  seconds: number;
  leakTerms: readonly string[];
  room: number;
}

/** Posts for organisations added in this edit. Does not ask the model to rewrite the feed. */
export function buildPeaceAddedPostsPrompt(input: PeaceAddedPostsPrompt): {
  system: string;
  user: string;
} {
  const maxOffset = Math.max(0, input.seconds - PEACE_OFFSET_TAIL_SECONDS);
  const room = Math.max(0, Math.floor(input.room));
  const system = [
    'You write extra pre-crisis posts for organisations just added to a crisis-simulation scenario.',
    PEACE_ORDINARY_LIFE_RULE,
    'Write posts only for the pages listed below. Do not write posts for any other organisation, and do not return leak_terms.',
    `Return JSON: { "posts": [ { "author": { "kind": "page", "org_key": "...", "platform": "facebook"|"x_twitter" }, "platform": "facebook"|"x_twitter", "post_format": "text", "content": "...", "media_description": "", "offset_seconds": number, "comments": [ { "author_handle": "@...", "content": "...", "offset_seconds": number } ] } ] }`,
    `Write at most ${room} posts. Every offset is an integer from 0 to ${maxOffset}. At most ${PEACE_COMMENT_MAX} comments on a post.`,
    'Every playable protagonist page listed below needs at least 2 posts on that platform when the room allows it. A rival or pressure page needs at least 1.',
    'Never use a leak term, and never hint at the crisis.',
  ].join('\n');
  const personas = input.cast.personas
    .map((persona) => {
      const interests = (persona.normal_interests ?? []).filter(Boolean).join(', ') || '(none)';
      return `- ${persona.handle} (${persona.type || 'persona'}) interests: ${interests}`;
    })
    .join('\n');
  const pages = input.cast.pages
    .map((page) => {
      const quota = page.playable ? 'playable protagonist, at least 2 posts' : page.role;
      return `- ${page.org_key} ${canonicalPlatform(page.platform)} ${page.handle} (${page.name || page.org_key}, ${quota})`;
    })
    .join('\n');
  const blocked = input.leakTerms.map((term) => term.trim()).filter(Boolean);
  const user = [
    'CAST',
    'Personas (comments only; do not give them a new top-level post):',
    personas || '(none)',
    'Pages to post as:',
    pages || '(none)',
    '',
    'Do not use these leak terms:',
    blocked.join(', ') || '(none)',
  ].join('\n');
  return { system, user };
}

export interface PeaceHandleRename {
  from: string;
  to: string;
}

export interface PeacePeriodRewrite {
  mapKey: (orgKey: string) => string;
  /** Org keys whose page posts leave the feed. Checked before and after `mapKey`. */
  dropOrgKeys: ReadonlySet<string>;
  handleRenames: readonly PeaceHandleRename[];
  /** Page handles of removed organisations. Their comments on surviving posts are dropped. */
  dropCommentHandles?: readonly string[];
}

/**
 * Rewrites one stored peace feed. Org re-keys and the primary swap update page
 * authors. A removed org's posts are dropped, and so are comments that page
 * left on other posts. A renamed handle updates persona authors and comment
 * authors. Returns the same value when nothing changes.
 */
export function rewritePeacePeriod(value: unknown, rewrite: PeacePeriodRewrite): unknown {
  const feed = asRecord(value);
  if (!feed || !Array.isArray(feed.posts)) return value;
  const handles = handleMapOf(rewrite.handleRenames);
  const dropComments = new Set(
    (rewrite.dropCommentHandles ?? []).map((handle) => handleKey(handle)).filter((handle) => handle.length > 0),
  );
  let changed = false;
  const posts: unknown[] = [];
  for (const raw of feed.posts) {
    const next = rewriteOnePost(raw, rewrite, handles, dropComments);
    if (next === undefined) {
      changed = true;
      continue;
    }
    if (next !== raw) changed = true;
    posts.push(next);
  }
  if (!changed) return value;
  return { ...feed, posts };
}

/** Page and persona handles that differ between the feed's current cast and the planned one. */
export function peaceHandleRenames(input: {
  orgPageBefore: unknown;
  orgPageAfter: unknown;
  personasBefore: unknown;
  personasAfter: unknown;
}): PeaceHandleRename[] {
  const renames: PeaceHandleRename[] = [];
  const beforeOrgs = indexBy(orgRecords(input.orgPageBefore), orgIdentity);
  const afterOrgs = indexBy(orgRecords(input.orgPageAfter), orgIdentity);
  for (const [id, before] of beforeOrgs) {
    const after = afterOrgs.get(id);
    if (!after) continue;
    for (const field of HANDLE_FIELDS) {
      const from = handleField(before, field);
      const to = handleField(after, field);
      if (from && to && handleKey(from) !== handleKey(to)) renames.push({ from, to });
    }
  }
  const beforePeople = indexBy(personaRecords(input.personasBefore), personaIdentity);
  const afterPeople = indexBy(personaRecords(input.personasAfter), personaIdentity);
  for (const [id, before] of beforePeople) {
    const after = afterPeople.get(id);
    if (!after) continue;
    const from = typeof before.handle === 'string' ? before.handle : '';
    const to = typeof after.handle === 'string' ? after.handle : '';
    if (from && to && handleKey(from) !== handleKey(to)) renames.push({ from, to });
  }
  return renames;
}

/**
 * Replaces leak terms and drops posts that now match them, the same drop
 * `dropOffendingPosts` uses. An empty reply, or a reply that would remove
 * every post, leaves the feed as it was so the result still stores.
 */
export function replacePeaceLeakTerms(feed: PeaceFeed, terms: readonly string[]): PeaceFeed {
  const cleaned = cleanTerms(terms);
  if (cleaned.length === 0) return feed;
  if (
    cleaned.length === feed.leak_terms.length &&
    cleaned.every((term, index) => term === feed.leak_terms[index])
  ) {
    return feed;
  }
  const dropped = dropOffendingPosts({ ...feed, leak_terms: cleaned }, []);
  if (dropped.posts.length === 0) return feed;
  if (dropped.posts.length === feed.posts.length) return { ...feed, leak_terms: cleaned };
  return dropped;
}

/**
 * Appends page posts for `addedOrgKeys` and leaves every existing post in place.
 * The reply is normalised and checked with the same rules as a full feed.
 * Existing posts fill the feed first; nothing is added once the feed is full.
 */
export function mergeAddedPeacePosts(
  feed: PeaceFeed,
  raw: unknown,
  cast: PeaceCast,
  addedOrgKeys: ReadonlySet<string>,
): PeaceFeed {
  const room = PEACE_POST_MAX - feed.posts.length;
  if (room <= 0 || addedOrgKeys.size === 0) return feed;
  const normalised = normalisePeaceFeed(raw, cast, {
    seconds: feed.seconds,
    enabled: feed.enabled,
  });
  if (!normalised) return feed;
  const candidates = normalised.posts.filter(
    (post) => post.author.kind === 'page' && addedOrgKeys.has(post.author.org_key),
  );
  if (candidates.length === 0) return feed;
  const probe = { ...feed, posts: candidates };
  const checked = dropOffendingPosts(probe, checkPeaceFeed(probe, cast));
  const used = new Set(feed.posts.map((post) => post.ref));
  const added: PeaceFeedPost[] = [];
  for (const post of checked.posts) {
    if (added.length >= room) break;
    const ref = used.has(post.ref) ? nextPeaceRef(used) : post.ref;
    used.add(ref);
    added.push(ref === post.ref ? post : { ...post, ref });
  }
  if (added.length === 0) return feed;
  return { ...feed, posts: [...feed.posts, ...added] };
}

/** Handles of organisation pages whose key `drop` accepts, from a page document or a list of orgs. */
export function pageHandlesOf(source: unknown, drop: (orgKey: string) => boolean): string[] {
  const rows = Array.isArray(source) ? source.filter(isOrgRecord) : orgRecords(source);
  const handles: string[] = [];
  for (const org of rows) {
    const key = typeof org.org_key === 'string' ? org.org_key.trim() : '';
    if (!key || !drop(key)) continue;
    for (const field of HANDLE_FIELDS) {
      const handle = handleField(org, field);
      if (handle) handles.push(handle);
    }
  }
  return handles;
}

function isOrgRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const HANDLE_FIELDS = ['facebook_handle', 'x_handle', 'facebook.page_handle', 'x_twitter.page_handle'] as const;

function handleField(org: Record<string, unknown>, field: (typeof HANDLE_FIELDS)[number]): string {
  if (field === 'facebook_handle' || field === 'x_handle') {
    return typeof org[field] === 'string' ? org[field].trim() : '';
  }
  const [parent, child] = field.split('.');
  const nested = asRecord(org[parent]);
  return nested && typeof nested[child] === 'string' ? nested[child].trim() : '';
}

function orgRecords(value: unknown): Record<string, unknown>[] {
  const page = asRecord(value);
  if (!page || !Array.isArray(page.orgs)) return [];
  return page.orgs.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item),
  );
}

function personaRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item),
  );
}

function orgIdentity(org: Record<string, unknown>): string {
  if (typeof org.org_uid === 'string' && org.org_uid.trim()) return `uid:${org.org_uid.trim()}`;
  if (typeof org.org_key === 'string' && org.org_key.trim()) return `key:${org.org_key.trim()}`;
  return '';
}

function personaIdentity(persona: Record<string, unknown>): string {
  if (typeof persona.id === 'string' && persona.id.trim()) return `id:${persona.id.trim()}`;
  if (typeof persona.name === 'string' && persona.name.trim()) return `name:${persona.name.trim()}`;
  return '';
}

function indexBy(
  rows: Record<string, unknown>[],
  identity: (row: Record<string, unknown>) => string,
): Map<string, Record<string, unknown>> {
  const indexed = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = identity(row);
    if (id && !indexed.has(id)) indexed.set(id, row);
  }
  return indexed;
}

function handleKey(handle: string): string {
  return canonicalHandle(handle).toLowerCase();
}

function handleMapOf(renames: readonly PeaceHandleRename[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const rename of renames) {
    const from = handleKey(rename.from);
    const to = canonicalHandle(rename.to);
    if (!from || !to || from === handleKey(to)) continue;
    map.set(from, to);
  }
  return map;
}

function renamedHandle(handle: string, handles: ReadonlyMap<string, string>): string | null {
  const next = handles.get(handleKey(handle));
  return next ?? null;
}

function rewriteOnePost(
  raw: unknown,
  rewrite: PeacePeriodRewrite,
  handles: ReadonlyMap<string, string>,
  dropComments: ReadonlySet<string>,
): unknown | undefined {
  const post = asRecord(raw);
  if (!post) return raw;
  const author = asRecord(post.author);
  if (author?.kind === 'page' && typeof author.org_key === 'string') {
    const original = author.org_key.trim();
    const mapped = rewrite.mapKey(original);
    if (rewrite.dropOrgKeys.has(original) || rewrite.dropOrgKeys.has(mapped)) return undefined;
    const authorNext = mapped !== author.org_key ? { ...author, org_key: mapped } : author;
    const comments = rewriteComments(post.comments, handles, dropComments);
    if (authorNext === author && comments === post.comments) return raw;
    return postWith(post, authorNext, comments);
  }
  const comments = rewriteComments(post.comments, handles, dropComments);
  let authorNext = author;
  if (author?.kind === 'persona' && typeof author.handle === 'string') {
    const next = renamedHandle(author.handle, handles);
    if (next && next !== author.handle) authorNext = { ...author, handle: next };
  }
  if (authorNext === author && comments === post.comments) return raw;
  return postWith(post, authorNext, comments);
}

function postWith(
  post: Record<string, unknown>,
  author: Record<string, unknown> | null,
  comments: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...post };
  if (author && author !== post.author) next.author = author;
  if (comments !== post.comments) next.comments = comments;
  return next;
}

function rewriteComments(
  value: unknown,
  handles: ReadonlyMap<string, string>,
  dropComments: ReadonlySet<string>,
): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const comments = [];
  for (const item of value) {
    const comment = asRecord(item);
    if (!comment || typeof comment.author_handle !== 'string') {
      comments.push(item);
      continue;
    }
    if (dropComments.has(handleKey(comment.author_handle))) {
      changed = true;
      continue;
    }
    const next = renamedHandle(comment.author_handle, handles);
    if (!next || next === comment.author_handle) {
      comments.push(item);
      continue;
    }
    changed = true;
    comments.push({ ...comment, author_handle: next });
  }
  return changed ? comments : value;
}

function nextPeaceRef(used: ReadonlySet<string>): string {
  let index = 1;
  while (used.has(`P${index}`)) index += 1;
  return `P${index}`;
}
