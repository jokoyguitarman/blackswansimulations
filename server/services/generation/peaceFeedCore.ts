/**
 * Peace feed shape, leak check and prompt (peace-period spec §5.5, WP2).
 * No database and no AI client. WP3 and WP4 import `matchesLeakTerms`.
 */

export const PEACE_POST_MIN = 10;
export const PEACE_POST_MAX = 24;
export const PEACE_COMMENT_MAX = 3;
export const PEACE_PERSONA_MIN = 6;
export const PEACE_PERIOD_DEFAULT_SECONDS = 300;
export const PEACE_PERIOD_MAX_SECONDS = 900;
/** A post or comment must land at least this long before crisis start. */
export const PEACE_OFFSET_TAIL_SECONDS = 30;

export const PEACE_ORDINARY_LIFE_RULE =
  'Posts must be about ordinary life and ordinary business. Do not hint at, foreshadow or allude to the crisis.';

export const PEACE_FEED_EMPTY_WARNING =
  'Peace feed could not be generated — the scenario compiles without one.';

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
   * Editor off switch. `false` keeps the posts but WP3 must not run peace.
   * Omitted on a stored feed means on.
   */
  enabled: boolean;
  leak_terms: string[];
  posts: PeaceFeedPost[];
}

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
    const body = trimmed.split(/\s+/).map(escapeRegExp).join(String.raw`\s+`);
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
  const value = platform.trim().toLowerCase().replace(/[\s-]+/g, '_');
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
    (page) => page.org_key.trim().toLowerCase() === key && canonicalPlatform(page.platform) === plat,
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
  return terms.slice(0, 40);
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
    if (page) return { kind: 'page', org_key: page.org_key, platform: canonicalPlatform(page.platform) };
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
  const seconds = clampSeconds(
    options.seconds ?? record.seconds,
    PEACE_PERIOD_DEFAULT_SECONDS,
  );
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
        const handle =
          typeof comment.author_handle === 'string' ? comment.author_handle : '';
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
      post_format: typeof post.post_format === 'string' && post.post_format.trim()
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

/** Every rule in §5.5. An empty list means the feed may be stored. */
export function checkPeaceFeed(feed: PeaceFeed, cast: PeaceCast): PeaceFeedIssue[] {
  const issues: PeaceFeedIssue[] = [];
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

  const window = offsetWindow(feed.seconds);
  const seenRefs = new Set<string>();
  for (const post of feed.posts) {
    if (!post.ref || seenRefs.has(post.ref)) {
      issues.push({ code: 'shape', ref: post.ref, message: `post ${post.ref || '(missing)'} needs a unique ref` });
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
      const interests = (persona?.normal_interests ?? []).map((interest) => interest.trim()).filter(Boolean);
      if (!persona || interests.length === 0 || !matchesLeakTerms(post.content, interests)) {
        issues.push({
          code: 'interests',
          ref: post.ref,
          message: `post ${post.ref} by ${post.author.handle} must be about their normal interests`,
        });
      }
    }
  }

  for (const page of cast.pages) {
    if (!page.playable || page.role !== 'protagonist') continue;
    const count = feed.posts.filter(
      (post) =>
        post.author.kind === 'page' &&
        post.author.org_key === page.org_key &&
        canonicalPlatform(post.author.platform) === canonicalPlatform(page.platform),
    ).length;
    if (count < 2) {
      issues.push({
        code: 'protagonist',
        message: `${page.org_key} on ${canonicalPlatform(page.platform)} needs at least 2 posts, not ${count}`,
      });
    }
  }

  const hasRival = cast.pages.some((page) => page.role === 'antagonist');
  if (
    hasRival &&
    !feed.posts.some(
      (post) => post.author.kind === 'page' && pageByKey(cast, post.author.org_key, post.author.platform)?.role === 'antagonist',
    )
  ) {
    issues.push({ code: 'rival', message: 'a rival page must post at least once' });
  }
  const hasPressure = cast.pages.some((page) => page.role === 'pressure');
  if (
    hasPressure &&
    !feed.posts.some(
      (post) => post.author.kind === 'page' && pageByKey(cast, post.author.org_key, post.author.platform)?.role === 'pressure',
    )
  ) {
    issues.push({ code: 'pressure', message: 'a pressure page must post at least once' });
  }

  const represented = new Set<string>();
  for (const post of feed.posts) {
    if (post.author.kind === 'persona' && personaByHandle(cast, post.author.handle)) {
      represented.add(personaByHandle(cast, post.author.handle)!.handle.toLowerCase());
    }
    for (const comment of post.comments) {
      const persona = personaByHandle(cast, comment.author_handle);
      if (persona) represented.add(persona.handle.toLowerCase());
    }
  }
  const needed =
    cast.personas.length >= PEACE_PERSONA_MIN
      ? PEACE_PERSONA_MIN
      : cast.personas.length;
  if (represented.size < needed) {
    issues.push({
      code: 'personas',
      message: `at least ${needed} distinct personas must appear; ${represented.size} do`,
    });
  }

  return issues;
}

/** Posts named by a per-post failure, plus any post that still matches a leak term. */
export function dropOffendingPosts(feed: PeaceFeed, issues: PeaceFeedIssue[]): PeaceFeed {
  const refs = new Set(
    issues.filter((issue) => issue.ref && POST_DROP_CODES.has(issue.code)).map((issue) => issue.ref),
  );
  const posts = feed.posts.filter((post) => {
    if (refs.has(post.ref)) return false;
    return !textsOf(post).some((text) => matchesLeakTerms(text, feed.leak_terms));
  });
  return { ...feed, posts };
}

export function buildPeaceFeedPrompt(input: PeaceFeedPromptInput): { system: string; user: string } {
  const maxOffset = Math.max(0, input.seconds - PEACE_OFFSET_TAIL_SECONDS);
  const system = [
    'You write the pre-crisis social feed for a crisis-simulation scenario.',
    PEACE_ORDINARY_LIFE_RULE,
    'The crisis brief is given only so you can list leak_terms. Never use those terms, or the crisis, in a post or comment.',
    `Return JSON: { "leak_terms": string[], "posts": [ { "ref": "P1", "author": { "kind": "page", "org_key": "...", "platform": "facebook"|"x_twitter" } | { "kind": "persona", "handle": "@..." }, "platform": "facebook"|"x_twitter", "post_format": "text", "content": "...", "media_description": "", "offset_seconds": number, "comments": [ { "author_handle": "@...", "content": "...", "offset_seconds": number } ] } ] }`,
    `Write ${PEACE_POST_MIN} to ${PEACE_POST_MAX} posts. Every offset is an integer from 0 to ${maxOffset}. At most ${PEACE_COMMENT_MAX} comments on a post.`,
    'Every playable protagonist page listed below needs at least 2 posts on that platform. Rival pages and pressure pages must each appear at least once. At least 6 distinct personas appear as authors or commenters, or every persona when the cast is smaller.',
    'A persona post must be about that persona\'s normal_interests. Page posts sound like that page\'s branded history.',
    'leak_terms are the short words and phrases a reader would recognise as the crisis (product, incident, injury, recall). They are matched whole-word, so prefer the specific phrase.',
  ].join('\n');

  const personas = input.cast.personas
    .map((persona) => {
      const interests = (persona.normal_interests ?? []).filter(Boolean).join(', ') || '(none)';
      return `- ${persona.handle} (${persona.type || 'persona'}) interests: ${interests}`;
    })
    .join('\n');
  const pages = input.cast.pages
    .map((page) => {
      const voice = (page.recent_posts ?? []).slice(0, 3).map((post) => `"${post}"`).join(' | ');
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
    'LEAK TERM SOURCE (use this only to choose leak_terms. Do not mention, hint at, foreshadow or allude to any of it in posts or comments):',
    input.crisisBrief.trim() || '(no brief)',
    errors,
  ].join('\n');
  return { system, user };
}
