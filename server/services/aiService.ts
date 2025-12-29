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

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      const status = response.status;
      const errorMessage = error.error?.message || error.message || 'Unknown error';

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

    if (!content) {
      throw new Error('No content received from OpenAI');
    }

    // Parse JSON response
    const parsed = JSON.parse(content) as DecisionClassification;

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
    logger.error({ error: err }, 'Error classifying decision with AI');
    throw err;
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
