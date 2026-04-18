import { logger } from '../lib/logger.js';

interface CasualtyPinInput {
  id: string;
  pos: { x: number; y: number };
  description: string;
  trueTag: string;
  distanceFromBlast?: number;
  nearbyHazards?: string[];
}

interface HazardInput {
  id: string;
  pos: { x: number; y: number };
  hazardType: string;
  severity: string;
  description: string;
  distanceFromBlast?: number;
}

interface SceneEnrichmentRequest {
  incidentDescription: string;
  blastRadius: number;
  blastSite: { x: number; y: number } | null;
  casualtyPins: CasualtyPinInput[];
  hazards: HazardInput[];
  buildingName: string | null;
  pedestrianCount: number;
  exitsCount: number;
  stairwellsCount: number;
}

interface EnrichedCasualty {
  id: string;
  description: string;
  trueTag: string;
  observableSigns: {
    breathing: string;
    pulse: string;
    consciousness: string;
    visibleInjuries: string;
    mobility: string;
    bleeding: string;
  };
}

interface HazardAnalysis {
  hazardId: string;
  blastInteraction: string;
  secondaryEffects: string[];
  progressionTimeline: string;
  riskLevel: string;
}

interface SceneEnrichmentResult {
  enrichedCasualties: EnrichedCasualty[];
  generatedCasualties: EnrichedCasualty[];
  hazardAnalysis: HazardAnalysis[];
  overallAssessment: string;
}

const ENRICHMENT_SYSTEM_PROMPT = `You are analyzing a crisis management training scenario for enrichment. You have expertise in blast effects, mass casualty incidents, hazardous materials, and emergency response.

Your tasks:
1. For casualties with empty descriptions: generate realistic injury descriptions based on their distance from the blast and nearby hazards. Use START triage protocol tags (RED/YELLOW/GREEN/BLACK).
2. If no casualties are provided, generate 8-15 realistic casualty descriptions distributed across different distances from the blast.
3. For each hazard: analyze whether the blast can reach it, what secondary effects would occur, and how the hazard would progress over time.
4. Provide an overall scene assessment.

Return JSON only:
{
  "enrichedCasualties": [{"id": "existing-id", "description": "...", "trueTag": "red|yellow|green|black", "observableSigns": {"breathing": "...", "pulse": "...", "consciousness": "...", "visibleInjuries": "...", "mobility": "...", "bleeding": "..."}}],
  "generatedCasualties": [{"id": "gen-1", "description": "...", "trueTag": "...", "observableSigns": {...}}],
  "hazardAnalysis": [{"hazardId": "...", "blastInteraction": "...", "secondaryEffects": ["..."], "progressionTimeline": "...", "riskLevel": "critical|high|medium|low"}],
  "overallAssessment": "Brief assessment of the scene complexity and key challenges for responders"
}`;

export async function enrichScene(
  req: SceneEnrichmentRequest,
  openAiApiKey: string,
): Promise<SceneEnrichmentResult> {
  const casualtiesNeedingEnrichment = req.casualtyPins.filter((c) => !c.description.trim());
  const noCasualties = req.casualtyPins.length === 0;

  const userPrompt = `Scene: ${req.incidentDescription}
Building: ${req.buildingName || 'Unknown'}
Blast radius: ${req.blastRadius}m
Exits: ${req.exitsCount}, Stairwells: ${req.stairwellsCount}
Evacuees: ${req.pedestrianCount}

${noCasualties ? `No casualty pins placed. Generate 8-15 realistic casualties distributed at various distances from the blast (0-100m range).` : `Casualties (${req.casualtyPins.length} total, ${casualtiesNeedingEnrichment.length} need descriptions):`}
${req.casualtyPins.map((c) => `  - ${c.id}: ${c.description || '[NEEDS DESCRIPTION]'} (tag: ${c.trueTag}, ${c.distanceFromBlast ? Math.round(c.distanceFromBlast) + 'm from blast' : 'unknown distance'}${c.nearbyHazards?.length ? ', near: ' + c.nearbyHazards.join(', ') : ''})`).join('\n')}

Hazards (${req.hazards.length}):
${req.hazards.map((h) => `  - ${h.id}: ${h.hazardType} (${h.severity}) at ${h.distanceFromBlast ? Math.round(h.distanceFromBlast) + 'm from blast' : 'unknown distance'}: ${h.description || 'no description'}`).join('\n') || '  None'}

Analyze and return JSON.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: ENRICHMENT_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 3000,
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, body: errBody }, 'Scene enrichment API failed');
      return defaultResult();
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, 'Scene enrichment response was not valid JSON');
      return defaultResult();
    }

    return JSON.parse(jsonMatch[0]) as SceneEnrichmentResult;
  } catch (err) {
    logger.error({ err }, 'Error in scene enrichment');
    return defaultResult();
  }
}

function defaultResult(): SceneEnrichmentResult {
  return {
    enrichedCasualties: [],
    generatedCasualties: [],
    hazardAnalysis: [],
    overallAssessment: 'Scene enrichment unavailable.',
  };
}
