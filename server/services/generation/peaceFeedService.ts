/**
 * One peace-feed generation call, plus the build and compile adapters.
 * The model client is injected so tests never call a provider.
 */

import { chatJson, systemUser } from '../ai/chatClient.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { normalizeOrgPages, type NPCPersona, type OrgConfig } from '../socialCrisisGeneratorService.js';
import type { LogKind, PeaceOutput } from '../warroomBuild/buildTypes.js';
export { PEACE_FEED_EMPTY_WARNING } from './peaceFeedCore.js';
import {
  PEACE_FEED_EMPTY_WARNING,
  PEACE_ORDINARY_LIFE_RULE,
  PEACE_PERIOD_DEFAULT_SECONDS,
  buildPeaceFeedPrompt,
  canonicalPlatform,
  checkPeaceFeed,
  dropOffendingPosts,
  feedContainsLeak,
  normalisePeaceFeed,
  type PeaceCast,
  type PeaceFeed,
  type PeaceFeedIssue,
  type PeacePage,
  type PeacePersona,
} from './peaceFeedCore.js';

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
  if (feed.posts.length < 10) return false;
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

function recentPosts(org: OrgConfig, fallback: OrgConfig['branded_history']): string[] {
  const history =
    org.branded_history && org.branded_history.length > 0
      ? org.branded_history
      : org.is_primary
        ? (fallback ?? [])
        : [];
  return [...history]
    .sort((a, b) => (a.days_ago ?? 0) - (b.days_ago ?? 0))
    .slice(0, 3)
    .map((post) => post.content)
    .filter((content): content is string => typeof content === 'string' && content.trim().length > 0);
}

function playable(org: OrgConfig): boolean {
  return org.role === 'protagonist' && org.operation !== 'ai' && org.control_mode !== 'ai';
}

/** Pages and personas the checker can resolve. Safe on a partial initial_state. */
export function castFromParts(
  personas: ReadonlyArray<Pick<NPCPersona, 'handle' | 'type' | 'normal_interests'> | PeacePersona>,
  orgPage: unknown,
): PeaceCast {
  const people: PeacePersona[] = [];
  const seen = new Set<string>();
  for (const persona of personas) {
    if (!persona || typeof persona.handle !== 'string' || !persona.handle.trim()) continue;
    const key = persona.handle.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      handle: persona.handle.trim().startsWith('@') ? persona.handle.trim() : `@${persona.handle.trim()}`,
      ...(persona.type ? { type: persona.type } : {}),
      ...(Array.isArray(persona.normal_interests)
        ? { normal_interests: persona.normal_interests.map(String) }
        : {}),
    });
  }

  const orgs = normalizeOrgPages(orgPage as Parameters<typeof normalizeOrgPages>[0]);
  const primaryHistory = orgs.find((org) => org.is_primary)?.branded_history;
  const flatHistory =
    orgPage && typeof orgPage === 'object' && Array.isArray((orgPage as { branded_history?: unknown }).branded_history)
      ? ((orgPage as { branded_history: OrgConfig['branded_history'] }).branded_history ?? [])
      : [];
  const pages: PeacePage[] = [];
  for (const org of orgs) {
    const voice = recentPosts(org, org.branded_history?.length ? org.branded_history : flatHistory.length ? flatHistory : primaryHistory);
    for (const platform of ['facebook', 'x_twitter'] as const) {
      const config = org[platform];
      if (!config?.page_handle) continue;
      pages.push({
        org_key: org.org_key,
        role: org.role === 'antagonist' || org.role === 'pressure' ? org.role : 'protagonist',
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

export interface PeaceStageSource {
  personas: ReadonlyArray<PeacePersona>;
  orgPage: unknown;
  crisisBrief: string;
  seconds?: number;
}

export interface PeaceStageLog {
  log(kind: Extract<LogKind, 'progress' | 'warning'>, message: string): void;
}

/**
 * Durable `peace` stage. A bad reply or a thrown client becomes a warning and
 * an empty feed. The build still succeeds.
 */
export async function runPeaceStage(
  source: PeaceStageSource,
  ctx: PeaceStageLog,
  client?: PeaceFeedClient,
): Promise<PeaceOutput> {
  try {
    if (!env.enablePeaceFeedBuildStage) {
      return { peace_period: null };
    }
    const cast = castFromParts(source.personas, source.orgPage);
    if (cast.pages.length === 0) {
      ctx.log('warning', PEACE_FEED_EMPTY_WARNING);
      logger.warn('peace feed stage has no organisation pages');
      return { peace_period: null, warning: PEACE_FEED_EMPTY_WARNING };
    }
    const result = await generatePeaceFeed(
      {
        cast,
        crisisBrief: source.crisisBrief,
        seconds: source.seconds ?? PEACE_PERIOD_DEFAULT_SECONDS,
      },
      client ? { client } : {},
    );
    if (!result.ok) {
      ctx.log('warning', result.warning);
      logger.warn({ warning: result.warning }, 'peace feed stage stored no feed');
      return { peace_period: null, warning: result.warning };
    }
    if (feedContainsLeak(result.feed)) {
      ctx.log('warning', PEACE_FEED_EMPTY_WARNING);
      logger.warn('peace feed stage dropped a feed that still matched a leak term');
      return { peace_period: null, warning: PEACE_FEED_EMPTY_WARNING };
    }
    ctx.log('progress', `Peace feed: ${result.feed.posts.length} posts`);
    return { peace_period: result.feed };
  } catch (err) {
    ctx.log('warning', PEACE_FEED_EMPTY_WARNING);
    logger.warn({ err }, 'peace feed stage failed');
    return { peace_period: null, warning: PEACE_FEED_EMPTY_WARNING };
  }
}

export interface CompiledPeaceInput {
  initialState: Record<string, unknown>;
  /** Set when a durable build already ran the stage. Undefined means legacy compile. */
  stageOutput?: PeaceOutput | null;
  personas: unknown;
  orgPage: unknown;
  crisisBrief: string;
  client?: PeaceFeedClient;
}

/**
 * Legacy compile calls the generator. A durable compile copies the stage
 * output and does not call the model again. A leak never lands on initial_state.
 * Failures are warnings.
 */
export async function applyCompiledPeaceFeed(input: CompiledPeaceInput): Promise<void> {
  if (!env.enablePeaceFeedBuildStage) return;
  try {
    if (input.stageOutput) {
      const feed = input.stageOutput.peace_period;
      if (feed && feed.posts.length > 0 && !feedContainsLeak(feed)) {
        input.initialState.peace_period = feed;
      }
      return;
    }
    const personas = Array.isArray(input.personas) ? input.personas : [];
    const result = await generatePeaceFeed(
      {
        cast: castFromParts(personas as PeacePersona[], input.orgPage),
        crisisBrief: input.crisisBrief,
      },
      input.client ? { client: input.client } : {},
    );
    if (!result.ok) {
      logger.warn({ warning: result.warning }, 'peace feed compile stored no feed');
      return;
    }
    if (feedContainsLeak(result.feed)) {
      logger.warn('peace feed compile refused a feed that matched a leak term');
      return;
    }
    input.initialState.peace_period = result.feed;
  } catch (err) {
    logger.warn({ err }, 'peace feed compile skipped');
  }
}
