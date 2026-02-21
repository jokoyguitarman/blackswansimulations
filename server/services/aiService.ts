import { logger } from '../lib/logger.js';

/**
 * AI Service - Business logic for AI-powered features
 * Separation of concerns: All AI-related business logic
 */

interface ScenarioGenerationPrompt {
  category: string;
  difficulty: string;
  duration_minutes: number;
  context?: string;
  specific_requirements?: string;
}

interface GeneratedScenario {
  title: string;
  description: string;
  category: string;
  difficulty: string;
  duration_minutes: number;
  objectives: string[];
  initial_state: Record<string, unknown>;
  suggested_injects?: Array<{
    trigger_time_minutes: number;
    type: string;
    title: string;
    content: string;
    severity: string;
    affected_roles: string[];
  }>;
}

/**
 * Generate a complete scenario using AI
 */
export const generateScenario = async (
  prompt: ScenarioGenerationPrompt,
  openAiApiKey: string,
): Promise<GeneratedScenario> => {
  try {
    const systemPrompt = `You are an expert crisis management scenario designer for multi-agency emergency response simulations. 
Your task is to create detailed, realistic scenarios that challenge decision-makers across multiple agencies including:
- Defence/Law Enforcement
- Health Services
- Civil Government
- Utilities
- Intelligence
- NGOs

Create scenarios that:
1. Require inter-agency coordination
2. Have realistic timelines and consequences
3. Include multiple decision points
4. Test communication and resource sharing
5. Reflect real-world crisis management challenges

Return ONLY valid JSON in this exact format:
{
  "title": "Scenario title",
  "description": "Detailed 3-4 paragraph description of the scenario, including background, current situation, and key challenges",
  "category": "one of: cyber, infrastructure, civil_unrest, natural_disaster, health_emergency, terrorism, custom",
  "difficulty": "one of: beginner, intermediate, advanced, expert",
  "duration_minutes": number,
  "objectives": ["objective 1", "objective 2", "objective 3"],
  "initial_state": {
    "public_sentiment": "neutral",
    "resource_availability": "moderate",
    "threat_level": "medium"
  },
  "suggested_injects": [
    {
      "trigger_time_minutes": number,
      "type": "one of: media_report, field_update, citizen_call, intel_brief, resource_shortage, weather_change, political_pressure",
      "title": "Inject title",
      "content": "Detailed inject content",
      "severity": "one of: low, medium, high, critical",
      "affected_roles": ["role1", "role2"]
    }
  ]
}`;

    const userPrompt = `Create a ${prompt.difficulty} difficulty ${prompt.category} scenario lasting approximately ${prompt.duration_minutes} minutes.
${prompt.context ? `Context: ${prompt.context}` : ''}
${prompt.specific_requirements ? `Specific requirements: ${prompt.specific_requirements}` : ''}

Make it realistic, challenging, and suitable for multi-agency crisis management training.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Using cost-effective model
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      const status = response.status;
      const errorMessage = error.error?.message || error.message || 'Unknown error';

      logger.error({ error: errorMessage, status }, 'OpenAI API error');

      // Create error with status code for proper handling
      const apiError = new Error(errorMessage) as Error & { statusCode?: number };
      apiError.statusCode = status;

      // Provide user-friendly messages for common errors
      if (status === 429) {
        apiError.message = 'Rate limit exceeded. Please wait a moment and try again.';
      } else if (status === 401) {
        apiError.message = 'OpenAI API key is invalid or expired.';
      } else if (status === 503) {
        apiError.message = 'OpenAI service is temporarily unavailable. Please try again later.';
      }

      throw apiError;
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No content received from OpenAI');
    }

    // Parse JSON response
    const parsed = JSON.parse(content) as GeneratedScenario;

    // Validate and normalize
    return {
      title: parsed.title || 'AI Generated Scenario',
      description: parsed.description || 'No description provided',
      category: parsed.category || prompt.category,
      difficulty: parsed.difficulty || prompt.difficulty,
      duration_minutes: parsed.duration_minutes || prompt.duration_minutes,
      objectives: Array.isArray(parsed.objectives) ? parsed.objectives : [],
      initial_state: parsed.initial_state || {},
      suggested_injects: parsed.suggested_injects || [],
    };
  } catch (err) {
    logger.error({ error: err }, 'Error generating scenario with AI');
    throw err;
  }
};

/**
 * Decision Classification Result
 */
export interface DecisionClassification {
  primary_category: string;
  categories: string[];
  keywords: string[];
  semantic_tags: string[];
  confidence: number;
}

/**
 * Classify a decision using AI
 * Analyzes decision title and description to extract categories, keywords, and semantic tags
 */
export const classifyDecision = async (
  decision: { title: string; description: string },
  openAiApiKey: string,
): Promise<DecisionClassification> => {
  try {
    console.log('🟡 CLASSIFY_START: Starting classification', { decisionTitle: decision.title });
    logger.info(
      { decisionTitle: decision.title },
      'CLASSIFY_START: Starting decision classification',
    );

    const systemPrompt = `You are an expert crisis management analyst. Your task is to classify decisions made during emergency response scenarios.

Analyze the decision and classify it into one or more of these categories:
- emergency_declaration: Declarations of emergency, evacuation orders, safety measures
- resource_allocation: Allocation of personnel, equipment, or resources
- public_statement: Public communications, press releases, official statements
- policy_change: Changes to policies, procedures, or protocols
- coordination_order: Inter-agency coordination, joint operations
- operational_action: Tactical operations, field actions, direct interventions

Extract:
1. Primary category (most relevant)
2. All applicable categories
3. Key keywords from the decision
4. Semantic tags that describe the decision's meaning

Return ONLY valid JSON in this exact format:
{
  "primary_category": "emergency_declaration",
  "categories": ["emergency_declaration", "operational_action"],
  "keywords": ["evacuation", "zone", "500m", "radius"],
  "semantic_tags": ["evacuation_order", "geographic_restriction", "safety_measure"],
  "confidence": 0.95
}`;

    const userPrompt = `Classify this decision:

Title: ${decision.title}
Description: ${decision.description}

Provide a detailed classification with high confidence.`;

    console.log('🟡 CLASSIFY_API_CALL: Sending request to OpenAI', {
      decisionTitle: decision.title,
    });
    logger.info(
      { decisionTitle: decision.title },
      'CLASSIFY_API_CALL: Sending request to OpenAI API',
    );

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
        temperature: 0.3, // Lower temperature for more consistent classification
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });

    console.log('🟡 CLASSIFY_RESPONSE: Received response', {
      decisionTitle: decision.title,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    });
    logger.info(
      { decisionTitle: decision.title, status: response.status, ok: response.ok },
      'CLASSIFY_RESPONSE: Received response from OpenAI',
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      const status = response.status;
      const errorMessage = error.error?.message || error.message || 'Unknown error';

      console.error('🔴 CLASSIFY_ERROR: OpenAI API error', {
        decisionTitle: decision.title,
        status,
        error: errorMessage,
      });
      logger.error({ error: errorMessage, status }, 'OpenAI API error in decision classification');

      const apiError = new Error(errorMessage) as Error & { statusCode?: number };
      apiError.statusCode = status;

      if (status === 429) {
        apiError.message = 'Rate limit exceeded. Please wait a moment and try again.';
      } else if (status === 401) {
        apiError.message = 'OpenAI API key is invalid or expired.';
      } else if (status === 503) {
        apiError.message = 'OpenAI service is temporarily unavailable. Please try again later.';
      }

      throw apiError;
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    console.log('🟡 CLASSIFY_PARSE: Parsing response', {
      decisionTitle: decision.title,
      hasContent: !!content,
      contentLength: content?.length || 0,
    });
    logger.info(
      { decisionTitle: decision.title, hasContent: !!content },
      'CLASSIFY_PARSE: Parsing OpenAI response',
    );

    if (!content) {
      console.error('🔴 CLASSIFY_ERROR: No content received', { decisionTitle: decision.title });
      throw new Error('No content received from OpenAI');
    }

    // Parse JSON response
    const parsed = JSON.parse(content) as DecisionClassification;

    console.log('🟢 CLASSIFY_SUCCESS: Classification complete', {
      decisionTitle: decision.title,
      classification: parsed.primary_category,
    });
    logger.info(
      { decisionTitle: decision.title, classification: parsed.primary_category },
      'CLASSIFY_SUCCESS: Decision classified successfully',
    );

    // Validate and normalize
    return {
      primary_category: parsed.primary_category || 'operational_action',
      categories: Array.isArray(parsed.categories)
        ? parsed.categories
        : [parsed.primary_category || 'operational_action'],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      semantic_tags: Array.isArray(parsed.semantic_tags) ? parsed.semantic_tags : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
    };
  } catch (err) {
    console.error('🔴 CLASSIFY_CATCH: Error in classifyDecision', {
      decisionTitle: decision.title,
      error: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
    logger.error({ error: err }, 'Error classifying decision with AI');
    throw err;
  }
};

/**
 * Result of AI check: should a scheduled inject be cancelled given recent player decisions?
 */
export interface ScheduledInjectCancellationResult {
  cancel: boolean;
  reason?: string;
}

/**
 * Decide whether a pre-loaded (scheduled) scenario inject should be suppressed
 * because player decisions in the last 5 minutes have already addressed, prevented,
 * or made the event obsolete (e.g. "bomb explodes" cancelled by "bomb safely detonated").
 */
export const shouldCancelScheduledInject = async (
  inject: { title: string; content: string },
  recentDecisions: Array<{ title: string; description: string; type: string | null }>,
  openAiApiKey: string,
): Promise<ScheduledInjectCancellationResult> => {
  try {
    const systemPrompt = `You are an expert crisis simulation facilitator. Your task is to decide whether a scheduled scenario event (inject) should still be published to players, given the decisions they have already made in the last 5 minutes.

Rules:
- If player decisions have already addressed, prevented, or made this scheduled event obsolete or contradictory, return cancel: true.
- Examples: scheduled "Bomb explodes" but players decided to "safely detonate the bomb" -> cancel. Scheduled "Evacuation chaos" but players already executed a full evacuation order -> consider cancelling if the inject would be redundant or contradictory.
- If the inject is still relevant, adds new information, or is not contradicted by recent decisions, return cancel: false.
- When in doubt, prefer cancel: false so the scenario continues as designed unless there is a clear contradiction.
- Consider partial overlap: if players did something that partially addresses the inject, you may still cancel if the inject would now be misleading (e.g. "Secondary explosion" when the threat was already neutralized).

Return ONLY valid JSON in this exact format:
{
  "cancel": true,
  "reason": "Brief explanation of why this inject should or should not be published"
}

or

{
  "cancel": false,
  "reason": "Brief explanation"
}`;

    const decisionsText =
      recentDecisions.length > 0
        ? recentDecisions
            .map((d, i) => `${i + 1}. [${d.type || 'unknown'}] ${d.title}\n   ${d.description}`)
            .join('\n\n')
        : 'No decisions executed in the last 5 minutes.';

    const userPrompt = `Scheduled inject that is about to be published:

Title: ${inject.title}

Content:
${inject.content}

---
Decisions made by players in the last 5 minutes:

${decisionsText}

---
Should this scheduled inject be CANCELLED (not published) because player actions have already addressed, prevented, or made it obsolete? Return JSON with "cancel" (boolean) and "reason" (string).`;

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
      const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      logger.warn(
        { status: response.status, injectTitle: inject.title, error },
        'OpenAI API error in shouldCancelScheduledInject, defaulting to not cancel',
      );
      return { cancel: false, reason: 'AI check failed; inject will publish.' };
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;
    if (!content) {
      return { cancel: false, reason: 'No AI response; inject will publish.' };
    }

    const parsed = JSON.parse(content) as { cancel?: boolean; reason?: string };
    const cancel = parsed.cancel === true;
    if (cancel) {
      logger.info(
        { injectTitle: inject.title, reason: parsed.reason },
        'Scheduled inject cancelled by AI due to recent decisions',
      );
    }
    return {
      cancel,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch (err) {
    logger.warn(
      { error: err, injectTitle: inject.title },
      'Error in shouldCancelScheduledInject, defaulting to not cancel',
    );
    return { cancel: false, reason: 'Error during check; inject will publish.' };
  }
};

/**
 * Escalation factor (Stage 2: AI-identified from scenario state).
 */
export interface EscalationFactor {
  id: string;
  name: string;
  description: string;
  severity: string;
}

export interface IdentifyEscalationFactorsResult {
  factors: EscalationFactor[];
}

/**
 * Stage 2: Identify escalation factors from current scenario state.
 * AI analyses scenario + current state + recent injects to find factors that may lead to escalation.
 */
export const identifyEscalationFactors = async (
  scenarioDescription: string,
  currentState: Record<string, unknown>,
  objectives: Array<{ objective_id?: string; objective_name?: string }>,
  recentInjects: Array<{ type?: string; title?: string; content?: string }>,
  openAiApiKey: string,
): Promise<IdentifyEscalationFactorsResult> => {
  const empty: IdentifyEscalationFactorsResult = { factors: [] };
  try {
    const systemPrompt = `You are an expert crisis management analyst. Analyse the scenario and current situation to identify factors that may lead to escalation. These are factors, not fixed outcomes.

Consider factors such as: delayed evacuation, misinformation, poor coordination, medical response failures, social panic or fragmentation, resource shortages, communication gaps, or similar.

Return ONLY valid JSON in this exact format:
{
  "factors": [
    { "id": "EF-1", "name": "Short name", "description": "One or two sentences.", "severity": "low" | "medium" | "high" | "critical" }
  ]
}

Include 3 to 8 factors. Use id like EF-1, EF-2, etc. Severity must be one of: low, medium, high, critical.`;

    const objectivesText =
      objectives.length > 0
        ? objectives.map((o) => `- ${o.objective_name ?? o.objective_id}`).join('\n')
        : 'None specified';
    const injectsText =
      recentInjects.length > 0
        ? recentInjects
            .map(
              (i) =>
                `[${i.type ?? 'update'}] ${i.title ?? 'Untitled'}\n${(i.content ?? '').slice(0, 300)}`,
            )
            .join('\n\n')
        : 'No recent injects';

    const userPrompt = `Scenario description:
${scenarioDescription.slice(0, 1500)}

Current state (summary): ${JSON.stringify(currentState).slice(0, 500)}

Objectives:
${objectivesText}

Recent injects (current situation):
${injectsText}

---
Identify escalation factors. Return JSON only.`;

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
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenAI API error in identifyEscalationFactors');
      return empty;
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;
    if (!content) {
      return empty;
    }

    const parsed = JSON.parse(content) as { factors?: EscalationFactor[] };
    const factors = Array.isArray(parsed.factors) ? parsed.factors : [];
    const normalized = factors
      .filter((f) => f && typeof f.name === 'string')
      .map((f, i) => ({
        id: typeof f.id === 'string' ? f.id : `EF-${i + 1}`,
        name: String(f.name),
        description: String(f.description ?? ''),
        severity: ['low', 'medium', 'high', 'critical'].includes(String(f.severity))
          ? f.severity
          : 'medium',
      }));

    logger.info({ factorCount: normalized.length }, 'Escalation factors identified');
    return { factors: normalized };
  } catch (err) {
    logger.warn({ error: err }, 'Error in identifyEscalationFactors, returning empty');
    return empty;
  }
};

/**
 * Escalation pathway (Stage 3: AI-generated from factors and context).
 */
export interface EscalationPathway {
  pathway_id: string;
  trajectory: string;
  trigger_behaviours: string[];
}

export interface GenerateEscalationPathwaysResult {
  pathways: EscalationPathway[];
}

/**
 * Stage 3: Generate escalation pathways from current factors and scenario context.
 * AI describes how the situation could escalate (trajectory) and what behaviours could trigger it.
 */
export const generateEscalationPathways = async (
  scenarioDescription: string,
  currentState: Record<string, unknown>,
  escalationFactors: EscalationFactor[],
  openAiApiKey: string,
): Promise<GenerateEscalationPathwaysResult> => {
  const empty: GenerateEscalationPathwaysResult = { pathways: [] };
  try {
    const systemPrompt = `You are an expert crisis management analyst. Given escalation factors already identified for a scenario, produce plausible escalation pathways: how the situation could get worse, and what trigger behaviours (actions or conditions) could lead there.

Return ONLY valid JSON in this exact format:
{
  "pathways": [
    {
      "pathway_id": "EP-1",
      "trajectory": "One or two sentences describing how the situation could escalate (e.g. delayed evacuation -> overcrowding at shelters -> disease outbreak).",
      "trigger_behaviours": ["Behaviour or condition 1", "Behaviour or condition 2"]
    }
  ]
}

Include 2 to 6 pathways. Use pathway_id like EP-1, EP-2, etc. Each pathway should have 1 to 4 trigger_behaviours (short phrases).`;

    const factorsText =
      escalationFactors.length > 0
        ? escalationFactors
            .map((f) => `- ${f.id}: ${f.name} (${f.severity}): ${f.description}`)
            .join('\n')
        : 'None provided';

    const userPrompt = `Scenario description:
${scenarioDescription.slice(0, 1200)}

Current state (summary): ${JSON.stringify(currentState).slice(0, 400)}

Escalation factors (from Stage 2):
${factorsText}

---
Generate escalation pathways (trajectory + trigger_behaviours). Return JSON only.`;

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
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenAI API error in generateEscalationPathways');
      return empty;
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;
    if (!content) {
      return empty;
    }

    const parsed = JSON.parse(content) as { pathways?: EscalationPathway[] };
    const pathways = Array.isArray(parsed.pathways) ? parsed.pathways : [];
    const normalized = pathways
      .filter((p) => p && typeof p.trajectory === 'string')
      .map((p, i) => ({
        pathway_id: typeof p.pathway_id === 'string' ? p.pathway_id : `EP-${i + 1}`,
        trajectory: String(p.trajectory),
        trigger_behaviours: Array.isArray(p.trigger_behaviours)
          ? p.trigger_behaviours.map((b) => String(b)).slice(0, 4)
          : [],
      }));

    logger.info({ pathwayCount: normalized.length }, 'Escalation pathways generated');
    return { pathways: normalized };
  } catch (err) {
    logger.warn({ error: err }, 'Error in generateEscalationPathways, returning empty');
    return empty;
  }
};

/**
 * Optional AI reasoning for the impact matrix (audit trail).
 */
export interface ImpactMatrixAnalysis {
  overall?: string;
  matrix_reasoning?: string;
  robustness_reasoning?: string;
}

/**
 * Inter-team impact matrix result: acting_team -> affected_team -> score.
 * Optional per-decision robustness (1-10) and optional analysis text.
 */
export interface ImpactMatrixResult {
  matrix: Record<string, Record<string, number>>;
  robustnessByDecisionId?: Record<string, number>;
  analysis?: ImpactMatrixAnalysis;
}

/**
 * Compute inter-team impact matrix and optional per-decision robustness from recent decisions.
 * Uses AI to score how each team's decisions affect other teams (-2 to +2 or similar).
 * Optional escalationFactors and escalationPathways inform the analysis reasoning.
 * Optional responseTaxonomy: teams with "absent" had no decisions in the window—do not include them as actors in the matrix; treat their robustness as 0.
 */
export const computeInterTeamImpactMatrix = async (
  teams: string[],
  decisionsWithTeam: Array<{
    decision_id: string;
    title: string;
    description: string;
    type: string | null;
    team: string | null;
  }>,
  openAiApiKey: string,
  scenarioContext?: string,
  escalationFactors?: EscalationFactor[],
  escalationPathways?: EscalationPathway[],
  responseTaxonomy?: Record<string, 'textual' | 'absent'>,
): Promise<ImpactMatrixResult> => {
  const empty: ImpactMatrixResult = { matrix: {}, robustnessByDecisionId: {} };
  try {
    if (teams.length === 0 || decisionsWithTeam.length === 0) {
      return empty;
    }

    const absentTeams =
      responseTaxonomy && Object.keys(responseTaxonomy).length > 0
        ? Object.entries(responseTaxonomy)
            .filter(([, v]) => v === 'absent')
            .map(([t]) => t)
        : [];
    const absentInstruction =
      absentTeams.length > 0
        ? `\n\nResponse taxonomy: the following teams had no decisions in this window (treat as non-responders, robustness 0): ${absentTeams.join(', ')}. Do NOT include these teams as acting_team in the matrix (only teams that made decisions should appear as keys in matrix). You may include them as affected_team when other teams' decisions impact them.`
        : '';

    const systemPrompt = `You are an expert crisis management analyst. Given a list of teams and decisions made by those teams in the last 5 minutes, produce:
1. An inter-team impact matrix: for each acting_team (team that made decisions), for each other affected_team, output an impact score from -2 (negative impact, hinders or increases risk) to +2 (positive impact, helps or reduces risk). Use 0 for neutral or no clear impact. Do not include acting_team on itself.
2. Optionally, for each decision_id, output a robustness score from 1 (weak, increases escalation) to 10 (strong, mitigates escalation). Teams with no decisions in the window have robustness 0 (do not invent entries for them).
3. Optionally, an "analysis" object with short reasoning: "overall" (1-2 sentences on overall inter-team dynamics), "matrix_reasoning" (brief note on key matrix scores), "robustness_reasoning" (brief note on decision robustness). When escalation factors or pathways are provided, reference them in your reasoning (e.g. whether decisions mitigate or worsen those factors, or align with pathway triggers).

Return ONLY valid JSON in this exact format:
{
  "matrix": {
    "TeamNameA": { "TeamNameB": 1, "TeamNameC": -1 },
    "TeamNameB": { "TeamNameA": 0, "TeamNameC": 2 }
  },
  "robustness": {
    "decision-uuid-1": 7,
    "decision-uuid-2": 4
  },
  "analysis": {
    "overall": "Optional 1-2 sentences.",
    "matrix_reasoning": "Optional brief note.",
    "robustness_reasoning": "Optional brief note."
  }
}

Team names must match exactly the input team list. Include as matrix actors only teams that actually made decisions (appear in the decisions list).${absentInstruction}`;

    const decisionsText = decisionsWithTeam
      .map(
        (d) =>
          `[${d.decision_id}] team=${d.team ?? 'unknown'} | ${d.type ?? 'unknown'} | ${d.title}\n   ${d.description}`,
      )
      .join('\n\n');

    const escalationContext =
      (escalationFactors?.length ?? 0) > 0 || (escalationPathways?.length ?? 0) > 0
        ? `\n\nCurrent escalation factors (evaluate decisions against these risks):\n${(escalationFactors ?? []).map((f) => `- ${f.id}: ${f.name} (${f.severity}): ${f.description}`).join('\n')}\n\nEscalation pathways (how situation could worsen; consider whether decisions avoid trigger behaviours):\n${(escalationPathways ?? []).map((p) => `- ${p.pathway_id}: ${p.trajectory}; triggers: ${(p.trigger_behaviours ?? []).join(', ')}`).join('\n')}\n`
        : '';

    const userPrompt = `Teams in this session: ${teams.join(', ')}

${scenarioContext ? `Scenario context: ${scenarioContext.substring(0, 500)}\n\n` : ''}Decisions (last 5 minutes):

${decisionsText}
${escalationContext}
---
Produce the impact matrix (acting_team -> affected_team -> score -2 to +2) and optional robustness per decision_id (1-10). When escalation context is provided, reference it in your analysis reasoning. Return JSON only.`;

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
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenAI API error in computeInterTeamImpactMatrix');
      return empty;
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;
    if (!content) {
      return empty;
    }

    const parsed = JSON.parse(content) as {
      matrix?: Record<string, Record<string, number>>;
      robustness?: Record<string, number>;
      analysis?: ImpactMatrixAnalysis;
    };
    const matrix = parsed.matrix && typeof parsed.matrix === 'object' ? parsed.matrix : {};
    const robustnessByDecisionId =
      parsed.robustness && typeof parsed.robustness === 'object' ? parsed.robustness : {};
    const analysis =
      parsed.analysis && typeof parsed.analysis === 'object'
        ? {
            overall:
              typeof parsed.analysis.overall === 'string' ? parsed.analysis.overall : undefined,
            matrix_reasoning:
              typeof parsed.analysis.matrix_reasoning === 'string'
                ? parsed.analysis.matrix_reasoning
                : undefined,
            robustness_reasoning:
              typeof parsed.analysis.robustness_reasoning === 'string'
                ? parsed.analysis.robustness_reasoning
                : undefined,
          }
        : undefined;

    logger.info(
      {
        teamCount: teams.length,
        decisionCount: decisionsWithTeam.length,
        matrixKeys: Object.keys(matrix).length,
      },
      'Inter-team impact matrix computed',
    );
    return { matrix, robustnessByDecisionId, analysis };
  } catch (err) {
    logger.warn({ error: err }, 'Error in computeInterTeamImpactMatrix, returning empty');
    return empty;
  }
};

/**
 * Objective Completion Evaluation Result
 */
export interface ObjectiveCompletionEvaluation {
  isComplete: boolean;
  confidence: number;
  reasoning: string;
  progressPercentage: number;
}

/**
 * Evaluate if an objective has been completed based on executed decisions
 * Analyzes all decisions against objective success criteria
 */
export const evaluateObjectiveCompletion = async (
  objective: {
    objective_id: string;
    objective_name: string;
    description: string;
    success_criteria: Record<string, unknown>;
  },
  decisions: Array<{
    id: string;
    title: string;
    description: string;
    type: string;
    executed_at: string;
  }>,
  sessionStartTime: string,
  openAiApiKey: string,
): Promise<ObjectiveCompletionEvaluation> => {
  try {
    const systemPrompt = `You are an expert crisis management evaluator. Your task is to determine if a scenario objective has been successfully completed based on the decisions made during the session.

Analyze all executed decisions and evaluate them against the objective's success criteria. Consider:
- Positive indicators: Decisions that satisfy or progress toward the objective
- Negative indicators: Decisions that violate criteria or create penalties
- Time-based criteria: Whether time thresholds are met
- Threshold requirements: Whether quantitative targets are achieved
- Quality indicators: Whether decisions demonstrate proper execution

Return ONLY valid JSON in this exact format:
{
  "isComplete": true,
  "confidence": 0.85,
  "reasoning": "Brief explanation of why the objective is or isn't complete based on the decisions",
  "progressPercentage": 95
}

Confidence should be between 0 and 1. Only mark isComplete as true if confidence >= 0.75.
Progress percentage should reflect current completion status (0-100).`;

    // Format decisions for context
    const decisionsContext = decisions
      .map((d, idx) => {
        const timeFromStart = d.executed_at
          ? Math.round(
              (new Date(d.executed_at).getTime() - new Date(sessionStartTime).getTime()) / 60000,
            )
          : null;
        return `Decision ${idx + 1} (${timeFromStart !== null ? `${timeFromStart} min` : 'time unknown'}):
Title: ${d.title}
Description: ${d.description}
Type: ${d.type}
Executed: ${d.executed_at}`;
      })
      .join('\n\n');

    const userPrompt = `Evaluate if this objective has been completed:

Objective: ${objective.objective_name}
Description: ${objective.description}
Success Criteria: ${JSON.stringify(objective.success_criteria, null, 2)}

Executed Decisions (${decisions.length} total):
${decisions.length > 0 ? decisionsContext : 'No decisions have been executed yet.'}

Session Start Time: ${sessionStartTime}

Based on the decisions made, determine:
1. Has the objective been successfully completed?
2. What is your confidence level (0-1)?
3. What is the current progress percentage (0-100)?
4. Provide brief reasoning for your evaluation.`;

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
        temperature: 0.3, // Lower temperature for consistent evaluation
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      const status = response.status;
      const errorMessage = error.error?.message || error.message || 'Unknown error';

      logger.error(
        { error: errorMessage, status, objectiveId: objective.objective_id },
        'OpenAI API error in objective completion evaluation',
      );

      const apiError = new Error(errorMessage) as Error & { statusCode?: number };
      apiError.statusCode = status;

      if (status === 429) {
        apiError.message = 'Rate limit exceeded. Please wait a moment and try again.';
      } else if (status === 401) {
        apiError.message = 'OpenAI API key is invalid or expired.';
      } else if (status === 503) {
        apiError.message = 'OpenAI service is temporarily unavailable. Please try again later.';
      }

      throw apiError;
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No content received from OpenAI');
    }

    // Parse JSON response
    const parsed = JSON.parse(content) as ObjectiveCompletionEvaluation;

    // Validate and normalize
    return {
      isComplete: parsed.isComplete === true && parsed.confidence >= 0.75,
      confidence:
        typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      reasoning: parsed.reasoning || 'No reasoning provided',
      progressPercentage:
        typeof parsed.progressPercentage === 'number'
          ? Math.max(0, Math.min(100, parsed.progressPercentage))
          : 0,
    };
  } catch (err) {
    logger.error(
      { error: err, objectiveId: objective.objective_id },
      'Error evaluating objective completion with AI',
    );
    throw err;
  }
};

/**
 * Generated Inject from AI
 */
export interface GeneratedInject {
  type:
    | 'media_report'
    | 'field_update'
    | 'citizen_call'
    | 'intel_brief'
    | 'resource_shortage'
    | 'weather_change'
    | 'political_pressure';
  title: string;
  content: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affected_roles: string[];
  inject_scope?: 'universal' | 'role_specific' | 'team_specific';
  requires_response?: boolean;
  requires_coordination?: boolean;
}

/**
 * Generate an inject based on a decision that was just executed
 * Creates realistic consequences, reactions, or developments that would naturally follow from the decision
 */
export const generateInjectFromDecision = async (
  decision: {
    title: string;
    description: string;
    type: string;
  },
  sessionContext: {
    scenarioDescription?: string;
    recentDecisions?: Array<{
      id: string;
      title: string;
      description: string;
      type: string;
      proposed_by?: string;
      proposed_by_name?: string;
      executed_at?: string;
      ai_classification?: DecisionClassification;
    }>;
    sessionDurationMinutes?: number;
    upcomingInjects?: Array<{
      trigger_time_minutes: number;
      type: string;
      title: string;
      content: string;
      severity: string;
    }>;
    currentState?: Record<string, unknown>;
    objectives?: Array<{
      objective_id: string;
      objective_name: string;
      status: string;
      progress_percentage: number;
    }>;
    recentInjects?: Array<{
      type: string;
      title: string;
      content: string;
      published_at: string;
    }>;
    participants?: Array<{
      user_id: string;
      role: string;
    }>;
    /** Checkpoint 8: Inter-team impact matrix and escalation context for inject generation */
    latestImpactMatrix?: Record<string, Record<string, number>>;
    latestImpactAnalysis?: {
      overall?: string;
      matrix_reasoning?: string;
      robustness_reasoning?: string;
    };
    latestRobustnessByDecision?: Record<string, number>;
    escalationFactors?: Array<{ id: string; name: string; description: string; severity: string }>;
    escalationPathways?: Array<{
      pathway_id: string;
      trajectory: string;
      trigger_behaviours: string[];
    }>;
    responseTaxonomy?: Record<string, string>;
  },
  openAiApiKey: string,
): Promise<GeneratedInject | null> => {
  try {
    const systemPrompt = `You are an expert crisis management scenario designer. Your task is to generate realistic injects (events, updates, or developments) that would naturally occur as consequences or reactions to decisions made during emergency response scenarios.

An inject should:
1. Be a realistic consequence, reaction, or development that follows from the decision
2. Challenge players with new information or complications
3. Be appropriate for the scenario context
4. Have appropriate severity based on the decision's impact
5. Target relevant roles that would be affected

Available inject types:
- media_report: News reports, press coverage, social media reactions
- field_update: On-the-ground situation updates, operational reports
- citizen_call: Reports from citizens, complaints, requests for help
- intel_brief: Intelligence updates, security information
- resource_shortage: Resource availability issues, supply problems
- weather_change: Environmental conditions, weather updates
- political_pressure: Political demands, official pressure, policy concerns

Return ONLY valid JSON in this exact format:
{
  "type": "media_report",
  "title": "Short, descriptive title (max 200 chars)",
  "content": "Detailed, realistic content describing the inject. Should be 2-4 sentences, written as if it's a real update or report.",
  "severity": "medium",
  "affected_roles": ["public_information_officer", "police_commander"],
  "inject_scope": "role_specific",
  "requires_response": false,
  "requires_coordination": false
}

CRITICAL: inject_scope and affected_roles determine who sees this inject:
- "universal": Use ONLY when the inject contains information that ALL participants need to know (e.g., major breaking news, system-wide alerts, critical public announcements). This should be RARE.
- "role_specific": Use when the inject is relevant to specific roles. This should be the DEFAULT for most injects. Only include roles in affected_roles that would realistically receive, need to know about, or respond to this inject.
- "team_specific": Use when the inject is relevant to specific teams (rare, typically for coordination scenarios).

CRITICAL: requires_response field determines if an incident is automatically created:
- Set requires_response: true when the inject requires an active operational response, contains misinformation needing correction, creates public concern requiring official response, or represents a situation demanding immediate action.

  Examples of requires_response: true:
  - Media report spreading false information about casualties → needs debunking/response
  - Media report creating panic about evacuation → needs official clarification
  - Media report with negative narrative requiring counter-messaging → needs response
  - Citizen call reporting an emergency or requesting help → needs response
  - Intel brief about active security threat → needs investigation/response
  - Resource shortage affecting operations → needs resource allocation
  - Field update reporting an incident requiring response → needs response

- Set requires_response: false when the inject is purely informational, neutral reporting, or provides context without requiring action.

  Examples of requires_response: false:
  - Media report: "Local news covers ongoing response efforts" → informational
  - Media report: "Weather service issues forecast update" → informational
  - Media report: "General coverage of response coordination" → informational
  - Field update: "Team A has completed initial assessment" → status update
  - Intel brief: "Background on suspect organization" → informational context
  - Political pressure: "General policy discussion" → informational

Examples of inject scope and affected_roles:
- Media report about police actions → inject_scope: "role_specific", affected_roles: ["public_information_officer", "police_commander"]
- Citizen complaint about medical services → inject_scope: "role_specific", affected_roles: ["medical_director", "hospital_admin"]
- Major breaking news affecting everyone → inject_scope: "universal", affected_roles: [] (all roles see it)
- Intel brief about security threat → inject_scope: "role_specific", affected_roles: ["police_commander", "security_officer"]

Important:
- Only generate an inject if the decision warrants a meaningful consequence or reaction
- Make the inject feel natural and realistic, not forced
- Severity should match the decision's impact (low for minor decisions, critical for major emergency declarations)
- DEFAULT to "role_specific" unless the inject truly needs to be seen by everyone
- affected_roles should include ONLY roles that would realistically need to know about or respond to this inject
- Use role names that match the active participants in the session
- Carefully consider requires_response: media reports with false info, panic, or negative narratives need response; neutral informational reports do not
- If the decision doesn't warrant an inject, return null`;

    // Build comprehensive context
    const scenarioContext = sessionContext.scenarioDescription
      ? `\n\nSCENARIO CONTEXT:\n${sessionContext.scenarioDescription}`
      : '';

    // ALL decisions made in this session (chronological order)
    const allDecisionsContext =
      sessionContext.recentDecisions && sessionContext.recentDecisions.length > 0
        ? `\n\nALL DECISIONS MADE IN THIS SESSION (chronological order):\n${sessionContext.recentDecisions
            .map((d, idx) => {
              const timeInfo = d.executed_at
                ? ` (executed at ${new Date(d.executed_at).toLocaleTimeString()})`
                : '';
              const proposerInfo = d.proposed_by_name ? ` by ${d.proposed_by_name}` : '';
              const classificationInfo = d.ai_classification
                ? ` [${d.ai_classification.primary_category}]`
                : '';
              return `${idx + 1}.${classificationInfo} ${d.title}: ${d.description}${proposerInfo}${timeInfo}`;
            })
            .join('\n')}`
        : '\n\nNo previous decisions have been made in this session.';

    // Upcoming scheduled injects
    const upcomingInjectsContext =
      sessionContext.upcomingInjects && sessionContext.upcomingInjects.length > 0
        ? `\n\nUPCOMING SCHEDULED INJECTS (to avoid contradictions - these will trigger soon):\n${sessionContext.upcomingInjects
            .map((inj, idx) => {
              const timeFromNow = sessionContext.sessionDurationMinutes
                ? inj.trigger_time_minutes - sessionContext.sessionDurationMinutes
                : inj.trigger_time_minutes;
              return `${idx + 1}. T+${inj.trigger_time_minutes} (in ${timeFromNow} min): [${inj.type}] ${inj.title} - ${inj.content.substring(0, 150)}${inj.content.length > 150 ? '...' : ''}`;
            })
            .join('\n')}`
        : '\n\nNo upcoming scheduled injects.';

    // Current game state
    const currentStateContext =
      sessionContext.currentState && Object.keys(sessionContext.currentState).length > 0
        ? `\n\nCURRENT GAME STATE:\n${JSON.stringify(sessionContext.currentState, null, 2)}`
        : '\n\nCurrent game state: No state data available.';

    // Objectives status
    const objectivesContext =
      sessionContext.objectives && sessionContext.objectives.length > 0
        ? `\n\nOBJECTIVES STATUS:\n${sessionContext.objectives
            .map(
              (obj) =>
                `${obj.objective_name}: ${obj.status} (${obj.progress_percentage}% complete)`,
            )
            .join('\n')}`
        : '\n\nNo objectives defined for this scenario.';

    // Recent injects
    const recentInjectsContext =
      sessionContext.recentInjects && sessionContext.recentInjects.length > 0
        ? `\n\nRECENT INJECTS (last 10 published):\n${sessionContext.recentInjects
            .map(
              (inj, idx) =>
                `${idx + 1}. [${inj.type}] ${inj.title} - ${inj.content.substring(0, 100)}${inj.content.length > 100 ? '...' : ''}`,
            )
            .join('\n')}`
        : '\n\nNo recent injects have been published.';

    // Participants context
    const participantsContext =
      sessionContext.participants && sessionContext.participants.length > 0
        ? `\n\nACTIVE PARTICIPANTS:\n${sessionContext.participants.map((p) => `- ${p.role}`).join('\n')}`
        : '';

    // Add inject type context if provided
    const injectTypeContext =
      (
        sessionContext as {
          injectType?: string;
          teamName?: string;
          teamDecisions?: Array<Record<string, unknown>>;
        }
      ).injectType === 'team_specific'
        ? `\n\nTEAM CONTEXT:\nThis inject is for team "${(sessionContext as { teamName?: string }).teamName}". Focus on the specific actions and decisions made by this team: ${JSON.stringify((sessionContext as { teamDecisions?: Array<Record<string, unknown>> }).teamDecisions || [], null, 2)}`
        : (sessionContext as { injectType?: string }).injectType === 'universal'
          ? `\n\nUNIVERSAL CONTEXT:\nThis inject should provide a general overview visible to all players, reflecting the overall state of play and all decisions made in the last 5 minutes.`
          : '';

    // Checkpoint 8: Inter-team impact matrix and escalation context (influence inject content)
    const hasMatrix =
      sessionContext.latestImpactMatrix &&
      Object.keys(sessionContext.latestImpactMatrix).length > 0;
    const hasFactors =
      sessionContext.escalationFactors && sessionContext.escalationFactors.length > 0;
    const hasPathways =
      sessionContext.escalationPathways && sessionContext.escalationPathways.length > 0;
    const hasAnalysis =
      sessionContext.latestImpactAnalysis &&
      (sessionContext.latestImpactAnalysis.overall ||
        sessionContext.latestImpactAnalysis.matrix_reasoning ||
        sessionContext.latestImpactAnalysis.robustness_reasoning);
    const escalationContext =
      hasMatrix || hasFactors || hasPathways || hasAnalysis
        ? `\n\nINTER-TEAM IMPACT MATRIX AND ESCALATION CONTEXT (use this to shape the inject):
Generate the next scenario state / inject based on the Inter-Team Impact Matrix and current escalation factors. Consider whether the situation is improving or worsening and what developments would align with the impact scores and escalation pathways.
${hasMatrix ? `\nImpact matrix (acting_team -> affected_team -> score -2 to +2):\n${JSON.stringify(sessionContext.latestImpactMatrix, null, 2)}` : ''}
${sessionContext.latestRobustnessByDecision && Object.keys(sessionContext.latestRobustnessByDecision).length > 0 ? `\nRobustness by decision (1-10, higher = more mitigating):\n${JSON.stringify(sessionContext.latestRobustnessByDecision)}` : ''}
${hasAnalysis ? `\nAnalysis: ${[sessionContext.latestImpactAnalysis!.overall, sessionContext.latestImpactAnalysis!.matrix_reasoning, sessionContext.latestImpactAnalysis!.robustness_reasoning].filter(Boolean).join(' ')}` : ''}
${sessionContext.responseTaxonomy && Object.keys(sessionContext.responseTaxonomy).length > 0 ? `\nResponse taxonomy (which teams responded in this window): ${JSON.stringify(sessionContext.responseTaxonomy)}` : ''}
${hasFactors ? `\nCurrent escalation factors (risks to consider):\n${sessionContext.escalationFactors!.map((f) => `- ${f.id}: ${f.name} (${f.severity}): ${f.description}`).join('\n')}` : ''}
${hasPathways ? `\nEscalation pathways (how situation could worsen; avoid trigger behaviours in inject unless intended):\n${sessionContext.escalationPathways!.map((p) => `- ${p.pathway_id}: ${p.trajectory}; triggers: ${(p.trigger_behaviours ?? []).join(', ')}`).join('\n')}` : ''}`
        : '';

    const instructions = (sessionContext as { instructions?: string }).instructions || '';

    const userPrompt = `Generate an inject based on this decision:

CURRENT DECISION:
Title: ${decision.title}
Description: ${decision.description}
Type: ${decision.type}${scenarioContext}${allDecisionsContext}${upcomingInjectsContext}${currentStateContext}${objectivesContext}${recentInjectsContext}${participantsContext}${injectTypeContext}${escalationContext}

${instructions}

Generate a realistic inject that:
- Is a natural consequence of the decision(s) and current state
- Stays consistent with ALL previous decisions
- Doesn't contradict upcoming scheduled injects
- Fits the current game state and objectives
- Creates appropriate challenges or complications
- When escalation/impact context is provided, align inject content with the inter-team impact and escalation factors (e.g. reflect improving or worsening dynamics, or developments that match the matrix and pathways)

CRITICAL: Scope targeting:
${
  (sessionContext as { injectType?: string; teamName?: string }).injectType === 'team_specific'
    ? `- MUST use "team_specific" scope with target_teams: ["${(sessionContext as { teamName?: string }).teamName}"]`
    : (sessionContext as { injectType?: string }).injectType === 'universal'
      ? `- MUST use "universal" scope (visible to all players)`
      : `- Use "role_specific" for role-targeted injects
- Use "universal" only for system-wide alerts
- Use "team_specific" if targeting specific teams`
}

Important considerations:
- If upcoming injects mention specific events (e.g., "explosion at 3pm"), don't create an inject that contradicts this
- Consider how previous decisions might have set up conditions that affect this decision's consequences
- The inject should feel like a natural progression of the story, not forced or disconnected
- Severity should match the decision's impact and the overall situation

If this decision doesn't warrant a meaningful inject, return null. Otherwise, return a well-crafted inject that fits seamlessly into the ongoing scenario.`;

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
        temperature: 0.7, // Creative but consistent
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      const status = response.status;
      const errorMessage = error.error?.message || error.message || 'Unknown error';

      logger.error({ error: errorMessage, status }, 'OpenAI API error in inject generation');

      const apiError = new Error(errorMessage) as Error & { statusCode?: number };
      apiError.statusCode = status;

      if (status === 429) {
        apiError.message = 'Rate limit exceeded. Please wait a moment and try again.';
      } else if (status === 401) {
        apiError.message = 'OpenAI API key is invalid or expired.';
      } else if (status === 503) {
        apiError.message = 'OpenAI service is temporarily unavailable. Please try again later.';
      }

      throw apiError;
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No content received from OpenAI');
    }

    // Parse JSON response
    const parsed = JSON.parse(content);

    // If AI returned null, don't generate an inject
    if (parsed === null || (typeof parsed === 'object' && Object.keys(parsed).length === 0)) {
      logger.debug(
        { decisionTitle: decision.title },
        'AI determined no inject needed for decision',
      );
      return null;
    }

    // Validate and normalize
    const validTypes = [
      'media_report',
      'field_update',
      'citizen_call',
      'intel_brief',
      'resource_shortage',
      'weather_change',
      'political_pressure',
    ];
    const validSeverities = ['low', 'medium', 'high', 'critical'];
    const validScopes = ['universal', 'role_specific', 'team_specific'];

    return {
      type: validTypes.includes(parsed.type) ? parsed.type : 'field_update',
      title: parsed.title || 'Update',
      content: parsed.content || 'No content provided',
      severity: validSeverities.includes(parsed.severity) ? parsed.severity : 'medium',
      affected_roles: Array.isArray(parsed.affected_roles) ? parsed.affected_roles : [],
      inject_scope: validScopes.includes(parsed.inject_scope) ? parsed.inject_scope : 'universal',
      requires_response: parsed.requires_response === true,
      requires_coordination: parsed.requires_coordination === true,
    };
  } catch (err) {
    logger.error(
      { error: err, decisionTitle: decision.title },
      'Error generating inject from decision',
    );
    return null; // Return null on error to not block decision execution
  }
};
