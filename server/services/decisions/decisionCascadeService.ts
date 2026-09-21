/**
 * Organic executive decisions — cascade tick + notice assessment + grievance override
 * (docs/executive-decisions-organic-plan.md §6.3–§6.6).
 *
 * Every tick, per active decision: relay nodes whose time has come move knowledge and deliver a
 * "found out" message from the carrier to the team that owns them; should-know actors nobody told
 * find out by rumour after a grace period; fired cascade injects mark public exposure for their
 * country and are logged as reaction_fired; stakeholder verdicts on cascade injects are mirrored
 * into the cascade tree.
 */
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { callSocialCrisisAI } from '../socialCrisisGeneratorService.js';
import { getWebSocketService } from '../websocketService.js';
import { createNotificationsForUsers } from '../notificationService.js';
import { getTeamsByFunction } from '../orgRegistryService.js';
import { getSessionPlayerDirectory } from '../playerDirectoryService.js';
import { appendConversation } from '../stakeholderReplyService.js';
import { registerGrievanceOverrideResolver } from '../stakeholderReconsiderationService.js';
import { recordPlayerAction } from '../sopCheckerService.js';
import { gradePlayerContent } from '../contentGraderService.js';
import type { Stakeholder } from '../../lib/stakeholderContract.js';
import { emitSessionEvent } from './sessionEventEmitter.js';
import { loadDecisionContext, type DecisionContextBundle } from './decisionContext.js';
import {
  addDecisionEvent,
  listDecisions,
  loadKnowledge,
  saveKnowledge,
  updateDecisionDetail,
} from './decisionLedger.js';
import {
  actorKey,
  expandGroups,
  learn,
  publicExposure,
  rankOf,
  relayProbability,
  shouldKnowGap,
} from './decisionKnowledgeCore.js';
import type { DecisionRecord, DecisionSource, PlanNode } from './decisionTypes.js';

const RUMOUR_GRACE_MINUTES = 15;
const MAX_RELAYS_PER_TICK = 2;

export async function runDecisionTick(sessionId: string, elapsedMinutes: number): Promise<void> {
  if (!env.enableExecutiveDecisions) return;
  const decisions = (await listDecisions(sessionId)).filter((d) => d.status === 'active');
  if (decisions.length === 0) return;
  const ctx = await loadDecisionContext(sessionId);
  if (!ctx) return;
  ctx.elapsedMinutes = elapsedMinutes;
  for (const d of decisions) {
    try {
      await tickDecision(ctx, d);
    } catch (err) {
      logger.warn({ err, decisionId: d.id }, 'decision tick failed');
    }
  }
}

async function tickDecision(ctx: DecisionContextBundle, decision: DecisionRecord): Promise<void> {
  const detail = decision.detail;
  const plan = detail.plan;
  const now = ctx.elapsedMinutes;
  const knowledge = await loadKnowledge(ctx.session.id, decision.id);
  const groups = new Map<string, string[]>();
  for (const s of ctx.stakeholders)
    if (s.kind === 'group' && s.members) groups.set(s.id, s.members);
  let dirty = false;
  let relays = 0;

  // 1. Fired cascade injects → reaction_fired + public exposure; verdicts mirrored.
  if (plan) {
    const injectIds = plan.nodes
      .filter((n) => n.inject_id && n.fired_at_minute == null)
      .map((n) => n.inject_id!) as string[];
    if (injectIds.length > 0) {
      const [{ data: fired }, { data: verdicts }] = await Promise.all([
        supabaseAdmin
          .from('session_events')
          .select('metadata, created_at')
          .eq('session_id', ctx.session.id)
          .eq('event_type', 'inject')
          .in('metadata->>inject_id', injectIds),
        supabaseAdmin
          .from('session_events')
          .select('metadata')
          .eq('session_id', ctx.session.id)
          .eq('event_type', 'stakeholder_verdict')
          .in('metadata->>inject_id', injectIds),
      ]);
      for (const row of fired || []) {
        const id = String((row.metadata as { inject_id?: string })?.inject_id || '');
        const node = plan.nodes.find((n) => n.inject_id === id);
        if (!node) continue;
        node.fired_at_minute = now;
        dirty = true;
        await addDecisionEvent({
          session_id: ctx.session.id,
          decision_id: decision.id,
          parent_id: null,
          kind:
            node.kind === 'public' ||
            node.channel === 'social_post' ||
            node.channel === 'news' ||
            node.channel === 'page_statement'
              ? 'public_effect'
              : 'reaction_fired',
          actor_kind: node.actor_kind,
          actor_id: node.actor_id,
          at_minute: now,
          ref_table: 'scenario_injects',
          ref_id: id,
          summary: node.content.title,
        });
        if (
          node.kind === 'public' ||
          node.channel === 'social_post' ||
          node.channel === 'news' ||
          node.channel === 'page_statement'
        ) {
          const candidates = ctx.stakeholders
            .filter((s) => s.tier !== 'roster')
            .map((s) => ({
              actor_kind: 'stakeholder' as const,
              actor_id: s.id,
              country: s.org_key ? (ctx.orgCountry.get(s.org_key) ?? null) : null,
            }));
          const changed = publicExposure(knowledge, candidates, node.country, now, {
            ref_table: 'scenario_injects',
            ref_id: id,
          });
          await saveKnowledge(ctx.session.id, decision.id, changed);
        }
      }
      const seenVerdicts = new Set((detail as { verdict_events?: string[] }).verdict_events || []);
      for (const row of verdicts || []) {
        const m = row.metadata as {
          inject_id?: string;
          verdict?: string;
          stakeholder_id?: string;
          reason?: string;
        };
        const key = `${m.inject_id}:${m.verdict}`;
        if (!m.inject_id || seenVerdicts.has(key)) continue;
        seenVerdicts.add(key);
        const node = plan.nodes.find((n) => n.inject_id === m.inject_id);
        const kind =
          m.verdict === 'cancel'
            ? 'reaction_withdrawn'
            : m.verdict === 'modify'
              ? 'reaction_softened'
              : m.verdict === 'delay'
                ? 'reaction_delayed'
                : null;
        if (kind && node) {
          await addDecisionEvent({
            session_id: ctx.session.id,
            decision_id: decision.id,
            parent_id: null,
            kind,
            actor_kind: node.actor_kind,
            actor_id: node.actor_id,
            at_minute: now,
            ref_table: 'scenario_injects',
            ref_id: m.inject_id,
            summary: `${node.content.title}: ${m.verdict}${m.reason ? ` — ${String(m.reason).slice(0, 160)}` : ''}`,
          });
          dirty = true;
        }
      }
      (detail as { verdict_events?: string[] }).verdict_events = Array.from(seenVerdicts);
    }

    // 2. Planned relays whose time has come.
    for (const node of plan.nodes) {
      if (relays >= MAX_RELAYS_PER_TICK) break;
      if (node.kind !== 'relay' && node.channel !== 'chat_dm') continue;
      if (node.relayed) continue;
      if (now < detail.detected_at_minute + node.delay_minutes) continue;
      const learners = (
        node.learners && node.learners.length > 0 ? node.learners : [node.actor_id]
      ).filter((id) => ctx.cast.has(id));
      const changed = learn(
        knowledge,
        expandGroups(
          learners.map((id) => ({
            actor_kind: (ctx.cast.get(id)?.kind === 'group' ? 'group' : 'stakeholder') as
              | 'group'
              | 'stakeholder',
            actor_id: id,
          })),
          groups,
        ),
        node.kind === 'relay' ? 'rumour' : 'informed',
        'internal_relay',
        node.actor_id,
        now,
      );
      await saveKnowledge(ctx.session.id, decision.id, changed);
      node.relayed = true;
      dirty = true;
      relays++;
      const carrier = ctx.stakeholderById.get(node.actor_id);
      if (carrier && carrier.tier !== 'roster') {
        await deliverFoundOutMessage(
          ctx,
          decision,
          carrier,
          node.content.body ||
            `I'm hearing that ${detail.summary}. Is that right? Nobody has told us anything.`,
          'internal_relay',
        );
      }
      await addDecisionEvent({
        session_id: ctx.session.id,
        decision_id: decision.id,
        parent_id: null,
        kind: 'found_out',
        actor_kind: node.actor_kind,
        actor_id: node.actor_id,
        at_minute: now,
        ref_table: null,
        ref_id: null,
        summary: `${node.content.title} → ${learners.length} learner(s) via internal relay`,
      });
    }
  }

  // 3. Rumour: should-know actors nobody told, past the grace period, find out (probabilistic on leakiness).
  const shouldKnow = detail.should_know_stakeholder_ids.map((id) => ({
    actor_kind: 'stakeholder' as const,
    actor_id: id,
  }));
  const gap = shouldKnowGap(knowledge, shouldKnow);
  if (
    gap.length > 0 &&
    now - detail.detected_at_minute >= RUMOUR_GRACE_MINUTES &&
    relays < MAX_RELAYS_PER_TICK
  ) {
    const p = relayProbability(
      ctx.decisionContext.leakiness,
      now - detail.detected_at_minute - RUMOUR_GRACE_MINUTES,
    );
    if (Math.random() < p) {
      const target = gap[0];
      const changed = learn(knowledge, [target], 'rumour', 'grievance_relay', 'rumour', now);
      await saveKnowledge(ctx.session.id, decision.id, changed);
      const s = ctx.stakeholderById.get(target.actor_id);
      if (s && s.tier !== 'roster') {
        await deliverFoundOutMessage(
          ctx,
          decision,
          s,
          `I have just heard — not from you — that ${detail.summary.replace(/\.$/, '')}. I would have expected to hear this from the organisation first. Can you confirm what is happening and what it means for the people I am responsible for?`,
          'grievance_relay',
        );
        await addDecisionEvent({
          session_id: ctx.session.id,
          decision_id: decision.id,
          parent_id: null,
          kind: 'found_out',
          actor_kind: 'stakeholder',
          actor_id: s.id,
          at_minute: now,
          ref_table: null,
          ref_id: null,
          summary: `${s.name} found out by rumour (should have been told)`,
        });
        await emitSessionEvent(ctx.session.id, 'decision_propagated', 'trainer_alert', {
          description: `${s.name} found out about "${detail.summary}" by rumour`,
          metadata: {
            decision_id: decision.id,
            stakeholder_id: s.id,
            via: 'grievance_relay',
            kind: 'decision_propagated',
          },
        });
      }
      dirty = true;
    }
  }

  if (dirty) await updateDecisionDetail(decision.id, detail);
}

/** "Found out" message from a carrier to the players of the team that owns them (email or TeamChat DM). */
async function deliverFoundOutMessage(
  ctx: DecisionContextBundle,
  decision: DecisionRecord,
  carrier: Stakeholder,
  body: string,
  via: 'internal_relay' | 'grievance_relay',
): Promise<void> {
  const teams = await getTeamsByFunction(ctx.session.id, carrier.owning_team, carrier.org_key);
  const userIds = Array.from(new Set(teams.flatMap((t) => t.member_user_ids)));
  const subject = `Re: ${decision.detail.scope.subject || decision.detail.summary.slice(0, 60)}`;
  if (userIds.length === 0) {
    logger.info(
      { decisionId: decision.id, carrier: carrier.id },
      'found-out message: owning team unstaffed (AI org) — knowledge only',
    );
    return;
  }
  const directory = await getSessionPlayerDirectory(ctx.session.id);
  const toAddresses = directory.filter((d) => userIds.includes(d.user_id)).map((d) => d.address);
  const { data: email, error } = await supabaseAdmin
    .from('sim_emails')
    .insert({
      session_id: ctx.session.id,
      direction: 'inbound',
      from_address: carrier.email,
      from_name: carrier.name,
      to_addresses: toAddresses,
      cc_addresses: [],
      subject,
      body_text: body,
      body_html: `<p>${body.replace(/\n/g, '</p><p>')}</p>`,
      priority: 'high',
      email_category: 'general',
      inject_id: null,
      sent_by_player_id: null,
      recipient_user_ids: userIds,
    })
    .select('*')
    .single();
  if (error || !email) {
    logger.warn({ error, carrier: carrier.id }, 'found-out email insert failed');
    return;
  }
  await appendConversation({
    sessionId: ctx.session.id,
    stakeholderId: carrier.id,
    channel: 'email',
    direction: 'npc',
    content: `Subject: ${subject}\n${body}`,
    refTable: 'sim_emails',
    refId: String(email.id),
  }).catch(() => undefined);
  try {
    getWebSocketService().broadcastToSession(ctx.session.id, {
      type: 'sim_email.received',
      data: { email },
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* non-critical */
  }
  await createNotificationsForUsers(userIds, {
    sessionId: ctx.session.id,
    type: 'inject_published',
    title: `${carrier.name}: ${subject}`,
    message: body.slice(0, 100),
    priority: 'high',
    metadata: { email_id: email.id, stakeholder_id: carrier.id, decision_id: decision.id, via },
    actionUrl: `/sessions/${ctx.session.id}#mail`,
  }).catch(() => undefined);
}

// ─── Formal notice (§6.6) ────────────────────────────────────────────────────

export async function assessNotice(
  ctx: DecisionContextBundle,
  decision: DecisionRecord,
  input: {
    userId: string;
    authorFunction: string | null;
    recipients: Stakeholder[];
    text: string;
    source: DecisionSource;
  },
): Promise<void> {
  const now = ctx.elapsedMinutes;
  const detail = decision.detail;
  const knowledge = await loadKnowledge(ctx.session.id, decision.id);
  const groups = new Map<string, string[]>();
  for (const s of ctx.stakeholders)
    if (s.kind === 'group' && s.members) groups.set(s.id, s.members);
  const actors = expandGroups(
    input.recipients.map((s) => ({
      actor_kind: (s.kind === 'group' ? 'group' : 'stakeholder') as 'group' | 'stakeholder',
      actor_id: s.id,
    })),
    groups,
  );
  const repsNotifiedBefore =
    input.recipients.some((s) => s.relationship === 'union') ||
    Array.from(knowledge.values()).some(
      (k) =>
        k.state === 'officially_notified' &&
        ctx.stakeholderById.get(k.actor_id)?.relationship === 'union',
    );
  const notifyingEmployees = input.recipients.some(
    (s) => s.kind === 'group' || s.tier === 'roster',
  );
  const changed = learn(
    knowledge,
    actors,
    'officially_notified',
    'formal_notice',
    input.userId,
    now,
    { ref_table: input.source.ref_table, ref_id: input.source.ref_id },
  );
  await saveKnowledge(ctx.session.id, decision.id, changed);

  const anyPublicFired = (detail.plan?.nodes || []).some(
    (n) =>
      (n.kind === 'public' ||
        n.channel === 'social_post' ||
        n.channel === 'news' ||
        n.channel === 'page_statement') &&
      n.fired_at_minute != null,
  );
  const anyRumour = Array.from(knowledge.values()).some(
    (k) => k.learned_via === 'grievance_relay' || k.learned_via === 'internal_relay',
  );
  const stepIds: string[] = [];
  if (
    input.recipients.some(
      (s) => s.relationship === 'union' || /steward|representative|council/i.test(s.title),
    )
  )
    stepIds.push('notify_workforce_representatives');
  if (notifyingEmployees) stepIds.push('notify_affected_employees');
  if (
    input.recipients.some(
      (s) =>
        s.relationship === 'internal' &&
        /manager|head|director|hr|human resources/i.test(s.title) &&
        s.kind !== 'group',
    )
  )
    stepIds.push('brief_site_leadership');

  let toneGrade: number | null = null;
  try {
    const grade = await gradePlayerContent(input.text, {
      crisis_description: ctx.crisisDescription,
      confirmed_facts: ctx.factSheet.confirmed_facts,
      post_format: 'text',
      elapsed_minutes: now,
      org_name: ctx.registry.find((o) => o.is_primary)?.display_name,
    });
    toneGrade =
      typeof (grade as { overall?: number })?.overall === 'number'
        ? (grade as { overall: number }).overall
        : null;
  } catch {
    /* grading is best-effort */
  }
  for (const stepId of stepIds.length > 0 ? stepIds : ['notify_affected_employees']) {
    await recordPlayerAction(
      ctx.session.id,
      input.userId,
      input.source.ref_table === 'chat_messages' ? 'dm_sent' : 'email_sent',
      input.source.ref_id,
      input.text.slice(0, 2000),
      {
        decision_id: decision.id,
        notice: true,
        recipients: input.recipients.map((s) => s.id),
        tone_grade: toneGrade,
      },
      stepId,
    ).catch(() => undefined);
  }
  const coverage =
    actors.filter(
      (a) =>
        rankOf(knowledge.get(actorKey(a))?.state ?? 'unaware') >= rankOf('officially_notified'),
    ).length / Math.max(1, actors.length);
  detail.notice = {
    at_minute: now,
    order_ok: notifyingEmployees ? repsNotifiedBefore : true,
    before_leak: !anyPublicFired && !anyRumour,
    tone_grade: toneGrade,
    coverage,
    by_user_id: input.userId,
    step_ids: stepIds,
  };
  await updateDecisionDetail(decision.id, detail);
  await addDecisionEvent({
    session_id: ctx.session.id,
    decision_id: decision.id,
    parent_id: null,
    kind: 'notice_sent',
    actor_kind: 'player',
    actor_id: input.userId,
    at_minute: now,
    ref_table: input.source.ref_table,
    ref_id: input.source.ref_id,
    summary: `Formal notice to ${input.recipients.map((s) => s.name).join(', ')} (${detail.notice.order_ok ? 'right order' : 'employees before representatives'}, ${detail.notice.before_leak ? 'before any leak' : 'after it leaked'})`,
  });
  // Soften unfired reactions of notified actors: push them out so the judge sees the notice first.
  const notifiedIds = new Set(actors.map((a) => a.actor_id));
  const pushed: PlanNode[] = [];
  for (const n of detail.plan?.nodes || []) {
    if (n.inject_id && n.fired_at_minute == null && notifiedIds.has(n.actor_id)) pushed.push(n);
  }
  for (const n of pushed) {
    await supabaseAdmin
      .from('scenario_injects')
      .update({
        trigger_time_minutes: Math.round(
          Math.max(now + 10, detail.detected_at_minute + n.delay_minutes + 10),
        ),
      })
      .eq('id', n.inject_id!)
      .eq('session_id', ctx.session.id)
      .not('trigger_time_minutes', 'is', null);
  }
  logger.info(
    { decisionId: decision.id, recipients: input.recipients.map((s) => s.id), stepIds, toneGrade },
    'formal notice assessed',
  );
}

// ─── Grievance override resolver (§6.4) ──────────────────────────────────────

export function registerDecisionGrievanceResolver(): void {
  registerGrievanceOverrideResolver(async (sessionId, stakeholder) => {
    const decisions = (await listDecisions(sessionId))
      .filter((d) => d.status === 'active')
      .reverse();
    for (const d of decisions) {
      const node = (d.detail.plan?.nodes || []).find(
        (n) => n.actor_id === stakeholder.id && n.grievance_override && n.fired_at_minute == null,
      );
      if (node?.grievance_override) {
        return { ...node.grievance_override, reason: `decision:${d.decision_key}` };
      }
    }
    return null;
  });
}

/** One-off in-character line for a relay (used when the plan has no body). */
export async function composeFoundOutLine(carrier: Stakeholder, summary: string): Promise<string> {
  const r = await callSocialCrisisAI(
    `Write ONE short in-character message (2-3 sentences) from ${carrier.name}, ${carrier.title} at ${carrier.organisation}, to the team that manages the relationship, saying they have just heard — not officially — that: "${summary}". They ask for confirmation and what it means for the people they are responsible for. Personality: ${carrier.personality}. Return ONLY JSON { "text": "..." }`,
    'Write it.',
    300,
    0.7,
  );
  return String(
    (r as { text?: string } | null)?.text || `I've just heard that ${summary}. Is that right?`,
  );
}
