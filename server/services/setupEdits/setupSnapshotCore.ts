import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonicalJson.js';
import { injectKeyOf } from '../../lib/injectKey.js';
import { isPresetFunction, functionKeyForTeamRow } from '../scenarioOrgModel.js';

/**
 * Reconstruct the setup a compiled scenario was built from, and the hash stored
 * on the edit row. Pure: callers load the rows.
 */

export interface SetupCrisis {
  crisis_type: string;
  context: string;
  uploaded_doc_name: string | null;
  uploaded_doc_text_hash: string | null;
  country: string;
  org_name: string;
  duration: number | null;
  auto_antagonist: boolean;
  /** True when the brief was guessed from description and briefing. */
  reconstructed?: boolean;
}

export interface SnapshotTeam {
  team_uid: string;
  team_name: string;
  function_key: string;
  description: string;
  is_custom: boolean;
  is_public_voice: boolean;
}

export interface SnapshotOrg {
  org_uid: string;
  org_key: string;
  display_name: string;
  short_name: string;
  country: string;
  city?: string;
  kind: string;
  operation: 'players' | 'ai';
  is_primary: boolean;
  facebook_handle?: string;
  x_handle?: string;
  teams: SnapshotTeam[];
}

export interface SnapshotPressure {
  org_uid: string;
  org_key: string;
  display_name: string;
  country: string;
  city?: string;
  kind?: string;
  wants?: string;
  register?: string;
  targets_org_keys: string[];
  facebook_handle?: string;
  x_handle?: string;
}

export interface SnapshotCompetitor {
  org_uid: string;
  org_key: string;
  name: string;
  country: string;
  description?: string;
  auto_generated: boolean;
  facebook_handle?: string;
  x_handle?: string;
}

export interface SetupSnapshot {
  crisis: SetupCrisis;
  organisations: SnapshotOrg[];
  pressure_organisations: SnapshotPressure[];
  competitors: SnapshotCompetitor[];
  inject_keys: string[];
  multi_org: boolean;
}

export interface SnapshotTeamRow {
  id?: string;
  team_uid?: string | null;
  team_name?: string | null;
  team_description?: string | null;
  org_key?: string | null;
  function_key?: string | null;
  charter?: {
    mission?: string;
    is_custom?: boolean;
    can_post_publicly?: boolean;
    function_key?: string | null;
  } | null;
}

export interface SnapshotInjectRow {
  id: string;
  delivery_config?: { inject_key?: unknown } | null;
}

export interface ScenarioSnapshotSource {
  scenario: {
    description?: string | null;
    briefing?: string | null;
    duration_minutes?: number | null;
    initial_state?: unknown;
  };
  teams: readonly SnapshotTeamRow[];
  injects: readonly SnapshotInjectRow[];
  /** Latest warroom_builds.request, used when setup_source was never stored. */
  build_request?: unknown;
}

export interface SnapshotOptions {
  /** Used when a legacy organisation has no org_uid. Defaults to a random UUID. */
  assignOrgUid?: () => string;
}

export interface CompileSetupSourceInput {
  crisis_type?: string;
  context?: string;
  uploaded_doc_name?: string | null;
  uploaded_doc_text?: string | null;
  country?: string;
  org_name?: string;
  duration?: number | null;
  auto_antagonist?: boolean;
}

/**
 * Stable org_uid for a legacy scenario that has no registry row yet.
 * The same scenario and key always produce the same id, so a failed write-back
 * still hashes the same way on the next open.
 */
export function stableOrgUid(scenarioId: string, orgKey: string): string {
  const hex = createHash('sha256').update(`org_uid:${scenarioId}:${orgKey}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Oldest scenarios store only org_page.facebook / x_twitter and no orgs[].
 * Add the primary registry row, with a stable org_uid, so the snapshot and the
 * write-back share one id.
 */
export function materializeLegacyPrimary<T>(initialState: T, scenarioId: string): T {
  const state = asRecord(initialState);
  if (!state) return initialState;
  const orgs = Array.isArray(state.orgs) ? state.orgs : [];
  const hasProtagonist = orgs.some((raw) => {
    const org = asRecord(raw);
    if (!org || typeof org.org_key !== 'string' || !org.org_key.trim()) return false;
    return org.side !== 'antagonist' && org.side !== 'pressure' && org.role !== 'antagonist' && org.role !== 'pressure';
  });
  if (hasProtagonist) return initialState;
  const copy = structuredClone(state);
  const existing = Array.isArray(copy.orgs) ? copy.orgs : [];
  copy.orgs = [
    ...existing,
    {
      org_uid: stableOrgUid(scenarioId, 'primary'),
      org_key: 'primary',
      display_name: text(copy.org_name) || 'Organisation',
      country: text(copy.country),
      side: 'protagonist',
      is_primary: true,
      operation: 'players',
      kind: 'company',
    },
  ];
  return copy as T;
}

/** SHA-256 of the uploaded document. Empty text has no hash. The text itself is not returned. */
export function hashUploadedDocument(textBody: string | null | undefined): string | null {
  const trimmed = typeof textBody === 'string' ? textBody.trim() : '';
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed).digest('hex');
}

/** What compile writes to initial_state.setup_source. The document text stays on the wizard draft. */
export function setupSourceFromCompile(input: CompileSetupSourceInput): SetupCrisis {
  return {
    crisis_type: text(input.crisis_type),
    context: text(input.context),
    uploaded_doc_name: text(input.uploaded_doc_name) || null,
    uploaded_doc_text_hash: hashUploadedDocument(input.uploaded_doc_text),
    country: text(input.country),
    org_name: text(input.org_name),
    duration: typeof input.duration === 'number' && Number.isFinite(input.duration) ? input.duration : null,
    auto_antagonist: input.auto_antagonist !== false,
  };
}

/** SHA-256 of the canonical snapshot, ignoring inject keys so a later inject edit does not look like a setup change. */
export function baselineHash(snapshot: SetupSnapshot): string {
  const { inject_keys: _injectKeys, ...rest } = snapshot;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

export function snapshotFromScenario(
  source: ScenarioSnapshotSource,
  options: SnapshotOptions = {},
): SetupSnapshot {
  const assignUid = options.assignOrgUid ?? (() => randomUUID());
  const state = asRecord(source.scenario.initial_state);
  const crisis = crisisFrom(source, state);
  const pageOrgs = pageOrgList(state);
  const registry = registryList(state);
  const organisations = protagonistOrgs(registry, pageOrgs, state, crisis, source.teams, assignUid);
  const protagonists = new Set(organisations.map((org) => org.org_key));
  const pressure = pressureOrgs(registry, pageOrgs, protagonists, assignUid);
  const competitors = competitorOrgs(registry, pageOrgs, assignUid);
  const injectKeys = [
    ...new Set(source.injects.map((inject) => injectKeyOf(inject)).filter((key) => key.length > 0)),
  ].sort();
  return {
    crisis,
    organisations,
    pressure_organisations: pressure,
    competitors,
    inject_keys: injectKeys,
    multi_org: organisations.length > 1,
  };
}

export interface SetupEditDraftLink {
  edit_id: string;
  scenario_id: string;
  scenario_title: string;
  remaining: number | null;
}

/**
 * Wizard draft `input`, using the same keys as SocialCrisisWizard buildDraftInput.
 * Identity fields (org_key, org_uid, team_uid) ride along so a later edit can pin them.
 * The original draft is not read or written.
 */
export function draftInputFromSnapshot(
  snapshot: SetupSnapshot,
  setupEdit: SetupEditDraftLink,
): Record<string, unknown> {
  const primary = snapshot.organisations.find((org) => org.is_primary) ?? snapshot.organisations[0];
  const extras = snapshot.organisations.filter((org) => org !== primary);
  return {
    sim_mode: 'social_media',
    crisis_description: snapshot.crisis.crisis_type,
    org_name: primary?.display_name || snapshot.crisis.org_name,
    country: primary?.country || snapshot.crisis.country,
    context: snapshot.crisis.context,
    uploaded_doc_name: snapshot.crisis.uploaded_doc_name,
    auto_antagonist: snapshot.crisis.auto_antagonist,
    duration: snapshot.crisis.duration,
    primary_city: primary?.city ?? '',
    primary_kind: primary?.kind ?? 'company',
    primary_short_name: primary?.short_name ?? '',
    primary_org_key: primary?.org_key ?? 'primary',
    primary_org_uid: primary?.org_uid ?? '',
    ...(primary?.facebook_handle ? { primary_facebook_handle: primary.facebook_handle } : {}),
    ...(primary?.x_handle ? { primary_x_handle: primary.x_handle } : {}),
    team_roster: (primary?.teams ?? []).map(teamDraft),
    extra_organisations: extras.map(extraOrgDraft),
    pressure_organisations: snapshot.pressure_organisations.map(pressureDraft),
    competitor_entries: snapshot.competitors.filter((rival) => !rival.auto_generated).map(rivalDraft),
    setup_edit: setupEdit,
    ...(snapshot.crisis.reconstructed ? { brief_reconstructed: true } : {}),
  };
}

function teamDraft(team: SnapshotTeam): Record<string, unknown> {
  return {
    team_name: team.function_key || team.team_name,
    description: team.description,
    is_custom: team.is_custom,
    is_public_voice: team.is_public_voice,
    team_uid: team.team_uid,
    function_key: team.function_key,
  };
}

function extraOrgDraft(org: SnapshotOrg): Record<string, unknown> {
  return {
    id: org.org_uid || org.org_key,
    org_key: org.org_key,
    org_uid: org.org_uid,
    display_name: org.display_name,
    short_name: org.short_name,
    country: org.country,
    city: org.city ?? '',
    kind: org.kind,
    facebook_handle: org.facebook_handle ?? '',
    x_handle: org.x_handle ?? '',
    operation: org.operation,
    team_roster: org.teams.map(teamDraft),
  };
}

function pressureDraft(org: SnapshotPressure): Record<string, unknown> {
  return {
    id: org.org_uid || org.org_key,
    org_key: org.org_key,
    org_uid: org.org_uid,
    display_name: org.display_name,
    kind: org.kind ?? 'regulator',
    country: org.country,
    city: org.city ?? '',
    register: org.register ?? 'advocacy',
    wants: org.wants ?? '',
    facebook_handle: org.facebook_handle ?? '',
    x_handle: org.x_handle ?? '',
    targets_org_keys: org.targets_org_keys,
  };
}

function rivalDraft(org: SnapshotCompetitor): Record<string, unknown> {
  return {
    id: `riv_${org.org_key}`,
    org_key: org.org_key,
    org_uid: org.org_uid,
    name: org.name,
    country: org.country,
    facebook_handle: org.facebook_handle ?? '',
    x_handle: org.x_handle ?? '',
    description: org.description ?? '',
  };
}

function crisisFrom(source: ScenarioSnapshotSource, state: Record<string, unknown> | null): SetupCrisis {
  const stored = asRecord(state?.setup_source);
  if (stored && Object.keys(stored).length > 0) return crisisFromRecord(stored, false);
  const request = asRecord(source.build_request);
  if (
    request &&
    (text(request.crisis_type) || text(request.org_name) || text(request.context) || text(request.country))
  ) {
    return crisisFromRecord(
      {
        ...request,
        country: text(request.country) || text(state?.country),
        org_name: text(request.org_name) || text(state?.org_name),
        duration: request.duration ?? source.scenario.duration_minutes ?? null,
      },
      false,
    );
  }
  return {
    crisis_type: text(source.scenario.description),
    context: text(source.scenario.briefing),
    uploaded_doc_name: null,
    uploaded_doc_text_hash: null,
    country: text(state?.country),
    org_name: text(state?.org_name),
    duration: numberOrNull(source.scenario.duration_minutes),
    auto_antagonist: true,
    reconstructed: true,
  };
}

function crisisFromRecord(raw: Record<string, unknown>, forceReconstructed: boolean): SetupCrisis {
  const crisis: SetupCrisis = {
    crisis_type: text(raw.crisis_type),
    context: text(raw.context),
    uploaded_doc_name: text(raw.uploaded_doc_name) || null,
    uploaded_doc_text_hash: text(raw.uploaded_doc_text_hash) || null,
    country: text(raw.country),
    org_name: text(raw.org_name),
    duration: numberOrNull(raw.duration),
    auto_antagonist: raw.auto_antagonist !== false,
  };
  if (forceReconstructed || raw.reconstructed === true) crisis.reconstructed = true;
  return crisis;
}

interface LooseOrg {
  org_uid: string;
  org_key: string;
  display_name: string;
  short_name: string;
  country: string;
  city?: string;
  kind: string;
  operation: 'players' | 'ai';
  is_primary: boolean;
  side: 'protagonist' | 'antagonist' | 'pressure';
  facebook_handle?: string;
  x_handle?: string;
  wants?: string;
  register?: string;
  targets_org_keys: string[];
  description?: string;
  auto_generated: boolean;
}

function protagonistOrgs(
  registry: LooseOrg[],
  pages: LooseOrg[],
  state: Record<string, unknown> | null,
  crisis: SetupCrisis,
  teams: readonly SnapshotTeamRow[],
  assignUid: () => string,
): SnapshotOrg[] {
  const byKey = new Map<string, LooseOrg>();
  for (const org of registry) {
    if (org.side !== 'protagonist' || !org.org_key) continue;
    byKey.set(org.org_key, org);
  }
  for (const org of pages) {
    if (org.side !== 'protagonist' || !org.org_key || byKey.has(org.org_key)) continue;
    byKey.set(org.org_key, org);
  }
  let orgs = [...byKey.values()];
  if (orgs.length === 0) {
    const page = pages.find((org) => org.is_primary) ?? pages.find((org) => org.side === 'protagonist');
    orgs = [
      {
        org_uid: page?.org_uid || assignUid(),
        org_key: 'primary',
        display_name: text(state?.org_name) || crisis.org_name || page?.display_name || 'Organisation',
        short_name: page?.short_name || '',
        country: text(state?.country) || crisis.country || page?.country || '',
        city: page?.city,
        kind: page?.kind || 'company',
        operation: 'players',
        is_primary: true,
        side: 'protagonist',
        facebook_handle: page?.facebook_handle,
        x_handle: page?.x_handle,
        targets_org_keys: [],
        auto_generated: false,
      },
    ];
  }
  const pageByKey = new Map(pages.filter((org) => org.org_key).map((org) => [org.org_key, org]));
  const built = orgs.map((org) => {
    const page = pageByKey.get(org.org_key);
    return {
      org_uid: org.org_uid || page?.org_uid || assignUid(),
      org_key: org.org_key,
      display_name: org.display_name || page?.display_name || org.org_key,
      short_name: org.short_name || page?.short_name || '',
      country: org.country || page?.country || '',
      ...(org.city || page?.city ? { city: org.city || page?.city } : {}),
      kind: org.kind || page?.kind || 'company',
      operation: org.operation === 'ai' || page?.operation === 'ai' ? 'ai' as const : 'players' as const,
      is_primary: org.is_primary || org.org_key === 'primary',
      ...(org.facebook_handle || page?.facebook_handle
        ? { facebook_handle: org.facebook_handle || page?.facebook_handle }
        : {}),
      ...(org.x_handle || page?.x_handle ? { x_handle: org.x_handle || page?.x_handle } : {}),
      teams: [] as SnapshotTeam[],
    };
  });
  built.sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.org_key.localeCompare(b.org_key));
  const primary = built.find((org) => org.is_primary) ?? built[0];
  const byOrg = new Map(built.map((org) => [org.org_key, org]));
  for (const row of teams) {
    const team = teamFromRow(row);
    if (!team) continue;
    const key = row.org_key?.trim() || '';
    const home = (key && byOrg.get(key)) || (key === 'primary' ? primary : undefined) || (built.length === 1 ? built[0] : primary);
    home?.teams.push(team);
  }
  for (const org of built) {
    org.teams.sort((a, b) => a.team_name.localeCompare(b.team_name) || a.team_uid.localeCompare(b.team_uid));
  }
  return built;
}

function pressureOrgs(
  registry: LooseOrg[],
  pages: LooseOrg[],
  protagonists: Set<string>,
  assignUid: () => string,
): SnapshotPressure[] {
  const byKey = new Map<string, LooseOrg>();
  for (const org of [...registry, ...pages]) {
    if (org.side !== 'pressure' || !org.org_key || protagonists.has(org.org_key)) continue;
    const prev = byKey.get(org.org_key);
    byKey.set(org.org_key, prev ? mergeLoose(prev, org) : org);
  }
  return [...byKey.values()]
    .map((org) => ({
      org_uid: org.org_uid || assignUid(),
      org_key: org.org_key,
      display_name: org.display_name || org.org_key,
      country: org.country,
      ...(org.city ? { city: org.city } : {}),
      ...(org.kind ? { kind: org.kind } : {}),
      ...(org.wants ? { wants: org.wants } : {}),
      ...(org.register ? { register: org.register } : {}),
      targets_org_keys: org.targets_org_keys,
      ...(org.facebook_handle ? { facebook_handle: org.facebook_handle } : {}),
      ...(org.x_handle ? { x_handle: org.x_handle } : {}),
    }))
    .sort((a, b) => a.org_key.localeCompare(b.org_key));
}

function competitorOrgs(
  registry: LooseOrg[],
  pages: LooseOrg[],
  assignUid: () => string,
): SnapshotCompetitor[] {
  const byKey = new Map<string, LooseOrg>();
  for (const org of [...registry, ...pages]) {
    if (org.side !== 'antagonist' || !org.org_key) continue;
    const prev = byKey.get(org.org_key);
    byKey.set(org.org_key, prev ? mergeLoose(prev, org) : org);
  }
  return [...byKey.values()]
    .map((org) => ({
      org_uid: org.org_uid || assignUid(),
      org_key: org.org_key,
      name: org.display_name || org.org_key,
      country: org.country,
      ...(org.description ? { description: org.description } : {}),
      auto_generated: org.auto_generated,
      ...(org.facebook_handle ? { facebook_handle: org.facebook_handle } : {}),
      ...(org.x_handle ? { x_handle: org.x_handle } : {}),
    }))
    .sort((a, b) => a.org_key.localeCompare(b.org_key));
}

function mergeLoose(base: LooseOrg, extra: LooseOrg): LooseOrg {
  return {
    ...base,
    org_uid: base.org_uid || extra.org_uid,
    display_name: base.display_name || extra.display_name,
    short_name: base.short_name || extra.short_name,
    country: base.country || extra.country,
    city: base.city || extra.city,
    kind: base.kind || extra.kind,
    facebook_handle: base.facebook_handle || extra.facebook_handle,
    x_handle: base.x_handle || extra.x_handle,
    wants: base.wants || extra.wants,
    register: base.register || extra.register,
    targets_org_keys: base.targets_org_keys.length > 0 ? base.targets_org_keys : extra.targets_org_keys,
    description: base.description || extra.description,
    auto_generated: base.auto_generated || extra.auto_generated,
    is_primary: base.is_primary || extra.is_primary,
  };
}

function teamFromRow(row: SnapshotTeamRow): SnapshotTeam | null {
  const teamName = text(row.team_name);
  if (!teamName) return null;
  const charter = row.charter && typeof row.charter === 'object' ? row.charter : null;
  const functionKey =
    text(row.function_key) ||
    text(charter?.function_key) ||
    functionKeyForTeamRow(teamName, charter) ||
    teamName.split(' — ')[0]?.trim() ||
    teamName;
  const description = text(row.team_description) || text(charter?.mission);
  const isCustom =
    charter?.is_custom === true ||
    (charter?.is_custom !== false && !text(row.function_key) && !isPresetFunction(functionKey));
  return {
    team_uid: text(row.team_uid) || text(row.id),
    team_name: teamName,
    function_key: functionKey,
    description,
    is_custom: isCustom,
    is_public_voice: charter?.can_post_publicly === true,
  };
}

function registryList(state: Record<string, unknown> | null): LooseOrg[] {
  if (!Array.isArray(state?.orgs)) return [];
  return state.orgs.map((raw) => looseOrg(raw, 'registry')).filter((org): org is LooseOrg => !!org);
}

function pageOrgList(state: Record<string, unknown> | null): LooseOrg[] {
  const page = asRecord(state?.org_page);
  if (Array.isArray(page?.orgs) && page.orgs.length > 0) {
    return page.orgs.map((raw) => looseOrg(raw, 'page')).filter((org): org is LooseOrg => !!org);
  }
  if (page && (asRecord(page.facebook) || asRecord(page.x_twitter))) {
    const legacy = looseOrg(
      {
        org_key: 'primary',
        display_name: text(state?.org_name) || 'Organisation',
        is_primary: true,
        role: 'protagonist',
        facebook: page.facebook,
        x_twitter: page.x_twitter,
        country: state?.country,
      },
      'page',
    );
    return legacy ? [legacy] : [];
  }
  return [];
}

function looseOrg(raw: unknown, origin: 'registry' | 'page'): LooseOrg | null {
  const org = asRecord(raw);
  if (!org) return null;
  const key = text(org.org_key);
  if (!key && origin === 'registry') return null;
  const side = sideOf(org);
  const posture = asRecord(org.posture);
  const targets = Array.isArray(posture?.targets_org_keys)
    ? posture.targets_org_keys.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const facebook = handleOf(org, 'facebook');
  const twitter = handleOf(org, 'x_twitter');
  const stance = text(org.stance);
  return {
    org_uid: text(org.org_uid),
    org_key: key || (org.is_primary === true ? 'primary' : ''),
    display_name: text(org.display_name) || text(org.name) || key,
    short_name: text(org.short_name),
    country: text(org.country),
    ...(text(org.city) ? { city: text(org.city) } : {}),
    kind: text(org.kind) || (side === 'protagonist' ? 'company' : ''),
    operation: org.operation === 'ai' ? 'ai' : 'players',
    is_primary: org.is_primary === true || key === 'primary',
    side,
    ...(facebook ? { facebook_handle: facebook } : {}),
    ...(twitter ? { x_handle: twitter } : {}),
    ...(text(posture?.mandate) ? { wants: text(posture?.mandate) } : {}),
    ...(text(posture?.register) ? { register: text(posture?.register) } : {}),
    targets_org_keys: targets,
    ...(stance ? { description: stance } : {}),
    auto_generated: org.auto_generated === true,
  };
}

function sideOf(org: Record<string, unknown>): 'protagonist' | 'antagonist' | 'pressure' {
  if (org.side === 'antagonist' || org.role === 'antagonist') return 'antagonist';
  if (org.side === 'pressure' || org.role === 'pressure') return 'pressure';
  return 'protagonist';
}

function handleOf(org: Record<string, unknown>, platform: 'facebook' | 'x_twitter'): string {
  const block = asRecord(org[platform]);
  return text(block?.page_handle);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
