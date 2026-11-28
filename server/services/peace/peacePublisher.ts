import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import {
  isPeaceSchemaMissing,
  markPeaceColumnsMissing,
  openedAtOf,
  peaceColumnsMissing,
  selectSession,
} from '../../lib/peaceSchema.js';
import { canonicalHandle, canonicalPlatform, usablePeaceFeed } from '../generation/peaceFeedCore.js';
import { runEngagementTick } from '../engagementAlgorithmService.js';
import { attachGeneratedPostMedia } from '../mediaGenerationService.js';
import { getWebSocketService } from '../websocketService.js';
import { insertSocialPost, isTopicSchemaMissing, topicKindColumns, topicSchemaMissing } from '../topic/topicColumns.js';
import type { PeaceFeed, PeaceFeedAuthor } from '../../../shared/peaceFeed.js';
import type { PeaceLaneSession } from './peaceLane.js';
import { peaceWindowSeconds, planPeacePublications, type PlannedPeaceItem } from './peaceLaneCore.js';

interface OrgPageRow {
  org_key: string;
  platform: string;
  page_handle: string;
  page_name: string;
}

interface PersonaRow {
  handle: string;
  name: string;
  type?: string;
}

interface PeaceAuthor {
  handle: string;
  displayName: string;
  authorType: string;
}

export interface PeacePublishDeps {
  engage?: typeof runEngagementTick;
  now?: number;
}

function errorText(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const record = err as { message?: string; details?: string; hint?: string };
  return `${record.message ?? ''} ${record.details ?? ''} ${record.hint ?? ''}`;
}

interface ScenarioPeaceCache {
  scenarioId: string;
  untilMs: number;
  feed: PeaceFeed | null;
  personas: PersonaRow[];
}

const scenarioCache = new Map<string, ScenarioPeaceCache>();

/** Tests change the scenario between calls. A live process keeps one read per peace. */
export function resetPeaceScenarioCacheForTests(): void {
  scenarioCache.clear();
}

async function loadScenarioPeace(
  sessionId: string,
  scenarioId: string,
  untilMs: number,
): Promise<{ feed: PeaceFeed | null; personas: PersonaRow[] }> {
  const hit = scenarioCache.get(sessionId);
  if (hit && hit.scenarioId === scenarioId && hit.untilMs === untilMs) {
    return { feed: hit.feed, personas: hit.personas };
  }
  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .maybeSingle();
  const initial = (scenario?.initial_state || {}) as Record<string, unknown>;
  const feed = usablePeaceFeed(initial.peace_period);
  const personas = (Array.isArray(initial.npc_personas) ? initial.npc_personas : []) as PersonaRow[];
  scenarioCache.set(sessionId, { scenarioId, untilMs, feed, personas });
  return { feed, personas };
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';
}

function pageFor(
  pages: readonly OrgPageRow[],
  author: Extract<PeaceFeedAuthor, { kind: 'page' }>,
): OrgPageRow | undefined {
  const key = author.org_key.trim().toLowerCase();
  const platform = canonicalPlatform(author.platform);
  return pages.find(
    (page) => page.org_key.trim().toLowerCase() === key && canonicalPlatform(page.platform) === platform,
  );
}

function personaFor(personas: readonly PersonaRow[], handle: string): PersonaRow | undefined {
  const wanted = canonicalHandle(handle).toLowerCase();
  if (!wanted) return undefined;
  return personas.find((persona) => canonicalHandle(String(persona.handle || '')).toLowerCase() === wanted);
}

function personaAuthor(persona: PersonaRow): PeaceAuthor {
  return {
    handle: canonicalHandle(persona.handle),
    displayName: persona.name || persona.handle,
    authorType: persona.type || 'npc_public',
  };
}

function resolvePostAuthor(
  author: PeaceFeedAuthor,
  pages: readonly OrgPageRow[],
  personas: readonly PersonaRow[],
): PeaceAuthor | null {
  if (author.kind === 'page') {
    const page = pageFor(pages, author);
    if (!page) return null;
    return { handle: page.page_handle, displayName: page.page_name, authorType: 'official_account' };
  }
  const persona = personaFor(personas, author.handle);
  return persona ? personaAuthor(persona) : null;
}

async function insertPeaceRow(row: Record<string, unknown>): Promise<{ id: string | null; stop: boolean }> {
  const run = (payload: Record<string, unknown>) =>
    supabaseAdmin.from('social_posts').insert(payload).select('id').single();
  const result = await insertSocialPost(row, run, (err) =>
    isTopicSchemaMissing(err) && errorText(err).includes('topic_kind'),
  );
  if (!result.error && result.data?.id) return { id: String(result.data.id), stop: false };
  if (result.error && isUniqueViolation(result.error)) return { id: null, stop: false };
  if (result.error && isPeaceSchemaMissing(result.error)) {
    markPeaceColumnsMissing();
    return { id: null, stop: true };
  }
  if (result.error) logger.warn({ error: result.error }, 'Peace post insert failed');
  return { id: null, stop: false };
}

function broadcastPost(sessionId: string, post: Record<string, unknown>): void {
  try {
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'social_post.created',
      data: { post },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.debug({ err, sessionId }, 'Peace post broadcast skipped');
  }
}

async function loadExisting(sessionId: string): Promise<Map<string, string> | null> {
  const { data, error } = await supabaseAdmin
    .from('social_posts')
    .select('id, peace_ref')
    .eq('session_id', sessionId)
    .not('peace_ref', 'is', null);
  if (error && isPeaceSchemaMissing(error)) {
    markPeaceColumnsMissing();
    return null;
  }
  if (error) {
    logger.warn({ error, sessionId }, 'Peace feed lookup failed');
    return new Map();
  }
  const known = new Map<string, string>();
  for (const row of (data || []) as Array<{ id?: string; peace_ref?: string }>) {
    if (row.peace_ref && row.id) known.set(row.peace_ref, row.id);
  }
  return known;
}

function rowFor(
  sessionId: string,
  item: PlannedPeaceItem<PeaceAuthor>,
  openedAtMs: number,
  parentId: string | undefined,
): Record<string, unknown> {
  const author = item.author;
  return {
    session_id: sessionId,
    platform: canonicalPlatform(item.platform),
    author_handle: author.handle,
    author_display_name: author.displayName,
    author_type: author.authorType,
    content: item.content,
    post_format: item.kind === 'post' ? item.postFormat : 'text',
    sentiment: 'neutral',
    like_count: 0,
    repost_count: 0,
    reply_count: 0,
    view_count: 0,
    virality_score: 0,
    content_flags: {},
    peace_ref: item.peaceRef,
    created_at: new Date(openedAtMs + item.offsetSeconds * 1000).toISOString(),
    ...topicKindColumns(true, 'normal', topicSchemaMissing()),
    ...(item.kind === 'comment' ? { reply_to_post_id: parentId } : {}),
  };
}

/**
 * Publish peace-feed rows whose offset has arrived, then the engagement tick
 * with ambient posts left off. Rows already published stay in the feed after
 * crisis start. The scheduler only calls this while the session is in peace.
 */
export async function publishPeaceFeed(session: PeaceLaneSession, deps: PeacePublishDeps = {}): Promise<void> {
  if (!env.enablePeacePeriod) return;
  const engage = deps.engage ?? runEngagementTick;
  const now = deps.now ?? Date.now();
  const finish = () => engage(session.id, { ambient: false });

  if (peaceColumnsMissing()) {
    await finish();
    return;
  }

  const clock = await selectSession<{
    scenario_id: string | null;
    start_time: string | null;
    opened_at?: string | null;
  }>('scenario_id, start_time', (query) => query.eq('id', session.id).maybeSingle());
  const openedAt = openedAtOf(clock.data);
  const scenarioId = clock.data?.scenario_id ? String(clock.data.scenario_id) : null;
  const startTime = typeof clock.data?.start_time === 'string' ? clock.data.start_time : null;
  if (!openedAt || !scenarioId) {
    await finish();
    return;
  }

  const untilMs = startTime ? Date.parse(startTime) : Number.NaN;
  const cached = await loadScenarioPeace(session.id, scenarioId, untilMs);
  const feed = cached.feed;
  if (!feed || feed.enabled === false) {
    await finish();
    return;
  }
  const personas = cached.personas;

  const [{ data: pageRows }, known] = await Promise.all([
    supabaseAdmin
      .from('sim_org_pages')
      .select('org_key, platform, page_handle, page_name')
      .eq('session_id', session.id),
    loadExisting(session.id),
  ]);
  if (!known) {
    await finish();
    return;
  }

  const pages = (pageRows || []) as OrgPageRow[];
  const openedAtMs = Date.parse(openedAt);
  const plan = planPeacePublications({
    posts: feed.posts,
    seconds: peaceWindowSeconds({
      openedAtMs,
      startTime,
      feedSeconds: typeof feed.seconds === 'number' ? feed.seconds : null,
      fallbackSeconds: env.peacePeriodDefaultSeconds,
    }),
    openedAtMs,
    now,
    already: new Set(known.keys()),
    postAuthor: (author) => resolvePostAuthor(author, pages, personas),
    commentAuthor: (handle) => {
      const persona = personaFor(personas, handle);
      return persona ? personaAuthor(persona) : null;
    },
  });

  for (const ref of plan.skippedUnresolved) {
    logger.debug({ sessionId: session.id, peaceRef: ref }, 'Peace item skipped: author does not resolve');
  }

  let published = 0;
  for (const item of plan.publish) {
    const parentId = item.kind === 'comment' ? known.get(item.parentRef) : undefined;
    if (item.kind === 'comment' && !parentId) continue;
    const row = rowFor(session.id, item, openedAtMs, parentId);
    const inserted = await insertPeaceRow(row);
    if (inserted.stop) break;
    if (!inserted.id) continue;
    known.set(item.peaceRef, inserted.id);
    published += 1;
    if (item.kind === 'comment' && parentId) {
      const { data: parent } = await supabaseAdmin
        .from('social_posts')
        .select('reply_count')
        .eq('id', parentId)
        .maybeSingle();
      const replyCount = Number((parent as { reply_count?: number } | null)?.reply_count) || 0;
      await supabaseAdmin.from('social_posts').update({ reply_count: replyCount + 1 }).eq('id', parentId);
    }
    broadcastPost(session.id, { ...row, id: inserted.id });
    if (item.kind === 'post' && env.peaceFeedMedia) {
      attachGeneratedPostMedia(inserted.id, item.mediaDescription, item.postFormat, 'Peace post media generation failed');
    }
  }

  if (published > 0) logger.info({ sessionId: session.id, published }, 'Peace feed rows published');
  await finish();
}
