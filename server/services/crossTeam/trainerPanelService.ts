/**
 * Payload for the trainer Dependencies panel. Migration 280 missing, or the
 * feature flag off, returns available: false so the panel shows nothing.
 */

import { env } from '../../env.js';
import { PRESSURE_STRIP_MINUTES } from '../../../shared/crossTeamPanel.js';
import {
  loadSessionDependencyViews,
  sessionMinute,
  type DependencySession,
  type SessionDependencyView,
} from '../dependencies/dependencyService.js';
import { readGuardEvents, readRecentTriggerPressure } from './crossTeamReads.js';

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
  const since = Math.max(0, elapsed - PRESSURE_STRIP_MINUTES);
  const [views, triggers, guards] = await Promise.all([
    loadSessionDependencyViews(session),
    readRecentTriggerPressure(session.id, since),
    readGuardEvents(session.id),
  ]);
  if (views.missing) return empty;
  const anchors: Record<string, number> = {};
  const events: TrainerPanelPayload['events'] = [];
  const published = new Set<string>();
  for (const row of triggers.rows) {
    if (row.inject_key) {
      published.add(row.inject_key);
      if (anchors[row.inject_key] == null) anchors[row.inject_key] = row.minute;
    }
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
    edges: views.edges,
    anchors,
    events,
    held: guards
      .filter((row) => row.reason !== '' && !published.has(row.inject_key))
      .map((row) => ({ inject_key: row.inject_key, reason: row.reason, minute: row.minute })),
  };
}
