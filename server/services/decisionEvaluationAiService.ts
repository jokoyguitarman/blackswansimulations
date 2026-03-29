/**
 * AI-based decision evaluation for gate content, location/route intent, and condition keys.
 * On API failure or missing key, callers fall back to existing substring/keyword logic.
 */

import { logger } from '../lib/logger.js';

export interface LocationReferenceIntentResult {
  referencesBadLocationPositively: boolean;
  reason?: string;
}

export interface RouteManagementIntentResult {
  proposesManagingBeforeUse: boolean;
  reason?: string;
}

export interface GateContentSatisfactionResult {
  satisfies: boolean;
  reason?: string;
}

/**
 * Does the decision propose using any of the bad locations, or only mention them in a rejecting/avoiding way?
 * Returns null on failure so caller can use keyword fallback.
 */
export async function evaluateLocationReferenceIntent(
  params: {
    decisionText: string;
    badLocations: Array<{ label: string; location_type: string }>;
    incidentContext?: { title: string; description: string } | null;
  },
  openAiApiKey: string | undefined,
): Promise<LocationReferenceIntentResult | null> {
  if (!openAiApiKey || !params.badLocations.length) return null;
  const { decisionText, badLocations, incidentContext } = params;
  try {
    const locationsBlock = badLocations.map((l) => `- ${l.label} (${l.location_type})`).join('\n');
    const incidentBlock =
      (incidentContext?.title ?? incidentContext?.description)
        ? `\nIncident context: ${[incidentContext.title, incidentContext.description].filter(Boolean).join(' ')}`
        : '';
    const systemPrompt = `You are a crisis management evaluator. Given a decision text and a list of locations that have poor suitability or are unmanaged, determine: does the decision PROPOSE USING any of these locations (e.g. "use Exit A", "route via North"), or does it only MENTION them in a REJECTING/AVOIDING way (e.g. "use Exit B instead of Exit A", "avoid A", "do not use A", "route via B not A")?
Return JSON only: { "referencesBadLocationPositively": boolean, "reason": "one short sentence" }
- referencesBadLocationPositively: true if the decision proposes or commits to using any of the listed bad locations. false if it only mentions them to reject/avoid or to choose an alternative.`;
    const userPrompt = `Bad locations (do not use unless cleared):\n${locationsBlock}${incidentBlock}\n\nDecision text:\n${decisionText.slice(0, 1500)}\n\nDoes the decision propose using any bad location (true) or only reject/avoid them (false)? JSON only.`;

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
        max_tokens: 150,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'OpenAI API error in evaluateLocationReferenceIntent',
      );
      return null;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as {
      referencesBadLocationPositively?: boolean;
      reason?: string;
    };
    const ref = parsed.referencesBadLocationPositively === true;
    return {
      referencesBadLocationPositively: ref,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 300) : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'evaluateLocationReferenceIntent failed, returning null for fallback');
    return null;
  }
}

/**
 * Does the decision explicitly propose managing or clearing these routes before using them?
 * Returns null on failure so caller can use MANAGE_FIRST_PATTERNS fallback.
 */
export async function evaluateRouteManagementIntent(
  params: { decisionText: string; unmanagedRouteLabelsOrSegments: string[] },
  openAiApiKey: string | undefined,
): Promise<RouteManagementIntentResult | null> {
  if (!openAiApiKey || !params.unmanagedRouteLabelsOrSegments.length) return null;
  const { decisionText, unmanagedRouteLabelsOrSegments } = params;
  try {
    const routesList = unmanagedRouteLabelsOrSegments.join(', ');
    const systemPrompt = `You are a crisis management evaluator. Given a decision and a list of unmanaged routes/corridors, determine: does the decision explicitly propose MANAGING or CLEARING these routes before using them (e.g. clear corridor, manage traffic, deploy marshals, then use route)?
Return JSON only: { "proposesManagingBeforeUse": boolean, "reason": "optional one sentence" }
- proposesManagingBeforeUse: true only if the decision clearly states or implies that the route will be cleared/managed before use. false if it assumes use without prior clearance.`;
    const userPrompt = `Unmanaged routes: ${routesList}\n\nDecision text:\n${decisionText.slice(0, 1500)}\n\nDoes the decision propose managing/clearing these routes before use? JSON only.`;

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
        max_tokens: 120,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenAI API error in evaluateRouteManagementIntent');
      return null;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { proposesManagingBeforeUse?: boolean; reason?: string };
    return {
      proposesManagingBeforeUse: parsed.proposesManagingBeforeUse === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 300) : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'evaluateRouteManagementIntent failed, returning null for fallback');
    return null;
  }
}

/**
 * Is the decision sufficiently concrete and on-topic for the gate (content_hints as guidance)?
 * Returns null on failure so caller can use decisionSatisfiesGateContent (substring) fallback.
 */
export async function evaluateGateContentSatisfaction(
  params: {
    decisionDescription: string;
    contentHints: string[];
    minHints: number;
    gateDescription?: string | null;
  },
  openAiApiKey: string | undefined,
): Promise<GateContentSatisfactionResult | null> {
  if (!openAiApiKey) return null;
  const { decisionDescription, contentHints, minHints, gateDescription } = params;
  if (!contentHints.length || minHints <= 0) return { satisfies: true };
  try {
    const hintsList = contentHints.join(', ');
    const gateBlock = gateDescription ? `\nGate expectation: ${gateDescription}` : '';
    const systemPrompt = `You are a crisis management evaluator. A gate requires the decision to be concrete and on-topic. The scenario author's hints are: ${hintsList}. At least ${minHints} of these themes (or equivalent phrasing/intent) should appear in the decision. Equivalent wording or same intent counts.
Return JSON only: { "satisfies": boolean, "reason": "optional one sentence" }
- satisfies: true if the decision is sufficiently concrete and addresses the gate (matches or paraphrases the required themes). false if it is vague or off-topic.`;
    const userPrompt = `Required themes (at least ${minHints}): ${hintsList}${gateBlock}\n\nDecision description:\n${decisionDescription.slice(0, 1200)}\n\nIs this decision sufficiently concrete and on-topic? JSON only.`;

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
        max_tokens: 150,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'OpenAI API error in evaluateGateContentSatisfaction',
      );
      return null;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { satisfies?: boolean; reason?: string };
    return {
      satisfies: parsed.satisfies === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 300) : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'evaluateGateContentSatisfaction failed, returning null for fallback');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prerequisite reference detection (replaces keyword matching)
// ---------------------------------------------------------------------------

export interface PrerequisiteReferenceResult {
  capacity_facility: { match: boolean; label?: string } | null;
  claimed_space: { match: boolean; label?: string; claimed_by?: string } | null;
  bad_location: { match: boolean; label?: string } | null;
  reason?: string;
}

/**
 * AI-based detection of whether a decision references at-capacity facilities,
 * claimed spaces, or unsuitable locations. Returns null on failure so caller
 * can fall back to keyword matching.
 */
export async function evaluatePrerequisiteReferences(
  params: {
    decisionText: string;
    capacityFacilities: Array<{ label: string; type: string }>;
    claimedSpaces: Array<{ label: string; claimed_by: string; claimed_as: string }>;
    badLocations: Array<{ label: string; location_type: string; condition: string }>;
    incidentContext?: { title: string; description: string };
  },
  openAiApiKey: string,
): Promise<PrerequisiteReferenceResult | null> {
  const { decisionText, capacityFacilities, claimedSpaces, badLocations, incidentContext } = params;
  const hasItems =
    capacityFacilities.length > 0 || claimedSpaces.length > 0 || badLocations.length > 0;
  if (!hasItems) return null;

  try {
    const sections: string[] = [];
    if (capacityFacilities.length > 0) {
      sections.push(
        'AT-CAPACITY FACILITIES (full, cannot accept more):\n' +
          capacityFacilities.map((f) => `- ${f.label} (${f.type})`).join('\n'),
      );
    }
    if (claimedSpaces.length > 0) {
      sections.push(
        'CLAIMED SPACES (already assigned to another team):\n' +
          claimedSpaces
            .map((s) => `- ${s.label} — claimed by ${s.claimed_by} as ${s.claimed_as}`)
            .join('\n'),
      );
    }
    if (badLocations.length > 0) {
      sections.push(
        'UNSUITABLE / UNCLEARED LOCATIONS:\n' +
          badLocations.map((l) => `- ${l.label} (${l.location_type}): ${l.condition}`).join('\n'),
      );
    }
    const incidentBlock = incidentContext
      ? `\nIncident context: ${incidentContext.title} — ${incidentContext.description}`
      : '';

    const systemPrompt = `You are a crisis management evaluator. Given a decision and lists of problematic locations/facilities, determine whether the decision PROPOSES USING any of them. A decision that only mentions a location to reject, avoid, or suggest alternatives does NOT count as proposing use.
Return JSON only:
{
  "capacity_facility": { "match": boolean, "label": "matched facility name or null" } | null,
  "claimed_space": { "match": boolean, "label": "matched space name or null", "claimed_by": "team name or null" } | null,
  "bad_location": { "match": boolean, "label": "matched location name or null" } | null,
  "reason": "one sentence explaining the match or why no match"
}
Set the category to null if that category has no items to check. Set match to true only if the decision proposes USING that specific facility/space/location.`;

    const userPrompt = `${sections.join('\n\n')}${incidentBlock}\n\nDECISION TEXT:\n${decisionText.slice(0, 1500)}\n\nDoes the decision propose using any of the listed items? JSON only.`;

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
      logger.warn(
        { status: response.status },
        'OpenAI API error in evaluatePrerequisiteReferences',
      );
      return null;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as PrerequisiteReferenceResult;
    return {
      capacity_facility: parsed.capacity_facility ?? null,
      claimed_space: parsed.claimed_space ?? null,
      bad_location: parsed.bad_location ?? null,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 400) : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'evaluatePrerequisiteReferences failed, returning null for fallback');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Narrative prerequisite conflict detection (v2 — intent-based, no matching)
// ---------------------------------------------------------------------------

export interface PrerequisiteConflictResult {
  conflict: boolean;
  conflict_type: 'capacity' | 'space_contention' | 'location' | null;
  location_label: string | null;
  reason: string;
}

/**
 * Narrative-based prerequisite check. Describes the environmental situation in
 * plain language and asks the AI to reason about whether the decision creates a
 * real conflict — no per-label matching fields, no structured lists to match against.
 *
 * Returns null on API failure so caller can fall back to keyword logic.
 */
export async function evaluatePrerequisiteConflict(
  params: {
    decisionText: string;
    capacityFacilities: Array<{ label: string; type: string }>;
    claimedSpaces: Array<{ label: string; claimed_by: string; claimed_as: string }>;
    badLocations: Array<{ label: string; location_type: string; condition: string }>;
    incidentContext?: { title: string; description: string };
  },
  openAiApiKey: string,
): Promise<PrerequisiteConflictResult | null> {
  const { decisionText, capacityFacilities, claimedSpaces, badLocations, incidentContext } = params;
  const hasItems =
    capacityFacilities.length > 0 || claimedSpaces.length > 0 || badLocations.length > 0;
  if (!hasItems) return null;

  try {
    const conditions: string[] = [];
    for (const f of capacityFacilities) {
      conditions.push(
        `${f.label} (${f.type}) is at full capacity and cannot accept more load right now.`,
      );
    }
    for (const s of claimedSpaces) {
      conditions.push(
        `${s.label} has been claimed by the ${s.claimed_by} team as their ${s.claimed_as}.`,
      );
    }
    for (const l of badLocations) {
      conditions.push(
        `${l.label} (${l.location_type}) has ${l.condition} — it has not been cleared or managed yet.`,
      );
    }

    const conditionsBlock = conditions.join('\n');
    const incidentBlock = incidentContext
      ? `\n=== INCIDENT BEING RESPONDED TO ===\n${incidentContext.title} — ${incidentContext.description}\n`
      : '';

    const systemPrompt = `You are a crisis management evaluator for an emergency exercise simulation. You assess whether a team's decision conflicts with current environmental conditions at the incident site.

You will receive:
1. The current environmental situation (facilities at capacity, spaces already claimed by other teams, locations with poor/unsuitable conditions).
2. The decision a team is trying to execute.
3. Optionally, the incident this decision is responding to.

Determine whether the decision creates a REAL CONFLICT with any of the environmental conditions described. A conflict exists when:
- The decision relies on a facility that is at capacity (e.g. sending patients to a full hospital).
- The decision proposes using a space that another team has already claimed for a different purpose — and the two uses would genuinely interfere with each other.
- The decision commits to operating in a location that has poor or unsuitable conditions that haven't been managed.

A conflict does NOT exist when:
- The decision merely mentions a location without proposing to use it.
- The decision references a location to reject, avoid, or suggest alternatives.
- The decision acknowledges the constraint and works around it.
- The overlap with a claimed space is compatible (e.g. both uses can coexist, or the team is coordinating with the claiming team).
- The decision mentions a location only in passing or as context.

Return JSON only:
{
  "conflict": boolean,
  "conflict_type": "capacity" | "space_contention" | "location" | null,
  "location_label": "the specific location/facility name if there is a conflict, or null",
  "reason": "one or two sentences explaining your assessment"
}`;

    const userPrompt = `=== CURRENT ENVIRONMENTAL CONDITIONS ===
${conditionsBlock}
${incidentBlock}
=== DECISION TEXT ===
${decisionText.slice(0, 1500)}

---
Does this decision conflict with the environmental conditions described above? JSON only.`;

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
      logger.warn({ status: response.status }, 'OpenAI API error in evaluatePrerequisiteConflict');
      return null;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as {
      conflict?: boolean;
      conflict_type?: string;
      location_label?: string;
      reason?: string;
    };
    const validTypes = ['capacity', 'space_contention', 'location'] as const;
    const conflictType =
      parsed.conflict === true &&
      typeof parsed.conflict_type === 'string' &&
      validTypes.includes(parsed.conflict_type as (typeof validTypes)[number])
        ? (parsed.conflict_type as PrerequisiteConflictResult['conflict_type'])
        : null;

    return {
      conflict: parsed.conflict === true,
      conflict_type: conflictType,
      location_label:
        typeof parsed.location_label === 'string' ? parsed.location_label.trim() : null,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 400) : '',
    };
  } catch (err) {
    logger.warn({ err }, 'evaluatePrerequisiteConflict failed, returning null for fallback');
    return null;
  }
}
