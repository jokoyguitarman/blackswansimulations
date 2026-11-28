/**
 * Payload for the trainer Dependencies panel. Migration 280 missing, or the
 * feature flag off, returns available: false so the panel shows nothing.
 */

import { env } from '../../env.js';
import {
  listSessionDependencies,
  sessionMinute,
  type DependencySession,
  type SessionDependencyView,
} from '../dependencies/dependencyService.js';
import { readDependencyStateRows, readGuardEvents, readInjectTriggers } from './crossTeamReads.js';

export interface TrainerPanelPayload {
  available: boolean;
  elapsed_minute: number;
  edges: SessionDependencyView[];
  anchors: Record<string, number>;
  events: Array<{
    minute: number;
    origin: string;
    source_teams: string[];
    target_teams: string[];
  }>;
  held: Array<{ inject_key: string; reason: string; minute: number }>;
}

export async function loadTrainerPanel(session: DependencySession): Promise<TrainerPanelPayload> {
  const elapsed = sessionMinute(session.start_time);
  const empty: TrainerPanelPayload = {
    available: false,
    elapsed_minute: elapsed,
    edges: [],
    anchors: {},
    events: [],
    held: [],
  };
  if (!env.crossTeamDependencies) return empty;
  const states = await readDependencyStateRows(session.id);
  if (states.missing) return empty;
  const [edges, triggers, guards] = await Promise.all([
    listSessionDependencies(session),
    readInjectTriggers(session.id),
    readGuardEvents(session.id),
  ]);
  const anchors: Record<string, number> = {};
  const events: TrainerPanelPayload['events'] = [];
  for (const row of triggers.rows) {
    if (row.inject_key && anchors[row.inject_key] == null) anchors[row.inject_key] = row.minute;
    events.push({
      minute: row.minute,
      origin: row.origin,
      source_teams: row.source_teams,
      target_teams: row.target_teams,
    });
  }
  return {
    available: true,
    elapsed_minute: elapsed,
    edges,
    anchors,
    events,
    held: guards
      .filter((row) => row.reason !== '')
      .map((row) => ({ inject_key: row.inject_key, reason: row.reason, minute: row.minute })),
  };
}
