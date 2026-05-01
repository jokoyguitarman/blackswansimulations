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
  },
): Promise<ContentGrade> {
  if (!env.openAiApiKey) {
    return defaultGrade('AI grading not available - no API key configured');
  }

  try {
    const systemPrompt = `You are an expert evaluator for a racial harmony crisis response team. 
Grade the following response on these criteria (each 0-100):

1. ACCURACY: Does the response use verified facts? Does it avoid unverified claims?
2. TONE: Is it empathetic, calm, and authoritative? Not defensive, dismissive, or inflammatory?
3. CULTURAL SENSITIVITY: Does it respect all communities? Avoid stereotypes? Use inclusive language?
4. PERSUASIVENESS: Would this response actually reduce tension and counter hate speech?
5. COMPLETENESS: Does it address the key claims and provide actionable information?

Context about the crisis:
${context.crisis_description}

Confirmed facts available:
${context.confirmed_facts.map((f) => `- ${f}`).join('\n')}

${context.hateful_post_being_addressed ? `The hateful post being addressed:\n${context.hateful_post_being_addressed}` : ''}

Return ONLY valid JSON:
{
  "accuracy": <0-100>,
  "tone": <0-100>,
  "cultural_sensitivity": <0-100>,
  "persuasiveness": <0-100>,
  "completeness": <0-100>,
  "overall": <0-100>,
  "feedback": "<2-3 sentence summary>",
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
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Grade this response:\n\n${playerContent}` },
        ],
        temperature: 0.3,
        max_tokens: 1024,
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
