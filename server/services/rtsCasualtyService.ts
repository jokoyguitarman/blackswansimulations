import { logger } from '../lib/logger.js';

// ── Types ───────────────────────────────────────────────────────────────

interface VictimSpec {
  label: string;
  trueTag: 'red' | 'yellow' | 'green' | 'black';
  description: string;
  observableSigns: {
    breathing: string;
    pulse: string;
    consciousness: string;
    visibleInjuries: string;
    mobility: string;
    bleeding: string;
  };
}

interface GenerateSceneRequest {
  victims: VictimSpec[];
  sceneContext: string;
}

interface TriageAssessmentRequest {
  imageUrl: string;
  victims: Array<{
    label: string;
    trueTag: string;
    description: string;
    playerTag: string;
  }>;
  sceneContext: string;
}

interface TriageAssessmentResult {
  overallScore: number;
  maxScore: number;
  evaluation: string;
  perVictim: Array<{
    label: string;
    correct: boolean;
    feedback: string;
  }>;
  criticalErrors: string[];
}

// ── DALL-E 3 scene image generation ─────────────────────────────────────

function victimPose(v: VictimSpec): string {
  const mob = v.observableSigns.mobility.toLowerCase();
  if (mob.includes('walk')) return 'sitting upright, alert, with minor cosmetic makeup on face';
  if (
    mob.includes('immobile') &&
    v.observableSigns.consciousness.toLowerCase().includes('unresponsive')
  )
    return 'lying flat on the ground, eyes closed, arms at sides';
  if (mob.includes('cannot'))
    return 'seated on the ground leaning against a wall, holding one arm, grimacing';
  return 'lying on side on the ground';
}

function buildImagePrompt(victims: VictimSpec[], sceneContext: string): string {
  const poses = victims.map((v, i) => `Person ${i + 1}: ${victimPose(v)}.`).join(' ');
  const context = sceneContext.replace(/bomb|explos|blast|detona/gi, 'incident');

  return (
    `A wide-angle photograph of an emergency response training drill. Setting: ${context}. ` +
    `${victims.length} volunteer actors are positioned in various poses to simulate an incident scene. ` +
    `${poses} ` +
    `Scattered dust and small debris on the pavement. Each actor wears a numbered vest (1, 2, 3, etc.). ` +
    `Professional training exercise photography, overhead angle, well-lit daytime scene. ` +
    `The actors have theatrical stage makeup to indicate their role in the drill. Clean, documentary style.`
  );
}

export async function generateCasualtySceneImage(
  req: GenerateSceneRequest,
  openAiApiKey: string,
): Promise<string | null> {
  const prompt = buildImagePrompt(req.victims, req.sceneContext);

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1792x1024',
        quality: 'standard',
        response_format: 'url',
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, body: errBody }, 'DALL-E 3 generation failed');
      return null;
    }

    const data = (await response.json()) as {
      data?: Array<{ url?: string; revised_prompt?: string }>;
    };

    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) {
      logger.warn({ data }, 'DALL-E 3 returned no image URL');
      return null;
    }

    return imageUrl;
  } catch (err) {
    logger.error({ err }, 'Error generating casualty scene image');
    return null;
  }
}

// ── DALL-E 3 individual victim image ─────────────────────────────────────

export async function generateVictimImage(
  victim: VictimSpec,
  sceneContext: string,
  openAiApiKey: string,
): Promise<string | null> {
  const pose = victimPose(victim);
  const context = sceneContext.replace(/bomb|explos|blast|detona/gi, 'incident');
  const prompt =
    `A close-up photograph from an emergency response training drill. Setting: ${context}. ` +
    `A single volunteer actor is ${pose}. ` +
    `They are on a concrete surface with scattered dust and small debris around them. ` +
    `The actor wears everyday clothing with theatrical stage makeup applied to indicate their role in the exercise. ` +
    `The lighting is bright and natural. Documentary photography style, slightly overhead angle, focused on this one person. ` +
    `Professional disaster preparedness training photo. Clean composition.`;

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        response_format: 'url',
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, body: errBody }, 'DALL-E 3 victim image failed');
      return null;
    }

    const data = (await response.json()) as {
      data?: Array<{ url?: string }>;
    };

    return data.data?.[0]?.url ?? null;
  } catch (err) {
    logger.error({ err }, 'Error generating victim image');
    return null;
  }
}

// ── GPT triage evaluation ───────────────────────────────────────────────

const TRIAGE_SYSTEM_PROMPT = `You are evaluating a triage exercise for emergency medical training. You are scoring a player's triage tag assignments against the correct (ground truth) tags.

Triage tags follow the START protocol:
- RED (Immediate): Life-threatening but survivable with immediate intervention. Breathing problems, uncontrolled bleeding, altered consciousness.
- YELLOW (Delayed): Serious injuries but can wait 1-4 hours. Fractures, controlled bleeding, burns without airway compromise.
- GREEN (Minor): Walking wounded. Cuts, bruises, minor burns, psychological distress.
- BLACK (Expectant/Deceased): Non-survivable injuries or already dead.

Scoring rules:
- Correct tag: +1 point
- Off by one severity level (e.g., Red tagged as Yellow): 0 points, note as minor error
- Survivable patient tagged as BLACK: -2 points — this is the most severe error (preventable death)
- Non-survivable patient tagged as RED: -1 point — wasted treatment resources on unsaveable patient
- GREEN patient tagged as RED: -1 point — CCP overwhelmed with minor cases

Evaluate each victim's tag and provide feedback. Be concise but educational.

Respond with JSON only:
{
  "overallScore": number,
  "maxScore": number,
  "evaluation": "Brief overall assessment of the player's triage performance",
  "perVictim": [
    { "label": "Victim 1", "correct": true/false, "feedback": "explanation" }
  ],
  "criticalErrors": ["description of any survivable-tagged-Black or similar critical mistakes"]
}`;

export async function evaluateTriageAssessment(
  req: TriageAssessmentRequest,
  openAiApiKey: string,
): Promise<TriageAssessmentResult> {
  const victimDetails = req.victims
    .map(
      (v) =>
        `${v.label}: True severity = ${v.trueTag.toUpperCase()}. Description: ${v.description}. Player assigned: ${v.playerTag.toUpperCase()}.`,
    )
    .join('\n');

  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  if (req.imageUrl) {
    userContent.push({
      type: 'image_url',
      image_url: { url: req.imageUrl },
    });
  }

  userContent.push({
    type: 'text',
    text: `Scene context: ${req.sceneContext}\n\nVictim triage assignments to evaluate:\n${victimDetails}\n\nEvaluate each assignment. Respond with JSON only.`,
  });

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
          { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_completion_tokens: 16000,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, body: errBody }, 'GPT triage evaluation failed');
      return defaultResult(req.victims.length);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, 'GPT triage response was not valid JSON');
      return defaultResult(req.victims.length);
    }

    return JSON.parse(jsonMatch[0]) as TriageAssessmentResult;
  } catch (err) {
    logger.error({ err }, 'Error evaluating triage assessment');
    return defaultResult(req.victims.length);
  }
}

function defaultResult(victimCount: number): TriageAssessmentResult {
  return {
    overallScore: 0,
    maxScore: victimCount,
    evaluation: 'Triage evaluation system temporarily unavailable.',
    perVictim: [],
    criticalErrors: [],
  };
}
