/**
 * Organic executive decisions — planner (docs/executive-decisions-organic-plan.md §6.2).
 * One LLM call per confirmed decision → bounded plan → runtime inject rows (reactions / public
 * beats) + relay nodes for the cascade tick. Reversals cancel / soften / add a U-turn beat.
 */
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { callSocialCrisisAI } from '../socialCrisisGeneratorService.js';
import type { DecisionContextBundle } from './decisionContext.js';
import { castForPrompt } from './decisionContext.js';
import {
  injectRowForNode,
  normalisePlan,
  reversalOutcome,
  type PlanContext,
} from './decisionPlannerCore.js';
import { addDecisionEvent, updateDecisionDetail, getDecision } from './decisionLedger.js';
import type { DecisionRecord, PlanNode } from './decisionTypes.js';

function planContextFor(ctx: DecisionContextBundle, decision: DecisionRecord): PlanContext {
  const humanCountries = new Set(
    ctx.registry
      .filter((o) => o.side === 'protagonist' && o.operation !== 'ai' && o.country)
      .map((o) => String(o.country)),
  );
  const unscoped = new Set<string>();
  for (const c of ctx.orgCountry.values()) if (!humanCountries.has(c)) unscoped.add(c);
  return {
    cast: ctx.cast,
    pressurePages: new Map(
      Array.from(ctx.pressurePages.entries()).map(([k, v]) => [
        k,
        { spokesperson_id: v.spokesperson_id, display_name: v.display_name, country: v.country },
      ]),
    ),
    decisionOrgKey: decision.org_key,
    decisionCountry:
      decision.detail.scope.country ??
      (decision.org_key ? (ctx.orgCountry.get(decision.org_key) ?? null) : null),
    orgCountry: ctx.orgCountry,
    unscopedCountries: unscoped,
  };
}

export async function planCascade(
  ctx: DecisionContextBundle,
  decision: DecisionRecord,
): Promise<void> {
  const d = decision.detail;
  const toldIds = new Set(
    d.informed
      .filter((a) => a.actor_kind === 'stakeholder' || a.actor_kind === 'group')
      .map((a) => a.actor_id),
  );
  const pressureLines = Array.from(ctx.pressurePages.entries())
    .map(([k, v]) => `- page ${k}: ${v.display_name} (spokesperson ${v.spokesperson_id})`)
    .join('\n');
  const raw = await callSocialCrisisAI(
    `You plan the CONSEQUENCES of an executive decision in a crisis simulation. Nothing is scripted: you decide who reacts, how, when, and what a team could still do about it. Consequences travel through the organisation and out to stakeholders on realistic delays.

Produce 4-8 nodes. Kinds:
- "relay": an INSIDER who was not told finds out (site leader tells supervisors, a supervisor tells the floor, an EA tells the board). No public artefact; it moves knowledge. Include "learners" (cast ids).
- "reaction": a stakeholder acts because of what they now know — an email or phone call to the team that owns them, a social post, a news article. Roster employees never author reactions (they act through the union rep / distribution list / a reporter).
- "public": a public artefact (social post / news / page statement) that everyone in that country sees.

For each node: { "id": "n1", "kind": "relay|reaction|public", "actor_kind": "stakeholder|group|page|crowd", "actor_id": "<cast id or page org_key>", "channel": "email|chat_dm|social_post|news|page_statement|phone", "delay_minutes": <minutes after detection>, "parent_node_id": "<id or null>", "title": "<inject title>", "body": "<the actual message / post / article text, in the actor's voice, 40-600 chars>", "grievance_override": { "grievance": "<what this person now holds against the organisation because of THIS decision and how they learnt it>", "resolution_criteria": ["<checkable things a team could say/do that would make them soften or withdraw>"], "persuadability": "none|low|medium|high", "hard_constraints": [] }, "learners": ["<ids for relay nodes>"] }

Rules:
- Delays by relationship: internal 5-20, client/partner/supplier 20-60, union 30-60, media 30-90, regulator 60-120, investor 60-180 minutes.
- People who were TOLD directly by leadership react to the substance; people who FIND OUT react to the substance AND to having been kept in the dark (say so in the grievance).
- Someone who should have been told first and was not → the grievance names it ("heard it from the drivers, not from HR").
- A workforce representative / regulator reacts through a pressure PAGE when one exists (actor_kind "page").
- Depth <= 3; every reaction is something a team could still influence by reaching the actor first.
- Never invent ids. Return ONLY valid JSON: { "nodes": [ ... ] }`,
    `DECISION (T+${Math.round(d.detected_at_minute)} min): ${d.summary}
Category: ${d.category}. Scope: ${d.scope.subject} (${d.scope.org_key || 'primary'}${d.scope.country ? `, ${d.scope.country}` : ''}).
Told directly: ${Array.from(toldIds).join(', ') || 'nobody outside the executive team'}; teams told: ${
      d.informed
        .filter((a) => a.actor_kind === 'team')
        .map((a) => a.actor_id)
        .join(', ') || 'none'
    }.
Should have been told: ${d.should_know_stakeholder_ids.join(', ') || '—'}; functions: ${d.should_know_functions.join(', ') || '—'}.
Affected: ${d.affected_stakeholder_ids.join(', ') || '—'}.
Leakiness of this organisation: ${ctx.decisionContext.leakiness} (0 tight … 1 leaky).
Crisis: ${ctx.crisisDescription.slice(0, 700)}
Confirmed facts: ${ctx.factSheet.confirmed_facts.slice(0, 5).join('; ') || '—'}
${pressureLines ? `PRESSURE PAGES:\n${pressureLines}` : ''}
CAST:
${castForPrompt(ctx)}`,
    6000,
    0.6,
  );
  const plan = normalisePlan(
    (raw as { nodes?: unknown } | null)?.nodes,
    planContextFor(ctx, decision),
    ctx.elapsedMinutes,
    (d.plan?.version ?? 0) + 1,
  );
  if (plan.nodes.length === 0) {
    logger.warn({ decisionId: decision.id }, 'cascade plan empty');
    await updateDecisionDetail(decision.id, { ...d, plan });
    return;
  }
  await materialisePlan(ctx, decision, plan.nodes);
  await updateDecisionDetail(decision.id, { ...d, plan });
  logger.info(
    {
      decisionId: decision.id,
      nodes: plan.nodes.length,
      injects: plan.nodes.filter((n) => n.inject_id).length,
    },
    'cascade planned',
  );
}

/** Write reaction / public nodes as session-scoped runtime injects; relays stay in the plan. */
async function materialisePlan(
  ctx: DecisionContextBundle,
  decision: DecisionRecord,
  nodes: PlanNode[],
): Promise<void> {
  const detectedAt = decision.detail.detected_at_minute;
  for (const node of nodes) {
    if (node.kind === 'relay' || node.channel === 'chat_dm') continue;
    const row = injectRowForNode(node, authorFor(ctx, node), {
      sessionId: ctx.session.id,
      scenarioId: ctx.session.scenario_id,
      decisionId: decision.id,
      decisionKey: decision.decision_key,
      detectedAtMinute: detectedAt,
    });
    if (!row) continue;
    const { data, error } = await supabaseAdmin
      .from('scenario_injects')
      .insert(row)
      .select('id')
      .single();
    if (error || !data) {
      logger.warn(
        { error, decisionId: decision.id, node: node.id },
        'cascade inject insert failed',
      );
      continue;
    }
    node.inject_id = String(data.id);
    node.inject_key = String((row.delivery_config as { inject_key: string }).inject_key);
    await addDecisionEvent({
      session_id: ctx.session.id,
      decision_id: decision.id,
      parent_id: null,
      kind: 'reaction_planned',
      actor_kind: node.actor_kind,
      actor_id: node.actor_id,
      at_minute: detectedAt + node.delay_minutes,
      ref_table: 'scenario_injects',
      ref_id: node.inject_id,
      summary: `${node.content.title} (${node.channel}, planned T+${Math.round(detectedAt + node.delay_minutes)})`,
    });
  }
}

function authorFor(ctx: DecisionContextBundle, node: PlanNode) {
  if (node.actor_kind === 'page') {
    const p = ctx.pressurePages.get(node.actor_id);
    if (!p) return {};
    const platform: 'facebook' | 'x_twitter' = p.page.x_twitter ? 'x_twitter' : 'facebook';
    const ident = platform === 'x_twitter' ? p.page.x_twitter : p.page.facebook;
    return {
      page: {
        org_key: node.actor_id,
        page_name: String(ident.page_name),
        page_handle: String(ident.page_handle),
        platform,
        spokesperson_id: p.spokesperson_id,
      },
    };
  }
  const s = ctx.stakeholderById.get(node.actor_id);
  if (!s) return {};
  return {
    stakeholder: {
      id: s.id,
      name: s.name,
      email: s.email,
      handle: s.handle,
      phone: s.phone,
      organisation: s.organisation,
    },
  };
}

// ─── Reversal + cancellation ─────────────────────────────────────────────────

export async function applyReversal(
  ctx: DecisionContextBundle,
  reversal: DecisionRecord,
  originalId: string,
): Promise<void> {
  const original = await getDecision(originalId);
  if (!original) return;
  const nodes = original.detail.plan?.nodes || [];
  const anyPublicFired = nodes.some(
    (n) =>
      (n.kind === 'public' ||
        n.channel === 'social_post' ||
        n.channel === 'news' ||
        n.channel === 'page_statement') &&
      n.fired_at_minute != null,
  );
  const outcome = reversalOutcome({
    originalDetectedAtMinute: original.detail.detected_at_minute,
    reversalAtMinute: ctx.elapsedMinutes,
    anyPublicArtefactFired: anyPublicFired,
  });
  const pendingIds = nodes
    .filter((n) => n.inject_id && n.fired_at_minute == null)
    .map((n) => n.inject_id!) as string[];
  if (outcome === 'cancel' && pendingIds.length > 0) {
    await supabaseAdmin
      .from('scenario_injects')
      .delete()
      .in('id', pendingIds)
      .eq('session_id', ctx.session.id);
    for (const n of nodes) if (n.inject_id && pendingIds.includes(n.inject_id)) n.inject_id = null;
  } else if (outcome === 'modify' && pendingIds.length > 0) {
    for (const id of pendingIds) {
      const node = nodes.find((n) => n.inject_id === id)!;
      await supabaseAdmin
        .from('scenario_injects')
        .update({
          content: `${node.content.body}\n\n(Update: leadership has since reversed course — "${reversal.detail.summary}". The U-turn itself is now the story.)`,
          severity: 'medium',
        })
        .eq('id', id)
        .eq('session_id', ctx.session.id);
    }
  }
  await updateDecisionDetail(original.id, original.detail, 'reversed');
  await addDecisionEvent({
    session_id: ctx.session.id,
    decision_id: original.id,
    parent_id: null,
    kind: 'reversed',
    actor_kind: 'player',
    actor_id: reversal.detail.author_user_id,
    at_minute: ctx.elapsedMinutes,
    ref_table: null,
    ref_id: reversal.id,
    summary: `Reversed by "${reversal.detail.summary}" — ${outcome} (${pendingIds.length} pending reaction(s))`,
  });
  logger.info({ originalId, reversalId: reversal.id, outcome }, 'decision reversed');
}

/** Delete unfired cascade injects for a decision (trainer dismissal). Returns the count. */
export async function cancelPendingCascade(
  sessionId: string,
  decision: DecisionRecord,
): Promise<number> {
  const nodes = decision.detail.plan?.nodes || [];
  const ids = nodes
    .filter((n) => n.inject_id && n.fired_at_minute == null)
    .map((n) => n.inject_id!) as string[];
  if (ids.length === 0) return 0;
  // Publication is tracked by session_events (type 'inject', metadata.inject_id); unfired rows are safe to remove.
  const { data: fired } = await supabaseAdmin
    .from('session_events')
    .select('metadata')
    .eq('session_id', sessionId)
    .eq('event_type', 'inject')
    .in('metadata->>inject_id', ids);
  const firedIds = new Set(
    (fired || []).map((r) => String((r.metadata as { inject_id?: string })?.inject_id || '')),
  );
  const deletable = ids.filter((id) => !firedIds.has(id));
  if (deletable.length === 0) return 0;
  const { error } = await supabaseAdmin
    .from('scenario_injects')
    .delete()
    .in('id', deletable)
    .eq('session_id', sessionId);
  if (error) logger.warn({ error, sessionId }, 'cancelPendingCascade delete failed');
  return deletable.length;
}
