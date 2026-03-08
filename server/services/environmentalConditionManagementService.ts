/**
 * Environmental condition management.
 * After a decision is executed, evaluates whether the player proposed a concrete,
 * sector-appropriate way to manage any unmanaged environmental condition (routes, bad locations).
 * When the AI confirms a condition was credibly addressed, updates session state so future
 * decisions see it as managed (full robustness, no counter penalties).
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';

interface UnmanagedCondition {
  type: 'route' | 'location';
  id: string;
  label: string;
  problem?: string;
  location_type?: string;
}

interface RouteRow {
  route_id?: string;
  label?: string;
  problem?: string | null;
  managed?: boolean;
  travel_time_minutes?: number | null;
}

type LocationConditions = { suitability?: string; unsuitable?: boolean; cleared?: boolean };

function isBadLocation(conditions: LocationConditions): boolean {
  return (
    conditions.suitability === 'low' ||
    conditions.unsuitable === true ||
    (conditions.cleared === false &&
      (conditions.suitability === 'poor' || Boolean(conditions.unsuitable)))
  );
}

/**
 * Build list of unmanaged conditions: routes with managed === false, and bad scenario_locations
 * not yet in location_state.managed.
 */
async function buildUnmanagedConditions(
  sessionId: string,
): Promise<{
  conditions: UnmanagedCondition[];
  currentState: Record<string, unknown>;
  scenarioId: string;
} | null> {
  const { data: session, error: sessionErr } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state')
    .eq('id', sessionId)
    .single();

  if (sessionErr || !session) {
    logger.debug(
      { sessionId, error: sessionErr },
      'Session not found for env condition management',
    );
    return null;
  }

  const scenarioId = (session as { scenario_id: string }).scenario_id;
  if (!scenarioId) return null;

  const currentState = ((session as { current_state?: Record<string, unknown> }).current_state ??
    {}) as Record<string, unknown>;
  const envState = currentState.environmental_state as { routes?: RouteRow[] } | undefined;
  const locationState = currentState.location_state as
    | Record<string, { managed?: boolean }>
    | undefined;

  const conditions: UnmanagedCondition[] = [];

  const routes = Array.isArray(envState?.routes) ? envState.routes : [];
  for (const r of routes) {
    if (r.managed === true) continue;
    const id = (r.route_id || r.label || '').trim() || `route-${routes.indexOf(r)}`;
    conditions.push({
      type: 'route',
      id,
      label: (r.label || id).trim(),
      problem: r.problem ?? undefined,
    });
  }

  const { data: locations, error: locErr } = await supabaseAdmin
    .from('scenario_locations')
    .select('id, location_type, label, conditions')
    .eq('scenario_id', scenarioId);

  if (!locErr && locations?.length) {
    for (const loc of locations) {
      const conditionsObj = (loc.conditions as LocationConditions) ?? {};
      if (!isBadLocation(conditionsObj)) continue;
      const locId = (loc as { id: string }).id;
      if (locationState?.[locId]?.managed === true) continue;
      conditions.push({
        type: 'location',
        id: locId,
        label:
          (((loc as { label?: string }).label ?? '').trim() ||
            (loc as { location_type?: string }).location_type) ??
          'location',
        location_type: (loc as { location_type?: string }).location_type,
      });
    }
  }

  return { conditions, currentState, scenarioId };
}

/**
 * Pre-filter: only call AI if decision text mentions at least one unmanaged condition (by label or id).
 */
function decisionMentionsAnyCondition(
  decisionText: string,
  conditions: UnmanagedCondition[],
): boolean {
  const lower = decisionText.toLowerCase();
  for (const c of conditions) {
    if (c.label && lower.includes(c.label.toLowerCase())) return true;
    if (c.id && c.id.length >= 3 && lower.includes(c.id.toLowerCase())) return true;
  }
  return false;
}

/**
 * Call OpenAI to determine which unmanaged conditions were credibly addressed by the decision.
 * Returns array of { type, id } for conditions that were addressed in a concrete, sector-appropriate way.
 */
async function evaluateConditionsAddressed(
  conditions: UnmanagedCondition[],
  sectorStandards: string | undefined,
  decisionTitle: string,
  decisionDescription: string,
  openAiApiKey: string,
): Promise<Array<{ type: 'route' | 'location'; id: string }>> {
  const conditionsList = conditions
    .map(
      (c) =>
        `- ${c.type}: id="${c.id}", label="${c.label}"${c.problem ? `, problem="${c.problem}"` : ''}${c.location_type ? `, location_type=${c.location_type}` : ''}`,
    )
    .join('\n');

  const sectorBlock = sectorStandards
    ? `\nSector standards (use to judge if the proposal is appropriate): ${sectorStandards.slice(0, 500)}`
    : '';

  const systemPrompt = `You are a crisis management evaluator. Given a list of unmanaged environmental conditions (routes with congestion/blockage, or locations with poor suitability) and a decision text, determine which conditions were addressed in a CONCRETE, SECTOR-APPROPRIATE way.

Concrete and sector-appropriate means:
- For route congestion/blockage: deploy marshals, clear obstruction (who/what), coordinate with traffic/law enforcement, designate alternate with clear handover. Must be specific (who, what, where).
- For bad locations: clear hazards, secure area, assign staff, or explicitly avoid and use an alternative with clear rationale. Must be specific.
- Vague phrases like "deal with traffic", "we'll handle it", "address the issue" do NOT count. The decision must propose a specific action (who does what, where).${sectorBlock}

Return JSON only: { "conditions_addressed": [ { "type": "route" | "location", "id": "<same id as in the list>" } ] }
- Include a condition in conditions_addressed only if the decision explicitly proposes a concrete, sector-appropriate way to manage that specific condition. Use the exact "id" value from the list. If none are credibly addressed, return an empty array.`;

  const userPrompt = `Unmanaged conditions:
${conditionsList}

Decision title: ${decisionTitle}
Decision description: ${decisionDescription}

Which conditions were credibly addressed (concrete, sector-appropriate proposal)? Return JSON only.`;

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
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenAI API error in evaluateConditionsAddressed');
      return [];
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content) as {
      conditions_addressed?: Array<{ type?: string; id?: string }>;
    };
    const addressed = Array.isArray(parsed.conditions_addressed) ? parsed.conditions_addressed : [];
    const validIds = new Set(conditions.map((c) => c.id));

    return addressed
      .filter((a) => a.type === 'route' || a.type === 'location')
      .filter((a) => typeof a.id === 'string' && validIds.has(a.id))
      .map((a) => ({ type: a.type as 'route' | 'location', id: a.id as string }));
  } catch (err) {
    logger.warn({ err }, 'evaluateConditionsAddressed failed');
    return [];
  }
}

/**
 * Apply state updates: set route.managed = true for addressed routes,
 * location_state[id].managed = true for addressed locations.
 */
function applyConditionUpdates(
  currentState: Record<string, unknown>,
  conditionsAddressed: Array<{ type: 'route' | 'location'; id: string }>,
): Record<string, unknown> {
  const nextState = { ...currentState };

  const envState = nextState.environmental_state as { routes?: RouteRow[] } | undefined;
  const routes = Array.isArray(envState?.routes) ? [...envState.routes] : [];
  let routeUpdated = false;
  for (const { type, id } of conditionsAddressed) {
    if (type === 'route') {
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        const match = (r.route_id && r.route_id === id) || (r.label && r.label === id);
        if (match) {
          routes[i] = { ...r, managed: true };
          routeUpdated = true;
          break;
        }
      }
    }
  }
  if (routeUpdated && routes.length > 0) {
    nextState.environmental_state = { ...envState, routes };
  }

  let locationState = (nextState.location_state as Record<string, { managed?: boolean }>) ?? {};
  let locationUpdated = false;
  for (const { type, id } of conditionsAddressed) {
    if (type === 'location') {
      locationState = { ...locationState, [id]: { managed: true } };
      locationUpdated = true;
    }
  }
  if (locationUpdated) {
    nextState.location_state = locationState;
  }

  return nextState;
}

/**
 * After a decision is executed, evaluate whether it proposed a concrete, sector-appropriate
 * way to manage any unmanaged environmental condition. If so, update session state (route.managed
 * or location_state[id].managed) and persist + broadcast.
 * On API failure or missing key, no state update (conservative).
 */
export async function evaluateEnvironmentalManagementIntentAndUpdateState(
  sessionId: string,
  decision: { id: string; title: string; description: string; type: string | null },
  openAiApiKey: string | undefined,
): Promise<void> {
  if (!openAiApiKey) return;

  const built = await buildUnmanagedConditions(sessionId);
  if (!built || built.conditions.length === 0) return;

  const { conditions, currentState, scenarioId } = built;

  const decisionText = `${decision.title ?? ''} ${decision.description ?? ''}`.trim();
  if (!decisionMentionsAnyCondition(decisionText, conditions)) return;

  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('insider_knowledge')
    .eq('id', scenarioId)
    .single();

  const insiderKnowledge = (scenario as { insider_knowledge?: Record<string, unknown> })
    ?.insider_knowledge as Record<string, unknown> | undefined;
  const sectorStandards =
    typeof insiderKnowledge?.sector_standards === 'string'
      ? insiderKnowledge.sector_standards
      : undefined;

  const conditionsAddressed = await evaluateConditionsAddressed(
    conditions,
    sectorStandards,
    decision.title ?? '',
    decision.description ?? '',
    openAiApiKey,
  );

  if (conditionsAddressed.length === 0) return;

  const nextState = applyConditionUpdates(currentState, conditionsAddressed);

  const { error: updateError } = await supabaseAdmin
    .from('sessions')
    .update({ current_state: nextState })
    .eq('id', sessionId);

  if (updateError) {
    logger.error(
      { sessionId, decisionId: decision.id, error: updateError },
      'Failed to persist env condition management state update',
    );
    return;
  }

  logger.info(
    { sessionId, decisionId: decision.id, conditions_addressed: conditionsAddressed },
    'Environmental conditions marked managed from decision',
  );

  getWebSocketService().stateUpdated?.(sessionId, {
    state: nextState,
    timestamp: new Date().toISOString(),
  });
}
