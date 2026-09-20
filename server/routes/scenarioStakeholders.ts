import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate } from '../lib/validation.js';
import { assertScenarioOwner } from '../lib/access.js';
import { canEditScenario } from '../services/scenarioEditService.js';
import {
  StakeholderSchema,
  STAKEHOLDER_RELATIONSHIPS as RELATIONSHIPS,
  PERSUADABILITIES as PERSUADABILITY,
  resolveTeamFunction,
  type Stakeholder,
  type OrgRegistryEntry,
} from '../lib/stakeholderContract.js';
import { countrySlug } from '../../shared/countries.js';
import { personaTwinFor } from '../services/stakeholderGenerationService.js';

/**
 * Trainer CRUD for stakeholder characters (contract §3) on a compiled
 * scenario. Generator-owned; mounted alongside /api/scenarios.
 *
 * Invariants kept on every write (so the runtime never sees a broken link):
 * - owning_team resolves to a team function present in the stakeholder's org
 * - org_key is null or a protagonist organisation
 * - email / handle / id unique across the scenario's stakeholders
 * - injects authored by the stakeholder keep author fields equal to the record
 *   (rename propagates to scenario_injects.delivery_config and the persona twin)
 * - deleting a stakeholder that still authors injects requires ?force=true
 */

export const scenarioStakeholdersRouter = Router();

async function guardScenarioEdit(
  scenarioId: string,
  req: AuthenticatedRequest,
  res: import('express').Response,
): Promise<boolean> {
  const user = req.user!;
  if (user.role !== 'trainer' && user.role !== 'admin') {
    res.status(403).json({ error: 'Access denied' });
    return false;
  }
  const owner = await assertScenarioOwner(scenarioId, user);
  if (!owner.ok) {
    res.status(owner.status).json({ error: owner.error });
    return false;
  }
  const editability = await canEditScenario(scenarioId, user);
  if (!editability.editable) {
    res.status(423).json({
      error:
        editability.reason === 'live_session'
          ? 'A session on this scenario is currently live. Editing resumes when it ends.'
          : 'No session launch credits remaining. Editing is locked until credits are topped up.',
      code:
        editability.reason === 'live_session'
          ? 'EDIT_LOCKED_LIVE_SESSION'
          : 'EDIT_LOCKED_NO_CREDITS',
    });
    return false;
  }
  return true;
}

interface ScenarioContext {
  initialState: Record<string, unknown>;
  stakeholders: Stakeholder[];
  orgs: OrgRegistryEntry[];
  teams: Array<{
    id: string;
    team_name: string;
    org_key: string | null;
    function_key: string | null;
  }>;
}

async function loadContext(scenarioId: string): Promise<ScenarioContext | null> {
  const { data: scen, error } = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .single();
  if (error || !scen) return null;
  const initialState = ((scen.initial_state as Record<string, unknown>) || {}) as Record<
    string,
    unknown
  >;
  const { data: teamRows } = await supabaseAdmin
    .from('scenario_teams')
    .select('id, team_name, org_key, function_key')
    .eq('scenario_id', scenarioId);
  return {
    initialState,
    stakeholders: Array.isArray(initialState.stakeholders)
      ? (initialState.stakeholders as Stakeholder[])
      : [],
    orgs: Array.isArray(initialState.orgs) ? (initialState.orgs as OrgRegistryEntry[]) : [],
    teams: ((teamRows || []) as ScenarioContext['teams']).map((t) => ({
      ...t,
      org_key: t.org_key ?? null,
      function_key: t.function_key ?? null,
    })),
  };
}

/** Functions available for owning_team, optionally restricted to one org. */
function functionsFor(ctx: ScenarioContext, orgKey: string | null): string[] {
  const fns = new Set<string>();
  for (const t of ctx.teams) {
    if (orgKey !== null && t.org_key !== null && t.org_key !== orgKey) continue;
    fns.add(resolveTeamFunction(t));
  }
  return Array.from(fns);
}

function validateLinks(ctx: ScenarioContext, s: Stakeholder, excludeId?: string): string | null {
  if (s.org_key !== null) {
    const org = ctx.orgs.find((o) => o.org_key === s.org_key);
    if (!org || org.side !== 'protagonist')
      return `org_key "${s.org_key}" is not a protagonist organisation`;
  }
  const fns = functionsFor(ctx, s.org_key);
  const teamNames = ctx.teams.map((t) => t.team_name);
  if (!fns.includes(s.owning_team) && !teamNames.includes(s.owning_team)) {
    return `owning_team "${s.owning_team}" matches no team${s.org_key ? ` in ${s.org_key}` : ''} (choose from: ${fns.join(', ')})`;
  }
  for (const other of ctx.stakeholders) {
    if (other.id === (excludeId ?? s.id)) continue;
    if (other.id === s.id) return `id "${s.id}" already exists`;
    if (other.email === s.email) return `email "${s.email}" is already used by ${other.name}`;
    if (other.handle === s.handle) return `handle "${s.handle}" is already used by ${other.name}`;
  }
  const personas = Array.isArray(ctx.initialState.npc_personas)
    ? (ctx.initialState.npc_personas as Array<{ handle: string; name: string }>)
    : [];
  const clash = personas.find((p) => p.handle === s.handle && p.name !== s.name);
  if (clash) return `handle "${s.handle}" belongs to persona "${clash.name}"`;
  return null;
}

const stakeholderBodySchema = z.object({
  name: z.string().min(2).max(80),
  title: z.string().min(2).max(80),
  organisation: z.string().min(2).max(120),
  relationship: z.enum(RELATIONSHIPS),
  owning_team: z.string().min(1).max(60),
  org_key: z.string().min(1).nullable().optional(),
  email: z.string().min(5).max(120).optional(),
  phone: z.string().max(40).nullable().optional(),
  handle: z.string().max(31).optional(),
  note: z.string().max(400).default(''),
  avatar_url: z.string().url().optional(),
  personality: z.string().max(600).default('Professional, direct.'),
  stance: z.string().max(400).default('Watching how the organisation responds.'),
  knowledge: z.array(z.string()).max(6).default([]),
  will_not_disclose: z.array(z.string()).max(4).default([]),
  grievance: z.string().max(600).default(''),
  resolution_criteria: z.array(z.string()).max(4).default([]),
  persuadability: z.enum(PERSUADABILITY).default('medium'),
  hard_constraints: z.array(z.string()).max(4).default([]),
});

function normaliseHandle(raw: string): string {
  const body = raw
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return `@${body.length >= 3 ? body : `${body}${'x'.repeat(3 - body.length)}`}`;
}

function defaultsFor(
  input: z.infer<typeof stakeholderBodySchema>,
  ctx: ScenarioContext,
): Stakeholder {
  const nameSlug = countrySlug(input.name).replace(/_+/g, '_');
  const orgSlug = countrySlug(input.organisation).replace(/_+/g, '_') || 'org';
  const [first, ...rest] = input.name.split(/\s+/).filter(Boolean);
  const last = rest.length > 0 ? rest[rest.length - 1] : '';
  let id = `stk_${orgSlug}_${nameSlug}`.slice(0, 60);
  let n = 2;
  while (ctx.stakeholders.some((s) => s.id === id))
    id = `stk_${orgSlug}_${nameSlug}_${n++}`.slice(0, 60);
  const email = (
    input.email ||
    `${countrySlug(first || 'contact').replace(/_/g, '.')}${last ? `.${countrySlug(last)}` : ''}@${orgSlug.replace(/_/g, '')}.sim`
  ).toLowerCase();
  const handle = normaliseHandle(
    input.handle || `${first || 'contact'}${last ? last.charAt(0) : ''}_${orgSlug.slice(0, 10)}`,
  );
  const grievance = input.grievance.trim();
  return {
    id,
    name: input.name.trim(),
    title: input.title.trim(),
    organisation: input.organisation.trim(),
    relationship: input.relationship,
    owning_team: input.owning_team.trim(),
    org_key: input.org_key ?? null,
    email,
    phone: input.phone ?? null,
    handle,
    note: input.note.trim(),
    ...(input.avatar_url ? { avatar_url: input.avatar_url } : {}),
    personality: input.personality,
    stance: input.stance,
    knowledge: input.knowledge.map((k) => k.trim()).filter(Boolean),
    will_not_disclose: input.will_not_disclose.map((k) => k.trim()).filter(Boolean),
    grievance,
    resolution_criteria: grievance
      ? input.resolution_criteria
          .map((c) => c.trim())
          .filter(Boolean)
          .slice(0, 4)
      : [],
    persuadability: input.persuadability,
    hard_constraints: input.hard_constraints.map((c) => c.trim()).filter(Boolean),
  };
}

async function saveStakeholders(
  scenarioId: string,
  ctx: ScenarioContext,
  next: Stakeholder[],
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('scenarios')
    .update({ initial_state: { ...ctx.initialState, stakeholders: next } })
    .eq('id', scenarioId);
  if (error) throw new Error(error.message);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** Full stakeholder records (trainer/admin; owner-checked). */
scenarioStakeholdersRouter.get(
  '/:id/stakeholders',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    if (user.role !== 'trainer' && user.role !== 'admin')
      return res.status(403).json({ error: 'Access denied' });
    const owner = await assertScenarioOwner(req.params.id, user);
    if (!owner.ok) return res.status(owner.status).json({ error: owner.error });
    const ctx = await loadContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Scenario not found' });
    const { data: injects } = await supabaseAdmin
      .from('scenario_injects')
      .select('id, title, trigger_time_minutes, delivery_config')
      .eq('scenario_id', req.params.id);
    const injectsByStakeholder: Record<string, number> = {};
    for (const inj of injects || []) {
      const sid = (inj.delivery_config as Record<string, unknown> | null)?.stakeholder_id;
      if (typeof sid === 'string') injectsByStakeholder[sid] = (injectsByStakeholder[sid] || 0) + 1;
    }
    res.json({
      data: ctx.stakeholders,
      orgs: ctx.orgs,
      countries: Array.isArray(ctx.initialState.countries) ? ctx.initialState.countries : [],
      teams: ctx.teams,
      functions: functionsFor(ctx, null),
      injects_by_stakeholder: injectsByStakeholder,
    });
  },
);

scenarioStakeholdersRouter.post(
  '/:id/stakeholders',
  requireAuth,
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: stakeholderBodySchema })),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      if (!(await guardScenarioEdit(id, req, res))) return;
      const ctx = await loadContext(id);
      if (!ctx) return res.status(404).json({ error: 'Scenario not found' });
      const stakeholder = defaultsFor(req.body, ctx);
      const parsed = StakeholderSchema.safeParse(stakeholder);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message || 'Invalid stakeholder' });
      const linkErr = validateLinks(ctx, stakeholder);
      if (linkErr) return res.status(400).json({ error: linkErr, code: 'MO-STK-001' });
      await saveStakeholders(id, ctx, [...ctx.stakeholders, stakeholder]);
      logger.info(
        { scenarioId: id, stakeholderId: stakeholder.id, userId: req.user!.id },
        'stakeholder_created',
      );
      res.status(201).json({ data: stakeholder });
    } catch (err) {
      logger.error({ err }, 'POST /scenarios/:id/stakeholders failed');
      res.status(500).json({ error: 'Failed to create stakeholder' });
    }
  },
);

scenarioStakeholdersRouter.patch(
  '/:id/stakeholders/:stakeholderId',
  requireAuth,
  validate(
    z.object({
      params: z.object({ id: z.string().uuid(), stakeholderId: z.string() }),
      body: stakeholderBodySchema.partial(),
    }),
  ),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id, stakeholderId } = req.params;
      if (!(await guardScenarioEdit(id, req, res))) return;
      const ctx = await loadContext(id);
      if (!ctx) return res.status(404).json({ error: 'Scenario not found' });
      const current = ctx.stakeholders.find((s) => s.id === stakeholderId);
      if (!current) return res.status(404).json({ error: 'Stakeholder not found' });

      const patch = req.body as Partial<z.infer<typeof stakeholderBodySchema>>;
      const next: Stakeholder = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.organisation !== undefined ? { organisation: patch.organisation.trim() } : {}),
        ...(patch.relationship !== undefined ? { relationship: patch.relationship } : {}),
        ...(patch.owning_team !== undefined ? { owning_team: patch.owning_team.trim() } : {}),
        ...(patch.org_key !== undefined ? { org_key: patch.org_key } : {}),
        ...(patch.email !== undefined ? { email: patch.email.trim().toLowerCase() } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.handle !== undefined ? { handle: normaliseHandle(patch.handle) } : {}),
        ...(patch.note !== undefined ? { note: patch.note.trim() } : {}),
        ...(patch.avatar_url !== undefined ? { avatar_url: patch.avatar_url } : {}),
        ...(patch.personality !== undefined ? { personality: patch.personality } : {}),
        ...(patch.stance !== undefined ? { stance: patch.stance } : {}),
        ...(patch.knowledge !== undefined
          ? { knowledge: patch.knowledge.map((k) => k.trim()).filter(Boolean) }
          : {}),
        ...(patch.will_not_disclose !== undefined
          ? { will_not_disclose: patch.will_not_disclose.map((k) => k.trim()).filter(Boolean) }
          : {}),
        ...(patch.grievance !== undefined ? { grievance: patch.grievance.trim() } : {}),
        ...(patch.resolution_criteria !== undefined
          ? {
              resolution_criteria: patch.resolution_criteria
                .map((c) => c.trim())
                .filter(Boolean)
                .slice(0, 4),
            }
          : {}),
        ...(patch.persuadability !== undefined ? { persuadability: patch.persuadability } : {}),
        ...(patch.hard_constraints !== undefined
          ? { hard_constraints: patch.hard_constraints.map((c) => c.trim()).filter(Boolean) }
          : {}),
      };
      if (next.grievance === '') next.resolution_criteria = [];
      else if (next.resolution_criteria.length === 0) {
        return res.status(400).json({
          error: 'A stakeholder with a grievance needs at least one resolution criterion',
        });
      }
      const parsed = StakeholderSchema.safeParse(next);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message || 'Invalid stakeholder' });
      const linkErr = validateLinks(ctx, next, stakeholderId);
      if (linkErr) return res.status(400).json({ error: linkErr, code: 'MO-STK-001' });

      // Propagate identity changes to authored injects (MO-INJ-005) and the persona twin.
      const identityChanged =
        next.name !== current.name ||
        next.email !== current.email ||
        next.handle !== current.handle ||
        next.phone !== current.phone ||
        next.organisation !== current.organisation;
      let injectsUpdated = 0;
      let initialState = ctx.initialState;
      if (identityChanged) {
        const { data: injects } = await supabaseAdmin
          .from('scenario_injects')
          .select('id, delivery_config')
          .eq('scenario_id', id);
        for (const inj of injects || []) {
          const dc = (inj.delivery_config as Record<string, unknown> | null) || null;
          if (!dc || dc.stakeholder_id !== stakeholderId) continue;
          const updated: Record<string, unknown> = { ...dc };
          if (dc.app === 'email') {
            updated.from_name = next.name;
            updated.from_address = next.email;
          } else if (dc.app === 'social_feed') {
            updated.author_handle = next.handle;
            updated.author_display_name = next.name;
          } else if (dc.app === 'news') {
            updated.author_handle = next.handle;
            updated.author_display_name = next.name;
            updated.outlet_name = next.organisation;
          } else if (dc.app === 'phone_call') {
            updated.from_name = next.name;
            if (next.phone) updated.from_address = next.phone;
          }
          const { error } = await supabaseAdmin
            .from('scenario_injects')
            .update({ delivery_config: updated })
            .eq('id', inj.id);
          if (error) throw new Error(`inject ${inj.id}: ${error.message}`);
          injectsUpdated++;
        }
        const personas = Array.isArray(initialState.npc_personas)
          ? [...(initialState.npc_personas as Array<Record<string, unknown>>)]
          : [];
        const twinIdx = personas.findIndex((p) => p.handle === current.handle);
        if (twinIdx >= 0) {
          personas[twinIdx] = {
            ...personas[twinIdx],
            handle: next.handle,
            name: next.name,
            personality: next.personality,
          };
          initialState = { ...initialState, npc_personas: personas };
        }
      }

      const list = ctx.stakeholders.map((s) => (s.id === stakeholderId ? next : s));
      const { error } = await supabaseAdmin
        .from('scenarios')
        .update({ initial_state: { ...initialState, stakeholders: list } })
        .eq('id', id);
      if (error) throw new Error(error.message);
      logger.info(
        { scenarioId: id, stakeholderId, injectsUpdated, userId: req.user!.id },
        'stakeholder_updated',
      );
      res.json({ data: next, injects_updated: injectsUpdated });
    } catch (err) {
      logger.error({ err }, 'PATCH /scenarios/:id/stakeholders/:stakeholderId failed');
      res.status(500).json({ error: 'Failed to update stakeholder' });
    }
  },
);

scenarioStakeholdersRouter.delete(
  '/:id/stakeholders/:stakeholderId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id, stakeholderId } = req.params;
      if (!(await guardScenarioEdit(id, req, res))) return;
      const ctx = await loadContext(id);
      if (!ctx) return res.status(404).json({ error: 'Scenario not found' });
      const current = ctx.stakeholders.find((s) => s.id === stakeholderId);
      if (!current) return res.status(404).json({ error: 'Stakeholder not found' });

      const { data: injects } = await supabaseAdmin
        .from('scenario_injects')
        .select('id, delivery_config')
        .eq('scenario_id', id);
      const authored = (injects || []).filter(
        (inj) =>
          (inj.delivery_config as Record<string, unknown> | null)?.stakeholder_id === stakeholderId,
      );
      const force = String(req.query.force || '') === 'true';
      if (authored.length > 0 && !force) {
        return res.status(409).json({
          error: `${current.name} still authors ${authored.length} inject(s). Delete them too?`,
          code: 'STAKEHOLDER_HAS_INJECTS',
          inject_count: authored.length,
        });
      }
      for (const inj of authored) {
        const { error } = await supabaseAdmin.from('scenario_injects').delete().eq('id', inj.id);
        if (error) throw new Error(`inject ${inj.id}: ${error.message}`);
      }
      // Drop the persona twin only when nothing else uses that handle.
      let initialState = ctx.initialState;
      const personas = Array.isArray(initialState.npc_personas)
        ? (initialState.npc_personas as Array<Record<string, unknown>>)
        : [];
      const stillReferenced = (injects || []).some(
        (inj) =>
          !authored.includes(inj) &&
          (inj.delivery_config as Record<string, unknown> | null)?.author_handle === current.handle,
      );
      if (!stillReferenced && personas.some((p) => p.handle === current.handle)) {
        initialState = {
          ...initialState,
          npc_personas: personas.filter((p) => p.handle !== current.handle),
        };
      }
      const list = ctx.stakeholders.filter((s) => s.id !== stakeholderId);
      const { error } = await supabaseAdmin
        .from('scenarios')
        .update({ initial_state: { ...initialState, stakeholders: list } })
        .eq('id', id);
      if (error) throw new Error(error.message);
      logger.info(
        { scenarioId: id, stakeholderId, injectsDeleted: authored.length, userId: req.user!.id },
        'stakeholder_deleted',
      );
      res.json({ ok: true, injects_deleted: authored.length });
    } catch (err) {
      logger.error({ err }, 'DELETE /scenarios/:id/stakeholders/:stakeholderId failed');
      res.status(500).json({ error: 'Failed to delete stakeholder' });
    }
  },
);

/** Ensure a persona twin exists for a stakeholder (used after giving a contact a public post). */
scenarioStakeholdersRouter.post(
  '/:id/stakeholders/:stakeholderId/persona-twin',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id, stakeholderId } = req.params;
      if (!(await guardScenarioEdit(id, req, res))) return;
      const ctx = await loadContext(id);
      if (!ctx) return res.status(404).json({ error: 'Scenario not found' });
      const s = ctx.stakeholders.find((x) => x.id === stakeholderId);
      if (!s) return res.status(404).json({ error: 'Stakeholder not found' });
      const personas = Array.isArray(ctx.initialState.npc_personas)
        ? (ctx.initialState.npc_personas as Array<Record<string, unknown>>)
        : [];
      if (personas.some((p) => p.handle === s.handle))
        return res.json({ ok: true, created: false });
      const country = s.org_key
        ? (ctx.orgs.find((o) => o.org_key === s.org_key)?.country ?? undefined)
        : undefined;
      const twin = personaTwinFor(s, country);
      const { error } = await supabaseAdmin
        .from('scenarios')
        .update({ initial_state: { ...ctx.initialState, npc_personas: [...personas, twin] } })
        .eq('id', id);
      if (error) throw new Error(error.message);
      res.json({ ok: true, created: true, persona: twin });
    } catch (err) {
      logger.error({ err }, 'POST persona-twin failed');
      res.status(500).json({ error: 'Failed to create persona twin' });
    }
  },
);
