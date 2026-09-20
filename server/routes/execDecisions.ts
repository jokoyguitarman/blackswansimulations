import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { assertSessionOwner } from '../lib/access.js';
import { logger } from '../lib/logger.js';
import {
  listDecisions,
  listDecisionEvents,
  loadKnowledge,
} from '../services/decisions/decisionLedger.js';
import {
  dismissDecision,
  recordManualDecision,
} from '../services/decisions/decisionDetectionService.js';
import { getStakeholders } from '../services/stakeholderService.js';
import { getSessionScenarioId } from '../lib/scenarioCache.js';

/**
 * Trainer surface for organic executive decisions
 * (docs/executive-decisions-organic-plan.md §6.7). Mounted at /api/sessions.
 * Trainer/admin only; summaries and quoted PLAYER messages only — hidden stakeholder
 * fields never leave the server.
 */
export const execDecisionsRouter = Router();

execDecisionsRouter.get(
  '/:sessionId/exec-decisions',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const access = await assertSessionOwner(sessionId, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const [decisions, events, scenarioId] = await Promise.all([
        listDecisions(sessionId),
        listDecisionEvents(sessionId),
        getSessionScenarioId(sessionId),
      ]);
      const stakeholders = scenarioId ? await getStakeholders(scenarioId) : [];
      const nameOf = new Map(stakeholders.map((s) => [s.id, `${s.name} (${s.title})`]));
      const data = await Promise.all(
        decisions.map(async (d) => {
          const knowledge = await loadKnowledge(sessionId, d.id);
          const nodes = d.detail.plan?.nodes || [];
          return {
            id: d.id,
            decision_key: d.decision_key,
            status: d.status,
            summary: d.detail.summary,
            category: d.detail.category,
            confidence: d.detail.confidence,
            org_key: d.org_key,
            scope: d.detail.scope,
            detected_at_minute: d.detail.detected_at_minute,
            decided_by: { team: d.team_name, by_trainer: d.recorded_by_trainer },
            told: d.detail.informed.map((a) => ({
              actor_kind: a.actor_kind,
              actor_id: a.actor_id,
              label:
                a.actor_kind === 'stakeholder'
                  ? (nameOf.get(a.actor_id) ?? a.actor_id)
                  : a.actor_id,
            })),
            should_know: {
              functions: d.detail.should_know_functions,
              stakeholders: d.detail.should_know_stakeholder_ids.map((id) => ({
                id,
                label: nameOf.get(id) ?? id,
                state: knowledge.get(`stakeholder:${id}`)?.state ?? 'unaware',
                via: knowledge.get(`stakeholder:${id}`)?.learned_via ?? null,
              })),
            },
            knowledge: Array.from(knowledge.values())
              .filter(
                (k) =>
                  k.actor_kind === 'stakeholder' ||
                  k.actor_kind === 'group' ||
                  k.actor_kind === 'team',
              )
              .map((k) => ({
                actor_kind: k.actor_kind,
                actor_id: k.actor_id,
                label:
                  k.actor_kind === 'team' ? k.actor_id : (nameOf.get(k.actor_id) ?? k.actor_id),
                state: k.state,
                via: k.learned_via,
                at_minute: k.at_minute,
              })),
            reactions: nodes
              .filter((n) => n.kind !== 'relay')
              .map((n) => ({
                node_id: n.id,
                actor_kind: n.actor_kind,
                actor_id: n.actor_id,
                label:
                  n.actor_kind === 'page' ? n.actor_id : (nameOf.get(n.actor_id) ?? n.actor_id),
                channel: n.channel,
                title: n.content.title,
                planned_minute: d.detail.detected_at_minute + n.delay_minutes,
                fired_minute: n.fired_at_minute ?? null,
                inject_id: n.inject_id ?? null,
                depth: n.depth,
              })),
            relays: nodes
              .filter((n) => n.kind === 'relay')
              .map((n) => ({
                node_id: n.id,
                carrier: nameOf.get(n.actor_id) ?? n.actor_id,
                learners: (n.learners || []).map((l) => nameOf.get(l) ?? l),
                planned_minute: d.detail.detected_at_minute + n.delay_minutes,
                done: !!n.relayed,
              })),
            notice: d.detail.notice ?? null,
            sources: d.detail.sources.map((s) => ({ ref_table: s.ref_table, excerpt: s.excerpt })),
            events: events
              .filter((e) => e.decision_id === d.id)
              .map((e) => ({
                id: e.id,
                kind: e.kind,
                actor_kind: e.actor_kind,
                actor_id: e.actor_id,
                label: e.actor_id ? (nameOf.get(e.actor_id) ?? e.actor_id) : null,
                at_minute: e.at_minute,
                summary: e.summary,
                created_at: e.created_at,
              })),
          };
        }),
      );
      res.json({ data });
    } catch (err) {
      logger.error({ err }, 'GET exec-decisions failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

execDecisionsRouter.post(
  '/:sessionId/exec-decisions/manual',
  requireAuth,
  validate(
    z.object({
      body: z.object({
        text: z.string().min(8).max(3000),
        org_key: z.string().max(80).optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;
      const access = await assertSessionOwner(sessionId, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const record = await recordManualDecision(
        sessionId,
        req.user!.id,
        String(req.body.text),
        req.body.org_key ?? null,
      );
      if (!record)
        return res
          .status(400)
          .json({ error: 'Could not record the decision (is the session live?)' });
      res
        .status(201)
        .json({
          data: {
            id: record.id,
            decision_key: record.decision_key,
            summary: record.detail.summary,
          },
        });
    } catch (err) {
      logger.error({ err }, 'POST exec-decisions/manual failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

execDecisionsRouter.post(
  '/:sessionId/exec-decisions/:decisionId/dismiss',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId, decisionId } = req.params;
      const access = await assertSessionOwner(sessionId, req.user!);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const ok = await dismissDecision(sessionId, decisionId, req.user!.id);
      if (!ok) return res.status(404).json({ error: 'Decision not found' });
      res.json({ data: { id: decisionId, status: 'dismissed' } });
    } catch (err) {
      logger.error({ err }, 'POST exec-decisions/dismiss failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);
