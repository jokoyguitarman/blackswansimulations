/**
 * Stakeholder records (contract §3) — loading, validation, visibility, lookups.
 *
 * Runtime plan §3.1. Player-facing callers must pass results through `toPlayerVisible` before
 * responding; hidden fields never leave the server.
 */
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { cachedByScenario, getSessionScenarioId } from '../lib/scenarioCache.js';
import {
  StakeholderSchema,
  isStakeholderVisibleToTeam,
  resolveTeamFunction,
  type Stakeholder,
  type PlayerVisibleStakeholder,
  type StakeholderRelationship,
} from '../lib/stakeholderContract.js';
import { getTeamIdentity } from './orgRegistryService.js';

// ─── Loading ─────────────────────────────────────────────────────────────────

interface StakeholderBundle {
  present: boolean;
  records: Stakeholder[];
  byId: Map<string, Stakeholder>;
  byEmail: Map<string, Stakeholder>;
  byHandle: Map<string, Stakeholder>;
}

const EMPTY_BUNDLE: StakeholderBundle = {
  present: false,
  records: [],
  byId: new Map(),
  byEmail: new Map(),
  byHandle: new Map(),
};

async function loadBundle(scenarioId: string): Promise<StakeholderBundle> {
  return cachedByScenario(
    'stakeholders',
    scenarioId,
    (snapshot) => {
      const raw = snapshot.initial_state.stakeholders;
      if (!Array.isArray(raw)) return EMPTY_BUNDLE;

      const records: Stakeholder[] = [];
      raw.forEach((item, index) => {
        const parsed = StakeholderSchema.safeParse(item);
        if (parsed.success) {
          records.push(parsed.data);
        } else {
          logger.warn(
            {
              scenarioId,
              index,
              id: (item as { id?: unknown })?.id,
              issues: parsed.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join('.')}: ${i.message}`),
            },
            'Skipping malformed stakeholder record',
          );
        }
      });

      const byId = new Map<string, Stakeholder>();
      const byEmail = new Map<string, Stakeholder>();
      const byHandle = new Map<string, Stakeholder>();
      for (const s of records) {
        if (!byId.has(s.id)) byId.set(s.id, s);
        const email = s.email.toLowerCase();
        if (!byEmail.has(email)) byEmail.set(email, s);
        const handle = s.handle.toLowerCase();
        if (!byHandle.has(handle)) byHandle.set(handle, s);
      }
      return { present: true, records, byId, byEmail, byHandle };
    },
    EMPTY_BUNDLE,
  );
}

export async function getStakeholders(scenarioId: string): Promise<Stakeholder[]> {
  return (await loadBundle(scenarioId)).records;
}

/** True when the scenario carries a `stakeholders` block (even if every record was invalid). */
export async function hasStakeholderBlock(scenarioId: string): Promise<boolean> {
  return (await loadBundle(scenarioId)).present;
}

export async function findById(scenarioId: string, id: string): Promise<Stakeholder | null> {
  return (await loadBundle(scenarioId)).byId.get(id) ?? null;
}

export async function findByEmail(scenarioId: string, email: string): Promise<Stakeholder | null> {
  return (await loadBundle(scenarioId)).byEmail.get(email.trim().toLowerCase()) ?? null;
}

export async function findByHandle(
  scenarioId: string,
  handle: string,
): Promise<Stakeholder | null> {
  const h = handle.trim().toLowerCase();
  return (await loadBundle(scenarioId)).byHandle.get(h.startsWith('@') ? h : `@${h}`) ?? null;
}

// ─── Visibility ──────────────────────────────────────────────────────────────

/**
 * Stakeholders the caller may see: their team's function at their org (+ common ones).
 * Trainers/admins (`asTrainer`) see everything. Unassigned players see nothing.
 */
export async function getVisibleStakeholders(
  sessionId: string,
  userId: string,
  opts: { asTrainer?: boolean } = {},
): Promise<Stakeholder[]> {
  const scenarioId = await getSessionScenarioId(sessionId);
  if (!scenarioId) return [];
  const records = await getStakeholders(scenarioId);
  if (records.length === 0) return [];
  if (opts.asTrainer) return records;

  const identity = await getTeamIdentity(sessionId, userId);
  if (!identity) return [];
  return records.filter((s) => isStakeholderVisibleToTeam(s, identity));
}

/** Visible-to-caller check for a single stakeholder (404-style: false when unknown). */
export async function canUserSeeStakeholder(
  sessionId: string,
  userId: string,
  stakeholderId: string,
  opts: { asTrainer?: boolean } = {},
): Promise<Stakeholder | null> {
  const scenarioId = await getSessionScenarioId(sessionId);
  if (!scenarioId) return null;
  const s = await findById(scenarioId, stakeholderId);
  if (!s) return null;
  if (opts.asTrainer) return s;
  const identity = await getTeamIdentity(sessionId, userId);
  if (!identity) return null;
  return isStakeholderVisibleToTeam(s, identity) ? s : null;
}

// ─── Fallback contacts for scenarios without a stakeholders block ───────────

const INTERNAL_CATEGORIES = new Set(['verified_facts', 'sitrep_request']);

/**
 * Contacts derived from inbound inject email senders (contract §7 item 1). Player-visible shape
 * only; no hidden fields, so these never take part in reconsideration.
 */
export async function getFallbackContacts(
  sessionId: string,
  userId: string,
  opts: { asTrainer?: boolean } = {},
): Promise<PlayerVisibleStakeholder[]> {
  const identity = opts.asTrainer ? null : await getTeamIdentity(sessionId, userId);
  if (!opts.asTrainer && !identity) return [];

  const { data: emails } = await supabaseAdmin
    .from('sim_emails')
    .select('from_address, from_name, email_category, inject_id')
    .eq('session_id', sessionId)
    .eq('direction', 'inbound')
    .not('inject_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(300);

  const injectIds = Array.from(
    new Set((emails ?? []).map((e) => String((e as { inject_id: string }).inject_id))),
  );
  const teamByInject = new Map<string, string>();
  if (injectIds.length > 0) {
    const { data: injects } = await supabaseAdmin
      .from('scenario_injects')
      .select('id, delivery_config')
      .in('id', injectIds);
    for (const inj of injects ?? []) {
      const row = inj as { id: string; delivery_config: Record<string, unknown> | null };
      const owner = row.delivery_config?.stakeholder_team;
      if (typeof owner === 'string' && owner) teamByInject.set(row.id, owner);
    }
  }

  const myFunction = identity ? resolveTeamFunction(identity) : null;
  const seen = new Set<string>();
  const out: PlayerVisibleStakeholder[] = [];
  for (const e of emails ?? []) {
    const row = e as {
      from_address: string;
      from_name: string;
      email_category: string | null;
      inject_id: string;
    };
    const address = String(row.from_address || '').toLowerCase();
    if (!address || address === 'system@sim.local' || seen.has(address)) continue;
    const owningTeam = teamByInject.get(row.inject_id) ?? '*';
    const visible =
      opts.asTrainer ||
      owningTeam === '*' ||
      owningTeam === myFunction ||
      owningTeam === identity?.team_name;
    if (!visible) continue;
    seen.add(address);
    const relationship: StakeholderRelationship = INTERNAL_CATEGORIES.has(
      String(row.email_category || ''),
    )
      ? 'internal'
      : 'other';
    out.push({
      id: `fallback:${address}`,
      name: String(row.from_name || address),
      title: '',
      organisation: address.split('@')[1]?.replace(/\.sim$/, '') || '',
      relationship,
      owning_team: owningTeam === '*' ? (identity?.team_name ?? 'All teams') : owningTeam,
      org_key: null,
      email: address,
      phone: null,
      handle: `@${address.split('@')[0].replace(/[^a-z0-9_]/g, '_')}`,
      note: 'Previous correspondent',
    });
  }
  return out;
}
