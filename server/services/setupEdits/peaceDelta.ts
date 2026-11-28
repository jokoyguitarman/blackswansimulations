/**
 * Peace feed for a setup-edit delta. Generation stays behind
 * ENABLE_PEACE_FEED_BUILD_STAGE. A failure here is a warning: the edit still
 * finishes, and posts already in the feed are left as they are.
 */

import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { PEACE_PERIOD_DEFAULT_SECONDS, PEACE_POST_MAX } from '../../../shared/peaceFeed.js';
import {
  mergeAddedPeacePosts,
  replacePeaceLeakTerms,
  type PeaceCast,
  type PeaceFeed,
  type PeaceFeedPost,
  type PeacePage,
} from '../generation/peaceFeedCore.js';
import {
  castFromParts,
  crisisBriefForLeakTerms,
  isPeaceInterrupt,
  requestAddedPeacePosts,
  requestPeaceLeakTerms,
} from '../generation/peaceFeedService.js';
import type { DeltaBuildContext } from './deltaBuildTypes.js';

/**
 * Leak terms for a brief change, and posts for added organisations merged onto
 * the feed the planner already rewrote. Undefined when the flag is off, the
 * scenario has no feed, or this edit does not change the feed.
 */
export async function revisePeaceForEdit(
  ctx: DeltaBuildContext,
  generatedPages: ReadonlyArray<Record<string, unknown>> = [],
): Promise<PeaceFeed | undefined> {
  if (!env.enablePeaceFeedBuildStage) return undefined;
  const baseline = peaceBaseline(ctx);
  if (!baseline) return undefined;
  const added = addedOrgKeys(ctx);
  if (!ctx.delta.brief_changed && added.length === 0) return undefined;

  let feed = baseline;
  if (ctx.delta.brief_changed) {
    feed = await withPeaceFallback(feed, 'peace leak terms skipped', async () => {
      const terms = await requestPeaceLeakTerms(crisisBrief(ctx), ctx.peaceClient);
      return replacePeaceLeakTerms(feed, terms);
    });
  }
  if (added.length > 0 && feed.posts.length < PEACE_POST_MAX) {
    const keys = new Set(added);
    const cast = castForAdded(ctx, keys, generatedPages);
    if (cast.pages.length > 0) {
      feed = await withPeaceFallback(feed, 'peace posts for added organisations skipped', async () => {
        const raw = await requestAddedPeacePosts(
          {
            cast,
            seconds: feed.seconds,
            leakTerms: feed.leak_terms,
            room: PEACE_POST_MAX - feed.posts.length,
          },
          ctx.peaceClient,
        );
        return mergeAddedPeacePosts(feed, raw, keys);
      });
    }
  }
  if (feed === baseline) return undefined;
  return feed;
}

async function withPeaceFallback(
  current: PeaceFeed,
  message: string,
  step: () => Promise<PeaceFeed>,
): Promise<PeaceFeed> {
  try {
    return await step();
  } catch (err) {
    if (isPeaceInterrupt(err)) throw err;
    logger.warn({ err }, message);
    return current;
  }
}

function peaceBaseline(ctx: DeltaBuildContext): PeaceFeed | null {
  const patched = ctx.plan.initial_state.patch.find((item) => item.path === '/peace_period');
  return asPeaceFeed(patched ? patched.value : ctx.peace_period);
}

function asPeaceFeed(value: unknown): PeaceFeed | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.posts) || record.posts.length === 0) return null;
  const posts = asPosts(record.posts);
  if (!posts) return null;
  const seconds = typeof record.seconds === 'number' && Number.isFinite(record.seconds)
    ? record.seconds
    : PEACE_PERIOD_DEFAULT_SECONDS;
  return {
    version: 1,
    seconds,
    enabled: record.enabled !== false,
    leak_terms: Array.isArray(record.leak_terms)
      ? record.leak_terms.filter((term): term is string => typeof term === 'string')
      : [],
    posts,
  };
}

function asPosts(value: unknown[]): PeaceFeedPost[] | null {
  if (!value.every(isStoredPost)) return null;
  return value as PeaceFeedPost[];
}

function isStoredPost(value: unknown): value is PeaceFeedPost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const post = value as Record<string, unknown>;
  if (typeof post.ref !== 'string' || typeof post.content !== 'string') return false;
  const author = post.author;
  if (!author || typeof author !== 'object' || Array.isArray(author)) return false;
  const kind = (author as Record<string, unknown>).kind;
  return kind === 'page' || kind === 'persona';
}

function crisisBrief(ctx: DeltaBuildContext): string {
  return crisisBriefForLeakTerms({
    crisisType: ctx.edited.crisis.crisis_type,
    context: ctx.edited.crisis.context,
    narrative: ctx.narrative.description,
    briefing: ctx.briefing || ctx.narrative.briefing,
    confirmedFacts: ctx.fact_sheet.confirmed_facts,
  });
}

function addedOrgKeys(ctx: DeltaBuildContext): string[] {
  const raw = [...ctx.delta.added_orgs, ...ctx.delta.added_rivals, ...ctx.delta.added_pressure];
  return [...new Set(raw.map((key) => postedOrgKey(ctx, key)))];
}

function postedOrgKey(ctx: DeltaBuildContext, orgKey: string): string {
  const swap = ctx.plan.primary_swap;
  if (swap?.to_is_new) {
    const org = ctx.edited.organisations.find((item) => item.org_key === orgKey);
    if (org?.org_uid === swap.to_org_uid) return 'primary';
  }
  return swap?.map[orgKey] ?? orgKey;
}

function castForAdded(
  ctx: DeltaBuildContext,
  keys: ReadonlySet<string>,
  generatedPages: ReadonlyArray<Record<string, unknown>>,
): PeaceCast {
  const existing = castFromParts(ctx.personas, ctx.org_page);
  const generated = castFromParts(
    [],
    { orgs: generatedPages.map((page) => retitle(ctx, page)) },
  );
  const synthetic = castFromParts([], { orgs: snapshotPages(ctx, keys) });
  return {
    personas: existing.personas,
    pages: dedupePages([...generated.pages, ...existing.pages, ...synthetic.pages]).filter((page) =>
      keys.has(page.org_key),
    ),
  };
}

function retitle(ctx: DeltaBuildContext, page: Record<string, unknown>): Record<string, unknown> {
  const key = typeof page.org_key === 'string' ? postedOrgKey(ctx, page.org_key) : '';
  if (!key || key === page.org_key) return page;
  return { ...page, org_key: key };
}

function snapshotPages(ctx: DeltaBuildContext, keys: ReadonlySet<string>): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const org of ctx.edited.organisations) {
    const key = postedOrgKey(ctx, org.org_key);
    if (!keys.has(key)) continue;
    rows.push(
      pageRow(key, org.display_name, 'protagonist', org.operation, org.is_primary, org.facebook_handle, org.x_handle),
    );
  }
  for (const org of ctx.edited.competitors) {
    if (!keys.has(postedOrgKey(ctx, org.org_key))) continue;
    rows.push(
      pageRow(
        postedOrgKey(ctx, org.org_key),
        org.name,
        'antagonist',
        'ai',
        false,
        org.facebook_handle,
        org.x_handle,
      ),
    );
  }
  for (const org of ctx.edited.pressure_organisations) {
    if (!keys.has(postedOrgKey(ctx, org.org_key))) continue;
    rows.push(
      pageRow(
        postedOrgKey(ctx, org.org_key),
        org.display_name,
        'pressure',
        'ai',
        false,
        org.facebook_handle,
        org.x_handle,
      ),
    );
  }
  return rows;
}

function pageRow(
  orgKey: string,
  name: string,
  role: 'protagonist' | 'antagonist' | 'pressure',
  operation: string,
  isPrimary: boolean,
  facebookHandle: string | undefined,
  xHandle: string | undefined,
): Record<string, unknown> {
  return {
    org_key: orgKey,
    display_name: name,
    role,
    operation,
    is_primary: isPrimary,
    ...(facebookHandle
      ? { facebook: { page_handle: facebookHandle, page_name: name, page_bio: '' } }
      : {}),
    ...(xHandle ? { x_twitter: { page_handle: xHandle, page_name: name, page_bio: '' } } : {}),
  };
}

function dedupePages(pages: PeacePage[]): PeacePage[] {
  const seen = new Set<string>();
  const out: PeacePage[] = [];
  for (const page of pages) {
    const id = `${page.org_key}\n${page.platform}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(page);
  }
  return out;
}
