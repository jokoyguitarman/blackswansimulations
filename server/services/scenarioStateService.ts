import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import {
  getConditionConfigForScenario,
  type KeywordPatternDef,
} from './scenarioConditionConfigService.js';
import type { CounterDefinition } from '../counterDefinitions.js';
import { env } from '../env.js';

/**
 * Scenario State Service - Server-side only
 * Separation of concerns: Manages scenario state updates when decisions are executed
 */

interface ScenarioState {
  evacuation_zones?: Array<{
    id: string;
    center_lat: number;
    center_lng: number;
    radius_meters: number;
    title: string;
    created_at: string;
  }>;
  resource_allocations?: Record<string, unknown>;
  public_sentiment?: number; // 0-100 scale
  active_incidents?: number;
  [key: string]: unknown;
}

/**
 * Update scenario state when a decision is executed
 */
export const updateStateOnDecisionExecution = async (
  sessionId: string,
  decision: {
    id: string;
    decision_type: string;
    title: string;
    description: string;
    resources_needed?: Record<string, unknown>;
    consequences?: Record<string, unknown>;
  },
): Promise<void> => {
  try {
    // Get current session state
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state, scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session) {
      logger.warn({ sessionId }, 'Session not found for state update');
      return;
    }

    const currentState: ScenarioState = (session.current_state as ScenarioState) || {};

    // Update state based on decision type
    switch (decision.decision_type) {
      case 'operational_action': {
        // Evacuation zones are rendered by BlastZoneOverlay (from scenario_locations)
        // and placed_asset cordon polygons. No separate keyword-triggered circle needed.
        break;
      }

      case 'resource_allocation': {
        // Update resource allocations
        if (decision.resources_needed) {
          if (!currentState.resource_allocations) {
            currentState.resource_allocations = {};
          }
          Object.assign(currentState.resource_allocations, decision.resources_needed);
          logger.info(
            { sessionId, decisionId: decision.id, resources: decision.resources_needed },
            'Resource allocations updated',
          );
        }
        break;
      }

      case 'public_statement': {
        // Update sentiment (will be enhanced in Phase 7)
        if (!currentState.public_sentiment) {
          currentState.public_sentiment = 50; // Neutral starting point
        }
        // Simple sentiment adjustment (will be replaced with AI-based calculation in Phase 7)
        const sentimentChange = decision.description.toLowerCase().includes('reassur') ? 5 : -2;
        currentState.public_sentiment = Math.max(
          0,
          Math.min(100, currentState.public_sentiment + sentimentChange),
        );
        logger.info(
          { sessionId, decisionId: decision.id, newSentiment: currentState.public_sentiment },
          'Public sentiment updated',
        );
        break;
      }

      default:
        logger.debug(
          { sessionId, decisionId: decision.id, decisionType: decision.decision_type },
          'No state update for decision type',
        );
    }

    // Save updated state to session
    const { error: updateError } = await supabaseAdmin
      .from('sessions')
      .update({ current_state: currentState })
      .eq('id', sessionId);

    if (updateError) {
      logger.error({ error: updateError, sessionId }, 'Failed to update session state');
      return;
    }

    // Create state snapshot for history
    await createStateSnapshot(sessionId, currentState, decision.id);

    // Broadcast state update via WebSocket
    getWebSocketService().stateUpdated?.(sessionId, {
      type: 'state.updated',
      state: currentState,
      decision_id: decision.id,
      timestamp: new Date().toISOString(),
    });

    logger.info({ sessionId, decisionId: decision.id }, 'State updated successfully');
  } catch (error) {
    logger.error({ error, sessionId, decisionId: decision.id }, 'Error updating scenario state');
  }
};

/**
 * Create a state snapshot for history tracking
 */
const createStateSnapshot = async (
  sessionId: string,
  state: ScenarioState,
  decisionId: string,
): Promise<void> => {
  try {
    const { error } = await supabaseAdmin.from('scenario_state_history').insert({
      session_id: sessionId,
      state_snapshot: state,
      triggered_by_decision_id: decisionId,
      created_at: new Date().toISOString(),
    });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to create state snapshot');
    } else {
      logger.debug({ sessionId, decisionId }, 'State snapshot created');
    }
  } catch (error) {
    logger.error({ error, sessionId }, 'Error creating state snapshot');
  }
};

/**
 * Location types that represent claimable spaces for each team domain.
 * The AI evaluation will determine intent (activate vs avoid).
 */
const CLAIMABLE_LOCATION_TYPES: Record<string, string[]> = {
  evacuation_state: ['evacuation_holding'],
  triage_state: ['area', 'triage_site'],
};

interface ClaimableLocation {
  label: string;
  locationType: string;
  stateKey: string;
  properties: Record<string, unknown>;
}

/**
 * Load claimable locations from scenario_locations and return them as
 * AI candidate entries plus a lookup map for processing results.
 */
async function loadClaimableLocations(
  scenarioId: string,
  teamStateKeys: string[],
): Promise<{ candidates: StateKeyCandidate[]; locationMap: Map<string, ClaimableLocation> }> {
  const candidates: StateKeyCandidate[] = [];
  const locationMap = new Map<string, ClaimableLocation>();

  const relevantTypes = new Set<string>();
  for (const sk of teamStateKeys) {
    for (const lt of CLAIMABLE_LOCATION_TYPES[sk] ?? []) relevantTypes.add(lt);
  }
  if (relevantTypes.size === 0) return { candidates, locationMap };

  const { data: locs } = await supabaseAdmin
    .from('scenario_locations')
    .select('label, location_type, conditions')
    .eq('scenario_id', scenarioId)
    .in('location_type', [...relevantTypes]);

  if (!locs?.length) return { candidates, locationMap };

  for (const loc of locs) {
    const label = loc.label as string;
    if (!label) continue;
    const lt = loc.location_type as string;
    const cond = (loc.conditions as Record<string, unknown>) || {};

    const stateKey = Object.entries(CLAIMABLE_LOCATION_TYPES).find(([, types]) =>
      types.includes(lt),
    )?.[0];
    if (!stateKey || !teamStateKeys.includes(stateKey)) continue;

    const candidateKey = `claim:${label}`;
    const domainLabel =
      stateKey === 'triage_state'
        ? `Select ${label} as Medical Triage zone`
        : `Activate ${label} as evacuation holding area`;

    candidates.push({
      key: candidateKey,
      label: domainLabel,
      behavior: 'decision_toggle',
      type: 'boolean',
      stateKey,
    });

    locationMap.set(candidateKey, {
      label,
      locationType: lt,
      stateKey,
      properties: {
        capacity: cond.capacity ?? cond.capacity_persons,
        water: cond.water ?? cond.has_water,
        has_cover: cond.has_cover ?? cond.has_shelter,
        suitability: cond.suitability,
        distance_from_blast_m: cond.distance_from_blast_m,
        capacity_lying: cond.capacity_lying,
        capacity_standing: cond.capacity_standing,
      },
    });
  }

  return { candidates, locationMap };
}

interface StateKeyCandidate {
  key: string;
  label: string;
  behavior: string;
  type: string;
  keywords?: string[];
  categories?: string[];
  stateKey: string;
}

interface AIStateKeyEvaluation {
  keys_to_flip: Array<{ key: string; stateKey: string; reason: string }>;
}

/**
 * Uses GPT-4o-mini to decide which counter-definition state keys should flip
 * based on the actual meaning and specificity of the player's decision.
 * Replaces raw keyword/substring matching to avoid false positives on vague decisions.
 */
async function evaluateStateKeysWithAI(
  decisionTitle: string,
  decisionDescription: string,
  candidates: StateKeyCandidate[],
  openAiApiKey: string,
): Promise<AIStateKeyEvaluation> {
  if (!candidates.length) return { keys_to_flip: [] };

  const candidateList = candidates
    .map(
      (c, i) =>
        `${i + 1}. key="${c.key}" (label: "${c.label}", type: ${c.type}, behavior: ${c.behavior})` +
        (c.keywords?.length ? `\n   Expected keywords: [${c.keywords.join(', ')}]` : '') +
        (c.categories?.length ? `\n   Expected categories: [${c.categories.join(', ')}]` : ''),
    )
    .join('\n');

  const systemPrompt = `You are a crisis simulation game engine evaluating whether a player's decision is specific and actionable enough to flip game-state flags.

You will receive:
1. A player decision (title + description).
2. A list of candidate state keys, each with a label describing what action it represents, and optional expected keywords/categories.

RULES:
- Only flip a key if the decision CLEARLY and SPECIFICALLY demonstrates the action the key represents.
- Vague or generic decisions (e.g. "secure the area", "handle the situation") should NOT flip keys unless the key is very broadly defined.
- The decision must show concrete, actionable intent that maps to the key's meaning.
- If the decision is tangentially related but doesn't specifically address the key's action, do NOT flip it.
- When in doubt, do NOT flip — false negatives are far better than false positives.

Return ONLY valid JSON:
{
  "keys_to_flip": [
    { "key": "the_key_name", "stateKey": "parent_state_key", "reason": "brief explanation" }
  ]
}

If no keys should flip, return: { "keys_to_flip": [] }`;

  const userPrompt = `Player decision:
Title: ${decisionTitle}
Description: ${decisionDescription}

Candidate state keys to evaluate:
${candidateList}

Which keys should be flipped? Be strict — only flip keys where the decision specifically and clearly demonstrates the action.`;

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
        temperature: 0.1,
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown');
      logger.warn(
        { status: response.status, body: errBody },
        'AI state-key evaluation failed; falling back to no flips',
      );
      return { keys_to_flip: [] };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { keys_to_flip: [] };

    const parsed = JSON.parse(content) as AIStateKeyEvaluation;
    const validKeys = new Set(candidates.map((c) => c.key));
    const validStateKeys = new Set(candidates.map((c) => c.stateKey));

    const filtered = (parsed.keys_to_flip ?? []).filter(
      (k) => validKeys.has(k.key) && validStateKeys.has(k.stateKey),
    );

    logger.info(
      {
        decisionTitle,
        candidateCount: candidates.length,
        flippedCount: filtered.length,
        flipped: filtered.map((f) => `${f.stateKey}.${f.key}`),
      },
      'AI state-key evaluation complete',
    );

    return { keys_to_flip: filtered };
  } catch (err) {
    logger.error({ err, decisionTitle }, 'Error in AI state-key evaluation');
    return { keys_to_flip: [] };
  }
}

/**
 * Phase 3: Update team state (evacuation_state, triage_state, media_state) from an executed decision
 * using AI classification and author team. Called after classifyDecision and storing ai_classification.
 * Also tracks claimed_locations (AI-evaluated from scenario_locations) and second_device_zone_cleared.
 */
export async function updateTeamStateFromDecision(
  sessionId: string,
  _decisionId: string,
  authorTeamNames: string[],
  classification: { categories?: string[]; keywords?: string[]; primary_category?: string },
  elapsedMinutes: number,
  options?: {
    decisionTitle?: string;
    decisionDescription?: string;
    scenarioId?: string;
  },
): Promise<void> {
  if (!authorTeamNames?.length) return;
  const categories = classification?.categories ?? [];
  const primary = (classification?.primary_category ?? '').toLowerCase();
  const keywords = (classification?.keywords ?? []).map((k) => String(k).toLowerCase());

  const hasCategory = (c: string) => categories.includes(c) || primary === c.toLowerCase();
  const hasKeyword = (...kws: string[]) =>
    kws.some((kw) => keywords.some((k) => k.includes(kw) || kw.includes(k)));

  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state, scenario_id')
      .eq('id', sessionId)
      .single();

    if (!session) return;
    const currentState: Record<string, unknown> =
      (session.current_state as Record<string, unknown>) || {};
    const scenarioId = options?.scenarioId ?? (session.scenario_id as string | undefined) ?? null;

    const title = options?.decisionTitle ?? '';
    const description = options?.decisionDescription ?? '';
    const decisionText = `${title} ${description}`.toLowerCase();

    const isEvacuation = authorTeamNames.some((t) => /evacuation/i.test(t));
    const isTriage = authorTeamNames.some((t) => /triage/i.test(t));
    const isMedia = authorTeamNames.some((t) => /media/i.test(t));

    // --- Data-driven counter updates from counter_definitions ---
    const counterDefsMap = (currentState._counter_definitions ?? {}) as Record<
      string,
      CounterDefinition[]
    >;
    const hasCounterDefs = Object.keys(counterDefsMap).length > 0;

    if (hasCounterDefs) {
      const teamToStateKey = (name: string): string => {
        const n = (name ?? '').toLowerCase();
        if (/evacuation|evac/.test(n)) return 'evacuation_state';
        if (/triage|medical/.test(n)) return 'triage_state';
        if (/media|communi/.test(n)) return 'media_state';
        if (/fire|hazmat|hazard|rescue/.test(n)) return 'fire_state';
        if (/pursuit|investigation|police|intelligence/.test(n)) return 'pursuit_state';
        if (/bomb|eod|explosive/.test(n)) return 'bomb_squad_state';
        return `${n.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_state`;
      };

      // Collect all candidate keys across all author teams for a single AI call
      const allCandidates: StateKeyCandidate[] = [];
      const teamStateKeyMap = new Map<string, string>();

      for (const teamName of authorTeamNames) {
        const stateKey = teamToStateKey(teamName);
        teamStateKeyMap.set(teamName, stateKey);
        const defs = counterDefsMap[stateKey];
        if (!defs?.length) continue;

        for (const def of defs) {
          if (
            (def.behavior === 'decision_toggle' && def.type === 'boolean') ||
            (def.behavior === 'decision_increment' && def.type === 'number')
          ) {
            allCandidates.push({
              key: def.key,
              label: def.label,
              behavior: def.behavior,
              type: def.type,
              keywords: def.config?.keywords,
              categories: def.config?.categories,
              stateKey,
            });
          }
        }
      }

      // Also gather config-driven keyword patterns as candidates
      if (scenarioId) {
        try {
          const config = await getConditionConfigForScenario(scenarioId);
          for (const pattern of config.keyword_patterns as KeywordPatternDef[]) {
            if (!pattern.state_key || !pattern.keywords?.length) continue;
            const [parent, child] = pattern.state_key.split('.');
            if (!parent || !child) continue;
            allCandidates.push({
              key: child,
              label: child.replace(/_/g, ' '),
              behavior: 'decision_toggle',
              type: 'boolean',
              keywords: pattern.keywords,
              stateKey: parent,
            });
          }
        } catch (configErr) {
          logger.debug({ scenarioId, err: configErr }, 'Condition config fetch failed');
        }
      }

      // Load claimable locations as additional AI candidates
      let locationMap = new Map<string, ClaimableLocation>();
      if (scenarioId) {
        const teamStateKeys = [...new Set(authorTeamNames.map((n) => teamToStateKey(n)))];
        const locResult = await loadClaimableLocations(scenarioId, teamStateKeys);
        allCandidates.push(...locResult.candidates);
        locationMap = locResult.locationMap;
      }

      const apiKey = env.openAiApiKey;
      if (allCandidates.length > 0 && apiKey) {
        const result = await evaluateStateKeysWithAI(title, description, allCandidates, apiKey);

        for (const flip of result.keys_to_flip) {
          // Handle location claims separately
          if (flip.key.startsWith('claim:')) {
            const locInfo = locationMap.get(flip.key);
            if (locInfo) {
              let target = currentState[locInfo.stateKey] as Record<string, unknown>;
              if (typeof target !== 'object' || target === null) {
                target = {};
                currentState[locInfo.stateKey] = target;
              }
              const existing = (target.claimed_locations as Record<string, unknown>) || {};
              existing[locInfo.label] = {
                ...locInfo.properties,
                assigned_at_min: elapsedMinutes,
              };
              target.claimed_locations = existing;
              logger.info(
                { sessionId, location: locInfo.label, stateKey: locInfo.stateKey },
                'Location claimed via AI evaluation',
              );
            }
            continue;
          }

          let target = currentState[flip.stateKey] as Record<string, unknown>;
          if (typeof target !== 'object' || target === null) {
            target = {};
            currentState[flip.stateKey] = target;
          }
          const candidate = allCandidates.find(
            (c) => c.key === flip.key && c.stateKey === flip.stateKey,
          );
          if (candidate?.behavior === 'decision_increment') {
            target[flip.key] = Math.max(0, Number(target[flip.key]) || 0) + 1;
          } else {
            target[flip.key] = true;
          }

          // When misinformation is addressed, decrement unaddressed count
          if (flip.key === 'misinformation_addressed_count' && flip.stateKey === 'media_state') {
            const cur = Math.max(0, Number(target.unaddressed_misinformation_count) || 0);
            target.unaddressed_misinformation_count = Math.max(0, cur - 1);
          }
        }

        logger.info(
          {
            sessionId,
            authorTeamNames,
            candidateCount: allCandidates.length,
            flippedKeys: result.keys_to_flip.map((f) => `${f.stateKey}.${f.key}`),
          },
          'AI-evaluated state key flips from decision',
        );
      } else if (allCandidates.length > 0) {
        logger.warn(
          { sessionId },
          'OpenAI API key not configured; skipping AI state-key evaluation',
        );
      }
    } else {
      // Legacy hardcoded decision handling (backward compatibility)
      const evacuationState = (currentState.evacuation_state as Record<string, unknown>) || {};
      const triageState = (currentState.triage_state as Record<string, unknown>) || {};
      const mediaState = (currentState.media_state as Record<string, unknown>) || {};

      if (isEvacuation) {
        if (
          hasCategory('flow_control') ||
          hasCategory('evacuation_flow_control') ||
          hasKeyword(
            'flow',
            'bottleneck',
            'stagger',
            'egress',
            'congestion',
            'exit capacity',
            'exit width',
            'flow rate',
            'people per minute',
            'capacity per exit',
          )
        ) {
          evacuationState.flow_control_decided = true;
        }
        if (
          hasCategory('coordination_order') ||
          hasCategory('coordination') ||
          hasCategory('evacuation_coordination') ||
          hasKeyword('coordinate', 'triage')
        ) {
          evacuationState.coordination_with_triage = true;
        }
      }
      if (isTriage) {
        if (
          hasCategory('supply_management') ||
          hasKeyword(
            'supply',
            'request',
            'ration',
            'equipment',
            'shortage',
            'tourniquet',
            'stretcher',
            'triage tag',
            'airway kit',
            'oxygen',
            'iv fluid',
            'trauma kit',
            'gauze',
            'bandage',
            'first aid kit',
            'medical kit',
          )
        ) {
          triageState.supply_request_made = true;
        }
        if (
          hasCategory('prioritisation') ||
          hasCategory('triage_protocol') ||
          hasKeyword('prioritise', 'critical first', 'severity', 'triage protocol')
        ) {
          triageState.prioritisation_decided = true;
        }
      }
      if (scenarioId) {
        try {
          const config = await getConditionConfigForScenario(scenarioId);
          for (const pattern of config.keyword_patterns as KeywordPatternDef[]) {
            if (!pattern.state_key || !pattern.keywords?.length) continue;
            const matches = pattern.keywords.some((kw) => decisionText.includes(kw.toLowerCase()));
            if (!matches) continue;
            const [parent, child] = pattern.state_key.split('.');
            if (!parent || !child) continue;
            if (parent === 'evacuation_state') {
              (evacuationState as Record<string, unknown>)[child] = true;
            } else if (parent === 'triage_state') {
              (triageState as Record<string, unknown>)[child] = true;
            } else if (parent === 'media_state') {
              (mediaState as Record<string, unknown>)[child] = true;
            } else {
              let target = currentState[parent] as Record<string, unknown>;
              if (typeof target !== 'object' || target === null) {
                target = {};
                currentState[parent] = target;
              }
              (target as Record<string, unknown>)[child] = true;
            }
          }
        } catch (configErr) {
          logger.debug(
            { scenarioId, err: configErr },
            'Condition config fetch failed; using defaults',
          );
        }
      }
      if (isMedia) {
        if (
          hasCategory('public_statement') ||
          hasKeyword('statement', 'press', 'announce', 'release')
        ) {
          mediaState.first_statement_issued = true;
          mediaState.statement_issued_at_minute = elapsedMinutes;
          mediaState.statements_issued = Math.max(0, Number(mediaState.statements_issued) || 0) + 1;
        }
        if (
          hasCategory('misinformation_management') ||
          hasCategory('misinformation_response') ||
          hasKeyword('debunk', 'counter', 'correct', 'misinformation', 'rumour', 'narrative')
        ) {
          mediaState.misinformation_addressed = true;
          mediaState.misinformation_addressed_count =
            Math.max(0, Number(mediaState.misinformation_addressed_count) || 0) + 1;
          const curUnaddressed = Math.max(
            0,
            Number(mediaState.unaddressed_misinformation_count) || 0,
          );
          mediaState.unaddressed_misinformation_count = Math.max(0, curUnaddressed - 1);
        }
        if (
          hasKeyword('spokesperson', 'one voice', 'single spokesperson', 'designated spokesperson')
        ) {
          mediaState.spokesperson_designated = true;
        }
        if (
          hasKeyword(
            'no names',
            'family first',
            'notify family',
            'victim dignity',
            'do not release names',
          )
        ) {
          mediaState.victim_dignity_respected = true;
        }
        if (
          hasKeyword(
            '30 min',
            '60 min',
            '30 minutes',
            '60 minutes',
            'next update',
            'regular updates',
            'update every',
          )
        ) {
          mediaState.regular_updates_planned = true;
        }
      }

      currentState.evacuation_state = evacuationState;
      currentState.triage_state = triageState;
      currentState.media_state = mediaState;
    }

    const nextState = { ...currentState };

    const { error } = await supabaseAdmin
      .from('sessions')
      .update({ current_state: nextState })
      .eq('id', sessionId);
    if (error) {
      logger.error({ error, sessionId }, 'Failed to update team state from decision');
      return;
    }
    getWebSocketService().stateUpdated?.(sessionId, {
      type: 'state.updated',
      state: nextState,
      timestamp: new Date().toISOString(),
    });
    logger.debug({ sessionId, authorTeamNames }, 'Team state updated from decision');
  } catch (err) {
    logger.error({ err, sessionId }, 'Error in updateTeamStateFromDecision');
  }
}

/**
 * Get current state for a session
 */
export const getCurrentState = async (sessionId: string): Promise<ScenarioState | null> => {
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state')
      .eq('id', sessionId)
      .single();

    return (session?.current_state as ScenarioState) || null;
  } catch (error) {
    logger.error({ error, sessionId }, 'Error getting current state');
    return null;
  }
};

/**
 * Snapshot final state when session completes so counters persist for AAR review.
 * Writes to scenario_state_history with notes 'Session completion snapshot'.
 */
export async function snapshotFinalStateOnCompletion(sessionId: string): Promise<void> {
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state')
      .eq('id', sessionId)
      .single();

    if (!session?.current_state || typeof session.current_state !== 'object') {
      logger.debug({ sessionId }, 'No current_state to snapshot on completion');
      return;
    }

    const { error } = await supabaseAdmin.from('scenario_state_history').insert({
      session_id: sessionId,
      state_snapshot: session.current_state,
      triggered_by_decision_id: null,
      triggered_by_inject_id: null,
      notes: 'Session completion snapshot',
    });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to snapshot final state on completion');
    } else {
      logger.info({ sessionId }, 'Final state snapshotted for AAR review');
    }
  } catch (err) {
    logger.error({ err, sessionId }, 'Error snapshotting final state on completion');
  }
}
