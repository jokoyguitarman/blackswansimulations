/**
 * Decision layer — executives as players (contract §7A, runtime plan §5).
 *
 * Optional mode: active only when the scenario carries `initial_state.decision_space[]`.
 * Recording a decision arms its eruption templates as pending runtime injects, opens the SOP
 * obligations it creates, and switches affected stakeholders onto their latent grievance so
 * the reconsideration engine judges them against the new situation.
 */
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { cachedByScenario, getSessionScenarioId } from '../lib/scenarioCache.js';
import {
  DecisionSpaceSchema,
  ChainOfCommandSchema,
  resolveTeamFunction,
  type DecisionOption,
  type ChainOfCommandLink,
  type TeamIdentity,
} from '../lib/stakeholderContract.js';
import { getTeamIdentity, getSessionTeams, getOrgMemberUserIds } from './orgRegistryService.js';
import { getStakeholders } from './stakeholderService.js';
import { getWebSocketService } from './websocketService.js';
import { createNotificationsForUsers } from './notificationService.js';
import { recordPlayerAction } from './sopCheckerService.js';

export const EXECUTIVE_FUNCTION = 'Executive';

// ─── Scenario data ───────────────────────────────────────────────────────────

export async function getDecisionSpace(scenarioId: string): Promise<DecisionOption[]> {
  return cachedByScenario(
    'decisionSpace',
    scenarioId,
    (snapshot) => {
      const raw = snapshot.initial_state.decision_space;
      if (!Array.isArray(raw) || raw.length === 0) return [];
      const parsed = DecisionSpaceSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      logger.warn(
        { scenarioId, issues: parsed.error.issues.slice(0, 5) },
        'initial_state.decision_space failed validation; decision layer disabled for this scenario',
      );
      return [];
    },
    [],
  );
}

export async function getChainOfCommand(scenarioId: string): Promise<ChainOfCommandLink[]> {
  return cachedByScenario(
    'chainOfCommand',
    scenarioId,
    (snapshot) => {
      const raw = snapshot.initial_state.chain_of_command;
      if (!Array.isArray(raw)) return [];
      const parsed = ChainOfCommandSchema.safeParse(raw);
      return parsed.success ? parsed.data : [];
    },
    [],
  );
}

export async function isDecisionLayerEnabled(sessionId: string): Promise<boolean> {
  const scenarioId = await getSessionScenarioId(sessionId);
  if (!scenarioId) return false;
  return (await getDecisionSpace(scenarioId)).length > 0;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionDecision {
  id: string;
  session_id: string;
  org_key: string;
  decision_key: string;
  title: string;
  recorded_by: string;
  team_name: string;
  scope: string | null;
  rationale: string | null;
  effective_at: string;
  recorded_at_minute: number;
  recorded_by_trainer: boolean;
  created_at: string;
}

export interface DecisionObligation {
  id: string;
  decision_id: string;
  stakeholder_id: string;
  stakeholder_name?: string;
  by_function: string;
  description: string;
  due_at_minute: number;
  status: 'open' | 'met' | 'lapsed';
  met_by_user_id: string | null;
  met_at: string | null;
}

function toDecision(row: Record<string, unknown>): SessionDecision {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    org_key: String(row.org_key),
    decision_key: String(row.decision_key),
    title: String(row.title ?? ''),
    recorded_by: String(row.recorded_by),
    team_name: String(row.team_name ?? ''),
    scope: (row.scope as string | null) ?? null,
    rationale: (row.rationale as string | null) ?? null,
    effective_at: String(row.effective_at),
    recorded_at_minute: Number(row.recorded_at_minute) || 0,
    recorded_by_trainer: !!row.recorded_by_trainer,
    created_at: String(row.created_at),
  };
}

async function elapsedMinutes(sessionId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('start_time')
    .eq('id', sessionId)
    .maybeSingle();
  if (!data?.start_time) return 0;
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(data.start_time as string).getTime()) / 60000),
  );
}

// ─── Authorisation ───────────────────────────────────────────────────────────

export type CanRecordResult =
  | { ok: true; identity: TeamIdentity; option: DecisionOption; orgKey: string }
  | { ok: false; status: 403 | 404 | 409; error: string };

/**
 * Executive of an org named in `decidable_by_org_keys` may record. Trainers may record on behalf
 * of an org with `asOrgKey`. 409 when that org already recorded this decision.
 */
export async function canRecord(
  sessionId: string,
  user: { id: string; role?: string },
  decisionKey: string,
  asOrgKey?: string | null,
): Promise<CanRecordResult> {
  const scenarioId = await getSessionScenarioId(sessionId);
  if (!scenarioId) return { ok: false, status: 404, error: 'Session not found' };
  const option = (await getDecisionSpace(scenarioId)).find((d) => d.decision_key === decisionKey);
  if (!option) return { ok: false, status: 404, error: 'Unknown decision' };

  const isStaff = user.role === 'trainer' || user.role === 'admin';
  let identity: TeamIdentity | null = await getTeamIdentity(sessionId, user.id);
  let orgKey: string | null = identity?.org_key ?? null;

  if (isStaff && asOrgKey) {
    orgKey = asOrgKey;
    identity = identity ?? {
      team_name: 'Trainer',
      function_key: EXECUTIVE_FUNCTION,
      org_key: asOrgKey,
      country: null,
    };
  } else {
    if (!identity || resolveTeamFunction(identity) !== EXECUTIVE_FUNCTION) {
      return { ok: false, status: 403, error: 'Only Executive team members can record decisions' };
    }
  }

  // Single-org scenarios: teams carry no org_key; fall back to the primary protagonist.
  if (!orgKey) {
    const { getProtagonistOrgs } = await import('./orgRegistryService.js');
    const orgs = await getProtagonistOrgs(scenarioId);
    orgKey = orgs.find((o) => o.is_primary)?.org_key ?? orgs[0]?.org_key ?? null;
  }
  if (!orgKey) return { ok: false, status: 403, error: 'No organisation resolved for this team' };

  if (option.decidable_by_org_keys.length > 0 && !option.decidable_by_org_keys.includes(orgKey)) {
    return { ok: false, status: 403, error: 'Your organisation cannot take this decision' };
  }

  const { data: existing } = await supabaseAdmin
    .from('session_decisions')
    .select('id')
    .eq('session_id', sessionId)
    .eq('org_key', orgKey)
    .eq('decision_key', decisionKey)
    .maybeSingle();
  if (existing) return { ok: false, status: 409, error: 'This decision has already been recorded' };

  return { ok: true, identity: identity!, option, orgKey };
}

// ─── Record + arm ────────────────────────────────────────────────────────────

export type RecordDecisionResult =
  | { ok: true; decision: SessionDecision }
  | { ok: false; status: 403 | 404 | 409; error: string };

export async function recordDecision(
  sessionId: string,
  user: { id: string; role?: string },
  input: {
    decision_key: string;
    scope?: string;
    rationale?: string;
    effective_at?: string;
    as_org_key?: string | null;
  },
): Promise<RecordDecisionResult> {
  const check = await canRecord(sessionId, user, input.decision_key, input.as_org_key ?? null);
  if (!check.ok) return { ok: false, status: check.status, error: check.error };
  const { identity, option, orgKey } = check;
  const minute = await elapsedMinutes(sessionId);
  const byTrainer = !!input.as_org_key && (user.role === 'trainer' || user.role === 'admin');

  const { data: row, error } = await supabaseAdmin
    .from('session_decisions')
    .insert({
      session_id: sessionId,
      org_key: orgKey,
      decision_key: option.decision_key,
      title: option.title,
      recorded_by: user.id,
      team_name: identity.team_name,
      scope: input.scope?.trim() || null,
      rationale: input.rationale?.trim() || null,
      effective_at: input.effective_at
        ? new Date(input.effective_at).toISOString()
        : new Date().toISOString(),
      recorded_at_minute: minute,
      recorded_by_trainer: byTrainer,
    })
    .select('*')
    .single();
  if (error || !row) {
    if (error?.code === '23505')
      return { ok: false, status: 409, error: 'This decision has already been recorded' };
    logger.error(
      { error, sessionId, decisionKey: input.decision_key },
      'Failed to record decision',
    );
    return { ok: false, status: 404, error: 'Failed to record decision' };
  }
  const decision = toDecision(row as Record<string, unknown>);

  // Scoring + trainer visibility
  void recordPlayerAction(sessionId, user.id, 'decision_recorded', decision.id, option.title, {
    decision_key: option.decision_key,
    org_key: orgKey,
    severity: option.severity,
    scope: decision.scope,
  }).catch(() => undefined);
  await supabaseAdmin.from('session_events').insert({
    session_id: sessionId,
    event_type: 'decision_recorded',
    description: `${identity.team_name} recorded decision: ${option.title}`,
    actor_id: user.id,
    metadata: {
      decision_id: decision.id,
      decision_key: option.decision_key,
      org_key: orgKey,
      team_name: identity.team_name,
      severity: option.severity,
      affected_org_keys: option.affected_org_keys,
      recorded_at_minute: minute,
    },
  });

  await arm(sessionId, decision, option);
  await broadcastToOrg(sessionId, decision, option);
  return { ok: true, decision };
}

/**
 * a) obligations; b) latent grievances on affected stakeholders; c) eruption templates copied as
 * pending runtime injects (eligible after the longest obligation window owed to that template's
 * stakeholder). Spillover templates stay condition-driven on inject_published:<key>.
 */
export async function arm(
  sessionId: string,
  decision: SessionDecision,
  option: DecisionOption,
): Promise<void> {
  const scenarioId = await getSessionScenarioId(sessionId);
  if (!scenarioId) return;

  // a) obligations
  const obligationRows: Array<Record<string, unknown>> = [];
  for (const ob of option.sop_obligations) {
    for (const stakeholderId of ob.owed_to_stakeholder_ids) {
      obligationRows.push({
        session_id: sessionId,
        decision_id: decision.id,
        stakeholder_id: stakeholderId,
        by_function: ob.by_function,
        description: ob.description || `Contact ${stakeholderId}`,
        due_at_minute: decision.recorded_at_minute + ob.window_minutes,
      });
    }
  }
  if (obligationRows.length > 0) {
    const { error } = await supabaseAdmin
      .from('decision_obligations')
      .upsert(obligationRows, { onConflict: 'decision_id,stakeholder_id,by_function' });
    if (error)
      logger.warn({ error, sessionId, decisionId: decision.id }, 'Failed to create obligations');
  }

  // b) latent grievances
  const stakeholders = await getStakeholders(scenarioId);
  const affected = stakeholders.filter((s) => s.latent_grievances?.[option.decision_key]);
  if (affected.length > 0) {
    const { error } = await supabaseAdmin.from('stakeholder_state').upsert(
      affected.map((s) => ({
        session_id: sessionId,
        stakeholder_id: s.id,
        active_decision_key: option.decision_key,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'session_id,stakeholder_id' },
    );
    if (error)
      logger.warn({ error, sessionId }, 'Failed to switch stakeholders to latent grievance');
  }

  // c) eruption templates → pending runtime injects
  if (option.eruption_inject_keys.length > 0) {
    const { data: templates } = await supabaseAdmin
      .from('scenario_injects')
      .select('*')
      .eq('scenario_id', scenarioId)
      .is('session_id', null)
      .in('delivery_config->>inject_key', option.eruption_inject_keys);

    const windowFor = (stakeholderId: string | undefined): number => {
      const windows = option.sop_obligations
        .filter((ob) => !stakeholderId || ob.owed_to_stakeholder_ids.includes(stakeholderId))
        .map((ob) => ob.window_minutes);
      if (windows.length === 0) {
        const all = option.sop_obligations.map((ob) => ob.window_minutes);
        return all.length ? Math.min(...all) : 0;
      }
      return Math.max(...windows);
    };

    for (const t of templates ?? []) {
      const tpl = t as Record<string, unknown>;
      const cfg = ((tpl.delivery_config as Record<string, unknown>) ?? {}) as Record<
        string,
        unknown
      >;
      const stakeholderId = typeof cfg.stakeholder_id === 'string' ? cfg.stakeholder_id : undefined;
      // Already armed for this session?
      const { data: dup } = await supabaseAdmin
        .from('scenario_injects')
        .select('id')
        .eq('session_id', sessionId)
        .eq('delivery_config->>armed_by_decision_id', decision.id)
        .eq('delivery_config->>inject_key', String(cfg.inject_key ?? ''))
        .limit(1);
      if (dup && dup.length > 0) continue;

      const { error } = await supabaseAdmin.from('scenario_injects').insert({
        scenario_id: scenarioId,
        session_id: sessionId,
        type: tpl.type,
        title: tpl.title,
        content: tpl.content,
        severity: tpl.severity ?? 'medium',
        inject_scope: tpl.inject_scope ?? 'universal',
        target_teams: tpl.target_teams ?? null,
        trigger_time_minutes: null,
        conditions_to_appear: tpl.conditions_to_appear ?? {
          all: [`decision_recorded:${option.decision_key}`],
        },
        conditions_to_cancel: tpl.conditions_to_cancel ?? null,
        eligible_after_minutes: decision.recorded_at_minute + windowFor(stakeholderId),
        state_effect: tpl.state_effect ?? null,
        requires_response: tpl.requires_response ?? false,
        delivery_config: {
          ...cfg,
          armed_by_decision_id: decision.id,
          decision_key: option.decision_key,
        },
        ai_generated: true,
        generation_source: 'decision_eruption',
      });
      if (error)
        logger.warn(
          { error, sessionId, injectKey: cfg.inject_key },
          'Failed to arm eruption template',
        );
    }
  }

  logger.info(
    {
      sessionId,
      decisionId: decision.id,
      decisionKey: option.decision_key,
      obligations: obligationRows.length,
      affected: affected.length,
    },
    'Decision armed',
  );
}

async function broadcastToOrg(
  sessionId: string,
  decision: SessionDecision,
  option: DecisionOption,
): Promise<void> {
  try {
    const memberIds = (await getOrgMemberUserIds(sessionId, decision.org_key)).filter(
      (id) => id !== decision.recorded_by,
    );
    const ws = getWebSocketService();
    const payload = {
      type: 'decision.recorded',
      data: {
        decision_id: decision.id,
        decision_key: decision.decision_key,
        title: decision.title,
        org_key: decision.org_key,
        team_name: decision.team_name,
        severity: option.severity,
        obligations: option.sop_obligations.map((o) => ({
          by_function: o.by_function,
          due_at_minute: decision.recorded_at_minute + o.window_minutes,
          description: o.description,
        })),
      },
      timestamp: new Date().toISOString(),
    };
    for (const id of [...memberIds, decision.recorded_by]) ws.emitToUser(id, payload);

    await createNotificationsForUsers(memberIds, {
      sessionId,
      type: 'system_alert',
      title: `Executive decision: ${decision.title}`,
      message: option.sop_obligations.length
        ? `Obligations due: ${option.sop_obligations.map((o) => `${o.by_function} by T+${decision.recorded_at_minute + o.window_minutes}`).join('; ')}`
        : 'No follow-up obligations recorded.',
      priority: option.severity === 'critical' || option.severity === 'high' ? 'high' : 'medium',
      metadata: {
        decision_id: decision.id,
        decision_key: decision.decision_key,
        org_key: decision.org_key,
      },
      actionUrl: `/sessions/${sessionId}#decisions`,
    });

    // System notice in every team channel of the org.
    const teams = (await getSessionTeams(sessionId)).filter(
      (t) => t.org_key === decision.org_key || t.org_key === null,
    );
    if (teams.length > 0) {
      const { ensureTeamChannels } = await import('./channelService.js');
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('trainer_id')
        .eq('id', sessionId)
        .maybeSingle();
      await ensureTeamChannels(sessionId, (session?.trainer_id as string | null) ?? null);
      const { data: channels } = await supabaseAdmin
        .from('chat_channels')
        .select('id')
        .eq('session_id', sessionId)
        .eq('type', 'team')
        .in(
          'team_name',
          teams.map((t) => t.team_name),
        );
      const dueText = option.sop_obligations.length
        ? ` Obligations: ${option.sop_obligations.map((o) => `${o.by_function} → ${o.description || 'contact stakeholders'} by T+${decision.recorded_at_minute + o.window_minutes}`).join('; ')}.`
        : '';
      for (const c of channels ?? []) {
        const { data: msg } = await supabaseAdmin
          .from('chat_messages')
          .insert({
            channel_id: c.id,
            session_id: sessionId,
            sender_id: decision.recorded_by,
            content: `📌 Executive decision recorded: ${decision.title}.${dueText}`,
            type: 'system',
          })
          .select('*')
          .single();
        if (msg) ws.messageSent(String(c.id), msg as Record<string, unknown>);
      }
    }
  } catch (err) {
    logger.warn({ err, sessionId, decisionId: decision.id }, 'Decision broadcast failed');
  }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export async function listDecisions(
  sessionId: string,
  scope: { orgKey: string | null; all: boolean },
): Promise<Array<SessionDecision & { obligations: DecisionObligation[] }>> {
  let q = supabaseAdmin
    .from('session_decisions')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (!scope.all && scope.orgKey) q = q.eq('org_key', scope.orgKey);
  const { data: rows } = await q;
  const decisions = (rows ?? []).map((r) => toDecision(r as Record<string, unknown>));
  if (decisions.length === 0) return [];

  const { data: obs } = await supabaseAdmin
    .from('decision_obligations')
    .select('*')
    .in(
      'decision_id',
      decisions.map((d) => d.id),
    );
  const scenarioId = await getSessionScenarioId(sessionId);
  const nameById = new Map(
    (scenarioId ? await getStakeholders(scenarioId) : []).map((s) => [s.id, s.name]),
  );

  return decisions.map((d) => ({
    ...d,
    obligations: (obs ?? [])
      .filter((o) => o.decision_id === d.id)
      .map((o) => ({
        id: String(o.id),
        decision_id: String(o.decision_id),
        stakeholder_id: String(o.stakeholder_id),
        stakeholder_name: nameById.get(String(o.stakeholder_id)),
        by_function: String(o.by_function),
        description: String(o.description ?? ''),
        due_at_minute: Number(o.due_at_minute) || 0,
        status: o.status as DecisionObligation['status'],
        met_by_user_id: (o.met_by_user_id as string | null) ?? null,
        met_at: (o.met_at as string | null) ?? null,
      })),
  }));
}

/** Decision keys recorded in this session (for the `decision_recorded:<key>` primitive). */
export async function recordedDecisionKeys(sessionId: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from('session_decisions')
    .select('decision_key')
    .eq('session_id', sessionId);
  return new Set((data ?? []).map((r) => String((r as { decision_key: string }).decision_key)));
}

// ─── Obligations ─────────────────────────────────────────────────────────────

/**
 * Called whenever a player writes to a stakeholder: open obligations owed to that stakeholder
 * by the writer's function are met if still within their window.
 */
export async function markObligationsMet(
  sessionId: string,
  stakeholderId: string,
  writer: { userId: string; identity: TeamIdentity | null },
): Promise<void> {
  if (!writer.identity) return;
  try {
    const fn = resolveTeamFunction(writer.identity);
    const minute = await elapsedMinutes(sessionId);
    const { data: open } = await supabaseAdmin
      .from('decision_obligations')
      .select('id, decision_id, by_function, due_at_minute, description')
      .eq('session_id', sessionId)
      .eq('stakeholder_id', stakeholderId)
      .eq('status', 'open');
    const met = (open ?? []).filter(
      (o) =>
        (o.by_function === fn || o.by_function === writer.identity!.team_name) &&
        minute <= Number(o.due_at_minute),
    );
    if (met.length === 0) return;
    await supabaseAdmin
      .from('decision_obligations')
      .update({ status: 'met', met_by_user_id: writer.userId, met_at: new Date().toISOString() })
      .in(
        'id',
        met.map((o) => o.id),
      );
    for (const o of met) {
      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'obligation_met',
        description: `${writer.identity.team_name} met obligation: ${o.description}`,
        actor_id: writer.userId,
        metadata: {
          obligation_id: o.id,
          decision_id: o.decision_id,
          stakeholder_id: stakeholderId,
          by_function: o.by_function,
          at_minute: minute,
        },
      });
    }
  } catch (err) {
    logger.warn({ err, sessionId, stakeholderId }, 'markObligationsMet failed');
  }
}

/** Scheduler tick: open obligations past their window lapse, with a heat-meter penalty. */
export async function lapseObligations(sessionId: string, elapsed: number): Promise<void> {
  try {
    const { data: overdue } = await supabaseAdmin
      .from('decision_obligations')
      .select('id, decision_id, by_function, due_at_minute, description, stakeholder_id')
      .eq('session_id', sessionId)
      .eq('status', 'open')
      .lt('due_at_minute', Math.floor(elapsed));
    if (!overdue || overdue.length === 0) return;

    await supabaseAdmin
      .from('decision_obligations')
      .update({ status: 'lapsed' })
      .in(
        'id',
        overdue.map((o) => o.id),
      );

    const { data: decisions } = await supabaseAdmin
      .from('session_decisions')
      .select('id, org_key')
      .in('id', Array.from(new Set(overdue.map((o) => String(o.decision_id)))));
    const orgByDecision = new Map((decisions ?? []).map((d) => [String(d.id), String(d.org_key)]));
    const teams = await getSessionTeams(sessionId);
    const { updateTeamHeatMeter } = await import('./heatMeterService.js');

    for (const o of overdue) {
      const orgKey = orgByDecision.get(String(o.decision_id)) ?? null;
      const owing = teams.filter(
        (t) =>
          resolveTeamFunction(t) === o.by_function &&
          (t.org_key === null || orgKey === null || t.org_key === orgKey),
      );
      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'obligation_lapsed',
        description: `Obligation lapsed (${o.by_function}): ${o.description}`,
        actor_id: null,
        metadata: {
          obligation_id: o.id,
          decision_id: o.decision_id,
          stakeholder_id: o.stakeholder_id,
          by_function: o.by_function,
          due_at_minute: o.due_at_minute,
          owing_teams: owing.map((t) => t.team_name),
        },
      });
      for (const t of owing) {
        try {
          // A lapsed obligation is a missed prerequisite step in heat-meter terms.
          await updateTeamHeatMeter(sessionId, t.team_name, 'prereq');
        } catch {
          /* non-critical */
        }
      }
    }
    logger.info({ sessionId, lapsed: overdue.length }, 'Decision obligations lapsed');
  } catch (err) {
    logger.warn({ err, sessionId }, 'lapseObligations failed');
  }
}
