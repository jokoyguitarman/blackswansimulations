/**
 * War Room Research Service
 * Uses OpenAI web search models for area, standards, and similar-cases research.
 * Standards research is narrative-driven: first identifies relevant domains from the
 * scenario story, then fetches specific protocols per domain.
 * Similar-cases research runs right after parsing (concurrent with geocoding) and
 * provides structured real-world incident context for every AI generation phase.
 */

import { logger } from '../lib/logger.js';

const SEARCH_MODEL = 'gpt-4o-search-preview';

export interface SimilarCase {
  name: string;
  summary: string;
  timeline: string;
  adversary_behavior: string;
  other_actors: string;
  environment: string;
  outcome: string;
}

export interface SiteRequirement {
  min_area_m2?: number;
  requires_water?: boolean;
  requires_shelter?: boolean;
  requires_vehicle_access?: boolean;
  requires_electricity?: boolean;
  min_capacity?: number;
  max_distance_from_incident_m?: number;
  notes?: string;
}

export interface StandardsFinding {
  domain: string;
  source: string;
  key_points: string[];
  decision_thresholds?: string;
  site_requirements?: Record<string, SiteRequirement>;
}

/**
 * Research the area around a location: geography, access, landmarks, local agencies.
 */
export async function researchArea(
  openAiApiKey: string,
  location: string,
  venueName?: string,
): Promise<string> {
  const venue = venueName || location;
  const prompt = `Research the area around ${venue} in ${location}: geography, access routes, landmarks, local emergency agencies (hospitals, police, fire), and constraints. Return a concise 200-word summary.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = (err as { error?: { message?: string } }).error?.message || response.statusText;
      logger.warn({ status: response.status, msg }, 'Area research failed');
      return '';
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim() : '';
  } catch (err) {
    logger.warn({ err }, 'Area research error');
    return '';
  }
}

/**
 * Two-step narrative-driven standards research.
 *
 * Step 1: From the scenario story, identify which response disciplines apply and name
 *         the authoritative frameworks/doctrines for each.
 * Step 2: For each domain, fetch specific protocols, thresholds, and procedures.
 *
 * Returns structured StandardsFinding[] so each inject/phase generation call can
 * reference precise content rather than a generic summary blob.
 */
export async function researchStandards(
  openAiApiKey: string,
  scenarioType: string,
  teams?: string[],
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<StandardsFinding[]> {
  const teamContext =
    teams && teams.length > 0 ? ` Response teams involved: ${teams.join(', ')}.` : '';

  const narrativeBlock = narrative
    ? `\n\nScenario narrative:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : `\n\nScenario type: ${scenarioType}`;

  // Step 1: Identify relevant domains and named standards from the narrative
  const domainPrompt = `You are an expert in emergency management and crisis response.${narrativeBlock}${teamContext}

Based ONLY on what this specific incident requires — not generic templates — identify the 3-5 response disciplines that would actually be deployed. For each, name the specific authoritative standard, doctrine, or framework that governs it (e.g. "ICS NIMS 2017", "START Triage Protocol", "FBI Crisis Negotiation Unit Manual", "CBRN STANAG 2513", "Singapore Civil Defence Act").

Return ONLY valid JSON:
{
  "domains": [
    { "discipline": "string", "standard_name": "string", "reason": "why this applies to THIS incident" }
  ]
}`;

  let domains: Array<{ discipline: string; standard_name: string; reason: string }> = [];

  try {
    const step1Res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: domainPrompt }],
        max_tokens: 600,
      }),
    });

    if (step1Res.ok) {
      const data = await step1Res.json();
      const raw = data.choices?.[0]?.message?.content as string | undefined;
      if (raw) {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            domains?: Array<{ discipline: string; standard_name: string; reason: string }>;
          };
          domains = parsed.domains?.slice(0, 5) ?? [];
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Standards domain identification failed');
  }

  if (domains.length === 0) {
    logger.warn({ scenarioType }, 'No domains identified; skipping standards deep fetch');
    return [];
  }

  // Step 2: For each domain, fetch specific actionable content
  const findings: StandardsFinding[] = [];

  await Promise.all(
    domains.map(async ({ discipline, standard_name, reason }) => {
      const fetchPrompt = `You are an expert in ${discipline}.${narrativeBlock}

Look up "${standard_name}" and extract the specific content relevant to this incident.
Return ONLY valid JSON:
{
  "domain": "${discipline}",
  "source": "${standard_name}",
  "key_points": ["specific protocol or threshold 1", "specific protocol or threshold 2", "..."],
  "decision_thresholds": "any numeric thresholds or decision gates (e.g. triage colour criteria, response time targets, resource ratios)",
  "site_requirements": {
    "operational_area_type": {
      "min_area_m2": 100,
      "requires_water": true,
      "requires_shelter": false,
      "requires_vehicle_access": true,
      "requires_electricity": false,
      "min_capacity": 20,
      "max_distance_from_incident_m": 150,
      "notes": "why these requirements matter"
    }
  }
}

Focus on: decision gates, time thresholds, role responsibilities, command structure, and any criteria that determine correct vs incorrect team responses.

For site_requirements: extract the PHYSICAL requirements for any operational area types governed by this standard. What does a site need to function as a triage area, evacuation assembly point, command post, negotiation post, decontamination zone, etc.? Include min area, water/power/shelter needs, vehicle access, capacity, and maximum distance from incident. Only include area types relevant to THIS standard and THIS incident — do not invent generic requirements.
Context for why this matters here: ${reason}`;

      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAiApiKey}`,
          },
          body: JSON.stringify({
            model: SEARCH_MODEL,
            messages: [{ role: 'user', content: fetchPrompt }],
            max_tokens: 600,
          }),
        });

        if (!res.ok) return;
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content as string | undefined;
        if (!raw) return;

        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;

        const finding = JSON.parse(jsonMatch[0]) as StandardsFinding;
        if (finding.domain && finding.source && Array.isArray(finding.key_points)) {
          if (
            finding.site_requirements &&
            typeof finding.site_requirements === 'object' &&
            Object.keys(finding.site_requirements).length === 0
          ) {
            delete finding.site_requirements;
          }
          findings.push(finding);
        }
      } catch (err) {
        logger.warn({ err, discipline, standard_name }, 'Standards deep fetch failed for domain');
      }
    }),
  );

  logger.info(
    { scenarioType, domainCount: domains.length, fetchedCount: findings.length },
    'Standards research complete',
  );

  return findings;
}

/**
 * Research 2–4 real-world incidents similar to the given scenario type and venue.
 * Runs right after parsing, concurrent with geocoding, before any AI generation.
 * Returns [] on any failure so generation always proceeds.
 */
export async function researchSimilarCases(
  openAiApiKey: string,
  scenarioType: string,
  location?: string,
  venueName?: string,
  setting?: string,
): Promise<SimilarCase[]> {
  const venueContext = venueName || location || setting || scenarioType;
  const locationHint = location ? ` in or near ${location}` : '';
  const settingHint = setting ? ` (setting: ${setting})` : '';

  const prompt = `You are an expert in crisis management and emergency response history.

Find 2–4 real-world incidents that are similar to: ${scenarioType}${locationHint}${settingHint}.

For each incident, extract a structured summary focused on HOW the event unfolded — the dynamics between the threat, responders, environment, and other actors. This will be used to make a crisis simulation scenario more realistic.

Return ONLY valid JSON:
{
  "cases": [
    {
      "name": "incident name, location, year (e.g. 'Nairobi Westgate Mall Attack, 2013')",
      "summary": "2–3 sentence overview of what happened",
      "timeline": "How the event evolved: key phases, escalation points, turning points (2–4 sentences)",
      "adversary_behavior": "What the threat actor(s) did: tactics, adaptations, objectives (2–3 sentences)",
      "other_actors": "How the public, media, bystanders, or other third parties behaved and influenced events (1–2 sentences)",
      "environment": "How location, infrastructure, crowd density, or environmental factors shaped the response (1–2 sentences)",
      "outcome": "How it resolved, key lessons for responders (1–2 sentences)"
    }
  ]
}

RULES:
- Use ONLY real, documented incidents — no fictional or hypothetical cases.
- If no closely similar real incidents can be found, return an empty cases array: { "cases": [] }
- Focus on incidents where the response dynamics (coordination, timing, actor behavior) are most instructive.
- Prioritise incidents from the past 30 years with documented after-action reviews.

Scenario context: ${scenarioType} at ${venueContext}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = (err as { error?: { message?: string } }).error?.message || res.statusText;
      logger.warn({ status: res.status, msg }, 'Similar cases research failed');
      return [];
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return [];

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { cases?: unknown[] };
    const cases = parsed.cases ?? [];

    const valid = cases.filter(
      (c): c is SimilarCase =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as SimilarCase).name === 'string' &&
        typeof (c as SimilarCase).summary === 'string',
    );

    logger.info({ scenarioType, location, found: valid.length }, 'Similar cases research complete');
    return valid;
  } catch (err) {
    logger.warn({ err, scenarioType }, 'Similar cases research error');
    return [];
  }
}

/**
 * Serialize SimilarCase[] to a compact string for embedding in AI prompts.
 */
export function similarCasesToPromptBlock(cases: SimilarCase[]): string {
  if (cases.length === 0) return '';
  return cases
    .map(
      (c) =>
        `[${c.name}]\n` +
        `  Overview: ${c.summary}\n` +
        `  Timeline: ${c.timeline}\n` +
        `  Adversary: ${c.adversary_behavior}\n` +
        `  Other actors: ${c.other_actors}\n` +
        `  Environment: ${c.environment}\n` +
        `  Outcome: ${c.outcome}`,
    )
    .join('\n\n');
}

/**
 * Map each StandardsFinding to the team(s) it applies to.
 * Shared command doctrines (e.g. AIIMS/ICS) are mapped to every team.
 * Returns Record<team_name, StandardsFinding[]>.
 */
export async function mapStandardsToTeams(
  openAiApiKey: string,
  teams: string[],
  findings: StandardsFinding[],
): Promise<Record<string, StandardsFinding[]>> {
  if (teams.length === 0 || findings.length === 0) return {};

  const findingsSummary = findings.map((f, i) => ({
    index: i,
    domain: f.domain,
    source: f.source,
  }));

  const prompt = `You are an expert in emergency management and crisis response.

Given these response TEAMS:
${teams.map((t) => `- ${t}`).join('\n')}

And these operational STANDARDS/DOCTRINES:
${findingsSummary.map((f) => `[${f.index}] ${f.source} (${f.domain})`).join('\n')}

Map each standard to the team(s) it primarily governs. Shared command frameworks (e.g. incident command systems like AIIMS, ICS, NIMS) should be mapped to ALL teams.

Return ONLY valid JSON:
{
  "mapping": {
    "team_name": [0, 2],
    "other_team": [1, 3]
  }
}

Where values are arrays of standard indices. Every standard must appear in at least one team. Every team must have at least one standard.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Standards-to-teams mapping failed');
      return {};
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return {};

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]) as {
      mapping?: Record<string, number[]>;
    };
    if (!parsed.mapping) return {};

    const result: Record<string, StandardsFinding[]> = {};
    for (const [team, indices] of Object.entries(parsed.mapping)) {
      const normalizedTeam = teams.find((t) => t.toLowerCase() === team.toLowerCase()) || team;
      result[normalizedTeam] = indices
        .filter((i) => i >= 0 && i < findings.length)
        .map((i) => findings[i]);
    }

    logger.info(
      { teamCount: Object.keys(result).length, standardsCount: findings.length },
      'Standards-to-teams mapping complete',
    );
    return result;
  } catch (err) {
    logger.warn({ err }, 'Standards-to-teams mapping error');
    return {};
  }
}

/**
 * Serialize a team_doctrines record into a prompt block grouped by team.
 */
export function teamDoctrinesToPromptBlock(
  teamDoctrines: Record<string, StandardsFinding[]>,
  teamFilter?: string,
): string {
  const entries = teamFilter
    ? [[teamFilter, teamDoctrines[teamFilter] ?? []] as const]
    : Object.entries(teamDoctrines);

  return entries
    .filter(([, findings]) => findings.length > 0)
    .map(
      ([team, findings]) => `[${team}]\n` + standardsToPromptBlock(findings as StandardsFinding[]),
    )
    .join('\n\n');
}

/**
 * Serialize StandardsFinding[] to a compact string for embedding in AI prompts.
 */
export function standardsToPromptBlock(findings: StandardsFinding[]): string {
  if (findings.length === 0) return '';
  return findings
    .map(
      (f) =>
        `[${f.source}] ${f.domain}:\n` +
        f.key_points.map((p) => `  - ${p}`).join('\n') +
        (f.decision_thresholds ? `\n  Thresholds: ${f.decision_thresholds}` : ''),
    )
    .join('\n\n');
}

/**
 * Extract and serialize all site_requirements from findings into a prompt block.
 */
export function siteRequirementsToPromptBlock(findings: StandardsFinding[]): string {
  const allReqs: Array<{ useType: string; req: SiteRequirement; source: string }> = [];
  for (const f of findings) {
    if (!f.site_requirements) continue;
    for (const [useType, req] of Object.entries(f.site_requirements)) {
      allReqs.push({ useType, req, source: f.source });
    }
  }
  if (allReqs.length === 0) return '';
  return allReqs
    .map(({ useType, req, source }) => {
      const parts: string[] = [];
      if (req.min_area_m2 != null) parts.push(`min area: ${req.min_area_m2}m²`);
      if (req.min_capacity != null) parts.push(`min capacity: ${req.min_capacity} persons`);
      if (req.requires_water) parts.push('requires water');
      if (req.requires_electricity) parts.push('requires electricity');
      if (req.requires_shelter) parts.push('requires shelter');
      if (req.requires_vehicle_access) parts.push('requires vehicle access');
      if (req.max_distance_from_incident_m != null)
        parts.push(`max ${req.max_distance_from_incident_m}m from incident`);
      if (req.notes) parts.push(req.notes);
      return `${useType} [${source}]: ${parts.join(', ')}`;
    })
    .join('\n');
}
