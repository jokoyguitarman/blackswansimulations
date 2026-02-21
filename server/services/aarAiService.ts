import { logger } from '../lib/logger.js';

/**
 * AAR AI Service
 * Generates AI-powered summaries and insights for AAR reports
 */

interface EscalationFactor {
  id: string;
  name: string;
  description: string;
  severity: string;
}

interface EscalationPathway {
  pathway_id: string;
  trajectory: string;
  trigger_behaviours: string[];
}

interface SessionData {
  sessionId: string;
  durationMinutes: number;
  participantCount: number;
  eventCount: number;
  decisionCount: number;
  decisions: Array<{
    title: string;
    type: string;
    status: string;
    created_at: string;
    description?: string;
    executed_at?: string;
  }>;
  keyMetrics: Record<string, unknown>;
  scenarioDescription?: string;
  scenarioTitle?: string;
  objectives?: Array<{ objective_name?: string; status?: string; progress_percentage?: number }>;
  injectsOccurred?: Array<{ at: string; type?: string; title?: string; content?: string }>;
  escalationFactors?: Array<{ evaluated_at: string; factors: EscalationFactor[] }>;
  escalationPathways?: Array<{ evaluated_at: string; pathways: EscalationPathway[] }>;
  impactMatrices?: Array<{
    evaluated_at: string;
    matrix: Record<string, Record<string, number>>;
    robustness_by_decision?: Record<string, number>;
    escalation_factors_snapshot?: unknown;
    analysis?: { overall?: string; matrix_reasoning?: string; robustness_reasoning?: string };
  }>;
}

/**
 * Generate AAR summary using AI
 */
export async function generateAARSummary(
  sessionData: SessionData,
  openAiApiKey: string,
): Promise<string> {
  try {
    const systemPrompt = `You are an expert crisis management analyst reviewing a training exercise simulation.
Your task is to generate a comprehensive, professional after-action review summary based on the session data provided.

How to evaluate:
- Judge recorded actions (decisions, timing, coordination, process adherence) against: (1) the scenario intent and objectives, (2) the injects that occurred and whether responses were appropriate and timely, (3) when escalation data is provided, use the impact matrices (inter-team impact and robustness by decision), escalation factors (risks identified), and escalation pathways (how the situation could have worsened and what trigger behaviours could lead there) to assess whether the team did well enough to avoid escalations or whether things turned for the worse.
- Compare "what was planned/expected" (scenario, objectives, injects) with "what was recorded" (decisions, events, metrics) and use escalation factors/pathways and impact/robustness to judge escalation avoidance or deterioration.
- Decisions are executed immediately by the decision maker (no approval workflow). Do not refer to approval workflows, cross-agency approval counts, or compliance with required sign-offs.

Guidelines:
- Write in a clear, professional tone suitable for training exercise documentation. Be objective and constructive. Focus on actionable insights. Use specific metrics and numbers where available. Structure the summary with clear sections.

The summary must include these six sections with the following focus:

1. Executive overview: Set the scene from the scenario; state whether objectives were met overall and how the recorded session aligned with the scenario.

2. Key decisions and timing: Relate decisions to the timeline of injects and scenario; note whether decisions were timely and appropriate to the situation presented. Where escalation data is available, relate decisions to robustness_by_decision (higher = more mitigating) and to escalation pathways (did decisions avoid the trigger behaviours or reduce the risk of those trajectories?).

3. Coordination and communication effectiveness: Judge coordination from inter_agency_messages and participation (shared channels, messages_per_participant)—not from cross-agency approvals. Use keyMetrics.communication: total_messages, messages_per_participant, avg_response_time_minutes, inter_agency_message_count, communication_delays. Assess whether participants communicated in line with scenario demands; note response times vs inject timing; note channel use and participation balance.

4. Compliance and process adherence: Do not use approval-based compliance. Judge by: decision latency (were decisions executed in a timely way relative to injects and scenario?); alignment of decisions with scenario and injects; objective progress (keyMetrics.objectives). State where execution was timely and aligned vs delayed or misaligned.

5. Overall performance assessment: Synthesise alignment with scenario and objectives; strengths and gaps. When escalation data is provided: use the impact matrix (inter-team impact scores), robustness by decision (1–10 per decision), escalation factors (risks identified), and escalation pathways (trajectories and trigger behaviours). Judge whether the team did well enough to avoid escalations (e.g. positive impact, higher robustness, decisions that did not align with pathway triggers) or whether things turned for the worse (e.g. negative inter-team impact, low robustness, or decisions/behaviours that matched pathway triggers). Use the matrix analysis field (overall, matrix_reasoning, robustness_reasoning) if present.

6. Key takeaways and recommendations: Prioritise actions that would improve alignment with scenario intent and response to injects. Where escalation data is available, include recommendations on how to avoid escalation pathways (trigger behaviours to avoid, factors to mitigate) and how to strengthen decisions that had low robustness or negative impact.`;

    const keyMetricsJson = JSON.stringify(sessionData.keyMetrics, null, 2);
    const scenarioBlock =
      sessionData.scenarioDescription || sessionData.scenarioTitle
        ? `
Scenario: ${sessionData.scenarioTitle ?? 'N/A'}
${sessionData.scenarioDescription ? `Description: ${sessionData.scenarioDescription.slice(0, 2000)}` : ''}

Objectives:
${(sessionData.objectives ?? []).map((o) => `- ${o.objective_name ?? 'Objective'}: ${o.status ?? 'N/A'}${o.progress_percentage != null ? ` (${o.progress_percentage}%)` : ''}`).join('\n')}

Injects that occurred (timeline):
${(sessionData.injectsOccurred ?? []).map((i) => `- At ${i.at}: [${i.type ?? 'update'}] ${i.title ?? 'Untitled'}${i.content ? ` — ${i.content.slice(0, 200)}` : ''}`).join('\n')}
`
        : '\nNo scenario/objectives/injects data provided.\n';

    const escalationBlock =
      (sessionData.escalationFactors?.length ?? 0) > 0 ||
      (sessionData.escalationPathways?.length ?? 0) > 0 ||
      (sessionData.impactMatrices?.length ?? 0) > 0
        ? `
Escalation factors (AI-identified risks during session):
${(sessionData.escalationFactors ?? [])
  .slice(0, 5)
  .map((r) => `Evaluated ${r.evaluated_at}: ${JSON.stringify(r.factors)}`)
  .join('\n')}

Escalation pathways (how situation could escalate, trigger behaviours):
${(sessionData.escalationPathways ?? [])
  .slice(0, 5)
  .map((r) => `Evaluated ${r.evaluated_at}: ${JSON.stringify(r.pathways)}`)
  .join('\n')}

Impact matrices (inter-team impact, robustness by decision):
${(sessionData.impactMatrices ?? [])
  .slice(0, 5)
  .map(
    (m) =>
      `Evaluated ${m.evaluated_at}: matrix=${JSON.stringify(m.matrix)} robustness_by_decision=${JSON.stringify(m.robustness_by_decision ?? {})}${m.analysis ? ` analysis=${JSON.stringify(m.analysis)}` : ''}`,
  )
  .join('\n')}
`
        : '\nNo escalation/impact data provided.\n';

    const decisionsList = sessionData.decisions
      .slice(0, 20)
      .map(
        (d, i) =>
          `${i + 1}. ${d.title} (${d.type}) - ${d.status} at ${d.created_at}${d.description ? ` — ${String(d.description).slice(0, 150)}` : ''}`,
      )
      .join('\n');

    const userPrompt = `Generate an after-action review summary for the following training exercise session.

Session Overview:
- Duration: ${sessionData.durationMinutes} minutes
- Participants: ${sessionData.participantCount}
- Total Events: ${sessionData.eventCount}
- Total Decisions: ${sessionData.decisionCount}
${scenarioBlock}

Full key metrics (use for coordination, communication, process adherence):
${keyMetricsJson}
${escalationBlock}

Key Decisions Made:
${decisionsList}
${sessionData.decisions.length > 20 ? `... and ${sessionData.decisions.length - 20} more decisions` : ''}

Generate a comprehensive summary that analyzes the exercise performance, uses the escalation data (when provided) to judge whether the team avoided escalations or things turned for the worse, and provides actionable insights for future training.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 3000,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `HTTP ${response.status}`;
      logger.error(
        { error: errorMessage, status: response.status },
        'OpenAI API error in AAR summary generation',
      );

      const apiError = new Error(`OpenAI API error: ${errorMessage}`) as Error & {
        statusCode?: number;
      };
      apiError.statusCode = response.status;

      if (response.status === 401 || response.status === 403) {
        apiError.message = 'OpenAI API key is invalid or expired.';
      } else if (response.status === 429) {
        apiError.message = 'OpenAI rate limit exceeded. Please try again later.';
      } else if (response.status >= 500) {
        apiError.message = 'OpenAI service is temporarily unavailable. Please try again later.';
      }

      throw apiError;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('No content received from OpenAI');
    }

    logger.info({ sessionId: sessionData.sessionId }, 'AAR summary generated successfully');
    return content;
  } catch (err) {
    logger.error({ error: err, sessionId: sessionData.sessionId }, 'Error generating AAR summary');
    throw err;
  }
}

/**
 * Generate AI insights for AAR (structured insights beyond the summary)
 */
export async function generateAARInsights(
  sessionData: SessionData,
  openAiApiKey: string,
): Promise<Array<{ type: string; content: string; priority: 'high' | 'medium' | 'low' }>> {
  try {
    const systemPrompt = `You are an expert crisis management analyst. Generate structured insights for a training exercise after-action review.
Return your response as a JSON array of insight objects. Each insight should have:
- type: The category (e.g., "decision_making", "coordination", "communication", "process_adherence", "escalation_impact", "recommendation")
- content: A concise insight statement (2-3 sentences)
- priority: "high", "medium", or "low"

Focus on actionable, specific insights. Decisions are executed immediately by the maker (no approval workflow). When scenario/objectives/injects are provided, reflect how well recorded actions matched them. When escalation data is provided (impact matrix, robustness by decision, escalation factors, pathways), include insights on whether the team did well enough to avoid escalations or things turned for the worse—use robustness scores, inter-team impact, and pathway triggers vs actual decisions. For coordination/communication use inter_agency_messages and participation balance; for process adherence use decision latency and objective progress.`;

    const scenarioSummary = sessionData.scenarioDescription
      ? `Scenario: ${sessionData.scenarioTitle ?? 'N/A'}. Objectives: ${(sessionData.objectives ?? []).map((o) => `${o.objective_name ?? 'Objective'}=${o.status}`).join('; ')}. Injects: ${(sessionData.injectsOccurred ?? []).length} occurred.`
      : 'No scenario/objectives/injects provided.';
    const escalationSummary =
      (sessionData.impactMatrices?.length ?? 0) > 0 ||
      (sessionData.escalationFactors?.length ?? 0) > 0 ||
      (sessionData.escalationPathways?.length ?? 0) > 0
        ? `Escalation data: ${sessionData.impactMatrices?.length ?? 0} impact matrix evaluations, ${sessionData.escalationFactors?.length ?? 0} factor snapshots, ${sessionData.escalationPathways?.length ?? 0} pathway snapshots. Use to assess if team avoided escalations or things turned for the worse.`
        : 'No escalation data provided.';

    const userPrompt = `Generate structured insights for this training exercise.

${scenarioSummary}
${escalationSummary}

Full key metrics:
${JSON.stringify(sessionData.keyMetrics, null, 2)}

Escalation/impact (if any): impact matrices with robustness_by_decision, escalation factors, escalation pathways.
${sessionData.impactMatrices?.length ? `Latest impact matrix robustness_by_decision: ${JSON.stringify(sessionData.impactMatrices[0]?.robustness_by_decision ?? {})}` : ''}

Key Decisions:
${sessionData.decisions
  .slice(0, 15)
  .map((d) => `- ${d.title} (${d.type}): ${d.status}`)
  .join('\n')}

Return a JSON array of 5-8 insight objects (use "insights" key or root array).`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
        max_tokens: 3000,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `HTTP ${response.status}`;
      logger.error(
        { error: errorMessage, status: response.status },
        'OpenAI API error in AAR insights generation',
      );
      throw new Error(`OpenAI API error: ${errorMessage}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('No content received from OpenAI');
    }

    // Parse JSON response
    const parsed = JSON.parse(content);
    const insights = parsed.insights || parsed; // Handle both { insights: [...] } and [...] formats

    if (!Array.isArray(insights)) {
      logger.warn({ sessionId: sessionData.sessionId }, 'AI insights not in expected array format');
      return [];
    }

    logger.info(
      { sessionId: sessionData.sessionId, insightCount: insights.length },
      'AAR insights generated successfully',
    );
    return insights;
  } catch (err) {
    logger.error({ error: err, sessionId: sessionData.sessionId }, 'Error generating AAR insights');
    throw err;
  }
}
