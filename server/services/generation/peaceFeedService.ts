/**
 * One peace-feed generation call, plus the build and compile adapters.
 * The model client is injected so tests never call a provider.
 */

import { chatJson, systemUser } from '../ai/chatClient.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import {
  normalizeOrgPages,
  type BrandedHistoryPost,
  type OrgConfig,
} from '../socialCrisisGeneratorService.js';
import {
  PEACE_FEED_EMPTY_WARNING,
  PEACE_ORDINARY_LIFE_RULE,
  PEACE_PERIOD_DEFAULT_SECONDS,
  PEACE_POST_MIN,
  buildPeaceFeedPrompt,
  canonicalPlatform,
  checkPeaceFeed,
  dropOffendingPosts,
  feedContainsLeak,
  normalisePeaceFeed,
  usablePeaceFeed,
  type PeaceCast,
  type PeaceFeed,
  type PeaceFeedIssue,
  type PeacePage,
  type PeacePersona,
} from './peaceFeedCore.js';

export { PEACE_FEED_EMPTY_WARNING } from './peaceFeedCore.js';

export interface PeaceFeedClient {
  complete(request: { system: string; user: string }): Promise<unknown>;
}

export interface GeneratePeaceFeedInput {
  cast: PeaceCast;
  crisisBrief: string;
  seconds?: number;
  enabled?: boolean;
}

export type GeneratePeaceFeedResult =
  | { ok: true; feed: PeaceFeed; attempts: number; dropped: number }
  | { ok: false; reason: 'empty'; warning: string };

const defaultClient: PeaceFeedClient = {
  async complete(request) {
    return chatJson({
      tier: 'standard',
      messages: systemUser(request.system, request.user),
      json: true,
      maxTokens: 12000,
      temperature: 0.7,
      growOnTruncation: true,
      label: 'peace.feed',
    });
  },
};

function issuesOf(feed: PeaceFeed | null, cast: PeaceCast): PeaceFeedIssue[] {
  if (!feed) return [{ code: 'shape', message: 'the reply was not a peace feed' }];
  return checkPeaceFeed(feed, cast);
}

function keepable(feed: PeaceFeed, cast: PeaceCast): boolean {
  if (feed.posts.length < PEACE_POST_MIN) return false;
  if (feed.leak_terms.length === 0) return false;
  if (feedContainsLeak(feed)) return false;
  return checkPeaceFeed(feed, cast).every(
    (issue) => issue.code !== 'leak' && issue.code !== 'author',
  );
}

/**
 * One call, then one retry with the check errors. If that still fails, drop
 * the offending posts and keep the feed when 10 or more clean posts remain.
 * Otherwise the caller stores no feed. This function does not throw on a bad
 * model reply; a thrown client error is the caller's to catch.
 */
export async function generatePeaceFeed(
  input: GeneratePeaceFeedInput,
  options?: { client?: PeaceFeedClient },
): Promise<GeneratePeaceFeedResult> {
  const client = options?.client ?? defaultClient;
  const seconds = input.seconds ?? PEACE_PERIOD_DEFAULT_SECONDS;
  const enabled = input.enabled ?? true;

  const attempt = async (errors?: PeaceFeedIssue[]) => {
    const prompt = buildPeaceFeedPrompt({
      cast: input.cast,
      crisisBrief: input.crisisBrief,
      seconds,
      ...(errors && errors.length > 0 ? { errors } : {}),
    });
    if (!prompt.system.includes(PEACE_ORDINARY_LIFE_RULE)) {
      throw new Error('peace feed prompt is missing the ordinary-life rule');
    }
    const raw = await client.complete(prompt);
    const feed = normalisePeaceFeed(raw, input.cast, { seconds, enabled });
    return { feed, issues: issuesOf(feed, input.cast) };
  };

  const first = await attempt();
  if (first.feed && first.issues.length === 0) {
    return { ok: true, feed: first.feed, attempts: 1, dropped: 0 };
  }
  const second = await attempt(first.issues);
  if (second.feed && second.issues.length === 0) {
    return { ok: true, feed: second.feed, attempts: 2, dropped: 0 };
  }

  const candidate = second.feed ?? first.feed;
  const issues = second.feed ? second.issues : first.issues;
  if (!candidate) return { ok: false, reason: 'empty', warning: PEACE_FEED_EMPTY_WARNING };
  const dropped = dropOffendingPosts(candidate, issues);
  if (!keepable(dropped, input.cast)) {
    return { ok: false, reason: 'empty', warning: PEACE_FEED_EMPTY_WARNING };
  }
  return {
    ok: true,
    feed: dropped,
    attempts: 2,
    dropped: candidate.posts.length - dropped.posts.length,
  };
}

function voicePosts(org: OrgConfig, flat: BrandedHistoryPost[], primary: BrandedHistoryPost[] | undefined): string[] {
  let history: BrandedHistoryPost[] = [];
  if (org.branded_history && org.branded_history.length > 0) history = org.branded_history;
  else if (org.is_primary && flat.length > 0) history = flat;
  else if (org.is_primary && primary) history = primary;
  return [...history]
    .sort((a, b) => (a.days_ago ?? 0) - (b.days_ago ?? 0))
    .slice(0, 3)
    .map((post) => post.content)
    .filter((content) => content.trim().length > 0);
}

function orgPageRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function personaFromUnknown(value: unknown): PeacePersona | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.handle !== 'string' || !record.handle.trim()) return null;
  const handle = record.handle.trim();
  return {
    handle: handle.startsWith('@') ? handle : `@${handle}`,
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(Array.isArray(record.normal_interests)
      ? { normal_interests: record.normal_interests.map(String) }
      : {}),
  };
}

function playable(org: OrgConfig): boolean {
  return org.role === 'protagonist' && org.operation !== 'ai' && org.control_mode !== 'ai';
}

/** Pages and personas the checker can resolve. Safe on a partial initial_state. */
export function castFromParts(personas: readonly unknown[], orgPage: unknown): PeaceCast {
  const people: PeacePersona[] = [];
  const seen = new Set<string>();
  for (const entry of personas) {
    const persona = personaFromUnknown(entry);
    if (!persona) continue;
    const key = persona.handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(persona);
  }

  const pageRecord = orgPageRecord(orgPage);
  const orgs = normalizeOrgPages(pageRecord);
  const primaryHistory = orgs.find((org) => org.is_primary)?.branded_history;
  const flatRaw = pageRecord?.branded_history;
  const flatHistory = Array.isArray(flatRaw) ? (flatRaw as BrandedHistoryPost[]) : [];
  const pages: PeacePage[] = [];
  for (const org of orgs) {
    const voice = voicePosts(org, flatHistory, primaryHistory);
    for (const platform of ['facebook', 'x_twitter'] as const) {
      const config = org[platform];
      if (!config?.page_handle) continue;
      const role = org.role === 'antagonist' || org.role === 'pressure' ? org.role : 'protagonist';
      pages.push({
        org_key: org.org_key,
        role,
        playable: playable(org),
        platform: canonicalPlatform(platform),
        handle: config.page_handle,
        name: config.page_name || org.display_name,
        bio: config.page_bio || '',
        recent_posts: voice,
      });
    }
  }
  return { personas: people, pages };
}

/** Same leak-term source on the build, the legacy compile and the editor route. */
export function crisisBriefForLeakTerms(source: {
  crisisType?: unknown;
  context?: unknown;
  narrative?: unknown;
  briefing?: unknown;
  confirmedFacts?: unknown;
}): string {
  const facts = Array.isArray(source.confirmedFacts)
    ? source.confirmedFacts.filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0)
    : [];
  return [source.crisisType, source.context, source.narrative, source.briefing, ...facts]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
}

export interface PeaceFeedSource {
  personas: readonly unknown[];
  orgPage: unknown;
  crisisBrief: string;
  seconds?: number;
  enabled?: boolean;
}

const INTERRUPT_NAMES = new Set(['AbortError', 'AbortedByCaller', 'CancelledError', 'ShutdownError']);

export function isPeaceInterrupt(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && INTERRUPT_NAMES.has(err.name);
}

/**
 * One feed for a cast. Callable on its own (the editor, legacy compile, and a
 * later re-edit delta). Does not catch errors and does not read the build flag.
 * Returns null when there is nothing safe to store.
 */
export async function generateScenarioPeaceFeed(
  source: PeaceFeedSource,
  client?: PeaceFeedClient,
): Promise<PeaceFeed | null> {
  const cast = castFromParts(source.personas, source.orgPage);
  if (cast.pages.length === 0) {
    logger.warn('peace feed skipped: no organisation pages');
    return null;
  }
  const result = await generatePeaceFeed(
    {
      cast,
      crisisBrief: source.crisisBrief,
      seconds: source.seconds ?? PEACE_PERIOD_DEFAULT_SECONDS,
      enabled: source.enabled ?? true,
    },
    client ? { client } : {},
  );
  if (!result.ok) {
    logger.warn({ warning: result.warning }, 'peace feed stored no feed');
    return null;
  }
  return usablePeaceFeed(result.feed);
}

export interface AttachPeaceOptions {
  signal?: AbortSignal;
  warn(message: string): void;
  client?: PeaceFeedClient;
}

/**
 * End of the pages stage. With the build flag off, the pages output is returned
 * unchanged. A peace failure other than abort or cancellation is a warning and
 * leaves the pages output intact.
 */
export async function attachPeaceToPages<T extends object>(
  pagesOutput: T,
  source: PeaceFeedSource,
  options: AttachPeaceOptions,
): Promise<T & { peace_period?: PeaceFeed }> {
  if (!env.enablePeaceFeedBuildStage) return pagesOutput;
  try {
    const feed = await generateScenarioPeaceFeed(source, options.client);
    if (options.signal?.aborted) {
      const reason = options.signal.reason;
      throw reason instanceof Error ? reason : new Error('aborted');
    }
    if (!feed) {
      options.warn(PEACE_FEED_EMPTY_WARNING);
      return pagesOutput;
    }
    return { ...pagesOutput, peace_period: feed };
  } catch (err) {
    if (isPeaceInterrupt(err, options.signal)) throw err;
    options.warn(PEACE_FEED_EMPTY_WARNING);
    logger.warn({ err }, 'peace feed skipped');
    return pagesOutput;
  }
}

export interface CompiledPeaceInput {
  initialState: Record<string, unknown>;
  /** Pages-stage feed from a durable build. Null means generate now (legacy compile). */
  storedFeed?: unknown;
  generate: boolean;
  personas: readonly unknown[];
  orgPage: unknown;
  crisisBrief: string;
  client?: PeaceFeedClient;
}

/**
 * Legacy compile generates. A durable compile copies the feed already stored on
 * the pages output. Neither path fails the compile, and a leak is not stored.
 */
export async function applyCompiledPeaceFeed(input: CompiledPeaceInput): Promise<void> {
  if (!env.enablePeaceFeedBuildStage) return;
  try {
    if (!input.generate) {
      const feed = usablePeaceFeed(input.storedFeed);
      if (feed) input.initialState.peace_period = feed;
      return;
    }
    const feed = await generateScenarioPeaceFeed(
      {
        personas: input.personas,
        orgPage: input.orgPage,
        crisisBrief: input.crisisBrief,
      },
      input.client,
    );
    if (feed) input.initialState.peace_period = feed;
  } catch (err) {
    logger.warn({ err }, 'peace feed compile skipped');
  }
}
