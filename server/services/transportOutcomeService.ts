/**
 * Transport Outcome Service
 * Evaluates decisions that involve patient transport to facilities, checks
 * route conditions from session state, and generates realistic outcome injects.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import type { Server as SocketServer } from 'socket.io';

interface RouteRow {
  route_id?: string;
  label?: string;
  problem?: string | null;
  managed?: boolean;
  travel_time_minutes?: number | null;
  connects_to?: string[];
  is_optimal_for?: string[];
}

interface TransportIntent {
  is_transport: boolean;
  destination_facility?: string;
}

async function detectTransportIntent(
  decisionText: string,
  openAiApiKey: string,
): Promise<TransportIntent | null> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a crisis management evaluator. Given a decision, determine if it involves TRANSPORTING patients, casualties, or injured people to a specific facility (hospital, clinic, medical center).
Return JSON only: { "is_transport": boolean, "destination_facility": "facility name or null" }
- is_transport: true only if the decision explicitly proposes moving patients/casualties to a named medical facility.
- destination_facility: the specific facility name mentioned (e.g. "Singapore General Hospital", "TTSH"). null if no specific facility named.
- Decisions about setting up triage or treating on-site are NOT transport decisions.`,
          },
          {
            role: 'user',
            content: `Decision text:\n${decisionText.slice(0, 1500)}\n\nIs this a transport decision? JSON only.`,
          },
        ],
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content) as TransportIntent;
  } catch (err) {
    logger.warn({ err }, 'Transport intent detection failed');
    return null;
  }
}

function findRoutesToFacility(routes: RouteRow[], facilityName: string): RouteRow[] {
  const lower = facilityName.toLowerCase();
  return routes.filter((r) => {
    const connects = r.connects_to ?? [];
    return connects.some((c) => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()));
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function findOptimalRoute(routes: RouteRow[], facilityName: string): RouteRow | undefined {
  const lower = facilityName.toLowerCase();
  return routes.find((r) => {
    const optimal = r.is_optimal_for ?? [];
    return optimal.some((o) => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()));
  });
}

type TransportOutcome =
  | { type: 'clear'; route: RouteRow; travelMin: number }
  | { type: 'congested'; route: RouteRow; problem: string; travelMin: number | null }
  | { type: 'no_route_named'; routes: RouteRow[] }
  | { type: 'no_data' };

function determineOutcome(matchingRoutes: RouteRow[]): TransportOutcome {
  if (matchingRoutes.length === 0) return { type: 'no_data' };

  const clearRoutes = matchingRoutes.filter((r) => r.managed === true || !r.problem);
  const congestedRoutes = matchingRoutes.filter((r) => r.managed === false && r.problem);

  if (congestedRoutes.length > 0 && clearRoutes.length === 0) {
    const worst = congestedRoutes[0];
    return {
      type: 'congested',
      route: worst,
      problem: worst.problem!,
      travelMin: worst.travel_time_minutes ?? null,
    };
  }

  if (clearRoutes.length > 0 && congestedRoutes.length === 0) {
    const best = clearRoutes.sort(
      (a, b) => (a.travel_time_minutes ?? 99) - (b.travel_time_minutes ?? 99),
    )[0];
    return {
      type: 'clear',
      route: best,
      travelMin: best.travel_time_minutes ?? 10,
    };
  }

  return { type: 'no_route_named', routes: matchingRoutes };
}

async function generateOutcomeInjectContent(
  outcome: Exclude<TransportOutcome, { type: 'no_data' }>,
  facilityName: string,
  scenarioTitle: string,
  openAiApiKey: string,
): Promise<{ title: string; content: string; severity: string } | null> {
  let contextBlock: string;
  let desiredTone: string;

  switch (outcome.type) {
    case 'clear':
      contextBlock = `Route "${outcome.route.label}" to ${facilityName} is CLEAR. Estimated travel time: ${outcome.travelMin} minutes. No issues reported.`;
      desiredTone = 'positive operational update';
      break;
    case 'congested':
      contextBlock = `Route to ${facilityName} is BLOCKED/CONGESTED. Problem: ${outcome.problem}. ${outcome.travelMin ? `Inflated travel time: ${outcome.travelMin} minutes.` : 'Route may be impassable.'} `;
      desiredTone = 'urgent field update requiring adaptation';
      break;
    case 'no_route_named': {
      const hasProblems = outcome.routes.some((r) => r.problem && !r.managed);
      if (hasProblems) {
        const problemRoute = outcome.routes.find((r) => r.problem && !r.managed)!;
        contextBlock = `Ambulance dispatched to ${facilityName}. However, the likely route "${problemRoute.label}" has a known issue: ${problemRoute.problem}. Travel time may be significantly increased.`;
        desiredTone = 'cautionary field update — transport underway but may face delays';
      } else {
        const bestRoute = outcome.routes.sort(
          (a, b) => (a.travel_time_minutes ?? 99) - (b.travel_time_minutes ?? 99),
        )[0];
        contextBlock = `Ambulance dispatched to ${facilityName} via ${bestRoute?.label ?? 'standard route'}. Estimated travel time: ${bestRoute?.travel_time_minutes ?? 10} minutes. Route conditions normal.`;
        desiredTone = 'neutral operational update';
      }
      break;
    }
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are generating a realistic in-world inject for a crisis management training exercise ("${scenarioTitle}"). Write a brief field update about a patient transport outcome.

Context: ${contextBlock}

Tone: ${desiredTone}

Return JSON only:
{
  "title": "string — short inject title (e.g. 'Ambulance Convoy Update', 'Transport Route Blocked')",
  "content": "string — 1-3 sentences. Write as a realistic field radio report. Be specific about road names and conditions. If the route is blocked, suggest the team consider alternatives or request traffic support.",
  "severity": "low|medium|high|critical"
}`,
          },
          {
            role: 'user',
            content: 'Generate the transport outcome inject. JSON only.',
          },
        ],
        temperature: 0.7,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content) as { title: string; content: string; severity: string };
  } catch (err) {
    logger.warn({ err }, 'Transport outcome inject generation failed');
    return null;
  }
}

/**
 * Evaluate whether a decision involves patient transport, check route conditions,
 * and generate an appropriate outcome inject.
 */
export async function evaluateTransportOutcome(
  sessionId: string,
  decision: { id: string; title: string; description: string; type: string | null },
  teamName: string,
  openAiApiKey: string | undefined,
  socketIo: SocketServer,
): Promise<void> {
  if (!openAiApiKey) return;

  const decisionText = `${decision.title ?? ''} ${decision.description ?? ''}`.trim();
  if (!decisionText) return;

  const intent = await detectTransportIntent(decisionText, openAiApiKey);
  if (!intent?.is_transport || !intent.destination_facility) return;

  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state, trainer_id')
    .eq('id', sessionId)
    .single();

  if (!session) return;

  const currentState = ((session as Record<string, unknown>).current_state ?? {}) as Record<
    string,
    unknown
  >;
  const envState = currentState.environmental_state as { routes?: RouteRow[] } | undefined;
  const routes = Array.isArray(envState?.routes) ? envState.routes : [];

  if (routes.length === 0) return;

  const matchingRoutes = findRoutesToFacility(routes, intent.destination_facility);
  const outcome = determineOutcome(matchingRoutes);

  if (outcome.type === 'no_data') return;

  const scenarioId = (session as Record<string, unknown>).scenario_id as string;
  const trainerId = (session as Record<string, unknown>).trainer_id as string | null;

  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('title')
    .eq('id', scenarioId)
    .single();

  const scenarioTitle =
    ((scenario as Record<string, unknown>)?.title as string) ?? 'Crisis Exercise';

  const injectData = await generateOutcomeInjectContent(
    outcome,
    intent.destination_facility,
    scenarioTitle,
    openAiApiKey,
  );

  if (!injectData) return;

  const validSeverities = ['low', 'medium', 'high', 'critical'];
  const severity = validSeverities.includes(injectData.severity) ? injectData.severity : 'medium';

  const { data: inject, error: insertErr } = await supabaseAdmin
    .from('scenario_injects')
    .insert({
      scenario_id: scenarioId,
      type: 'field_update',
      title: injectData.title,
      content: injectData.content,
      severity,
      inject_scope: 'team_specific',
      target_teams: [teamName],
      requires_response: outcome.type === 'congested',
      requires_coordination: false,
      ai_generated: true,
      generation_source: 'transport_outcome',
    })
    .select()
    .single();

  if (insertErr || !inject) {
    logger.warn(
      { err: insertErr, sessionId, decisionId: decision.id },
      'Transport outcome inject insert failed',
    );
    return;
  }

  const publishUserId = trainerId ?? 'system';
  await publishInjectToSession(inject.id, sessionId, publishUserId, socketIo);

  logger.info(
    {
      sessionId,
      decisionId: decision.id,
      facility: intent.destination_facility,
      outcomeType: outcome.type,
      injectId: inject.id,
    },
    'Transport outcome inject published',
  );
}
