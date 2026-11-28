/**
 * Turn a published director event into a template inject on the scenario.
 * The scenario owner or an admin must pass the same edit lock as other
 * scenario content (canEditScenario).
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { assertScenarioOwner } from '../../lib/access.js';
import { isUnappliedSchema } from '../../lib/unappliedSchema.js';
import { logger } from '../../lib/logger.js';
import { canEditScenario } from '../scenarioEditService.js';
import { getStakeholders } from '../stakeholderService.js';
import { parseStoredProposal } from './directorCore.js';
import { buildPromotedTemplate, type DirectorNpc, type DirectorPerson } from './directorPublish.js';
import { readNpcs } from './directorService.js';
import type { CommandResult } from './directorConsole.js';
import type { Signal } from './directorSignals.js';

const TEMPLATE_READ_LIMIT = 2000;
const PROMOTABLE = new Set(['approved', 'edited', 'auto_published']);

export async function promoteDirectorProposal(
  sessionId: string,
  proposalId: string,
  user: { id: string; role?: string },
): Promise<CommandResult> {
  const session = await loadSession(sessionId);
  if (!session) return { ok: false, status: 404, error: 'Session not found' };
  const owner = await assertScenarioOwner(session.scenarioId, user);
  if (!owner.ok) return { ok: false, status: owner.status, error: owner.error };
  const editability = await canEditScenario(session.scenarioId, user);
  if (!editability.editable) {
    return {
      ok: false,
      status: 423,
      error:
        editability.reason === 'live_session'
          ? 'A session on this scenario is currently live. Editing resumes when it ends.'
          : 'No session launch credits remaining. Editing is locked until credits are topped up.',
    };
  }

  const proposal = await loadProposal(sessionId, proposalId);
  if (proposal === 'missing') return { ok: false, status: 503, error: 'AI director is not available' };
  if (!proposal) return { ok: false, status: 404, error: 'Proposal not found' };
  if (!PROMOTABLE.has(proposal.status)) {
    return { ok: false, status: 409, error: 'Only a published director event can be promoted' };
  }
  const parsed = parseStoredProposal(proposal.proposal);
  if (!parsed) return { ok: false, status: 422, error: 'Proposal has no event to promote' };

  const templates = await loadTemplates(session.scenarioId);
  const existing = templates.find((row) => promotedFrom(row.delivery_config) === proposalId);
  if (existing) return { ok: true, status: 200, body: { data: { inject_id: existing.id } } };

  const [people, npcs] = await Promise.all([
    loadPeople(session.scenarioId),
    loadNpcs(session.scenarioId),
  ]);
  const row = buildPromotedTemplate({
    scenarioId: session.scenarioId,
    proposalId,
    minute: proposal.minute,
    proposal: parsed,
    signals: proposal.signals,
    edited: proposal.status === 'edited' || proposal.edit_before != null,
    people,
    npcs,
    takenKeys: new Set(templates.map((item) => item.key).filter((key): key is string => Boolean(key))),
  });
  const created = await insertTemplate(row);
  if (!created) return { ok: false, status: 500, error: 'The template inject was not created' };
  return { ok: true, status: 201, body: { data: { inject_id: created } } };
}

async function loadSession(sessionId: string): Promise<{ scenarioId: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (error || !data || typeof data.scenario_id !== 'string') return null;
  return { scenarioId: data.scenario_id };
}

async function loadProposal(
  sessionId: string,
  proposalId: string,
): Promise<
  | {
      status: string;
      minute: number;
      proposal: unknown;
      signals: Signal[];
      edit_before: unknown;
    }
  | null
  | 'missing'
> {
  const { data, error } = await supabaseAdmin
    .from('director_proposals')
    .select('status, minute, proposal, signals, edit_before')
    .eq('id', proposalId)
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) {
    if (isUnappliedSchema(error)) {
      warnMissing(error);
      return 'missing';
    }
    logger.warn({ err: error, proposalId }, 'director proposal was not loaded for promotion');
    return null;
  }
  if (!data) return null;
  return {
    status: String(data.status),
    minute: Number(data.minute),
    proposal: data.proposal,
    signals: Array.isArray(data.signals) ? (data.signals as Signal[]) : [],
    edit_before: data.edit_before,
  };
}

async function loadTemplates(
  scenarioId: string,
): Promise<Array<{ id: string; key: string | null; delivery_config: unknown }>> {
  const { data, error } = await supabaseAdmin
    .from('scenario_injects')
    .select('id, delivery_config')
    .eq('scenario_id', scenarioId)
    .is('session_id', null)
    .limit(TEMPLATE_READ_LIMIT);
  if (error) {
    logger.warn({ err: error, scenarioId }, 'template injects were not listed for promotion');
    return [];
  }
  return (data ?? []).map((row) => {
    const config = row.delivery_config as { inject_key?: unknown } | null;
    const key = typeof config?.inject_key === 'string' ? config.inject_key : null;
    return { id: String(row.id), key, delivery_config: row.delivery_config };
  });
}

async function loadPeople(scenarioId: string): Promise<DirectorPerson[]> {
  const people = await getStakeholders(scenarioId);
  return people.map((person) => ({
    id: person.id,
    name: person.name,
    email: person.email,
    phone: person.phone,
    handle: person.handle,
    organisation: person.organisation,
  }));
}

async function loadNpcs(scenarioId: string): Promise<DirectorNpc[]> {
  const { data } = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .maybeSingle();
  const initial = (data?.initial_state ?? {}) as Record<string, unknown>;
  return readNpcs(initial);
}

async function insertTemplate(row: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('scenario_injects')
    .insert(row)
    .select('id')
    .maybeSingle();
  if (error || !data) {
    logger.warn({ err: error }, 'promoted template inject was not created');
    return null;
  }
  return String(data.id);
}

function promotedFrom(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = (config as { promoted_from?: unknown }).promoted_from;
  return typeof value === 'string' ? value : null;
}

let missingWarned = false;

function warnMissing(err: unknown): void {
  if (missingWarned) return;
  missingWarned = true;
  logger.warn({ err, event: 'director_promote_unapplied' }, 'Director proposals are not available');
}
