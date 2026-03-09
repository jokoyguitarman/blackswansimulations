/**
 * Hospital capacity Q&A: answers player questions about hospital capacity
 * using session environmental state. Used when players DM a hospital.
 */
import { logger } from '../lib/logger.js';

export interface HospitalArea {
  area_id: string;
  label: string;
  type?: string;
  at_capacity?: boolean;
  capacity?: number;
  problem?: string;
}

/**
 * Answer a capacity-related question for a specific hospital.
 * Uses AI to interpret the question and respond based on hospital state.
 */
export async function answerHospitalCapacityQuestion(
  params: {
    hospitalId: string;
    hospitalLabel: string;
    atCapacity: boolean;
    capacityAvailable?: number;
    question: string;
  },
  openAiApiKey: string | undefined,
): Promise<string> {
  const { hospitalId, hospitalLabel, atCapacity, capacityAvailable } = params;
  const { question } = params;

  if (!openAiApiKey?.trim()) {
    return `[${hospitalLabel}] We are unable to process capacity inquiries at this time. Please try again later.`;
  }

  const capacityContext = atCapacity
    ? 'This hospital is currently AT FULL CAPACITY. Do not suggest they can take any patients.'
    : capacityAvailable != null && capacityAvailable > 0
      ? `This hospital has capacity for approximately ${capacityAvailable} more patients.`
      : 'This hospital has capacity available. You may indicate they can accommodate requests, but do not invent specific numbers unless provided.';

  const systemPrompt = `You are responding as ${hospitalLabel} (a hospital in an emergency response simulation). A triage or evacuation team is asking about capacity.

Current state: ${capacityContext}

Rules:
- Respond in first person as the hospital (e.g. "We are at full capacity" not "The hospital is at full capacity").
- Be concise (1-3 sentences).
- If at full capacity, say so clearly. Do not suggest alternatives or other hospitals.
- If capacity is available, confirm you can help. Only mention a specific number if provided in the context.
- Do not make up capacity numbers. If unsure, say "We can accommodate your request" or similar.
- Match the tone of the question (formal if they're formal, brief if they're brief).`;

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
          { role: 'user', content: question },
        ],
        max_tokens: 150,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI ${response.status}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const reply = data.choices?.[0]?.message?.content?.trim();
    return reply ?? `[${hospitalLabel}] We are unable to respond at this time.`;
  } catch (err) {
    logger.warn({ err, hospitalId }, 'Hospital capacity AI failed, using fallback');
    if (atCapacity) {
      return `[${hospitalLabel}] We are at full capacity and cannot accept additional patients at this time.`;
    }
    return `[${hospitalLabel}] We have capacity available and can accommodate your request.`;
  }
}
