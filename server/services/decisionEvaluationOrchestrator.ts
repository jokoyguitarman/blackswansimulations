/**
 * Split Decision Evaluation Orchestrator
 *
 * Replaces the monolithic evaluateDecisionAgainstEnvironment with 7 focused
 * single-responsibility evaluators, each with its own small prompt and only
 * the context data it needs.
 *
 * Architecture:
 *   Gate:     evaluateSafetyGuardrails (runs first — can reject outright)
 *   Parallel: evaluateSpecificity, evaluateStandardsCompliance,
 *             evaluateInfrastructureReadiness, evaluateCasualtyTreatment,
 *             evaluateZoneSafety, evaluateHazardResponse
 *   Merge:    aggregateEvaluations → EnvironmentalConsistencyResult
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import {
  type EnvironmentalConsistencyResult,
  type EnvironmentalConsistencySeverity,
  type EnvironmentalMismatchKind,
  type EnvironmentalConsistencyErrorType,
  resolveTeamDoctrines,
  buildInfrastructureContext,
  buildCasualtyContext,
  buildHazardSafetyContext,
  buildFacilityChallengesContext,
} from './environmentalConsistencyService.js';
import {
  standardsToPromptBlock,
  forbiddenActionsToPromptBlock,
  type ForbiddenAction,
  type StandardsFinding,
} from './warroomResearchService.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DecisionInput {
  id: string;
  title: string;
  description: string;
  type: string | null;
}

interface IncidentContext {
  title: string;
  description: string;
  response_type?: string;
}

interface EvaluatorResult {
  evaluator: string;
  consistent: boolean;
  severity?: EnvironmentalConsistencySeverity;
  mismatch_kind?: EnvironmentalMismatchKind;
  error_type?: EnvironmentalConsistencyErrorType;
  reason?: string;
  consequence_title?: string;
  specific?: boolean;
  missing_details?: string[];
  feedback?: string;
  rejected?: boolean;
  rejection_reason?: string;
  skipped?: boolean;
  latencyMs?: number;
}

// ─── Universal forbidden actions baseline ────────────────────────────────────

export const UNIVERSAL_FORBIDDEN_ACTIONS: ForbiddenAction[] = [
  {
    action: 'Intentionally cause harm to civilians or responders',
    why: 'Violates fundamental duty of care in all emergency response',
    exception: null,
  },
  {
    action: 'Order emergency services to stand down without proper authority',
    why: 'Only the Incident Commander can authorize stand-down',
    exception: 'IC ordering tactical withdrawal for safety reasons',
  },
  {
    action: 'Impersonate emergency services or misrepresent team identity',
    why: 'Undermines command structure and public trust',
    exception: null,
  },
  {
    action: 'Deliberately endanger civilians',
    why: 'Violates duty of care and potentially criminal',
    exception: null,
  },
];

// ─── LLM call helper ────────────────────────────────────────────────────────

const EVAL_MODEL = 'gpt-4o-mini';
const EVAL_TEMPERATURE = 0.2;
const EVAL_MAX_TOKENS = 2048;

async function callEvaluatorLLM(
  openAiApiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<Record<string, unknown> | null> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: EVAL_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: EVAL_TEMPERATURE,
      max_tokens: EVAL_MAX_TOKENS,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return JSON.parse(content) as Record<string, unknown>;
}

function parseEvaluatorOutput(
  evaluator: string,
  parsed: Record<string, unknown> | null,
): EvaluatorResult {
  if (!parsed) {
    return { evaluator, consistent: true, specific: true, skipped: true };
  }

  const result: EvaluatorResult = {
    evaluator,
    consistent: parsed.consistent !== false,
    specific: parsed.specific !== false,
  };

  if (parsed.rejected === true) {
    result.rejected = true;
    result.consistent = false;
    result.severity = 'high';
    result.mismatch_kind = 'contradiction';
    if (typeof parsed.rejection_reason === 'string')
      result.rejection_reason = parsed.rejection_reason.trim();
    if (typeof parsed.consequence_title === 'string')
      result.consequence_title = parsed.consequence_title.trim();
    return result;
  }

  if (!result.consistent) {
    const rawKind = (typeof parsed.mismatch_kind === 'string' ? parsed.mismatch_kind : '')
      .toLowerCase()
      .trim()
      .replace(/[\s-]+/g, '_');
    result.mismatch_kind =
      rawKind === 'below_standard'
        ? 'below_standard'
        : rawKind === 'infrastructure_gap'
          ? 'infrastructure_gap'
          : 'contradiction';

    result.severity = ['low', 'medium', 'high'].includes(String(parsed.severity))
      ? (parsed.severity as EnvironmentalConsistencySeverity)
      : 'medium';

    if (result.mismatch_kind === 'below_standard' && result.severity === 'high') {
      result.severity = 'medium';
    }

    result.error_type = ['capacity', 'location', 'flow', 'space_contention', 'other'].includes(
      String(parsed.error_type),
    )
      ? (parsed.error_type as EnvironmentalConsistencyErrorType)
      : 'other';

    result.reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 500)
        : 'Decision does not meet professional response standards.';

    if (typeof parsed.consequence_title === 'string' && parsed.consequence_title.trim())
      result.consequence_title = parsed.consequence_title.trim();
  }

  if (result.specific === false) {
    if (Array.isArray(parsed.missing_details))
      result.missing_details = (parsed.missing_details as unknown[]).filter(
        (d): d is string => typeof d === 'string',
      );
    if (typeof parsed.feedback === 'string' && parsed.feedback.trim())
      result.feedback = parsed.feedback.trim();
    if (typeof parsed.consequence_title === 'string' && parsed.consequence_title.trim())
      result.consequence_title = parsed.consequence_title.trim();
  }

  return result;
}

// ─── JSON output format (shared across evaluators) ──────────────────────────

const JSON_OUTPUT_FORMAT = `Return ONLY valid JSON:
{
  "rejected": boolean,
  "rejection_reason": "..." (only if rejected),
  "consistent": boolean,
  "mismatch_kind": "contradiction"|"below_standard"|"infrastructure_gap" (only if consistent is false),
  "severity": "low"|"medium"|"high" (only if consistent is false),
  "error_type": "other" (only if consistent is false),
  "reason": "..." (only if consistent is false — in-world consequence),
  "consequence_title": "..." (when consistent is false OR specific is false),
  "specific": boolean,
  "missing_details": ["..."] (only if specific is false),
  "feedback": "..." (only if specific is false — in-world consequence)
}`;

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 7: Safety Guardrails (gate — runs first)
// ═══════════════════════════════════════════════════════════════════════════════

async function evaluateSafetyGuardrails(
  decision: DecisionInput,
  openAiApiKey: string,
  forbiddenBlock: string,
  teamName?: string,
): Promise<EvaluatorResult> {
  const t0 = Date.now();

  const systemPrompt = `You are a safety guardrails evaluator for a crisis management training exercise.

Your ONLY job is to check whether this decision proposes a FORBIDDEN action. You are NOT evaluating quality, specificity, or standards compliance — only safety.

${forbiddenBlock || 'No team-specific forbidden actions defined. Apply universal safety rules: no intentionally harming people, no impersonating emergency services, no deliberately endangering civilians, no unauthorized stand-down orders.'}

Non-EOD teams directly handling, detonating, disarming, or triggering explosive devices is FORBIDDEN. Bomb Squad / EOD teams ARE authorized to perform render-safe procedures via robot or approved RSP methods. Contacting or requesting bomb disposal teams is ALLOWED for all teams.

TEAM ROLE: ${teamName || 'Unknown'}

If the decision proposes a forbidden action, set "rejected": true with an in-world "rejection_reason" explaining why this action cannot be carried out.
If the decision is safe, set "rejected": false, "consistent": true, "specific": true.

${JSON_OUTPUT_FORMAT}`;

  const userPrompt = `DECISION:
Title: ${decision.title}
Description: ${decision.description}

Check this decision against the forbidden actions list. Return JSON only.`;

  try {
    const parsed = await callEvaluatorLLM(openAiApiKey, systemPrompt, userPrompt);
    const result = parseEvaluatorOutput('safety_guardrails', parsed);
    result.latencyMs = Date.now() - t0;
    return result;
  } catch (err) {
    logger.warn({ err, decisionId: decision.id }, 'evaluateSafetyGuardrails failed');
    return {
      evaluator: 'safety_guardrails',
      consistent: true,
      specific: true,
      latencyMs: Date.now() - t0,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 1: Operational Specificity
// ═══════════════════════════════════════════════════════════════════════════════

async function evaluateSpecificity(
  decision: DecisionInput,
  openAiApiKey: string,
  teamName?: string,
  incident?: IncidentContext | null,
  escalationLevel?: number,
): Promise<EvaluatorResult> {
  const t0 = Date.now();
  const esc = escalationLevel ?? 0;

  const incidentBlock =
    incident?.title || incident?.description
      ? `\nTRIGGER INJECT (this decision is in response to):\nTitle: ${incident.title ?? ''}\nDescription: ${incident.description ?? ''}\nresponse_type: ${incident.response_type ?? 'standard'}\n`
      : '';

  const systemPrompt = `You are an operational specificity evaluator for a crisis management training exercise. Evaluate whether this decision is OPERATIONALLY SPECIFIC enough to be executed on the ground.

TEAM ROLE: ${teamName || 'Unknown'}
ESCALATION LEVEL: ${esc} (${esc === 0 ? 'first offence — minor operational friction' : esc === 1 ? 'second offence — significant in-world problems' : 'third+ offence — critical in-world damage and casualties'})

Specificity requirements by team role:
- Evacuation: specific exit names/IDs, flow control method, marshal-to-evacuee ratios, staging/assembly areas, ground zero perimeter distance, phased evacuation order if applicable
- Medical Triage: named triage zones/areas, triage protocol (e.g. START, SALT, Triage Sieve), staff-to-patient ratios, casualty categorisation zones (Red/Yellow/Green), transport priorities and destination hospitals
- Media & Communications: evaluate based on the TYPE of media decision:
  • PUBLIC STATEMENT / PRESS RELEASE: Must contain specific, accurate content — incident details, verified numbers, named locations, actions being taken. A statement with accurate figures and clear facts IS specific even without naming a spokesperson. Set specific: true if the statement contains verifiable facts.
  • MEDIA INFRASTRUCTURE SETUP: Must name WHO the spokesperson is, WHERE the media area is, WHAT the update cadence is.
  • SPOKESPERSON ASSIGNMENT: Must explain WHY this person is suited — authority level, crisis-communication training, credibility.
  • CAMERA / BROADCAST POSITIONING: Must protect victim dignity, avoid revealing tactical positions.
  • MISINFORMATION RESPONSE: Must name the false claim and provide correct information.
  Do NOT require spokesperson names, press conference locations, or update frequencies on EVERY media decision.
- Hazard Response: specific equipment type and class, trained personnel, approach method, safety perimeter
- Bomb Squad / EOD: robot assessment before approach, correct disruptor type for container material, exclusion zone radius, comms blackout, X-ray before RSP

UNAUTHORIZED PUBLIC COMMUNICATION (applies to ALL non-media teams):
If the responding team is NOT the media/communications team AND the trigger inject has response_type "media_statement", check whether the decision constitutes a direct public-facing statement. If a non-media team is issuing its own public statement, set consistent: false, mismatch_kind: "contradiction", severity: "high".

Set "specific": false when the decision gives general/vague instructions without naming concrete details. Set "specific": true when the decision names enough specifics to be executed.

When "specific" is false:
- "missing_details": array of 2-5 short phrases
- "feedback": one paragraph (2-4 sentences) — in-world consequence narrative matching ESCALATION LEVEL. Reference the actual scenario — do NOT be generic. NEVER tell the player what to do.
- "consequence_title": short (3-8 word) in-world headline

For infrastructure setup decisions (establishing command posts, triage areas, cordons), feedback can be constructive when the decision includes coordinates, personnel, and equipment details.

${JSON_OUTPUT_FORMAT}`;

  const userPrompt = `${incidentBlock}
DECISION:
Title: ${decision.title}
Description: ${decision.description}

Evaluate operational specificity. ALL "reason" and "feedback" text must be IN-WORLD CONSEQUENCES only. Return JSON only.`;

  try {
    const parsed = await callEvaluatorLLM(openAiApiKey, systemPrompt, userPrompt);
    const result = parseEvaluatorOutput('specificity', parsed);
    result.latencyMs = Date.now() - t0;
    return result;
  } catch (err) {
    logger.warn({ err, decisionId: decision.id }, 'evaluateSpecificity failed');
    return {
      evaluator: 'specificity',
      consistent: true,
      specific: true,
      latencyMs: Date.now() - t0,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 2: Standards Compliance
// ═══════════════════════════════════════════════════════════════════════════════

async function evaluateStandardsCompliance(
  decision: DecisionInput,
  openAiApiKey: string,
  sectorStandards: string,
  teamName?: string,
  escalationLevel?: number,
): Promise<EvaluatorResult> {
  const t0 = Date.now();
  const esc = escalationLevel ?? 0;

  if (!sectorStandards) {
    return {
      evaluator: 'standards_compliance',
      consistent: true,
      specific: true,
      skipped: true,
      latencyMs: 0,
    };
  }

  const systemPrompt = `You are a professional standards compliance evaluator for a crisis management training exercise.

TEAM ROLE: ${teamName || 'Unknown'}
ESCALATION LEVEL: ${esc}

Evaluate whether this decision meets the sector-specific professional standards and doctrines provided.

Rules:
- consistent: false with mismatch_kind "below_standard" when the approach falls short of professional standards
- consistent: false with mismatch_kind "contradiction" when the decision proposes something directly wrong or dangerous per the standards
- consistent: true when the decision follows or reasonably approximates the standards
- severity: "low" = minor shortfall; "medium" = significant gap; "high" = dangerous deviation
- reason: when consistent is false, write an IN-WORLD CONSEQUENCE — describe what is happening on the ground. Match the ESCALATION LEVEL.
- consequence_title: short (3-8 word) in-world headline

HAZARD RESPONSE SPECIFICS:
- A response that proposes incorrect equipment or procedures (e.g. water on Class B/electrical fire, improvised tools instead of professional equipment) = mismatch_kind "contradiction"
- Improvised civilian methods when professional equipment is specified = mismatch_kind "below_standard" (or "contradiction" if it could worsen the hazard)
- Fire response MUST involve calling the fire service OR using professional fire suppression equipment. Civilian improvisation does NOT meet standards.

${JSON_OUTPUT_FORMAT}`;

  const userPrompt = `Sector standards / team doctrines:
${sectorStandards}

DECISION:
Title: ${decision.title}
Description: ${decision.description}

Evaluate against professional standards. ALL text must be IN-WORLD CONSEQUENCES only. Return JSON only.`;

  try {
    const parsed = await callEvaluatorLLM(openAiApiKey, systemPrompt, userPrompt);
    const result = parseEvaluatorOutput('standards_compliance', parsed);
    result.latencyMs = Date.now() - t0;
    return result;
  } catch (err) {
    logger.warn({ err, decisionId: decision.id }, 'evaluateStandardsCompliance failed');
    return {
      evaluator: 'standards_compliance',
      consistent: true,
      specific: true,
      latencyMs: Date.now() - t0,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 3: Infrastructure Readiness
// ═══════════════════════════════════════════════════════════════════════════════

async function evaluateInfrastructureReadiness(
  decision: DecisionInput,
  openAiApiKey: string,
  infrastructureBlock: string,
  facilityChallengesBlock: string,
  teamName?: string,
  escalationLevel?: number,
): Promise<EvaluatorResult> {
  const t0 = Date.now();

  const hasInfra = infrastructureBlock.length > 0;
  const isTransportDecision = /transport|transfer|handover|move.*to|send.*to|deliver.*to/i.test(
    decision.description,
  );
  const isEstablishDecision = /establish|set up|deploy|place|create|designate/i.test(
    decision.description,
  );

  if (!hasInfra && !isTransportDecision && !isEstablishDecision) {
    return {
      evaluator: 'infrastructure_readiness',
      consistent: true,
      specific: true,
      skipped: true,
      latencyMs: 0,
    };
  }

  const esc = escalationLevel ?? 0;

  const systemPrompt = `You are an infrastructure readiness evaluator for a crisis management training exercise. Evaluate infrastructure ONLY in these cases:

A) The decision is about ESTABLISHING infrastructure → evaluate positively (rules 3-5 below).
B) The decision involves TRANSPORT / TRANSFER / HANDOVER of a patient → check destination exists.

⚠️ Do NOT flag infrastructure gaps for on-scene rescue, triage assessment, treatment, or stabilization. A responder treating a patient in the field does NOT need a triage tent to administer first aid.

TEAM ROLE: ${teamName || 'Unknown'}
ESCALATION LEVEL: ${esc}

1. CRITICAL GAP (ONLY for TRANSPORT/HANDOVER decisions): Transport to a facility NOT deployed on the map. Set consistent: false, mismatch_kind "infrastructure_gap".
2. CROSS-TEAM GAP: Same, but another team's infrastructure is missing.
3. PLANNING / ESTABLISHMENT EXCEPTION: Decision uses "establish", "set up", "deploy", "place", "create" → decision IS creating the infrastructure. Evaluate POSITIVELY.
   - With coordinates + personnel + equipment: consistent: true, specific: true.
   - With partial details: consistent: true, specific: true, constructive feedback.
   - Extremely vague: specific: false.
4. SETUP WITH COORDINATES: Infrastructure + explicit coordinates = HIGH-QUALITY.
5. SETUP WITHOUT COORDINATES: Infrastructure at named location but no coordinates → consistent: true, specific: false.

TRANSPORT DESTINATION CHECK:
- Names an existing facility → consistent: true.
- Names a non-existent facility → consistent: false, mismatch_kind: "infrastructure_gap".
- No destination named but facilities exist → consistent: true with mild feedback.
- No destination and NO medical facilities exist → consistent: false, mismatch_kind: "infrastructure_gap".

FACILITY ENVIRONMENTAL CHALLENGES:
${facilityChallengesBlock || 'No facility challenges reported.'}

${JSON_OUTPUT_FORMAT}`;

  const userPrompt = `${infrastructureBlock}
DECISION:
Title: ${decision.title}
Description: ${decision.description}

Evaluate infrastructure readiness. ALL text must be IN-WORLD CONSEQUENCES only. Return JSON only.`;

  try {
    const parsed = await callEvaluatorLLM(openAiApiKey, systemPrompt, userPrompt);
    const result = parseEvaluatorOutput('infrastructure_readiness', parsed);
    result.latencyMs = Date.now() - t0;
    return result;
  } catch (err) {
    logger.warn({ err, decisionId: decision.id }, 'evaluateInfrastructureReadiness failed');
    return {
      evaluator: 'infrastructure_readiness',
      consistent: true,
      specific: true,
      latencyMs: Date.now() - t0,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 4: Casualty Treatment (conditional)
// ═══════════════════════════════════════════════════════════════════════════════

async function evaluateCasualtyTreatment(
  decision: DecisionInput,
  openAiApiKey: string,
  casualtyBlock: string,
  escalationLevel?: number,
): Promise<EvaluatorResult> {
  const t0 = Date.now();

  if (!casualtyBlock) {
    return {
      evaluator: 'casualty_treatment',
      consistent: true,
      specific: true,
      skipped: true,
      latencyMs: 0,
    };
  }

  const casualtyPattern =
    /patient|casualty|triage|treat|wound|injur|bleed|fracture|burn|splint|tourniquet|stretcher|transport.*patient|medical|first.?aid|cpr|resuscitat|airway|breathing/i;
  if (!casualtyPattern.test(decision.description) && !casualtyPattern.test(decision.title)) {
    return {
      evaluator: 'casualty_treatment',
      consistent: true,
      specific: true,
      skipped: true,
      latencyMs: 0,
    };
  }

  const esc = escalationLevel ?? 0;

  const systemPrompt = `You are a casualty treatment evaluator for a crisis management training exercise.

ESCALATION LEVEL: ${esc}

Evaluate in this STRICT PRIORITY ORDER:

STEP 1 — RESCUE QUALITY:
- Personnel qualified for the task?
- Equipment appropriate? (stretcher for immobile, burn dressings for burns, splint for fractures, tourniquet for hemorrhage)
- Personnel count sufficient? (2 bearers minimum for stretcher carry)
- PPE appropriate for the zone?

STEP 2 — TREATMENT ADEQUACY:
1. INADEQUATE: Critical interventions skipped (transporting fracture without splinting, no bleeding control, no airway management, no burn dressings). Set consistent: false, mismatch_kind "below_standard".
2. DANGEROUS: Contraindicated actions (tourniquet on crush injury without medical oversight, moving spinal injury without immobilization). Set consistent: false, mismatch_kind "contradiction", severity "high".
3. ADEQUATE: Appropriate care. No penalty.

STEP 3 — TRANSPORT DESTINATION (ONLY if decision explicitly mentions transport/transfer):
Check if destination facility is mentioned and appropriate.

RESOURCE MISALLOCATION — BLACK PATIENTS:
If the decision allocates treatment resources to a BLACK-tagged patient while RED or YELLOW patients remain untreated: consistent: false, mismatch_kind "below_standard", severity "high".

RELEVANCE: Only evaluate when the decision DIRECTLY involves patient care, treatment, or transport.

When treatment_requirements or ideal_response_sequence are listed, use them as ground truth. When recommended_transport is listed, score transport destination against it.

${JSON_OUTPUT_FORMAT}`;

  const userPrompt = `${casualtyBlock}
DECISION:
Title: ${decision.title}
Description: ${decision.description}

Evaluate casualty treatment adequacy. ALL text must be IN-WORLD CONSEQUENCES only. Return JSON only.`;

  try {
    const parsed = await callEvaluatorLLM(openAiApiKey, systemPrompt, userPrompt);
    const result = parseEvaluatorOutput('casualty_treatment', parsed);
    result.latencyMs = Date.now() - t0;
    return result;
  } catch (err) {
    logger.warn({ err, decisionId: decision.id }, 'evaluateCasualtyTreatment failed');
    return {
      evaluator: 'casualty_treatment',
      consistent: true,
      specific: true,
      latencyMs: Date.now() - t0,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 5: Zone Safety (conditional)
// ═══════════════════════════════════════════════════════════════════════════════

async function evaluateZoneSafety(
  decision: DecisionInput,
  openAiApiKey: string,
  hazardSafetyBlock: string,
  escalationLevel?: number,
): Promise<EvaluatorResult> {
  const t0 = Date.now();

  if (!hazardSafetyBlock) {
    return {
      evaluator: 'zone_safety',
      consistent: true,
      specific: true,
      skipped: true,
      latencyMs: 0,
    };
  }

  const esc = escalationLevel ?? 0;

  const systemPrompt = `You are a zone safety evaluator for a crisis management training exercise following ICS/NIMS zone protocol. The game does NOT hard-block any action — all decisions proceed, but violations produce consequence injects.

ESCALATION LEVEL: ${esc}

A. ZONE ESTABLISHMENT:
- If "NO zones" are reported AND teams are operating near hazards: below_standard.
- If zones are drawn but critical types missing (e.g. hot zone but no warm zone): below_standard.
- Do NOT penalize if no personnel are near hazards yet.

B. ZONE ACCESS VIOLATIONS:
- Unauthorized teams in HOT ZONE: consistent: false, mismatch_kind "contradiction", severity "high". Severe consequence (e.g. "medic suffered burns").
- Unauthorized teams in WARM ZONE: consistent: false, mismatch_kind "below_standard", severity "medium".
- COLD ZONE: open to all, no penalty.
- "[UNAUTHORIZED TEAM]" flag = definitively not allowed.

C. PPE FOR ZONE:
- HOT ZONE without critical PPE: mismatch_kind "contradiction", severity "high".
- WARM ZONE without required PPE: mismatch_kind "below_standard", severity "high".
- COLD ZONE: no special PPE required.

D. PATIENT HANDOFF CHAIN:
HOT ZONE patients — EXTRACTION ONLY: If decision describes full triage, IV access, wound care in hot zone: consistent: false, severity "high". ALLOWED: DRABC, tourniquet, basic airway, rapid extrication, transport to warm zone.
WARM ZONE — TRIAGE & STABILIZATION: Full triage, IV, splinting all allowed. Definitive surgical care = below_standard.
COLD ZONE — FULL TREATMENT: All levels allowed.
SKIPPING ZONES: Hot → cold directly, skipping warm = below_standard.

RELEVANCE: Only evaluate when decisions involve deploying people near active hazards. Cold zone infrastructure setup should NOT be penalized.

${JSON_OUTPUT_FORMAT}`;

  const userPrompt = `${hazardSafetyBlock}
DECISION:
Title: ${decision.title}
Description: ${decision.description}

Evaluate zone safety compliance. ALL text must be IN-WORLD CONSEQUENCES only. Return JSON only.`;

  try {
    const parsed = await callEvaluatorLLM(openAiApiKey, systemPrompt, userPrompt);
    const result = parseEvaluatorOutput('zone_safety', parsed);
    result.latencyMs = Date.now() - t0;
    return result;
  } catch (err) {
    logger.warn({ err, decisionId: decision.id }, 'evaluateZoneSafety failed');
    return {
      evaluator: 'zone_safety',
      consistent: true,
      specific: true,
      latencyMs: Date.now() - t0,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVALUATOR 6: Hazard Response (conditional)
// ═══════════════════════════════════════════════════════════════════════════════

async function evaluateHazardResponse(
  decision: DecisionInput,
  openAiApiKey: string,
  hazardStandardsBlock: string,
  teamName?: string,
  escalationLevel?: number,
): Promise<EvaluatorResult> {
  const t0 = Date.now();

  if (!hazardStandardsBlock) {
    return {
      evaluator: 'hazard_response',
      consistent: true,
      specific: true,
      skipped: true,
      latencyMs: 0,
    };
  }

  const esc = escalationLevel ?? 0;

  const systemPrompt = `You are a hazard response evaluator for a crisis management training exercise.

TEAM ROLE: ${teamName || 'Unknown'}
ESCALATION LEVEL: ${esc}

The decision is a direct response to a specific hazard. You MUST rigorously evaluate whether the proposed response meets the hazard's resolution requirements, personnel requirements, and equipment requirements.

1. INCORRECT APPROACH: Wrong equipment or procedures for the hazard type = mismatch_kind "contradiction". "Pour water from buckets" on ANY fire is a contradiction — professional fire suppression equipment is required.
2. IMPROVISED / AMATEUR RESPONSE: Professional equipment specified but decision proposes improvised civilian methods = mismatch_kind "below_standard" (or "contradiction" if it could worsen the hazard).
3. PROFESSIONAL STANDARD: Fire response MUST involve calling the fire service OR using professional fire suppression equipment.

Bomb Squad / EOD evaluation:
CRITICAL FAILURES (contradiction, severity "high"):
  • Manual approach without robot assessment first
  • Standard water disruptor on METALLIC container (fragmentation risk)
  • Moving unstable device manually without TCV
  • No exclusion zone before RSP
  • Radio/cell use within exclusion zone (RF detonation risk)

BELOW STANDARD (severity "medium"):
  • Exclusion zone too small
  • No X-ray before RSP
  • No coordination with nearby teams
  • Blow-in-place near sensitive structure when TCV viable

RSP SELECTION GUIDE:
  • Soft containers (backpack, cardboard): Standard Water Cannon
  • Semi-rigid (plastic cooler): Standard Water Cannon acceptable
  • Metallic (briefcase, pipe, pressure cooker): Hard Target Disruptor ONLY
  • Vehicle-borne: Vehicle-rated Standoff Disruptor
  • Sealed/unstable: Controlled Detonation or TCV transport

${JSON_OUTPUT_FORMAT}`;

  const userPrompt = `${hazardStandardsBlock}
DECISION:
Title: ${decision.title}
Description: ${decision.description}

Evaluate against hazard response requirements. ALL text must be IN-WORLD CONSEQUENCES only. Return JSON only.`;

  try {
    const parsed = await callEvaluatorLLM(openAiApiKey, systemPrompt, userPrompt);
    const result = parseEvaluatorOutput('hazard_response', parsed);
    result.latencyMs = Date.now() - t0;
    return result;
  } catch (err) {
    logger.warn({ err, decisionId: decision.id }, 'evaluateHazardResponse failed');
    return {
      evaluator: 'hazard_response',
      consistent: true,
      specific: true,
      latencyMs: Date.now() - t0,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Aggregation
// ═══════════════════════════════════════════════════════════════════════════════

const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
const MISMATCH_RANK: Record<string, number> = {
  below_standard: 1,
  infrastructure_gap: 2,
  contradiction: 3,
};

function aggregateEvaluations(results: EvaluatorResult[]): EnvironmentalConsistencyResult {
  const active = results.filter((r) => !r.skipped);
  if (active.length === 0) return { consistent: true, specific: true };

  const rejected = active.find((r) => r.rejected);
  if (rejected) {
    return {
      consistent: false,
      severity: 'high',
      error_type: 'other',
      mismatch_kind: 'contradiction',
      reason: rejected.rejection_reason || 'Action cannot be carried out',
      consequence_title: rejected.consequence_title || 'Action cannot be carried out',
      specific: false,
      rejected: true,
      rejection_reason: rejected.rejection_reason || 'Forbidden action',
    };
  }

  const failures = active.filter((r) => !r.consistent);
  const vagueResults = active.filter((r) => r.specific === false);

  if (failures.length === 0 && vagueResults.length === 0) {
    return { consistent: true, specific: true };
  }

  if (failures.length === 0 && vagueResults.length > 0) {
    const allMissing = vagueResults.flatMap((r) => r.missing_details ?? []);
    const worst = vagueResults.sort(
      (a, b) => (SEVERITY_RANK[b.severity ?? ''] ?? 0) - (SEVERITY_RANK[a.severity ?? ''] ?? 0),
    )[0];
    return {
      consistent: true,
      specific: false,
      missing_details: [...new Set(allMissing)],
      feedback: worst.feedback,
      consequence_title: worst.consequence_title,
    };
  }

  const worstFailure = failures.sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[b.severity ?? ''] ?? 0) - (SEVERITY_RANK[a.severity ?? ''] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    return (
      (MISMATCH_RANK[b.mismatch_kind ?? ''] ?? 0) - (MISMATCH_RANK[a.mismatch_kind ?? ''] ?? 0)
    );
  })[0];

  const allMissing = [...failures, ...vagueResults].flatMap((r) => r.missing_details ?? []);
  const isSpecific = vagueResults.length === 0 && failures.every((r) => r.specific !== false);

  return {
    consistent: false,
    severity: worstFailure.severity ?? 'medium',
    error_type: worstFailure.error_type ?? 'other',
    mismatch_kind: worstFailure.mismatch_kind ?? 'contradiction',
    reason: worstFailure.reason ?? 'Decision does not meet professional response standards.',
    consequence_title: worstFailure.consequence_title,
    specific: isSpecific,
    missing_details: isSpecific ? undefined : [...new Set(allMissing)],
    feedback: isSpecific
      ? undefined
      : (vagueResults[0]?.feedback ?? worstFailure.feedback ?? undefined),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Orchestrator (main entry point)
// ═══════════════════════════════════════════════════════════════════════════════

export async function orchestrateDecisionEvaluation(
  sessionId: string,
  decision: DecisionInput,
  openAiApiKey: string | undefined,
  incident?: IncidentContext | null,
  teamName?: string,
  qualityFailureCount?: number,
): Promise<EnvironmentalConsistencyResult> {
  const consistentDefault: EnvironmentalConsistencyResult = { consistent: true };
  if (!openAiApiKey) return consistentDefault;

  try {
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();
    if (sessionErr || !session) return consistentDefault;

    const scenarioId = (session as { scenario_id: string }).scenario_id;
    const { data: scenario, error: scenarioErr } = await supabaseAdmin
      .from('scenarios')
      .select('id, description, insider_knowledge')
      .eq('id', scenarioId)
      .single();
    if (scenarioErr || !scenario) return consistentDefault;

    const insiderKnowledge = ((scenario as { insider_knowledge?: Record<string, unknown> })
      .insider_knowledge ?? {}) as Record<string, unknown>;

    // ─── Resolve team doctrines ──────────────────────────────────────────
    let sectorStandards = '';
    if (teamName) {
      const teamDoctrines = insiderKnowledge.team_doctrines as
        | Record<string, unknown[]>
        | undefined;
      if (teamDoctrines) {
        const findings = resolveTeamDoctrines(teamDoctrines, teamName);
        if (findings.length > 0) {
          sectorStandards = standardsToPromptBlock(findings as StandardsFinding[]);
        }
      }
    }
    if (!sectorStandards && typeof insiderKnowledge.sector_standards === 'string') {
      sectorStandards = insiderKnowledge.sector_standards;
    }

    // ─── Resolve forbidden actions ───────────────────────────────────────
    const storedForbidden = (insiderKnowledge.forbidden_actions ?? {}) as Record<
      string,
      ForbiddenAction[]
    >;
    const mergedForbidden: Record<string, ForbiddenAction[]> = {
      _universal: UNIVERSAL_FORBIDDEN_ACTIONS,
      ...storedForbidden,
    };
    const forbiddenBlock = teamName ? forbiddenActionsToPromptBlock(mergedForbidden, teamName) : '';

    // ─── Detect hazard-response decisions ────────────────────────────────
    let hazardStandardsBlock = '';
    const hazardMatch = decision.description.match(/^\[Hazard Response:\s*(.+?)\]/);
    if (hazardMatch) {
      const hazardTypeRaw = hazardMatch[1].trim().replace(/\s+/g, '_').toLowerCase();
      const { data: matchingHazards } = await supabaseAdmin
        .from('scenario_hazards')
        .select(
          'hazard_type, enriched_description, resolution_requirements, personnel_requirements, equipment_requirements, properties',
        )
        .eq('scenario_id', scenarioId)
        .ilike('hazard_type', `%${hazardTypeRaw}%`)
        .limit(3);

      if (matchingHazards?.length) {
        const parts: string[] = [];
        for (const h of matchingHazards) {
          const lines: string[] = [];
          lines.push(`Hazard type: ${(h.hazard_type as string).replace(/_/g, ' ')}`);
          if (h.enriched_description) lines.push(`Situation: ${h.enriched_description}`);
          const reqs = h.resolution_requirements as Record<string, unknown> | null;
          if (reqs && Object.keys(reqs).length > 0)
            lines.push(`Resolution requirements: ${JSON.stringify(reqs)}`);
          const personnel = h.personnel_requirements as Record<string, unknown> | null;
          if (personnel && Object.keys(personnel).length > 0)
            lines.push(`Personnel requirements: ${JSON.stringify(personnel)}`);
          const equipment = h.equipment_requirements as unknown[] | null;
          if (equipment && equipment.length > 0)
            lines.push(`Equipment requirements: ${JSON.stringify(equipment)}`);
          const props = (h.properties ?? {}) as Record<string, unknown>;
          const propEntries = Object.entries(props).filter(
            ([k]) => !['deterioration_stage', 'minutes_unaddressed'].includes(k),
          );
          if (propEntries.length > 0)
            lines.push(`Properties: ${propEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
          parts.push(lines.join('\n'));
        }
        hazardStandardsBlock = `HAZARD RESPONSE STANDARDS:\n${parts.join('\n---\n')}\n\n`;
      }
    }

    // ─── Gate: Safety guardrails ─────────────────────────────────────────
    const guardrailResult = await evaluateSafetyGuardrails(
      decision,
      openAiApiKey,
      forbiddenBlock,
      teamName,
    );

    await logEvaluatorEvent(sessionId, guardrailResult);

    if (guardrailResult.rejected) {
      return aggregateEvaluations([guardrailResult]);
    }

    // ─── Load context blocks in parallel ─────────────────────────────────
    const [infrastructureBlock, casualtyBlock, hazardSafetyBlock, facilityChallengesBlock] =
      await Promise.all([
        buildInfrastructureContext(sessionId, teamName),
        buildCasualtyContext(sessionId),
        buildHazardSafetyContext(sessionId),
        buildFacilityChallengesContext(sessionId),
      ]);

    const escalationLevel = qualityFailureCount ?? 0;

    // ─── Run 6 evaluators in parallel ────────────────────────────────────
    const parallelResults = await Promise.all([
      evaluateSpecificity(decision, openAiApiKey, teamName, incident, escalationLevel),
      evaluateStandardsCompliance(
        decision,
        openAiApiKey,
        sectorStandards,
        teamName,
        escalationLevel,
      ),
      evaluateInfrastructureReadiness(
        decision,
        openAiApiKey,
        infrastructureBlock,
        facilityChallengesBlock,
        teamName,
        escalationLevel,
      ),
      evaluateCasualtyTreatment(decision, openAiApiKey, casualtyBlock, escalationLevel),
      evaluateZoneSafety(decision, openAiApiKey, hazardSafetyBlock, escalationLevel),
      evaluateHazardResponse(
        decision,
        openAiApiKey,
        hazardStandardsBlock,
        teamName,
        escalationLevel,
      ),
    ]);

    const allResults = [guardrailResult, ...parallelResults];

    // Log each evaluator result
    for (const r of parallelResults) {
      logEvaluatorEvent(sessionId, r).catch(() => {});
    }

    logger.info(
      {
        sessionId,
        decisionId: decision.id,
        evaluators: allResults.map((r) => ({
          name: r.evaluator,
          consistent: r.consistent,
          specific: r.specific,
          skipped: r.skipped,
          latencyMs: r.latencyMs,
        })),
      },
      'Decision evaluation orchestration complete',
    );

    return aggregateEvaluations(allResults);
  } catch (err) {
    logger.warn(
      { err, sessionId, decisionId: decision.id },
      'orchestrateDecisionEvaluation failed, treating as consistent',
    );
    return consistentDefault;
  }
}

async function logEvaluatorEvent(sessionId: string, result: EvaluatorResult): Promise<void> {
  try {
    await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: 'evaluator_result',
      description: `${result.evaluator}: ${result.skipped ? 'skipped' : result.consistent ? 'pass' : result.rejected ? 'rejected' : `fail (${result.mismatch_kind})`}`,
      actor_id: null,
      metadata: {
        evaluator: result.evaluator,
        consistent: result.consistent,
        specific: result.specific,
        skipped: result.skipped ?? false,
        severity: result.severity,
        mismatch_kind: result.mismatch_kind,
        rejected: result.rejected,
        latencyMs: result.latencyMs,
      },
    });
  } catch {
    // non-critical
  }
}
