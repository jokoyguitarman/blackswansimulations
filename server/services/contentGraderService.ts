import { logger } from '../lib/logger.js';
import { env } from '../env.js';

export interface ContentGrade {
  accuracy: number;
  tone: number;
  cultural_sensitivity: number;
  persuasiveness: number;
  completeness: number;
  overall: number;
  feedback: string;
  strengths: string[];
  improvements: string[];
}

export async function gradePlayerContent(
  playerContent: string,
  context: {
    crisis_description: string;
    confirmed_facts: string[];
    content_guidelines?: Record<string, unknown>;
    hateful_post_being_addressed?: string;
    research_guidelines?: Array<{ best_practice: string; source_basis: string }>;
  },
): Promise<ContentGrade> {
  if (!env.openAiApiKey) {
    return defaultGrade('AI grading not available - no API key configured');
  }

  try {
    const systemPrompt = `You are an expert evaluator for a racial harmony crisis response team.
You evaluate responses from a BYSTANDER AND COMMUNITY PROTECTION perspective -- NOT whether the response "wins an argument."

Grade the following response on these criteria (each 0-100):

1. ACCURACY: Uses only verified facts? Cites official sources? Avoids speculation?
2. TONE: Empathetic, calm, authoritative? Not defensive, sarcastic, or preachy? Would a scared bystander feel reassured?
3. CULTURAL SENSITIVITY: Protects targeted communities? Avoids collective blame? Uses inclusive language? Separates perpetrators from communities?
4. PERSUASIVENESS: Would a neutral bystander be convinced? Does it address the concerns behind the hate (fear, uncertainty) rather than just condemning?
5. COMPLETENESS: Provides actionable guidance (report hate, follow official channels, helplines)? Includes verified facts? Redirects to safe sources?

ANTI-AMPLIFICATION CHECK: If the response QUOTES or REPEATS hateful language verbatim (even to debunk it), deduct 20 points from PERSUASIVENESS and 10 from CULTURAL SENSITIVITY. The correct approach is to state the correction WITHOUT repeating the harmful claim.

Context about the crisis:
${context.crisis_description}

Confirmed facts available:
${context.confirmed_facts.map((f) => '- ' + f).join('\\n')}

${context.hateful_post_being_addressed ? 'The hateful post being addressed:\\n' + context.hateful_post_being_addressed : ''}

${context.research_guidelines?.length ? 'Doctrine-based best practices to evaluate against:\\n' + context.research_guidelines.map((g) => '- ' + g.best_practice + ' (' + g.source_basis + ')').join('\\n') : ''}

Return ONLY valid JSON:
{
  "accuracy": <0-100>,
  "tone": <0-100>,
  "cultural_sensitivity": <0-100>,
  "persuasiveness": <0-100>,
  "completeness": <0-100>,
  "overall": <0-100>,
  "feedback": "<2-3 sentence summary focusing on bystander impact>",
  "strengths": ["<strength1>", "<strength2>"],
  "improvements": ["<improvement1>", "<improvement2>"]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Grade this response:\n\n${playerContent}` },
        ],
        temperature: 0.3,
        max_completion_tokens: 1024,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenAI content grading failed');
      return defaultGrade('AI grading temporarily unavailable');
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return defaultGrade('Empty AI response');

    const grade = JSON.parse(content) as ContentGrade;
    return grade;
  } catch (err) {
    logger.error({ err }, 'Content grading error');
    return defaultGrade('Grading failed');
  }
}

function defaultGrade(feedback: string): ContentGrade {
  return {
    accuracy: 50,
    tone: 50,
    cultural_sensitivity: 50,
    persuasiveness: 50,
    completeness: 50,
    overall: 50,
    feedback,
    strengths: [],
    improvements: [],
  };
}
