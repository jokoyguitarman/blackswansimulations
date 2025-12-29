import { logger } from '../lib/logger.js';
import { env } from '../env.js';

/**
 * AAR AI Service
 * Generates AI-powered summaries and insights for AAR reports
 */

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
  }>;
  keyMetrics: {
    decisionLatency?: { avg_minutes: number };
    coordination?: { overall_score: number };
    compliance?: { rate: number };
    objectives?: { overall_score: number; success_level: string };
  };
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

Guidelines:
- Write in a clear, professional tone suitable for training exercise documentation
- Highlight key decisions, coordination efforts, and areas for improvement
- Be objective and constructive
- Focus on actionable insights
- Keep the summary concise but comprehensive (approximately 500-800 words)
- Structure the summary with clear sections
- Use specific metrics and numbers where available

The summary should include:
1. Executive overview of the exercise
2. Key decisions made and their timing
3. Coordination and communication effectiveness
4. Compliance and process adherence
5. Overall performance assessment
6. Key takeaways and recommendations`;

    const userPrompt = `Generate an after-action review summary for the following training exercise session:

Session Overview:
- Duration: ${sessionData.durationMinutes} minutes
- Participants: ${sessionData.participantCount}
- Total Events: ${sessionData.eventCount}
- Total Decisions: ${sessionData.decisionCount}

Key Metrics:
${sessionData.keyMetrics.decisionLatency ? `- Average Decision Latency: ${sessionData.keyMetrics.decisionLatency.avg_minutes.toFixed(1)} minutes` : ''}
${sessionData.keyMetrics.coordination ? `- Coordination Score: ${sessionData.keyMetrics.coordination.overall_score}/100` : ''}
${sessionData.keyMetrics.compliance ? `- Compliance Rate: ${sessionData.keyMetrics.compliance.rate.toFixed(1)}%` : ''}
${sessionData.keyMetrics.objectives ? `- Overall Objective Score: ${sessionData.keyMetrics.objectives.overall_score}/100 (${sessionData.keyMetrics.objectives.success_level})` : ''}

Key Decisions Made:
${sessionData.decisions
  .slice(0, 10)
  .map((d, i) => `${i + 1}. ${d.title} (${d.type}) - ${d.status}`)
  .join('\n')}
${sessionData.decisions.length > 10 ? `... and ${sessionData.decisions.length - 10} more decisions` : ''}

Please generate a comprehensive summary that analyzes the exercise performance, highlights strengths and areas for improvement, and provides actionable insights for future training.`;

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
        max_tokens: 1500,
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
- type: The category (e.g., "decision_making", "coordination", "communication", "compliance", "recommendation")
- content: A concise insight statement (2-3 sentences)
- priority: "high", "medium", or "low"

Focus on actionable, specific insights based on the metrics and decisions provided.`;

    const userPrompt = `Generate structured insights for this training exercise:

Metrics:
${JSON.stringify(sessionData.keyMetrics, null, 2)}

Key Decisions:
${sessionData.decisions
  .slice(0, 15)
  .map((d) => `- ${d.title} (${d.type}): ${d.status}`)
  .join('\n')}

Return a JSON array of 5-8 insight objects.`;

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
        max_tokens: 1000,
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
