import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

/** Inject titles or keywords that indicate the Insider has no relevant intel (opportunistic / external actor). */
const NO_INSIDER_INTEL_KEYWORDS = [
  'journalist',
  'filming',
  'suspicious individual',
  'press demand',
  'on-site filming',
  'bystander film',
  'privacy violated',
  'accusations from a patient',
];

/**
 * Whether the Insider has factual intel (sites, routes, figures) for this incident.
 * If the incident is about journalist, filming, suspicious individual, etc., return false.
 */
export function insiderHasInfoForIncident(injectTitle: string, injectContent: string): boolean {
  const combined = `${(injectTitle || '').toLowerCase()} ${(injectContent || '').toLowerCase()}`;
  const hasNoIntel = NO_INSIDER_INTEL_KEYWORDS.some((k) => combined.includes(k));
  return !hasNoIntel;
}

/**
 * Get Insider intel for the scenario (layout, exits, zones, etc.) as a string for AI comparison.
 */
export async function getInsiderIntelForScenario(scenarioId: string): Promise<string> {
  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('insider_knowledge')
    .eq('id', scenarioId)
    .single();
  const knowledge = (scenario as { insider_knowledge?: unknown } | null)?.insider_knowledge;
  if (!knowledge || typeof knowledge !== 'object') return '';
  return JSON.stringify(knowledge, null, 2);
}

/**
 * Whether the team consulted the Insider (session_insider_qa) before the given time.
 * Used to distinguish "informed decision" from "lucky guess" when the decision matches intel.
 */
export async function teamConsultedInsiderBefore(
  sessionId: string,
  teamUserIds: string[],
  beforeTime: string,
): Promise<boolean> {
  if (teamUserIds.length === 0) return false;
  const { data, error } = await supabaseAdmin
    .from('session_insider_qa')
    .select('id')
    .eq('session_id', sessionId)
    .in('asked_by', teamUserIds)
    .lt('asked_at', beforeTime)
    .limit(1);
  if (error) {
    logger.warn({ error, sessionId }, 'Failed to check session_insider_qa for consultation');
    return false;
  }
  return (data?.length ?? 0) > 0;
}

export type DecisionBand = 'top' | 'medium' | 'lowest';

/**
 * AI: Do the stats/figures/specifics in the decision match the Insider intel?
 */
export async function aiMatchInsiderIntel(
  incidentTitle: string,
  incidentDescription: string,
  decisionDescription: string,
  insiderIntel: string,
  openAiApiKey: string | undefined,
): Promise<boolean> {
  if (!openAiApiKey || !insiderIntel.trim()) return false;
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
          {
            role: 'system',
            content: `You are an expert evaluator. Given an INCIDENT (title and description), a DECISION (the player's response), and INSIDER INTEL (ground truth: sites, exits, zones, figures), answer: do the stats, figures, and specifics mentioned in the decision MATCH what the Insider intel says? (e.g. correct exit names, capacities, zone labels, flow numbers.)
Return ONLY a JSON object: { "match": true } or { "match": false }.`,
          },
          {
            role: 'user',
            content: `INCIDENT - Title: ${incidentTitle}\nDescription: ${incidentDescription}\n\nDECISION: ${decisionDescription}\n\nINSIDER INTEL: ${insiderIntel.slice(0, 4000)}\n\nDo the decision's specifics match the intel? JSON only.`,
          },
        ],
        temperature: 0.2,
        max_tokens: 50,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return false;
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return false;
    const parsed = JSON.parse(content) as { match?: boolean };
    return parsed.match === true;
  } catch (e) {
    logger.warn({ err: e }, 'aiMatchInsiderIntel failed');
    return false;
  }
}

/**
 * AI: Grade relevance and detail of the decision to the incident (no Insider).
 * Returns top (relevant and detailed), medium, or lowest.
 */
export async function aiGradeRelevanceOnly(
  incidentTitle: string,
  incidentDescription: string,
  decisionDescription: string,
  openAiApiKey: string | undefined,
): Promise<DecisionBand> {
  if (!openAiApiKey) return 'lowest';
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
          {
            role: 'system',
            content: `You are an expert evaluator. Rate how relevant and detailed the DECISION is in response to the INCIDENT. No Insider intel is available for this incident.
Return ONLY a JSON object with one key "band": "top" | "medium" | "lowest".
- top: decision is clearly relevant and sufficiently detailed for the situation.
- medium: partly relevant or somewhat vague.
- lowest: vague, off-topic, or unhelpful.
When judging whether the decision is sufficiently detailed, consider sector norms where relevant to the incident: evacuation (marshal-to-evacuee ratio, assembly/holding capacity); triage (staff-to-critical 1:5, START protocol, zone layout Red/Yellow/Green, Red transport first, hospital distribution: trauma center for Red, community for Yellow, clinic for Green); media (designated spokesperson, one voice, verify before release, avoid speculation on perpetrators, media zone 100–150 m, victim dignity/no names until family notified, regular updates 30–60 min). More specific on these points counts as more detailed; vague or absent on them counts as less detailed.`,
          },
          {
            role: 'user',
            content: `INCIDENT - Title: ${incidentTitle}\nDescription: ${incidentDescription}\n\nDECISION: ${decisionDescription}\n\nRate relevance and detail. JSON only: { "band": "top"|"medium"|"lowest" }`,
          },
        ],
        temperature: 0.2,
        max_tokens: 50,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return 'lowest';
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return 'lowest';
    const parsed = JSON.parse(content) as { band?: string };
    if (parsed.band === 'top' || parsed.band === 'medium' || parsed.band === 'lowest') {
      return parsed.band;
    }
    return 'lowest';
  } catch (e) {
    logger.warn({ err: e }, 'aiGradeRelevanceOnly failed');
    return 'lowest';
  }
}

/**
 * Compute band for an incident-linked decision: Insider has info? Match intel? Consulted?
 */
export async function gradeDecisionBand(
  context: {
    incidentTitle: string;
    incidentDescription: string;
    decisionDescription: string;
    scenarioId: string;
    sessionId: string;
    teamUserIds: string[];
    executedAt: string;
  },
  openAiApiKey: string | undefined,
): Promise<DecisionBand> {
  const {
    incidentTitle,
    incidentDescription,
    decisionDescription,
    scenarioId,
    sessionId,
    teamUserIds,
    executedAt,
  } = context;

  const hasInsiderInfo = insiderHasInfoForIncident(incidentTitle, incidentDescription);
  if (!hasInsiderInfo) {
    return aiGradeRelevanceOnly(
      incidentTitle,
      incidentDescription,
      decisionDescription,
      openAiApiKey,
    );
  }

  const insiderIntel = await getInsiderIntelForScenario(scenarioId);
  const match = await aiMatchInsiderIntel(
    incidentTitle,
    incidentDescription,
    decisionDescription,
    insiderIntel,
    openAiApiKey,
  );
  if (!match) return 'lowest';

  const consulted = await teamConsultedInsiderBefore(sessionId, teamUserIds, executedAt);
  return consulted ? 'top' : 'medium';
}
