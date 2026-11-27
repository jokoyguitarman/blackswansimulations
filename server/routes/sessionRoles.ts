import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { assertSessionAccess, assertSessionOwner } from '../lib/access.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getSessionCallCoverage } from '../services/callCoverageService.js';
import { autofillLines, listLines, loadCallPolicy, replaceLineHolders, saveCallPolicy } from '../services/calls/lineService.js';
import { mergeCallPolicy, type CallPolicy } from '../services/calls/lineCore.js';
import { listRoleAssignments, replaceRolePlayers, rerouteRole } from '../services/roles/roleService.js';

const router = Router();

const idParams = z.object({ params: z.object({ id: z.string().uuid() }) });

router.get('/:id/call-coverage', requireAuth, validate(idParams), async (req: AuthenticatedRequest, res) => {
  try {
    const access = await assertSessionOwner(req.params.id, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    res.json({ data: await getSessionCallCoverage(req.params.id) });
  } catch (err) {
    logger.error({ err }, 'GET /sessions/:id/call-coverage failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/roles', requireAuth, validate(idParams), async (req: AuthenticatedRequest, res) => {
  try {
    const access = await assertSessionAccess(req.params.id, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const policy = await loadCallPolicy(req.params.id);
    const data = await listRoleAssignments(req.params.id);
    const owner = await assertSessionOwner(req.params.id, req.user!);
    if (!owner.ok && !policy.show_line_holders) {
      return res.json({ data: data.map((role) => ({ ...role, players: [] })) });
    }
    res.json({ data });
  } catch (err) {
    logger.error({ err }, 'GET /sessions/:id/roles failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const roleBody = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ role_id: z.string().min(2).max(40), user_ids: z.array(z.string().uuid()).max(8) }),
});

router.put('/:id/roles', requireAuth, validate(roleBody), async (req: AuthenticatedRequest, res) => {
  try {
    const access = await assertSessionOwner(req.params.id, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const status = await sessionStatus(req.params.id);
    if (!status || !['scheduled', 'paused', 'in_progress'].includes(status)) {
      return res.status(409).json({ error: 'Roles can only be assigned before the session ends' });
    }
    const result = await replaceRolePlayers({
      sessionId: req.params.id,
      roleId: req.body.role_id,
      userIds: req.body.user_ids,
      actorId: req.user!.id,
      source: status === 'in_progress' ? 'trainer_console' : 'trainer_lobby',
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ data: await listRoleAssignments(req.params.id) });
  } catch (err) {
    logger.error({ err }, 'PUT /sessions/:id/roles failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const rerouteBody = z.object({
  params: z.object({ id: z.string().uuid(), roleId: z.string().min(2).max(40) }),
  body: z.object({ pending_ids: z.array(z.string()).max(40).optional() }),
});

router.post('/:id/roles/:roleId/reroute', requireAuth, validate(rerouteBody), async (req: AuthenticatedRequest, res) => {
  try {
    const access = await assertSessionOwner(req.params.id, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const result = await rerouteRole({
      sessionId: req.params.id,
      roleId: req.params.roleId,
      pendingIds: req.body.pending_ids,
      reason: 'trainer_reroute',
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ rerouted: result.rerouted });
  } catch (err) {
    logger.error({ err }, 'POST role reroute failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/call-lines', requireAuth, validate(idParams), async (req: AuthenticatedRequest, res) => {
  try {
    const access = await assertSessionAccess(req.params.id, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const policy = await loadCallPolicy(req.params.id);
    const owner = await assertSessionOwner(req.params.id, req.user!);
    let data = await listLines(req.params.id);
    if (!owner.ok && !policy.show_line_holders) data = data.map((line) => ({ ...line, holders: [] }));
    res.json({ data, policy });
  } catch (err) {
    logger.error({ err }, 'GET /sessions/:id/call-lines failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const takersBody = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ team_name: z.string().min(1).max(100), user_ids: z.array(z.string().uuid()).max(8) }),
});

router.put('/:id/call-takers', requireAuth, validate(takersBody), async (req: AuthenticatedRequest, res) => {
  try {
    const access = await assertSessionOwner(req.params.id, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const status = await sessionStatus(req.params.id);
    const result = await replaceLineHolders({
      sessionId: req.params.id,
      teamName: req.body.team_name,
      userIds: req.body.user_ids,
      actorId: req.user!.id,
      source: status === 'in_progress' ? 'trainer_console' : 'trainer_lobby',
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ data: await listLines(req.params.id) });
  } catch (err) {
    logger.error({ err }, 'PUT /sessions/:id/call-takers failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const autofillBody = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ team_names: z.array(z.string().min(1)).max(40).optional() }),
});

router.post('/:id/call-takers/autofill', requireAuth, validate(autofillBody), async (req: AuthenticatedRequest, res) => {
  try {
    const access = await assertSessionOwner(req.params.id, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const coverage = await getSessionCallCoverage(req.params.id);
    const gateTeams = coverage.items.filter((item) => item.kind === 'line').map((item) => item.key);
    const result = await autofillLines({
      sessionId: req.params.id,
      teamNames: req.body.team_names,
      actorId: req.user!.id,
      gateTeams,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ picks: result.picks });
  } catch (err) {
    logger.error({ err }, 'POST call-takers autofill failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const policyBody = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    reassign_on_offline: z.boolean().optional(),
    offline_grace_seconds: z.number().int().min(0).max(600).optional(),
    role_offline_prompt: z.boolean().optional(),
    role_offline_auto_fallback_minutes: z.number().int().min(1).max(60).nullable().optional(),
    callback_by: z.enum(['any_team_member', 'line_holders']).optional(),
    show_line_holders: z.boolean().optional(),
    line_log_visible_to: z.enum(['team', 'line_holders']).optional(),
    missed_badge_for: z.enum(['line_holders', 'team']).optional(),
    overflow_when_busy: z.boolean().optional(),
    ring_new_holders_mid_ring: z.boolean().optional(),
  }),
});

router.patch('/:id/call-policy', requireAuth, validate(policyBody), async (req: AuthenticatedRequest, res) => {
  try {
    const access = await assertSessionOwner(req.params.id, req.user!);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const saved = await saveCallPolicy(req.params.id, req.body as Partial<CallPolicy>);
    res.json({ data: saved ?? mergeCallPolicy(null) });
  } catch (err) {
    logger.error({ err }, 'PATCH call-policy failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function sessionStatus(sessionId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('sessions').select('status').eq('id', sessionId).maybeSingle();
  return (data?.status as string | null) ?? null;
}

export { router as sessionRolesRouter };
