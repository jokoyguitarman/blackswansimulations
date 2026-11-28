import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson.js';

/**
 * Editable fields covered by delivery_config.gen.hash. `delivery_config` is
 * included without its `gen` stamp, so rewriting the stamp does not look like
 * an edit and object key order does not change the hash.
 */
export interface FingerprintInject {
  title?: string | null;
  content?: string | null;
  type?: string | null;
  severity?: string | null;
  trigger_time_minutes?: number | null;
  eligible_after_minutes?: number | null;
  target_teams?: string[] | null;
  inject_scope?: string | null;
  requires_response?: boolean | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  trigger_condition?: string | null;
  delivery_config?: Record<string, unknown> | null;
  generation_source?: string | null;
  gen_layer?: string | null;
}

export interface LayerTeam {
  team_name: string;
  team_uid?: string | null;
}

export interface GenStamp {
  layer: string;
  edit: number;
  hash: string;
  team_uid?: string;
  org_key?: string;
  stakeholder_id?: string;
  parent_key?: string;
}

const PRESSURE_ORG_KEY = /^org_pressure_[a-z0-9_]+$/;

export function deliveryConfigWithoutGen(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const copy = { ...(config as Record<string, unknown>) };
  delete copy.gen;
  return copy;
}

export function fingerprintInject(row: FingerprintInject): string {
  const payload = {
    title: row.title ?? null,
    content: row.content ?? null,
    type: row.type ?? null,
    severity: row.severity ?? null,
    trigger_time_minutes: row.trigger_time_minutes ?? null,
    eligible_after_minutes: row.eligible_after_minutes ?? null,
    target_teams: row.target_teams ?? null,
    inject_scope: row.inject_scope ?? null,
    requires_response: row.requires_response ?? null,
    conditions_to_appear: row.conditions_to_appear ?? null,
    conditions_to_cancel: row.conditions_to_cancel ?? null,
    delivery_config: deliveryConfigWithoutGen(row.delivery_config),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function genRecord(row: FingerprintInject): Record<string, unknown> | null {
  const gen = row.delivery_config?.gen;
  if (!gen || typeof gen !== 'object' || Array.isArray(gen)) return null;
  return gen as Record<string, unknown>;
}

/**
 * True when the row is still the War Room's text.
 * A legacy row with no gen.hash counts as AI-owned from generation_source alone.
 * Review marks those rows unverified (see injectProvenance).
 */
export function isAiOwned(row: FingerprintInject): boolean {
  if (row.generation_source === 'war_room') {
    const hash = genRecord(row)?.hash;
    if (typeof hash !== 'string' || hash.length === 0) return true;
    return hash === fingerprintInject(row);
  }
  return promotedAiOwned(row);
}

/**
 * A promoted director event is AI-owned only while its text still matches the
 * stamp. An edit before promotion (gen.edit 1, or no hash) is hand-owned.
 */
function promotedAiOwned(row: FingerprintInject): boolean {
  if (row.generation_source !== 'trainer') return false;
  const gen = genRecord(row);
  if (!gen || gen.layer !== 'promoted') return false;
  if (gen.edit === 1) return false;
  const hash = gen.hash;
  if (typeof hash !== 'string' || hash.length === 0) return false;
  return hash === fingerprintInject(row);
}

export type InjectProvenance = 'ai_owned' | 'hand_edited' | 'unverified';

/** Legacy War Room rows are AI-owned for revision, and unverified for Review. */
export function injectProvenance(row: FingerprintInject): InjectProvenance {
  if (row.generation_source === 'war_room') {
    const hash = genRecord(row)?.hash;
    if (typeof hash !== 'string' || hash.length === 0) return 'unverified';
    return hash === fingerprintInject(row) ? 'ai_owned' : 'hand_edited';
  }
  return promotedAiOwned(row) ? 'ai_owned' : 'hand_edited';
}

function textField(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Guess a generation layer for a row that was never stamped.
 * Most specific signal wins: branch, stakeholder, pressure org, one team,
 * decision trigger, conditions, then shared (no teams) or backbone.
 */
export function inferLayer(row: FingerprintInject, teams: readonly LayerTeam[] = []): string {
  const config = deliveryConfigWithoutGen(row.delivery_config);
  if (textField(config, 'promoted_from')) return 'promoted';
  const parent = textField(config, 'parent_inject_key') ?? textField(config, 'parent_key');
  if (parent) return `branch:${parent}`;

  const stakeholder = textField(config, 'stakeholder_id');
  if (stakeholder) return `stakeholder:${stakeholder}`;

  const orgKey = textField(config, 'page_org_key') ?? textField(config, 'org_key');
  if (orgKey && PRESSURE_ORG_KEY.test(orgKey)) return `pressure:${orgKey}`;

  const targets = Array.isArray(row.target_teams) ? row.target_teams.filter((name) => name) : [];
  if (targets.length === 1) {
    const team = teams.find((item) => item.team_name === targets[0] || item.team_uid === targets[0]);
    const uid = team?.team_uid || null;
    return `team:${uid || targets[0]}`;
  }

  if (typeof row.trigger_condition === 'string' && row.trigger_condition.length > 0) {
    return 'strategy';
  }
  if (row.conditions_to_appear != null) return 'gate';
  if (targets.length === 0) return 'shared';
  return 'backbone';
}

export function applyInjectGenStamp<T extends FingerprintInject>(
  row: T,
  options: {
    teamUidByName: ReadonlyMap<string, string>;
    persistTeamUid: boolean;
  },
): Omit<T, 'gen_layer'> & { delivery_config: Record<string, unknown> } {
  const { gen_layer: genLayer, ...rest } = row;
  const delivery = deliveryConfigWithoutGen(row.delivery_config);
  const teamsForGuess: LayerTeam[] = [...options.teamUidByName.entries()].map(
    ([team_name, team_uid]) =>
      options.persistTeamUid ? { team_name, team_uid } : { team_name },
  );
  let layer = genLayer || inferLayer({ ...rest, delivery_config: delivery }, teamsForGuess);
  let teamUid: string | undefined;
  if (layer.startsWith('team:')) {
    const token = layer.slice('team:'.length);
    const byName = options.teamUidByName.get(token);
    const byUid = [...options.teamUidByName.entries()].find(([, uid]) => uid === token);
    if (options.persistTeamUid && (byName || byUid)) {
      teamUid = byName ?? byUid?.[1];
      layer = `team:${teamUid}`;
    } else if (byUid) {
      layer = `team:${byUid[0]}`;
    }
  }

  const hash = fingerprintInject({ ...rest, delivery_config: delivery });
  const gen: GenStamp = { layer, edit: 0, hash };
  if (teamUid) gen.team_uid = teamUid;
  const orgKey = textField(delivery, 'org_key');
  const stakeholderId = textField(delivery, 'stakeholder_id');
  const parentKey = textField(delivery, 'parent_inject_key') ?? textField(delivery, 'parent_key');
  if (orgKey) gen.org_key = orgKey;
  if (stakeholderId) gen.stakeholder_id = stakeholderId;
  if (parentKey) gen.parent_key = parentKey;

  return {
    ...rest,
    delivery_config: { ...delivery, gen },
  };
}
