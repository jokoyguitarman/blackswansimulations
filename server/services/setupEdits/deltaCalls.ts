import { affectedLayers, mentionsBriefChange, type BriefDiff } from './affectedLayers.js';
import { mentionsCentreRole } from './briefRevisionCore.js';
import type { DeltaBuildContext } from './deltaBuildTypes.js';

export type DeltaStageName = 'characters' | 'storyline' | 'convergence' | 'pages';

export type DeltaCall =
  | { op: 'brief_diff' }
  | { op: 'fact_sheet' }
  | { op: 'personas'; country: string }
  | { op: 'persona_groups' }
  | { op: 'charter'; team_name: string; org_key: string }
  | { op: 'team_storyline'; team_name: string; org_key: string; country?: string }
  | { op: 'stakeholders'; org_key: string }
  | { op: 'spokesperson'; org_key: string }
  | { op: 'revise_layer'; layer: string; country?: string }
  | { op: 'stakeholder_text' }
  | { op: 'convergence_delta' }
  | { op: 'narrative' }
  | { op: 'pages'; org_keys: string[] }
  | { op: 'page_history'; org_key: string; country?: string };

/** Every AI call this edit needs once the brief diff is known. `diff` null plans only structural work. */
export function listDeltaCalls(ctx: DeltaBuildContext, diff: BriefDiff | null): DeltaCall[] {
  const calls: DeltaCall[] = [];
  const { delta, plan } = ctx;
  const swap = plan.primary_swap;

  if (delta.brief_changed || swap) calls.push({ op: 'brief_diff' });
  for (const country of delta.new_countries) calls.push({ op: 'personas', country });
  if (diff && diff.severity !== 'cosmetic') calls.push({ op: 'fact_sheet' });
  if (diff && (diff.new_groups?.length ?? 0) > 0) calls.push({ op: 'persona_groups' });

  for (const team of delta.added_teams) {
    calls.push({ op: 'charter', team_name: team.team_name, org_key: team.org_key });
    calls.push({
      op: 'team_storyline',
      team_name: team.team_name,
      org_key: team.org_key,
      country: orgCountry(ctx, team.org_key),
    });
  }
  for (const orgKey of delta.added_orgs) calls.push({ op: 'stakeholders', org_key: orgKey });
  for (const orgKey of delta.added_pressure) calls.push({ op: 'spokesperson', org_key: orgKey });
  if (delta.added_teams.length > 0) calls.push({ op: 'convergence_delta' });

  const layers = new Set<string>();
  if (diff && diff.severity !== 'cosmetic') {
    for (const layer of affectedLayers(diff, ctx.injects)) {
      if (!layer.startsWith('branch:')) layers.add(layer);
    }
  }
  if (swap) layers.add('backbone');
  const moved = new Map(delta.relocated_orgs.map((org) => [org.org_key, org.to_country]));
  for (const orgKey of moved.keys()) {
    for (const team of ctx.teams) {
      if (team.org_key !== orgKey) continue;
      layers.add(`team:${team.team_uid}`);
    }
  }
  if (swap) {
    const keys = new Set(
      [swap.old_primary_key, swap.new_primary_previous_key].filter((key): key is string => !!key),
    );
    for (const team of ctx.teams) {
      if (!team.org_key || !keys.has(team.org_key)) continue;
      const layer = `team:${team.team_uid}`;
      const owned = ctx.injects.filter(
        (inject) => inject.layer === layer && inject.provenance === 'ai_owned',
      );
      if (owned.some((inject) => mentionsCentreRole(`${inject.title}\n${inject.content}`))) {
        layers.add(layer);
      }
    }
  }
  for (const layer of [...layers].sort()) {
    const teamUid = layer.startsWith('team:') ? layer.slice('team:'.length) : '';
    const team = ctx.teams.find((item) => item.team_uid === teamUid);
    const country = team?.org_key ? moved.get(team.org_key) : undefined;
    calls.push({ op: 'revise_layer', layer, ...(country ? { country } : {}) });
  }

  if (diff && diff.severity !== 'cosmetic' && stakeholdersAffected(ctx, diff)) {
    calls.push({ op: 'stakeholder_text' });
  }
  if (swap || diff?.severity === 'story') calls.push({ op: 'narrative' });

  const history = new Set<string>();
  for (const org of delta.relocated_orgs) history.add(org.org_key);
  if (swap?.new_primary_previous_key) history.add(swap.new_primary_previous_key);
  if (diff?.severity === 'story') {
    for (const page of ctx.pages) {
      if (mentionsBriefChange(page.historyText, diff)) history.add(page.org_key);
    }
  }
  for (const orgKey of [...history].sort()) {
    calls.push({
      op: 'page_history',
      org_key: orgKey,
      ...(moved.get(orgKey) ? { country: moved.get(orgKey) } : {}),
    });
  }

  const pageOrgs = [...delta.added_orgs, ...delta.added_rivals, ...delta.added_pressure];
  if (pageOrgs.length > 0) calls.push({ op: 'pages', org_keys: pageOrgs });
  return calls;
}

export function stageOfCall(call: DeltaCall): DeltaStageName {
  if (call.op === 'revise_layer') {
    if (call.layer === 'shared' || call.layer === 'gate') return 'convergence';
    if (call.layer.startsWith('pressure:')) return 'pages';
    return 'storyline';
  }
  if (call.op === 'convergence_delta' || call.op === 'narrative') return 'convergence';
  if (call.op === 'pages' || call.op === 'page_history') return 'pages';
  if (
    call.op === 'brief_diff' ||
    call.op === 'fact_sheet' ||
    call.op === 'personas' ||
    call.op === 'persona_groups'
  ) {
    return 'characters';
  }
  return 'storyline';
}

function stakeholdersAffected(ctx: DeltaBuildContext, diff: BriefDiff): boolean {
  const layers = new Set(affectedLayers(diff, ctx.injects));
  return ctx.stakeholders.some(
    (stakeholder) =>
      layers.has(`stakeholder:${stakeholder.id}`) ||
      mentionsBriefChange(`${stakeholder.grievance}\n${stakeholder.knowledge.join('\n')}`, diff),
  );
}

function orgCountry(ctx: DeltaBuildContext, orgKey: string): string | undefined {
  return ctx.edited.organisations.find((org) => org.org_key === orgKey)?.country;
}
