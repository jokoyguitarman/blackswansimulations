/**
 * AAR Incident-Response Service
 * Builds incident-response pairs and insider usage gaps for AAR sections.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import {
  insiderHasInfoForIncident,
  teamConsultedInsiderBefore,
} from './incidentDecisionGradingService.js';

export interface IncidentResponsePair {
  incident: {
    id: string;
    title: string;
    description?: string;
    reported_at?: string;
    inject_id?: string;
  };
  decision: {
    id: string;
    title: string;
    description?: string;
    executed_at?: string;
    proposed_by?: string;
  };
  robustness?: number;
  environmentalConsistency?: unknown;
  latencyMinutes?: number;
  insiderConsulted?: boolean;
  intelMatch?: boolean;
}

interface DecisionRow {
  id: string;
  title: string;
  description?: string;
  executed_at?: string;
  proposed_by?: string;
  response_to_incident_id?: string | null;
  environmental_consistency?: unknown;
}

interface IncidentRow {
  id: string;
  title: string;
  description?: string;
  reported_at?: string;
  inject_id?: string;
}

interface ImpactMatrixRow {
  evaluated_at: string;
  robustness_by_decision?: Record<string, number>;
}

/**
 * Build incident-response pairs for AAR.
 * Joins incidents to decisions via response_to_incident_id, adds robustness,
 * environmental consistency, latency, and insider consultation.
 * Intel match is skipped for initial implementation (Option B).
 */
export async function buildIncidentResponsePairs(
  sessionId: string,
  scenarioId: string,
  decisions: DecisionRow[],
  incidents: IncidentRow[],
  impactMatrices: ImpactMatrixRow[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved for future intel match (Option A)
  openAiApiKey: string | undefined,
): Promise<IncidentResponsePair[]> {
  const incidentMap = new Map(incidents.map((i) => [i.id, i]));
  const decisionsWithIncident = decisions.filter(
    (d) => d.response_to_incident_id && incidentMap.has(d.response_to_incident_id),
  );

  if (decisionsWithIncident.length === 0) return [];

  const latestMatrix = impactMatrices[impactMatrices.length - 1];
  const robustnessByDecision = latestMatrix?.robustness_by_decision ?? {};

  const { data: sessionTeams } = await supabaseAdmin
    .from('session_teams')
    .select('user_id, team_name')
    .eq('session_id', sessionId);

  const userIdToTeamName = new Map<string, string>();
  const teamNameToUserIds = new Map<string, string[]>();
  for (const row of sessionTeams ?? []) {
    const r = row as { user_id: string; team_name: string };
    userIdToTeamName.set(r.user_id, r.team_name);
    const existing = teamNameToUserIds.get(r.team_name) ?? [];
    if (!existing.includes(r.user_id)) existing.push(r.user_id);
    teamNameToUserIds.set(r.team_name, existing);
  }

  const pairs: IncidentResponsePair[] = [];

  for (const decision of decisionsWithIncident) {
    const incidentId = decision.response_to_incident_id!;
    const incident = incidentMap.get(incidentId);
    if (!incident) continue;

    const proposedBy = decision.proposed_by;
    const teamName = proposedBy ? userIdToTeamName.get(proposedBy) : undefined;
    const teamUserIds = teamName
      ? (teamNameToUserIds.get(teamName) ?? [proposedBy!])
      : proposedBy
        ? [proposedBy]
        : [];

    const executedAt = decision.executed_at;
    const insiderConsulted =
      executedAt && teamUserIds.length > 0
        ? await teamConsultedInsiderBefore(sessionId, teamUserIds, executedAt)
        : false;

    let latencyMinutes: number | undefined;
    if (incident.reported_at && decision.executed_at) {
      const reported = new Date(incident.reported_at).getTime();
      const executed = new Date(decision.executed_at).getTime();
      latencyMinutes = Math.round((executed - reported) / (1000 * 60));
    }

    pairs.push({
      incident: {
        id: incident.id,
        title: incident.title ?? '',
        description: incident.description,
        reported_at: incident.reported_at,
        inject_id: incident.inject_id,
      },
      decision: {
        id: decision.id,
        title: decision.title ?? '',
        description: decision.description,
        executed_at: decision.executed_at,
        proposed_by: decision.proposed_by,
      },
      robustness: robustnessByDecision[decision.id],
      environmentalConsistency: decision.environmental_consistency,
      latencyMinutes,
      insiderConsulted,
      intelMatch: undefined,
    });
  }

  return pairs;
}

export interface InsiderUsageGap {
  incident_id: string;
  incident_title: string;
  decision_id?: string;
}

export interface InsiderUsageResult {
  questions: Array<{
    question_text?: string;
    category?: string;
    asked_by?: string;
    asked_at?: string;
  }>;
  gaps: InsiderUsageGap[];
}

/**
 * Build insider usage data and gaps (incidents with intel but no consultation before decision).
 */
export async function buildInsiderUsageGaps(
  sessionId: string,
  incidents: IncidentRow[],
  decisions: DecisionRow[],
  sessionInsiderQa: Array<{
    question_text?: string;
    category?: string;
    asked_by?: string;
    asked_at?: string;
  }>,
): Promise<InsiderUsageResult> {
  const questions = sessionInsiderQa.map((q) => ({
    question_text: q.question_text,
    category: q.category,
    asked_by: q.asked_by,
    asked_at: q.asked_at,
  }));

  const { data: sessionTeams } = await supabaseAdmin
    .from('session_teams')
    .select('user_id, team_name')
    .eq('session_id', sessionId);

  const userIdToTeamName = new Map<string, string>();
  const teamNameToUserIds = new Map<string, string[]>();
  for (const row of sessionTeams ?? []) {
    const r = row as { user_id: string; team_name: string };
    userIdToTeamName.set(r.user_id, r.team_name);
    const existing = teamNameToUserIds.get(r.team_name) ?? [];
    if (!existing.includes(r.user_id)) existing.push(r.user_id);
    teamNameToUserIds.set(r.team_name, existing);
  }

  const gaps: InsiderUsageGap[] = [];
  const decisionsByIncident = new Map<string, DecisionRow[]>();
  for (const d of decisions) {
    const incId = d.response_to_incident_id;
    if (!incId) continue;
    const list = decisionsByIncident.get(incId) ?? [];
    list.push(d);
    decisionsByIncident.set(incId, list);
  }

  for (const incident of incidents) {
    const hasIntel = insiderHasInfoForIncident(incident.title ?? '', incident.description ?? '');
    if (!hasIntel) continue;

    const incidentDecisions = decisionsByIncident.get(incident.id) ?? [];
    const executedDecisions = incidentDecisions.filter((d) => d.executed_at);

    let anyConsulted = false;
    let firstUnconsultedDecisionId: string | undefined;
    for (const decision of executedDecisions) {
      const proposedBy = decision.proposed_by;
      const teamName = proposedBy ? userIdToTeamName.get(proposedBy) : undefined;
      const teamUserIds = teamName
        ? (teamNameToUserIds.get(teamName) ?? [proposedBy!])
        : proposedBy
          ? [proposedBy]
          : [];

      const consulted =
        decision.executed_at && teamUserIds.length > 0
          ? await teamConsultedInsiderBefore(sessionId, teamUserIds, decision.executed_at)
          : false;

      if (consulted) anyConsulted = true;
      else if (!firstUnconsultedDecisionId) firstUnconsultedDecisionId = decision.id;
    }

    if (!anyConsulted) {
      gaps.push({
        incident_id: incident.id,
        incident_title: incident.title ?? '',
        decision_id: firstUnconsultedDecisionId,
      });
    }
  }

  return { questions, gaps };
}
