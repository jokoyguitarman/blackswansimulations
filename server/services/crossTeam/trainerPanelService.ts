/**
 * Payload for the trainer Dependencies panel. Migration 280 missing, or the
 * feature flag off, returns available: false so the panel shows nothing.
 */

import { env } from '../../env.js';
import { applyFiredMinutes, PRESSURE_STRIP_MINUTES } from '../../../shared/crossTeamPanel.js';
import {
  loadSessionDependencyViews,
  sessionMinute,
  type DependencySession,
  type SessionDependencyView,
} from '../dependencies/dependencyService.js';
import {
  readGuardEvents,
  readRecentTriggerPressure,
  readTriggerMinutes,
} from './crossTeamReads.js';

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
  const heldItems = guards
    .filter((row) => row.reason !== '' && row.inject_key !== '')
    .map((row) => ({ inject_key: row.inject_key, reason: row.reason, minute: row.minute }));
  const keys = new Set<string>(heldItems.map((item) => item.inject_key));
  for (const edge of views.edges) {
    if ('after_inject_key' in edge.due) keys.add(edge.due.after_inject_key);
  }
  const fires = await readTriggerMinutes(session.id, [...keys]);
  const activity = applyFiredMinutes({
    fired: fires.missing ? [] : fires.rows,
    held: heldItems,
  });
  return {
    available: true,
    elapsed_minute: elapsed,
    edges: views.edges,
    anchors: activity.anchors,
    events: triggers.rows.map((row) => ({
      minute: row.minute,
      origin: row.origin,
      source_teams: row.source_teams,
      target_teams: row.target_teams,
    })),
    held: activity.held,
  };
}
