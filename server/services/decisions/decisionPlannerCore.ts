/**
 * Organic executive decisions — planner core (pure; docs/executive-decisions-organic-plan.md §6.2).
 * Turns the model's proposed cascade into a bounded, scoped plan and shapes the runtime inject
 * rows. No IO.
 */
import type { StakeholderRelationship } from '../../lib/stakeholderContract.js';
import type {
  CastEntry,
  DecisionPlan,
  GrievanceOverride,
  PlanChannel,
  PlanNode,
  PlanNodeKind,
} from './decisionTypes.js';

export const MAX_NODES = 8;
export const MAX_DEPTH = 3;
/** Minutes after detection, by the reacting actor's relationship (plan §6.2). */
export const DELAY_BANDS: Record<StakeholderRelationship, { min: number; max: number }> = {
  internal: { min: 5, max: 20 },
  client: { min: 20, max: 60 },
  supplier: { min: 20, max: 60 },
  partner: { min: 20, max: 60 },
  union: { min: 30, max: 60 },
  media: { min: 30, max: 90 },
  regulator: { min: 60, max: 120 },
  investor: { min: 60, max: 180 },
  community: { min: 30, max: 90 },
  other: { min: 20, max: 90 },
};
/** Reversal rule (v1 answer #3): within this window and before any public artefact → cancel. */
export const REVERSAL_CANCEL_WINDOW_MINUTES = 15;

export function clampDelay(
  relationship: StakeholderRelationship,
  minutes: number,
  parentDelay = 0,
): number {
  const band = DELAY_BANDS[relationship] ?? DELAY_BANDS.other;
  const n = Number.isFinite(minutes) ? minutes : band.min;
  const clamped = Math.max(band.min, Math.min(band.max, Math.round(n)));
  // A child never fires before its parent (+3 min).
  return Math.max(clamped, parentDelay + 3);
}

export interface PlanContext {
  cast: Map<string, CastEntry>;
  /** Pressure pages by org_key → spokesperson id. */
  pressurePages: Map<
    string,
    { spokesperson_id: string; display_name: string; country: string | null }
  >;
  /** Deciding organisation + its country. */
  decisionOrgKey: string | null;
  decisionCountry: string | null;
  /** Protagonist org_key → country. */
  orgCountry: Map<string, string>;
  /** Public channels are unscoped when a footprint country has no human players. */
  unscopedCountries?: Set<string>;
}

interface RawNode {
  id?: unknown;
  kind?: unknown;
  actor_kind?: unknown;
  actor_id?: unknown;
  channel?: unknown;
  delay_minutes?: unknown;
  parent_node_id?: unknown;
  title?: unknown;
  body?: unknown;
  grievance_override?: unknown;
  learners?: unknown;
}

const KINDS: readonly PlanNodeKind[] = ['reaction', 'relay', 'public'];
const CHANNELS: readonly PlanChannel[] = [
  'email',
  'chat_dm',
  'social_post',
  'news',
  'page_statement',
  'phone',
];

/**
 * Normalise the model's nodes: drop unknown actors, clamp delays by relationship, cap the budget
 * and depth, enforce the scope rule (a reaction stays in the deciding org's country unless the
 * actor is common (org_key null) or the node is public), and route pressure-org spokespersons
 * to their page.
 */
export function normalisePlan(
  rawNodes: unknown,
  ctx: PlanContext,
  plannedAtMinute: number,
  version = 1,
): DecisionPlan {
  const list = Array.isArray(rawNodes) ? (rawNodes as RawNode[]) : [];
  const byId = new Map<string, PlanNode>();
  const order: PlanNode[] = [];
  // First pass: parents before children (sort by declared parent chain length)
  const raws = list
    .map((r, i) => ({ r, i, id: String(r.id || `n${i + 1}`) }))
    .filter((x) => x.r && typeof x.r === 'object');
  const declaredParent = new Map(
    raws.map((x) => [x.id, x.r.parent_node_id ? String(x.r.parent_node_id) : null]),
  );
  const depthOf = (id: string, guard = 0): number => {
    const p = declaredParent.get(id);
    if (!p || guard > 10 || !declaredParent.has(p)) return 0;
    return 1 + depthOf(p, guard + 1);
  };
  raws.sort((a, b) => depthOf(a.id) - depthOf(b.id) || a.i - b.i);

  for (const { r, id } of raws) {
    if (order.length >= MAX_NODES) break;
    const kind = KINDS.includes(r.kind as PlanNodeKind) ? (r.kind as PlanNodeKind) : 'reaction';
    const actorKind = String(r.actor_kind || 'stakeholder');
    const actorId = String(r.actor_id || '');
    const parentId = r.parent_node_id ? String(r.parent_node_id) : null;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parentId && !parent) continue; // dangling parent → drop
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_DEPTH - 1) continue;

    let channel = CHANNELS.includes(r.channel as PlanChannel)
      ? (r.channel as PlanChannel)
      : 'email';
    let relationship: StakeholderRelationship = 'other';
    let orgKey: string | null = ctx.decisionOrgKey;
    let country: string | null = ctx.decisionCountry;
    let targetTeams: string[] = [];
    let resolvedActorKind: PlanNode['actor_kind'] = 'stakeholder';
    let resolvedActorId = actorId;

    if (actorKind === 'page') {
      const page = ctx.pressurePages.get(actorId);
      if (!page) continue;
      resolvedActorKind = 'page';
      channel = 'page_statement';
      relationship = 'other';
      country = page.country;
      orgKey = null;
    } else if (actorKind === 'crowd') {
      resolvedActorKind = 'crowd';
      channel = 'social_post';
      relationship = 'community';
      orgKey = null;
    } else {
      const s = ctx.cast.get(actorId);
      if (!s) continue;
      if (s.tier === 'roster' && kind !== 'relay') continue; // roster entries never author reactions
      relationship = s.relationship;
      resolvedActorKind = s.kind === 'group' ? 'group' : 'stakeholder';
      targetTeams = [s.owning_team];
      // Scope rule: a private reaction stays within the deciding org's country unless the actor is common.
      if (s.org_key) {
        orgKey = s.org_key;
        country = ctx.orgCountry.get(s.org_key) ?? country;
        if (kind !== 'public' && ctx.decisionOrgKey && s.org_key !== ctx.decisionOrgKey) {
          // Cross-org private reaction: allowed only when the decision explicitly scopes that org.
          if (
            ctx.decisionOrgKey !== s.org_key &&
            ctx.decisionCountry &&
            country !== ctx.decisionCountry
          ) {
            continue;
          }
        }
      } else {
        orgKey = null;
      }
      // A pressure-org spokesperson speaks through the page for public statements.
      if (
        s.page_org_key &&
        (kind === 'public' || channel === 'social_post' || channel === 'page_statement')
      ) {
        const page = ctx.pressurePages.get(s.page_org_key);
        if (page) {
          resolvedActorKind = 'page';
          resolvedActorId = s.page_org_key;
          channel = 'page_statement';
          country = page.country;
          orgKey = null;
        }
      }
      if (
        kind === 'public' &&
        (channel === 'email' || channel === 'chat_dm' || channel === 'phone')
      )
        channel = 'social_post';
    }
    if (kind === 'public' && country && ctx.unscopedCountries?.has(country)) country = null;

    const delay = clampDelay(relationship, Number(r.delay_minutes), parent?.delay_minutes ?? 0);
    const title =
      String(r.title || '')
        .trim()
        .slice(0, 120) || `${resolvedActorId} reacts`;
    const body = String(r.body || '')
      .trim()
      .slice(0, 2000);
    if (kind !== 'relay' && body.length < 10) continue;

    const node: PlanNode = {
      id,
      kind,
      actor_kind: resolvedActorKind,
      actor_id: resolvedActorId,
      channel,
      delay_minutes: delay,
      parent_node_id: parent ? parent.id : null,
      depth,
      content: { title, body },
      target_teams: targetTeams,
      org_key: orgKey,
      country,
      ...(kind === 'relay' && Array.isArray(r.learners)
        ? {
            learners: (r.learners as unknown[])
              .map(String)
              .filter((l) => ctx.cast.has(l))
              .slice(0, 20),
          }
        : {}),
    };
    const go = normaliseOverride(r.grievance_override, relationship);
    if (go && kind === 'reaction' && resolvedActorKind !== 'crowd') node.grievance_override = go;
    byId.set(id, node);
    order.push(node);
  }
  return { version, planned_at_minute: plannedAtMinute, nodes: order };
}

function normaliseOverride(
  raw: unknown,
  relationship: StakeholderRelationship,
): GrievanceOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const grievance = String(r.grievance || '').trim();
  if (grievance.length < 8) return null;
  const persuadabilityRaw = String(r.persuadability || 'medium');
  let persuadability: GrievanceOverride['persuadability'] = (
    ['none', 'low', 'medium', 'high'] as const
  ).includes(persuadabilityRaw as 'none')
    ? (persuadabilityRaw as GrievanceOverride['persuadability'])
    : 'medium';
  if (relationship === 'regulator' && persuadability !== 'none' && persuadability !== 'low')
    persuadability = 'low';
  return {
    grievance: grievance.slice(0, 400),
    resolution_criteria: Array.isArray(r.resolution_criteria)
      ? (r.resolution_criteria as unknown[]).map(String).filter(Boolean).slice(0, 4)
      : [],
    persuadability,
    hard_constraints: Array.isArray(r.hard_constraints)
      ? (r.hard_constraints as unknown[]).map(String).slice(0, 3)
      : [],
  };
}

// ─── Inject rows ─────────────────────────────────────────────────────────────

export interface InjectAuthor {
  /** Stakeholder record fields (contract §4.2). */
  stakeholder?: {
    id: string;
    name: string;
    email: string;
    handle: string;
    phone: string | null;
    organisation: string;
  };
  /** Page identity when routed to a pressure page (contract v3.2 §4.4). */
  page?: {
    org_key: string;
    page_name: string;
    page_handle: string;
    platform: 'facebook' | 'x_twitter';
    spokesperson_id: string;
  };
}

export function injectRowForNode(
  node: PlanNode,
  author: InjectAuthor,
  ctx: {
    sessionId: string;
    scenarioId: string;
    decisionId: string;
    decisionKey: string;
    detectedAtMinute: number;
  },
): Record<string, unknown> | null {
  const injectKey = `dec_${ctx.decisionKey}_${node.id}`.slice(0, 80);
  const parentKey = node.parent_node_id
    ? `dec_${ctx.decisionKey}_${node.parent_node_id}`.slice(0, 80)
    : null;
  const base = {
    scenario_id: ctx.scenarioId,
    session_id: ctx.sessionId,
    title: node.content.title,
    content: node.content.body,
    severity: node.depth === 0 ? 'high' : 'medium',
    inject_scope:
      node.target_teams.length > 0 &&
      node.channel !== 'social_post' &&
      node.channel !== 'news' &&
      node.channel !== 'page_statement'
        ? 'team_specific'
        : 'universal',
    target_teams: node.target_teams,
    requires_response: true,
    requires_coordination: false,
    ai_generated: true,
    generation_source: 'decision_response',
    // Chained nodes wait for their parent to publish; roots fire on the clock. Minute columns are
    // INTEGER, so round defensively even though the context already supplies whole minutes.
    trigger_time_minutes: parentKey ? null : Math.round(ctx.detectedAtMinute + node.delay_minutes),
    ...(parentKey
      ? {
          conditions_to_appear: { threshold: 1, conditions: [`inject_published:${parentKey}`] },
          eligible_after_minutes: Math.round(ctx.detectedAtMinute + node.delay_minutes),
        }
      : {}),
  };
  const common = {
    inject_key: injectKey,
    ...(parentKey ? { parent_inject_key: parentKey } : {}),
    decision_id: ctx.decisionId,
    ...(node.org_key ? { org_key: node.org_key } : {}),
    ...(node.country ? { country: node.country } : {}),
  };
  if (node.actor_kind === 'page') {
    if (!author.page) return null;
    return {
      ...base,
      type: 'social_post',
      delivery_config: {
        app: 'social_feed',
        platform: author.page.platform,
        page_org_key: author.page.org_key,
        stakeholder_id: author.page.spokesperson_id,
        author_handle: author.page.page_handle,
        author_display_name: author.page.page_name,
        author_type: 'official_account',
        ...common,
      },
    };
  }
  if (node.actor_kind === 'crowd') {
    return {
      ...base,
      type: 'social_post',
      delivery_config: {
        app: 'social_feed',
        platform: 'x_twitter',
        author_type: 'npc_public',
        ...common,
      },
    };
  }
  const s = author.stakeholder;
  if (!s) return null;
  switch (node.channel) {
    case 'email':
      return {
        ...base,
        type: 'email',
        delivery_config: {
          app: 'email',
          from_address: s.email,
          from_name: s.name,
          stakeholder_id: s.id,
          email_category: 'stakeholder',
          ...common,
        },
      };
    case 'phone':
      return {
        ...base,
        type: 'phone_call',
        delivery_config: {
          app: 'phone_call',
          from_address: s.phone || s.email,
          from_name: s.name,
          stakeholder_id: s.id,
          ...common,
        },
      };
    case 'news':
      return {
        ...base,
        type: 'news_article',
        delivery_config: {
          app: 'news',
          outlet_name: s.organisation,
          author_handle: s.handle,
          author_display_name: s.name,
          stakeholder_id: s.id,
          ...common,
        },
      };
    case 'social_post':
    case 'page_statement':
      return {
        ...base,
        type: 'social_post',
        delivery_config: {
          app: 'social_feed',
          platform: 'x_twitter',
          author_handle: s.handle,
          author_display_name: s.name,
          author_type: 'npc_media',
          stakeholder_id: s.id,
          ...common,
        },
      };
    case 'chat_dm':
    default:
      // Chat DMs are delivered by the cascade tick as NPC messages, not as injects.
      return null;
  }
}

// ─── Reversal rule ───────────────────────────────────────────────────────────

export type ReversalOutcome = 'cancel' | 'modify' | 'second_wave';

export function reversalOutcome(input: {
  originalDetectedAtMinute: number;
  reversalAtMinute: number;
  anyPublicArtefactFired: boolean;
}): ReversalOutcome {
  const within =
    input.reversalAtMinute - input.originalDetectedAtMinute <= REVERSAL_CANCEL_WINDOW_MINUTES;
  if (within && !input.anyPublicArtefactFired) return 'cancel';
  if (!input.anyPublicArtefactFired) return 'modify';
  return 'second_wave';
}
