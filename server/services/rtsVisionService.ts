import { logger } from '../lib/logger.js';

interface AssessmentRequest {
  imageUrl: string;
  playerAction: string;
  plantedItem: {
    description: string;
    threatLevel: 'decoy' | 'real_device' | 'secondary_device';
    concealmentDifficulty: 'easy' | 'moderate' | 'hard';
  } | null;
  context: string;
}

interface AssessmentResult {
  found: boolean;
  response: string;
  confidenceHint: 'certain' | 'likely' | 'uncertain';
}

const SYSTEM_PROMPT = `You are the exercise controller for a bomb squad training simulation. You are evaluating an EOD technician's stated inspection action against a Street View photograph of a building exterior.

Your role:
- You can see the photograph. Analyze what objects, structures, and potential concealment points are visible.
- The trainer may have planted a hidden threat at this location. If a planted item description is provided, you know exactly what is hidden and where.
- The player has stated what they want to inspect. You must determine whether their stated action would realistically discover the planted item.

Rules:
1. NEVER reveal the planted item's existence if the player did not specifically identify the correct object or area.
2. If the player names the exact object containing the threat (e.g., "inspect the recycling bin"), respond that the item was found and describe what was discovered.
3. If the player is vague (e.g., "sweep the area" or "check everything"), respond that a sweep requires identifying specific concealment points. Ask them to be more specific about which objects they want to inspect. Do NOT reveal what they should look for.
4. If the player names a wrong object (e.g., "inspect the planter" when the bomb is in the bin), respond that the inspected object is clear — no anomalies found. Do NOT hint that they should look elsewhere.
5. If there is NO planted item at this location, respond that the inspection found no threats — area clear.
6. Stay in character as an exercise observer. Be professional and concise.
7. Describe what the EOD team would realistically find based on the player's stated action.

Respond with JSON only:
{
  "found": true/false,
  "response": "Your in-character response to the player",
  "confidenceHint": "certain" | "likely" | "uncertain"
}`;

export async function evaluateBombSquadAssessment(
  req: AssessmentRequest,
  openAiApiKey: string,
): Promise<AssessmentResult> {
  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  if (req.imageUrl) {
    userContent.push({
      type: 'image_url',
      image_url: { url: req.imageUrl },
    });
  }

  let promptText = `Context: ${req.context}\n\n`;

  if (req.plantedItem) {
    promptText += `[TRAINER KNOWLEDGE — HIDDEN FROM PLAYER]\nPlanted item: ${req.plantedItem.description}\nThreat level: ${req.plantedItem.threatLevel}\nConcealment difficulty: ${req.plantedItem.concealmentDifficulty}\n\n`;
  } else {
    promptText += `[TRAINER KNOWLEDGE]\nNo item has been planted at this location.\n\n`;
  }

  promptText += `[PLAYER'S STATED ACTION]\n"${req.playerAction}"\n\nEvaluate whether this action would discover the planted item (if any). Respond with JSON only.`;

  userContent.push({ type: 'text', text: promptText });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.1',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_tokens: 16000,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, body: errBody }, 'GPT vision API error');
      return {
        found: false,
        response: 'Assessment system temporarily unavailable. Continue sweep manually.',
        confidenceHint: 'uncertain',
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, 'GPT vision response was not valid JSON');
      return {
        found: false,
        response: raw || 'Unable to evaluate assessment.',
        confidenceHint: 'uncertain',
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as AssessmentResult;
    return {
      found: !!parsed.found,
      response: parsed.response || 'Assessment evaluated.',
      confidenceHint: parsed.confidenceHint || 'uncertain',
    };
  } catch (err) {
    logger.error({ err }, 'Error calling GPT vision for bomb squad assessment');
    return {
      found: false,
      response: 'Assessment system error. Continue sweep manually.',
      confidenceHint: 'uncertain',
    };
  }
}
