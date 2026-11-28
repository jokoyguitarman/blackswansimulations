/**
 * Cross-team after-action section. Injects, deliveries and replies come from
 * the comms timeline loader. Dependency rows come from the dependency service.
 */

import { logger } from '../../lib/logger.js';
import { isInjectKey } from '../../../shared/injectKeySlug.js';
import {
  buildCrossTeamSection,
  type CrossTeamEdgeInput,
  type CrossTeamReplyInput,
  type CrossTeamSection,
  type CrossTeamTriggerInput,
  type PublishedInjectInput,
} from '../../../shared/crossTeamAar.js';
import { crisisElapsedMinutes } from '../../lib/sessionPhase.js';
import { formatConditionLabel, parseConditionKey } from '../conditions/conditionCatalog.js';
import { loadRoster } from '../conditions/injectTriggerService.js';
import {
  loadSessionDependencyViews,
  type SessionDependencyView,
} from '../dependencies/dependencyService.js';
import {
  buildCommsResponsesSection,
  loadAarSessionParts,
  type AarInject,
  type AarResponse,
  type AarSessionParts,
} from '../aarCommsResponses.js';
import { loadDirectorAar, type DirectorAarLoad } from '../director/directorAarService.js';
import { emptyUnscriptedAar, type UnscriptedAarSection } from '../director/directorAarCore.js';
import type { TriggerHistoryRow } from '../crossTeam/crossTeamReads.js';
import { inferCrossTeamTriggers } from './aarCrossTeamInfer.js';

export function emptyCrossTeamSection(): CrossTeamSection {
  return { provenance: 'inferred', edges: [], chains: [], teams: [] };
}

export async function loadCrossTeamSection(sessionId: string): Promise<CrossTeamSection> {
  const parts = await loadAarSessionParts(sessionId);
  if (!parts) return emptyCrossTeamSection();
  return loadCrossTeamSectionFromParts(parts);
}

export async function loadCrossTeamSectionFromParts(
  parts: AarSessionParts,
): Promise<CrossTeamSection> {
  try {
    if (!parts.scenarioId) return emptyCrossTeamSection();
    const views = await loadSessionDependencyViews(
      { id: parts.sessionId, scenario_id: parts.scenarioId, start_time: parts.startTime },
      { history: true },
    );
    return sectionFrom(parts, views.edges, await loadRoster(parts.scenarioId, true));
  } catch (err) {
    logger.warn(
      { err, event: 'aar_cross_team_failed', sessionId: parts.sessionId },
      'Cross-team cause and effect omitted',
    );
    return emptyCrossTeamSection();
  }
}

/** Comms timeline, cross-team section and director rows share one load of the session. */
export async function loadSharedAarSections(sessionId: string): Promise<{
  comms: ReturnType<typeof buildCommsResponsesSection>;
  crossTeam: CrossTeamSection;
  unscripted: UnscriptedAarSection;
}> {
  const parts = await loadAarSessionParts(sessionId);
  const director = await directorFrom(sessionId, parts);
  if (!parts) {
    return {
      comms: buildCommsResponsesSection({ unscriptedNotes: director.notes }),
      crossTeam: emptyCrossTeamSection(),
      unscripted: director.section,
    };
  }
  return {
    comms: buildCommsResponsesSection({ ...parts, unscriptedNotes: director.notes }),
    crossTeam: await loadCrossTeamSectionFromParts(parts),
    unscripted: director.section,
  };
}

async function directorFrom(
  sessionId: string,
  parts: AarSessionParts | null,
): Promise<DirectorAarLoad> {
  try {
    return await loadDirectorAar(
      sessionId,
      parts?.startTime ?? null,
      parts?.scenarioId ?? null,
      parts?.validAt ?? null,
    );
  } catch {
    return { notes: {}, section: emptyUnscriptedAar(), withheld: [] };
  }
}

function sectionFrom(
  parts: AarSessionParts,
  views: readonly SessionDependencyView[],
  teams: Awaited<ReturnType<typeof loadRoster>>,
): CrossTeamSection {
  const edges = views.map(edgeFromView);
  const titles = new Map(
    parts.injects.map((inject) => [
      inject.inject_key ?? '',
      inject.title || inject.inject_key || '',
    ]),
  );
  const known = new Set(
    parts.injects.map((inject) => inject.inject_key ?? '').filter((key) => isInjectKey(key)),
  );
  const recorded =
    parts.triggerRows == null ? null : parts.triggerRows.map((row) => triggerInput(row, titles));
  const hasTriggers = recorded != null && recorded.length > 0;
  return buildCrossTeamSection({
    triggers: recorded,
    edges,
    replies: parts.responses.map(replyFrom).filter((reply) => reply.inject_key !== ''),
    inferred: hasTriggers ? [] : inferCrossTeamTriggers(publishedInjects(parts), edges, teams),
    inject_keys: [...known],
  });
}

function edgeFromView(view: SessionDependencyView): CrossTeamEdgeInput {
  const downstream =
    view.state.downstream.length > 0
      ? view.state.downstream
      : view.downstream.map((team) => team.team_name);
  return {
    id: view.id,
    upstream: view.state.upstream || view.upstream.team_name,
    downstream,
    deliverable: view.deliverable,
    due: view.due,
    consequence_keys: view.consequence_keys,
    status: view.state.status,
    broken_minute: view.state.broken_minute,
    met_minute: view.state.met_minute,
    recovered_minute: view.state.recovered_minute,
    evidence: view.state.evidence.map((item) => ({ detail: item.detail })),
  };
}

export function triggerInput(
  row: TriggerHistoryRow,
  titles: ReadonlyMap<string, string>,
): CrossTeamTriggerInput {
  const parents: string[] = [];
  for (const key of row.parent_inject_keys) {
    if (!isInjectKey(key) || parents.includes(key)) continue;
    parents.push(key);
  }
  return {
    inject_key: row.inject_key,
    title: titles.get(row.inject_key) || row.inject_key,
    minute: row.minute,
    origin: row.origin,
    source_teams: row.source_teams,
    target_teams: row.target_teams,
    dep_id: row.dep_id,
    cause_depth: row.cause_depth,
    parent_inject_keys: parents,
    signals: signalPhrases(row),
  };
}

function signalPhrases(row: TriggerHistoryRow): string[] {
  const phrases: string[] = [];
  const push = (phrase: string) => {
    const trimmed = phrase.trim();
    if (trimmed && !phrases.includes(trimmed)) phrases.push(trimmed);
  };
  for (const detail of row.key_details) {
    if (isInjectKey(detail.key)) continue;
    push(detail.detail || detail.label || catalogueLabel(detail.key));
  }
  for (const key of row.parent_inject_keys) {
    if (isInjectKey(key) || row.key_details.some((detail) => detail.key === key)) continue;
    push(catalogueLabel(key));
  }
  return phrases;
}

function catalogueLabel(key: string): string {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) return '';
  return formatConditionLabel(parsed);
}

function publishedInjects(parts: AarSessionParts): PublishedInjectInput[] {
  const minuteById = new Map<string, number>();
  const published = new Set<string>();
  for (const delivery of parts.deliveries) {
    published.add(delivery.inject_id);
    const current = minuteById.get(delivery.inject_id);
    if (current == null || delivery.delivered_minute < current) {
      minuteById.set(delivery.inject_id, delivery.delivered_minute);
    }
  }
  for (const claim of parts.publications) {
    published.add(claim.inject_id);
    if (minuteById.has(claim.inject_id) || !claim.claimed_at) continue;
    const at = Date.parse(claim.claimed_at);
    if (!Number.isFinite(at)) continue;
    minuteById.set(claim.inject_id, crisisElapsedMinutes(parts.startTime, at));
  }
  return parts.injects.flatMap((inject) => {
    if (!published.has(inject.id)) return [];
    return [injectInput(inject, minuteById.get(inject.id) ?? null)];
  });
}

function injectInput(inject: AarInject, publishedMinute: number | null): PublishedInjectInput {
  return {
    inject_key: inject.inject_key ?? '',
    title: inject.title || inject.inject_key || '',
    target_teams: inject.target_teams ?? [],
    conditions_to_appear: inject.conditions_to_appear,
    conditions_to_cancel: inject.conditions_to_cancel,
    trigger_time_minutes: inject.trigger_time_minutes ?? null,
    published_minute: publishedMinute,
  };
}

function replyFrom(response: AarResponse): CrossTeamReplyInput {
  const criteria = response.judgement?.criteria ?? [];
  const met = criteria.filter((item) => item.met === true).length;
  return {
    inject_key: response.inject_key,
    team: response.team_name ?? '',
    minute: response.response_minute,
    tone: response.judgement?.tone ?? null,
    criteria_met: criteria.length > 0 ? met : null,
    criteria_total: criteria.length > 0 ? criteria.length : null,
  };
}
