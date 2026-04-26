import { logger } from '../lib/logger.js';
import {
  runEnvironmentalSimulation,
  type SimStud,
  type SimWall,
  type SimHazard,
} from './environmentalSimService.js';

// ── Shared constants ─────────────────────────────────────────────────────

const AI_MODEL = 'gpt-5.1';
const MAX_TOKENS = 16000;

// ── Input types ──────────────────────────────────────────────────────────

export interface CasualtyPinInput {
  id: string;
  pos: { x: number; y: number };
  description: string;
  trueTag: string;
  photos: string[];
  distanceFromBlast?: number;
  nearbyHazards?: string[];
  insideBuilding?: boolean;
  nearestExitId?: string;
  nearestExitDistance?: number;
}

export interface HazardInput {
  id: string;
  pos: { x: number; y: number };
  hazardType: string;
  severity: string;
  description: string;
  photos: string[];
  distanceFromBlast?: number;
  insideBuilding?: boolean;
  nearbyExits?: { id: string; status: string; distance: number }[];
  nearbyHazards?: { id: string; hazardType: string; distance: number }[];
  nearbyWallMaterials?: string[];
}

export interface ExitInput {
  id: string;
  status: string;
  description: string;
  width: number;
}

export interface WallInput {
  start: { x: number; y: number };
  end: { x: number; y: number };
  hasDoor: boolean;
  doorWidth: number;
  doorPosition: number;
  material: string;
}

export interface SceneEnrichmentRequest {
  incidentDescription: string;
  blastRadius: number;
  blastSite: { x: number; y: number } | null;
  casualtyPins: CasualtyPinInput[];
  hazards: HazardInput[];
  exits: ExitInput[];
  wallMaterials: string[];
  walls?: WallInput[];
  gameZones: { type: string; radius: number }[];
  buildingName: string | null;
  pedestrianCount: number;
  gameDurationMin?: number;
}

// ── Output types ─────────────────────────────────────────────────────────

export interface EnrichedCasualty {
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

export type SmokeGeneration = 'none' | 'light' | 'moderate' | 'heavy' | 'toxic';

export interface HazardEvent {
  triggerTimeSec: number;
  eventType: 'ignite' | 'rupture' | 'collapse' | 'flood' | 'arc' | 'explode';
  spreadType: 'fire' | 'gas' | 'flood' | 'structural_zone' | null;
  spreadRadius: number;
  spreadRate: number;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  smokeGeneration?: SmokeGeneration;
  smokeDescription?: string;
  affectedStuds?: string[];
}

export interface HazardStateProgression {
  initial: string;
  triggered: string;
  worsening: string;
  critical: string;
}

export interface HazardAnalysis {
  hazardId: string;
  identifiedMaterial: string;
  blastInteraction: string;
  secondaryEffects: string[];
  progressionTimeline: string;
  riskLevel: string;
  chainReactionRisk: string;
  responderGuidance: string;
  generatedDescription: string;
  events: HazardEvent[];
  hazardStates: HazardStateProgression;
}

export interface StudEnvironmentalEffect {
  stud_id: string;
  smoke_density: number;
  fire_intensity: number;
  gas_concentration: number;
  structural_damage: number;
  visibility_m: number;
}

export interface EnvironmentalSnapshot {
  at_minutes: number;
  stud_effects: StudEnvironmentalEffect[];
  narrative: string;
}

export interface SceneEnrichmentResult {
  enrichedCasualties: EnrichedCasualty[];
  generatedCasualties: EnrichedCasualty[];
  hazardAnalysis: HazardAnalysis[];
  overallAssessment: string;
  sceneSynthesis: {
    chainReactions: string[];
    escalationTimeline: string;
    keyChallenges: string[];
    casualtyDeteriorationRisks: string[];
    environmentalTimeline: EnvironmentalSnapshot[];
  };
}

// ── Per-hazard deep analysis ─────────────────────────────────────────────

const HAZARD_SYSTEM_PROMPT = `You are an expert in hazardous materials, blast effects, structural engineering, and emergency response. You are performing a deep analysis of a SINGLE hazard in a crisis management training scenario.

Analyze this hazard thoroughly considering:
1. What the material/substance is (identify from photos if available, or infer from the hazard type and environment)
2. How a blast wave at the given distance would interact with this hazard
3. How THIS SPECIFIC material would behave after blast interaction — only effects this material can physically produce
4. How the hazard would progress over time (minutes, hours)
5. Whether nearby hazards could cause chain reactions
6. What this means for responders — approach distance, PPE, decontamination needs
7. How wall materials in the vicinity affect fire/blast propagation

If photos are provided, analyze them carefully to identify the specific material, quantity, storage conditions, and containment state. Be specific — "20kg propane cylinder with valve exposed" is far better than "combustible material."

STRICT CONSTRAINT ON EVENTS — You must ONLY generate events and spread effects that the IDENTIFIED MATERIAL can physically produce:
- Wooden benches, paper, fabric, plastic → "fire" spread ONLY. These materials do NOT produce gas clouds, flooding, or structural collapse.
- Pressurized gas cylinders (propane, LPG, acetylene) → "gas" cloud first (from venting), then "fire" if ignited. NOT flooding or structural collapse.
- Chemical containers (acids, solvents, industrial chemicals) → "gas" (toxic fumes) and/or "fire". NOT flooding unless the chemical is a liquid in large volume.
- Water pipes, tanks, sprinkler systems → "flood" ONLY. NOT fire or gas.
- Load-bearing structural elements, heavy objects, weakened masonry → "structural_zone" ONLY. NOT fire or gas.
- Electrical panels, wiring, transformers → "fire" from arcing. NOT gas or flooding unless combined with water.
- DO NOT invent effects that require materials or conditions not present in this hazard.
- DO NOT add structural collapse zones unless this hazard IS a structural element.
- DO NOT add gas effects unless this hazard contains pressurized gas or volatile chemicals.

Determine what events this hazard will experience after the blast:
- At what second does the blast wave reach this hazard? (use distance / 340 m/s for blast wave, then add secondary effect delays)
- Does it rupture, ignite, collapse, flood, or arc?
- What spatial effect does each event produce? Options: "fire" (flame spread), "gas" (toxic/flammable gas cloud), "flood" (water/liquid release), "structural_zone" (collapse debris zone), or null (no spatial spread)
- How fast does that effect spread (meters per minute)?
- What initial radius does it affect?
- What are the state transitions this hazard goes through over time?
- What smoke does each event produce? Options: "none" (no smoke), "light" (thin haze), "moderate" (reduced visibility), "heavy" (near-zero visibility), "toxic" (heavy + chemical irritants). Only events involving combustion or chemical release produce smoke.
- If nearby stud IDs are provided, list which studs would be affected by each event based on the spread radius and direction.

Return JSON only:
{
  "identifiedMaterial": "specific identification from photo or best inference from type",
  "blastInteraction": "detailed analysis of blast-hazard interaction",
  "secondaryEffects": ["effect 1", "effect 2", ...],
  "progressionTimeline": "minute-by-minute progression over the first 30 minutes",
  "riskLevel": "critical|high|medium|low",
  "chainReactionRisk": "analysis of chain reaction potential with nearby hazards",
  "responderGuidance": "specific guidance for response teams approaching this hazard",
  "generatedDescription": "if trainer description was empty, a rich description of what this hazard is based on all available evidence",
  "events": [
    {
      "triggerTimeSec": 0,
      "eventType": "ignite|rupture|collapse|flood|arc|explode",
      "spreadType": "fire|gas|flood|structural_zone|null",
      "spreadRadius": 5,
      "spreadRate": 10,
      "smokeGeneration": "none|light|moderate|heavy|toxic",
      "smokeDescription": "what the smoke looks like and contains (e.g. thick black acrid smoke from burning plastics)",
      "affectedStuds": ["stud-id-1", "stud-id-2"],
      "description": "what happens at this moment",
      "severity": "low|medium|high|critical"
    }
  ],
  "hazardStates": {
    "initial": "state before blast (e.g. intact propane cylinder)",
    "triggered": "state immediately after blast interaction (e.g. valve sheared, gas venting)",
    "worsening": "state as situation deteriorates (e.g. gas cloud ignited, fireball)",
    "critical": "worst-case state (e.g. BLEVE imminent, tank failure)"
  }
}`;

interface NearbyStud {
  id: string;
  distance: number;
  spatialContext: string;
  blastBand?: string;
}

async function analyzeHazard(
  hazard: HazardInput,
  sceneContext: string,
  openAiApiKey: string,
  nearbyStuds?: NearbyStud[],
): Promise<HazardAnalysis> {
  const userContent: Array<{
    type: string;
    text?: string;
    image_url?: { url: string; detail?: string };
  }> = [];

  for (const photoUrl of hazard.photos) {
    if (photoUrl) {
      userContent.push({ type: 'image_url', image_url: { url: photoUrl, detail: 'high' } });
    }
  }

  const nearbyInfo = [];
  if (hazard.nearbyExits?.length) {
    nearbyInfo.push(
      `Nearby exits: ${hazard.nearbyExits.map((e) => `${e.id} (${e.status}, ${Math.round(e.distance)}m away)`).join(', ')}`,
    );
  }
  if (hazard.nearbyHazards?.length) {
    nearbyInfo.push(
      `Adjacent hazards: ${hazard.nearbyHazards.map((h) => `${h.hazardType} ${Math.round(h.distance)}m away`).join(', ')}`,
    );
  }
  if (hazard.nearbyWallMaterials?.length) {
    nearbyInfo.push(`Wall materials nearby: ${hazard.nearbyWallMaterials.join(', ')}`);
  }

  const studBlock = nearbyStuds?.length
    ? `\nNEARBY STUDS (snap-points in the building grid — use these IDs in affectedStuds for each event):\n${nearbyStuds.map((s) => `- ${s.id}: ${s.spatialContext}, ${Math.round(s.distance)}m from hazard${s.blastBand ? `, blast band: ${s.blastBand}` : ''}`).join('\n')}`
    : '';

  const promptText = `${sceneContext}

HAZARD TO ANALYZE:
- ID: ${hazard.id}
- Type: ${hazard.hazardType}
- Severity: ${hazard.severity}
- Trainer description: ${hazard.description || '[NONE PROVIDED — identify from photos or infer from type and environment]'}
- Distance from blast: ${hazard.distanceFromBlast != null ? `${Math.round(hazard.distanceFromBlast)}m` : 'unknown'}
- Location: ${hazard.insideBuilding ? 'INSIDE building' : 'OUTSIDE building'}
- Photos attached: ${hazard.photos.length}
${nearbyInfo.length ? '\nSPATIAL CONTEXT:\n' + nearbyInfo.join('\n') : ''}${studBlock}

Perform a thorough analysis and return JSON only.`;

  userContent.push({ type: 'text', text: promptText });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: HAZARD_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_completion_tokens: MAX_TOKENS,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error(
        { status: response.status, body: errBody, hazardId: hazard.id },
        'Hazard analysis API failed',
      );
      return defaultHazardAnalysis(hazard.id);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw, hazardId: hazard.id }, 'Hazard analysis response was not valid JSON');
      return defaultHazardAnalysis(hazard.id);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return { hazardId: hazard.id, ...parsed };
  } catch (err) {
    logger.error({ err, hazardId: hazard.id }, 'Error in per-hazard analysis');
    return defaultHazardAnalysis(hazard.id);
  }
}

function defaultHazardAnalysis(hazardId: string): HazardAnalysis {
  return {
    hazardId,
    identifiedMaterial: 'Unknown — analysis unavailable',
    blastInteraction: 'Analysis unavailable',
    secondaryEffects: [],
    progressionTimeline: 'Analysis unavailable',
    riskLevel: 'medium',
    chainReactionRisk: 'Analysis unavailable',
    responderGuidance: 'Standard precautions — analysis unavailable',
    generatedDescription: '',
    events: [],
    hazardStates: {
      initial: 'Unknown',
      triggered: 'Unknown',
      worsening: 'Unknown',
      critical: 'Unknown',
    },
  };
}

// ── Per-casualty deep analysis ───────────────────────────────────────────

const CASUALTY_SYSTEM_PROMPT = `You are an expert in blast injury patterns, trauma medicine, and the START triage protocol. You are generating a detailed injury profile for a SINGLE casualty in a crisis management training scenario.

Consider:
1. The casualty's distance from the blast — this is the primary determinant of injury severity
2. Nearby hazards and their effects (chemical burns, thermal burns, toxic inhalation, debris impact)
3. Whether the casualty is inside or outside the building (blast amplification, structural collapse, glass fragmentation)
4. The blast radius and what that implies about overpressure at this distance

Generate a medically realistic injury profile that training participants would need to triage. Include specific observable signs that a first responder could assess in the field.

Triage tags follow START protocol:
- RED (Immediate): Life-threatening but survivable with immediate intervention
- YELLOW (Delayed): Serious injuries but can wait 1-4 hours
- GREEN (Minor): Walking wounded
- BLACK (Expectant/Deceased): Non-survivable injuries or already dead

Return JSON only:
{
  "description": "detailed injury description appropriate for the distance and environment",
  "trueTag": "red|yellow|green|black",
  "observableSigns": {
    "breathing": "specific breathing pattern a responder would observe",
    "pulse": "pulse characteristics",
    "consciousness": "level of consciousness and responsiveness",
    "visibleInjuries": "what a responder can see",
    "mobility": "can this person move, walk, respond to commands",
    "bleeding": "type, location, and severity of any bleeding"
  }
}`;

async function analyzeCasualty(
  casualty: CasualtyPinInput,
  sceneContext: string,
  openAiApiKey: string,
): Promise<EnrichedCasualty> {
  const userContent: Array<{
    type: string;
    text?: string;
    image_url?: { url: string; detail?: string };
  }> = [];

  for (const photoUrl of casualty.photos) {
    if (photoUrl) {
      userContent.push({ type: 'image_url', image_url: { url: photoUrl, detail: 'high' } });
    }
  }

  const promptText = `${sceneContext}

CASUALTY TO ANALYZE:
- ID: ${casualty.id}
- Trainer description: ${casualty.description || '[NONE PROVIDED — generate based on distance and environment]'}
- Current tag: ${casualty.trueTag || 'untagged'}
- Distance from blast: ${casualty.distanceFromBlast != null ? `${Math.round(casualty.distanceFromBlast)}m` : 'unknown'}
- Location: ${casualty.insideBuilding ? 'INSIDE building (blast amplification, structural debris, glass fragmentation likely)' : 'OUTSIDE building'}
- Nearby hazards: ${casualty.nearbyHazards?.length ? casualty.nearbyHazards.join(', ') : 'none identified'}
- Nearest exit: ${casualty.nearestExitId ? `${casualty.nearestExitId} at ${Math.round(casualty.nearestExitDistance ?? 0)}m` : 'unknown'}
- Photos attached: ${casualty.photos.length}

${casualty.description ? 'The trainer has provided a description. Validate and enrich it with specific observable signs.' : 'No description provided. Generate a complete, medically realistic injury profile based on the distance from blast and environmental factors.'}

Return JSON only.`;

  userContent.push({ type: 'text', text: promptText });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: CASUALTY_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_completion_tokens: MAX_TOKENS,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error(
        { status: response.status, body: errBody, casualtyId: casualty.id },
        'Casualty analysis API failed',
      );
      return defaultCasualtyAnalysis(casualty.id);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(
        { raw, casualtyId: casualty.id },
        'Casualty analysis response was not valid JSON',
      );
      return defaultCasualtyAnalysis(casualty.id);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return { id: casualty.id, ...parsed };
  } catch (err) {
    logger.error({ err, casualtyId: casualty.id }, 'Error in per-casualty analysis');
    return defaultCasualtyAnalysis(casualty.id);
  }
}

function defaultCasualtyAnalysis(id: string): EnrichedCasualty {
  return {
    id,
    description: 'Injury profile unavailable — analysis error.',
    trueTag: 'yellow',
    observableSigns: {
      breathing: 'Unknown',
      pulse: 'Unknown',
      consciousness: 'Unknown',
      visibleInjuries: 'Unknown',
      mobility: 'Unknown',
      bleeding: 'Unknown',
    },
  };
}

// ── Synthesis call ───────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are a senior emergency management consultant synthesizing the complete analysis of a crisis training scenario. You have received individual deep-dive analyses for each hazard and each casualty. Now produce a unified scene synthesis.

Consider:
1. Chain reactions between hazards — which hazards would trigger or worsen others
2. Escalation timeline — how the scene changes over the first 60 minutes (fire spread, smoke filling corridors, gas clouds expanding, structural weakening). Describe this as a narrative.
3. Key challenges for each response discipline (medical, fire, bomb squad, command)
4. Which casualties will deteriorate if not treated promptly, based on their proximity to progressing hazards
5. Bottlenecks — exits that are compromised, routes blocked by hazards or smoke
6. Resource prioritization — what must happen first, second, third

Also: if no casualty pins were placed by the trainer, generate realistic casualties distributed at various distances from the blast (0-100m). The number of casualties should be proportional to the crowd size (given in EVACUEES count). Use the hazard analysis results to inform what additional injuries these generated casualties might have. Include a realistic distribution of triage tags (red/yellow/green/black) based on proximity to blast.

NOTE: The stud-level environmental timeline (fire/smoke/gas per stud over time) is computed separately by a deterministic simulation engine. You do NOT need to produce stud-level data. Focus on the narrative escalation timeline and strategic analysis.

Return JSON only:
{
  "chainReactions": ["description of chain reaction 1", ...],
  "escalationTimeline": "minute-by-minute narrative progression for the first 60 minutes — describe how fire, smoke, gas, and structural damage evolve and what this means for responders",
  "keyChallenges": ["challenge 1", "challenge 2", ...],
  "casualtyDeteriorationRisks": ["which casualties will worsen and why", ...],
  "generatedCasualties": [{"id": "gen-1", "description": "...", "trueTag": "red|yellow|green|black", "observableSigns": {"breathing": "...", "pulse": "...", "consciousness": "...", "visibleInjuries": "...", "mobility": "...", "bleeding": "..."}}],
  "overallAssessment": "comprehensive assessment of the scene — complexity, resource requirements, critical decision points for the incident commander"
}`;

interface SynthesisResult {
  chainReactions: string[];
  escalationTimeline: string;
  keyChallenges: string[];
  casualtyDeteriorationRisks: string[];
  generatedCasualties: EnrichedCasualty[];
  overallAssessment: string;
}

async function synthesizeScene(
  sceneContext: string,
  hazardResults: HazardAnalysis[],
  casualtyResults: EnrichedCasualty[],
  noCasualtiesPlaced: boolean,
  openAiApiKey: string,
  studSummary?: string,
  pedestrianCount?: number,
): Promise<SynthesisResult> {
  const hazardSummary = hazardResults
    .map((h) => {
      const eventDetails = h.events?.length
        ? h.events
            .map(
              (e) =>
                `    T+${e.triggerTimeSec}s: ${e.eventType} → ${e.spreadType || 'none'} (smoke: ${e.smokeGeneration || 'none'})${e.affectedStuds?.length ? ` [studs: ${e.affectedStuds.join(', ')}]` : ''}`,
            )
            .join('\n')
        : '    No events predicted';
      return `- ${h.hazardId}: ${h.identifiedMaterial} (${h.riskLevel})\n  Blast interaction: ${h.blastInteraction}\n  Secondary effects: ${h.secondaryEffects.join(', ')}\n  Timeline: ${h.progressionTimeline}\n  Chain risk: ${h.chainReactionRisk}\n  Events:\n${eventDetails}`;
    })
    .join('\n\n');

  const casualtySummary = casualtyResults
    .map(
      (c) =>
        `- ${c.id}: ${c.trueTag.toUpperCase()} — ${c.description}\n  Breathing: ${c.observableSigns.breathing} | Mobility: ${c.observableSigns.mobility}`,
    )
    .join('\n');

  const studBlock = studSummary
    ? `\n═══ BUILDING STUDS (snap-points for environmental timeline) ═══\n${studSummary}\n`
    : '';

  const promptText = `${sceneContext}

═══ INDIVIDUAL HAZARD ANALYSES ═══
${hazardSummary || 'No hazards on scene.'}

═══ INDIVIDUAL CASUALTY PROFILES ═══
${
  casualtySummary ||
  (noCasualtiesPlaced
    ? (() => {
        const pc = pedestrianCount ?? 120;
        const [minC, maxC] =
          pc > 1000 ? [40, 80] : pc > 500 ? [25, 50] : pc > 200 ? [15, 30] : [8, 15];
        return `No casualty pins placed by trainer. The venue has approximately ${pc} people present. You must generate ${minC}-${maxC} realistic casualties distributed across the blast zones at varying distances (0-100m). Scale injuries by proximity to blast.

MANDATORY TRIAGE TAG DISTRIBUTION FOR BOMBING/EXPLOSION:
- At least 15-20% MUST be BLACK (deceased) — people at ground zero DO NOT survive an explosion
- At least 25-30% MUST be RED (immediate/critical) — severe blast injuries, burns, amputations
- Remaining split between YELLOW (delayed) and GREEN (minor)
- Casualties within 0-5m of blast center MUST ALL be BLACK
- Casualties within 5-15m should be mostly RED with some BLACK
- You MUST include BLACK casualties. A bombing without fatalities is unrealistic.`;
      })()
    : 'No casualties analyzed.')
}
${studBlock}
Synthesize all findings into a unified scene analysis. Include an environmentalTimeline showing how fire, smoke, gas, and structural damage affect specific studs over 30 minutes. Return JSON only.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
          { role: 'user', content: promptText },
        ],
        max_completion_tokens: MAX_TOKENS,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, body: errBody }, 'Synthesis API failed');
      return defaultSynthesis();
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, 'Synthesis response was not valid JSON');
      return defaultSynthesis();
    }

    return JSON.parse(jsonMatch[0]) as SynthesisResult;
  } catch (err) {
    logger.error({ err }, 'Error in scene synthesis');
    return defaultSynthesis();
  }
}

function defaultSynthesis(): SynthesisResult {
  return {
    chainReactions: [],
    escalationTimeline: 'Analysis unavailable.',
    keyChallenges: [],
    casualtyDeteriorationRisks: [],
    generatedCasualties: [],
    overallAssessment: 'Scene synthesis unavailable.',
  };
}

// ── Spatial context computation ──────────────────────────────────────────

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function computeSpatialContext(req: SceneEnrichmentRequest): void {
  const { blastSite, hazards, casualtyPins } = req;

  for (const h of hazards) {
    if (blastSite && h.distanceFromBlast == null) {
      h.distanceFromBlast = dist(h.pos, blastSite);
    }
    h.nearbyHazards = hazards
      .filter((other) => other.id !== h.id)
      .map((other) => ({
        id: other.id,
        hazardType: other.hazardType,
        distance: dist(h.pos, other.pos),
      }))
      .filter((nh) => nh.distance < 80)
      .sort((a, b) => a.distance - b.distance);
  }

  for (const c of casualtyPins) {
    if (blastSite && c.distanceFromBlast == null) {
      c.distanceFromBlast = dist(c.pos, blastSite);
    }
    c.nearbyHazards = hazards
      .filter((h) => dist(h.pos, c.pos) < 60)
      .map((h) => `${h.hazardType} (${h.severity}) ${Math.round(dist(h.pos, c.pos))}m away`);
  }
}

// ── Build shared scene context string ────────────────────────────────────

function buildSceneContext(req: SceneEnrichmentRequest): string {
  const exitInfo = req.exits.length
    ? req.exits
        .map(
          (e) =>
            `  ${e.id}: ${e.status}, width ${e.width}m${e.description ? ' — ' + e.description : ''}`,
        )
        .join('\n')
    : '  No exits defined';

  const zoneInfo = req.gameZones.length
    ? req.gameZones.map((z) => `  ${z.type}: ${z.radius}m radius`).join('\n')
    : '  No zones defined';

  return `INCIDENT: ${req.incidentDescription}
BUILDING: ${req.buildingName || 'Unknown structure'}
BLAST RADIUS: ${req.blastRadius}m
EVACUEES: ${req.pedestrianCount}

EXITS:
${exitInfo}

OPERATIONAL ZONES:
${zoneInfo}

WALL MATERIALS: ${req.wallMaterials.length ? req.wallMaterials.join(', ') : 'Unknown'}

TOTAL HAZARDS ON SCENE: ${req.hazards.length}
TOTAL CASUALTY PINS: ${req.casualtyPins.length}`;
}

// ── Main enrichment orchestrator (fan-out / fan-in) ──────────────────────

export interface ProjectedStud {
  id: string;
  simPos: { x: number; y: number };
  spatialContext: string | null;
  blastBand?: string;
  distFromIncidentM?: number;
}

function projectStudsToSimSpace(
  studGrids: Array<{
    studs: Array<{
      id: string;
      lat: number;
      lng: number;
      spatialContext?: string;
      blastBand?: string;
      distFromIncidentM?: number;
    }>;
  }>,
  buildingPolygon: [number, number][],
): ProjectedStud[] {
  if (!buildingPolygon.length) return [];
  const refLat = buildingPolygon.reduce((s, p) => s + p[0], 0) / buildingPolygon.length;
  const refLng = buildingPolygon.reduce((s, p) => s + p[1], 0) / buildingPolygon.length;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);

  const projected: ProjectedStud[] = [];
  for (const grid of studGrids) {
    for (const stud of grid.studs) {
      projected.push({
        id: stud.id,
        simPos: {
          x: (stud.lng - refLng) * mPerDegLng,
          y: (refLat - stud.lat) * mPerDegLat,
        },
        spatialContext: stud.spatialContext || null,
        blastBand: stud.blastBand,
        distFromIncidentM: stud.distFromIncidentM,
      });
    }
  }
  return projected;
}

export async function enrichScene(
  req: SceneEnrichmentRequest,
  openAiApiKey: string,
  studGrids?: Array<{
    studs: Array<{
      id: string;
      lat: number;
      lng: number;
      spatialContext?: string;
      blastBand?: string;
      distFromIncidentM?: number;
    }>;
  }>,
  buildingPolygon?: [number, number][],
): Promise<SceneEnrichmentResult> {
  computeSpatialContext(req);
  const sceneContext = buildSceneContext(req);
  const noCasualties = req.casualtyPins.length === 0;

  // Project studs from lat/lng to sim-space meters (same frame as hazards/blast)
  const projectedStuds =
    studGrids && buildingPolygon ? projectStudsToSimSpace(studGrids, buildingPolygon) : [];

  // Pre-compute nearby studs for each hazard using sim-space distances
  const NEARBY_STUD_RADIUS = 30;
  const hazardStudMap = new Map<string, NearbyStud[]>();
  if (projectedStuds.length > 0) {
    for (const h of req.hazards) {
      const nearby: NearbyStud[] = [];
      for (const stud of projectedStuds) {
        const d = Math.hypot(stud.simPos.x - h.pos.x, stud.simPos.y - h.pos.y);
        if (d <= NEARBY_STUD_RADIUS) {
          nearby.push({
            id: stud.id,
            distance: Math.round(d),
            spatialContext: stud.spatialContext || 'unknown',
            blastBand: stud.blastBand,
          });
        }
      }
      nearby.sort((a, b) => a.distance - b.distance);
      hazardStudMap.set(h.id, nearby.slice(0, 20));
    }
  }

  // Build a stud summary for the synthesis prompt
  const studSummary =
    projectedStuds.length > 0
      ? projectedStuds
          .slice(0, 40)
          .map(
            (s) =>
              `${s.id}: ${s.spatialContext || 'unknown'}${s.blastBand ? `, blast: ${s.blastBand}` : ''}${s.distFromIncidentM != null ? `, ${Math.round(s.distFromIncidentM)}m from blast` : ''}`,
          )
          .join('\n')
      : undefined;

  logger.info(
    {
      hazards: req.hazards.length,
      casualties: req.casualtyPins.length,
      studs: projectedStuds.length,
    },
    'Starting fan-out scene enrichment',
  );

  // Phase 1: parallel per-element deep dives
  const [hazardResults, casualtyResults] = await Promise.all([
    Promise.allSettled(
      req.hazards.map((h) => analyzeHazard(h, sceneContext, openAiApiKey, hazardStudMap.get(h.id))),
    ).then((results) =>
      results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : defaultHazardAnalysis(req.hazards[i].id),
      ),
    ),
    Promise.allSettled(
      req.casualtyPins
        .filter((c) => !c.description.trim() || c.photos.length > 0)
        .map((c) => analyzeCasualty(c, sceneContext, openAiApiKey)),
    ).then((results) => {
      const needingAnalysis = req.casualtyPins.filter(
        (c) => !c.description.trim() || c.photos.length > 0,
      );
      return results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : defaultCasualtyAnalysis(needingAnalysis[i].id),
      );
    }),
  ]);

  // Merge casualties that already had descriptions (no analysis needed)
  const alreadyDescribed: EnrichedCasualty[] = req.casualtyPins
    .filter((c) => c.description.trim() && c.photos.length === 0)
    .map((c) => ({
      id: c.id,
      description: c.description,
      trueTag: c.trueTag,
      observableSigns: {
        breathing: '',
        pulse: '',
        consciousness: '',
        visibleInjuries: '',
        mobility: '',
        bleeding: '',
      },
    }));

  const allCasualties = [...casualtyResults, ...alreadyDescribed];

  logger.info(
    {
      hazardAnalyses: hazardResults.length,
      casualtyAnalyses: casualtyResults.length,
      passthrough: alreadyDescribed.length,
    },
    'Phase 1 complete',
  );

  // Phase 1.5: Deterministic environmental simulation using AI hazard parameters
  let engineTimeline: EnvironmentalSnapshot[] = [];
  if (projectedStuds.length > 0 && hazardResults.some((h) => h.events?.length > 0)) {
    const simStuds: SimStud[] = projectedStuds.map((s) => ({
      id: s.id,
      simPos: s.simPos,
      spatialContext: s.spatialContext,
    }));

    const simWalls: SimWall[] = (req.walls ?? []).map((w) => ({
      start: w.start,
      end: w.end,
      hasDoor: w.hasDoor,
      doorWidth: w.doorWidth,
      doorPosition: w.doorPosition,
      material: w.material,
    }));

    const simHazards: SimHazard[] = req.hazards.map((h) => ({
      id: h.id,
      pos: h.pos,
      radius: 5,
      hazardType: h.hazardType,
    }));

    engineTimeline = runEnvironmentalSimulation(
      simStuds,
      simWalls,
      simHazards,
      hazardResults,
      req.gameDurationMin || 60,
    );

    logger.info(
      {
        snapshots: engineTimeline.length,
        maxAffected: engineTimeline.reduce((m, s) => Math.max(m, s.stud_effects.length), 0),
      },
      'Environmental simulation complete, starting synthesis',
    );
  } else {
    logger.info(
      'No studs or hazard events — skipping environmental simulation, starting synthesis',
    );
  }

  // Phase 2: AI synthesis (narrative overview; engine provides the authoritative timeline)
  const synthesis = await synthesizeScene(
    sceneContext,
    hazardResults,
    allCasualties,
    noCasualties,
    openAiApiKey,
    studSummary,
    req.pedestrianCount,
  );

  return {
    enrichedCasualties: allCasualties,
    generatedCasualties: synthesis.generatedCasualties || [],
    hazardAnalysis: hazardResults,
    overallAssessment: synthesis.overallAssessment || 'Assessment unavailable.',
    sceneSynthesis: {
      chainReactions: synthesis.chainReactions || [],
      escalationTimeline: synthesis.escalationTimeline || '',
      keyChallenges: synthesis.keyChallenges || [],
      casualtyDeteriorationRisks: synthesis.casualtyDeteriorationRisks || [],
      environmentalTimeline: engineTimeline,
    },
  };
}

// ── Fire parameter calibration ──────────────────────────────────────────

export interface FireCalibrationRequest {
  incidentDescription: string;
  buildingName: string | null;
  hazards: Array<{
    hazardType: string;
    severity: string;
    description: string;
    photos: string[];
  }>;
  wallMaterials: string[];
  blastRadius: number;
}

export interface CalibratedFireParams {
  baseSpreadRate: number;
  burnDuration: number;
  heatTransferRate: number;
  wallResistance: Record<string, number>;
  hazardAcceleration: Record<string, number>;
  reasoning: string;
}

const FIRE_CALIBRATION_PROMPT = `You are a fire engineering expert calibrating a fire spread simulation for a crisis management training scenario. Based on the scene description, hazardous materials, and building construction, generate realistic fire spread parameters.

Consider:
1. The specific materials present (identified from descriptions/photos) — propane spreads fire differently than paper
2. Building construction and ventilation characteristics
3. Interaction between multiple hazards (e.g. accelerants near ignition sources)
4. Fire engineering research (NFPA, ISO 834 standards)

Return JSON only:
{
  "baseSpreadRate": <seconds for fire to spread 5m to a neighbor cell in a furnished building>,
  "burnDuration": <seconds a 5m cell burns before exhausting fuel>,
  "heatTransferRate": <seconds of radiant heat exposure before ignition>,
  "wallResistance": {
    "<material>": <seconds of fire resistance, use 999999 for fireproof materials>
  },
  "hazardAcceleration": {
    "<hazardType>": <multiplier: 1.0 = normal, higher = faster ignition>
  },
  "reasoning": "Brief explanation of why these parameters were chosen for this specific scene"
}`;

export async function calibrateFireParams(
  req: FireCalibrationRequest,
  openAiApiKey: string,
): Promise<CalibratedFireParams> {
  const userContent: Array<{
    type: string;
    text?: string;
    image_url?: { url: string; detail?: string };
  }> = [];

  for (const h of req.hazards) {
    for (const photoUrl of h.photos) {
      if (photoUrl) {
        userContent.push({ type: 'image_url', image_url: { url: photoUrl, detail: 'high' } });
      }
    }
  }

  const hazardList = req.hazards.length
    ? req.hazards
        .map(
          (h) => `- ${h.hazardType} (${h.severity}): ${h.description || 'no description provided'}`,
        )
        .join('\n')
    : '  No hazards placed';

  const promptText = `INCIDENT: ${req.incidentDescription}
BUILDING: ${req.buildingName || 'Unknown structure'}
BLAST RADIUS: ${req.blastRadius}m

HAZARDOUS MATERIALS ON SCENE:
${hazardList}

WALL MATERIALS IN BUILDING: ${req.wallMaterials.length ? req.wallMaterials.join(', ') : 'Unknown'}

Calibrate fire spread parameters for this specific scene. Return JSON only.`;

  userContent.push({ type: 'text', text: promptText });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: FIRE_CALIBRATION_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_completion_tokens: MAX_TOKENS,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error({ status: response.status, body: errBody }, 'Fire calibration API failed');
      return defaultFireParams();
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, 'Fire calibration response was not valid JSON');
      return defaultFireParams();
    }

    return JSON.parse(jsonMatch[0]) as CalibratedFireParams;
  } catch (err) {
    logger.error({ err }, 'Error in fire parameter calibration');
    return defaultFireParams();
  }
}

function defaultFireParams(): CalibratedFireParams {
  return {
    baseSpreadRate: 30,
    burnDuration: 300,
    heatTransferRate: 15,
    wallResistance: {
      concrete: 999999,
      drywall: 1200,
      glass: 120,
      wood: 600,
      metal: 1800,
      '': 900,
    },
    hazardAcceleration: { combustible: 3, ignitable: 5, chemical: 4, electrical: 2 },
    reasoning: 'Default parameters — AI calibration unavailable.',
  };
}
