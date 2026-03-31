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
 * Per-team standards research.
 *
 * For each team, makes a dedicated research call that considers the team's name,
 * description, role within the scenario, and the scenario narrative. Produces
 * rich, team-specific doctrine at 4000 tokens per team — including overarching
 * command frameworks (ICS/AIIMS/NIMS) as they apply to each team's role.
 *
 * Returns { teamDoctrines, allFindings } — no separate mapping step needed.
 */
export interface TeamInput {
  team_name: string;
  team_description?: string;
}

export async function researchStandardsPerTeam(
  openAiApiKey: string,
  scenarioType: string,
  teams: TeamInput[],
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<{ teamDoctrines: Record<string, StandardsFinding[]>; allFindings: StandardsFinding[] }> {
  if (teams.length === 0) return { teamDoctrines: {}, allFindings: [] };

  const narrativeBlock = narrative
    ? `\nScenario: ${narrative.title || scenarioType}\nDescription: ${(narrative.description || '').slice(0, 800)}\nBriefing: ${(narrative.briefing || '').slice(0, 400)}`
    : `\nScenario type: ${scenarioType}`;

  const otherTeamsContext = teams
    .map((t) => `${t.team_name}${t.team_description ? ` — ${t.team_description}` : ''}`)
    .join('; ');

  const teamDoctrines: Record<string, StandardsFinding[]> = {};
  const allFindings: StandardsFinding[] = [];

  await Promise.all(
    teams.map(async (team) => {
      const descLine = team.team_description ? `\nTeam description: ${team.team_description}` : '';

      const prompt = `You are an expert in emergency management, crisis response, and sector-specific operational standards.
${narrativeBlock}

All teams in this exercise: ${otherTeamsContext}

FOCUS TEAM: ${team.team_name}${descLine}

Research the specific standards, doctrines, frameworks, and operational protocols that govern how "${team.team_name}" should operate during this kind of incident. Consider:

1. What is this team's FUNCTIONAL ROLE in the response — infer from the team name, description, the scenario type, and how they fit alongside the other teams? For example, a "Railway Maintenance Team" in a subway bombing would handle power isolation, ventilation, structural assessment. An "Interreligious Organisation" placed alongside media/police teams is likely handling community communications and interfaith liaison.

2. What SPECIFIC authoritative standards or doctrines govern this functional role? Name real frameworks (e.g. "ICS NIMS 2017", "START Triage Protocol", "Rail Safety Directive 2016/798", "Singapore Civil Defence Act", "CBRN STANAG 2513"). Include sector-specific regulations (rail, aviation, maritime, hospitality, etc.) where applicable.

3. Include any OVERARCHING command frameworks (ICS, AIIMS, NIMS, SCDF) as they specifically apply to this team's position in the command structure.

Return ONLY valid JSON — an array of 2-4 findings:
[
  {
    "domain": "the discipline area",
    "source": "specific named standard or doctrine",
    "key_points": [
      "specific protocol, procedure, or threshold 1",
      "specific protocol, procedure, or threshold 2",
      "..."
    ],
    "decision_thresholds": "any numeric thresholds, time targets, or decision gates relevant to this team",
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
]

Focus on: decision gates, time thresholds, role responsibilities, handover procedures, and any criteria that determine correct vs incorrect responses by this team. For site_requirements, include only area types this team would actually set up or manage.`;

      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAiApiKey}`,
          },
          body: JSON.stringify({
            model: SEARCH_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 4000,
          }),
        });

        if (!res.ok) {
          logger.warn(
            { status: res.status, team: team.team_name },
            'Per-team standards research failed',
          );
          return;
        }

        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content as string | undefined;
        if (!raw) return;

        let parsed: StandardsFinding[] = [];
        const jsonArrMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonArrMatch) {
          parsed = JSON.parse(jsonArrMatch[0]) as StandardsFinding[];
        } else {
          const objMatch = raw.match(/\{[\s\S]*\}/);
          if (objMatch) {
            const single = JSON.parse(objMatch[0]) as StandardsFinding;
            parsed = [single];
          }
        }

        const valid = (Array.isArray(parsed) ? parsed : []).filter(
          (f) => f.domain && f.source && Array.isArray(f.key_points),
        );
        for (const f of valid) {
          if (
            f.site_requirements &&
            typeof f.site_requirements === 'object' &&
            Object.keys(f.site_requirements).length === 0
          ) {
            delete f.site_requirements;
          }
        }
        if (valid.length > 0) {
          teamDoctrines[team.team_name] = valid;
          allFindings.push(...valid);
        }
      } catch (err) {
        logger.warn({ err, team: team.team_name }, 'Per-team standards research error');
      }
    }),
  );

  logger.info(
    {
      scenarioType,
      teamCount: teams.length,
      teamsWithDoctrines: Object.keys(teamDoctrines).length,
      totalFindings: allFindings.length,
    },
    'Per-team standards research complete',
  );

  return { teamDoctrines, allFindings };
}

/**
 * @deprecated Use researchStandardsPerTeam instead.
 * Legacy wrapper — converts string[] team names into TeamInput[] and delegates.
 */
export async function researchStandards(
  openAiApiKey: string,
  scenarioType: string,
  teams?: string[],
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<StandardsFinding[]> {
  const teamInputs: TeamInput[] = (teams ?? []).map((t) => ({ team_name: t }));
  const { allFindings } = await researchStandardsPerTeam(
    openAiApiKey,
    scenarioType,
    teamInputs,
    narrative,
  );
  return allFindings;
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

export interface TeamWorkflow {
  endgame: string;
  steps: string[];
  personnel_ratios?: Record<string, string>;
  sop_checklist?: string[];
}

/**
 * Research team-specific workflow chains — endgame definitions, step-by-step
 * process, personnel ratios, and SOP checklists for each team in the scenario.
 */
export async function researchTeamWorkflows(
  openAiApiKey: string,
  scenarioType: string,
  teamNames: string[],
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<Record<string, TeamWorkflow>> {
  if (teamNames.length === 0) return {};

  const narrativeBlock = narrative
    ? `\nScenario: ${narrative.title}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : `\nScenario type: ${scenarioType}`;

  const prompt = `You are an expert in emergency management operations and standard operating procedures.
${narrativeBlock}

Teams in this exercise: ${teamNames.join(', ')}

For EACH team, research and define:

1. ENDGAME: What does "done" look like for this team? The definitive completion state.
2. STEPS: The sequential workflow chain this team follows from first action to endgame. Each step should be a discrete, verifiable action. Order matters.
3. PERSONNEL RATIOS: Key staffing ratios from real SOPs (e.g. "medic_to_patient": "1:4", "marshal_to_exit": "2:1"). Use the format "role_to_role": "N:M".
4. SOP CHECKLIST: Mandatory procedural items this team must complete per established standards (e.g. "triage_color_coding", "scene_safety_check", "communication_log").

Return ONLY valid JSON:
{
  "workflows": {
    "Team Name": {
      "endgame": "string",
      "steps": ["step1", "step2", ...],
      "personnel_ratios": { "role_to_role": "N:M" },
      "sop_checklist": ["item1", "item2"]
    }
  }
}`;

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
        max_tokens: 3000,
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Team workflow research failed');
      return {};
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return {};

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]) as { workflows?: Record<string, TeamWorkflow> };
    return parsed.workflows ?? {};
  } catch (err) {
    logger.warn({ err }, 'Team workflow research error');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Crowd Dynamics Research
// ---------------------------------------------------------------------------

export interface ConvergentCrowdType {
  type: string;
  typical_arrival_minutes: number;
  behavior: string;
  size_range: string;
}

export interface CrowdDynamicsResearch {
  self_evacuation_patterns: string;
  convergent_crowd_types: ConvergentCrowdType[];
  movement_notes: string;
}

/**
 * Research crowd dynamics for a specific scenario type and venue:
 * self-evacuation patterns, convergent crowd behavior, arrival schedules.
 */
export async function researchCrowdDynamics(
  openAiApiKey: string,
  scenarioType: string,
  location?: string,
  venueName?: string,
): Promise<CrowdDynamicsResearch | null> {
  const venue = venueName || location || scenarioType;
  const locationHint = location ? ` at or near ${location}` : '';

  const prompt = `You are an expert in crowd psychology, mass casualty incidents, and emergency evacuation dynamics.

Research how crowds behave during and after a ${scenarioType}${locationHint} at a venue like ${venue}.

Cover THREE areas:

1. SELF-EVACUATION PATTERNS: How do people inside the venue react in the first 0-10 minutes? Consider panic flight vs freeze response, shell-shocked individuals, orderly vs disorderly movement, bottleneck formation, stampede risk, and how crowd density affects flow.

2. CONVERGENT CROWD TYPES: After word of the incident spreads, who arrives from OUTSIDE and when? For each type, provide the typical arrival window in minutes after the incident, their behavior, and estimated group size. Types include: onlookers/rubberneckers, media crews, family members searching for loved ones, self-appointed helpers/volunteers, political figures, and religious/community leaders.

3. MOVEMENT NOTES: Which entry/exit points do convergent crowds typically gravitate toward? How does their presence interfere with response operations? What happens when convergent crowds meet evacuees?

Return ONLY valid JSON:
{
  "self_evacuation_patterns": "2-4 sentence description of initial crowd behavior inside the venue",
  "convergent_crowd_types": [
    {
      "type": "onlooker|media|family|helper|political|religious",
      "typical_arrival_minutes": 10,
      "behavior": "1-2 sentence description of what this group does when they arrive",
      "size_range": "10-30"
    }
  ],
  "movement_notes": "2-3 sentences about how convergent crowds use entry points and interfere with operations"
}

Base your response on documented after-action reports and crowd psychology research. Use ONLY real behavioral patterns from real incidents.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = (err as { error?: { message?: string } }).error?.message || res.statusText;
      logger.warn({ status: res.status, msg }, 'Crowd dynamics research failed');
      return null;
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return null;

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as CrowdDynamicsResearch;
    if (!parsed.self_evacuation_patterns || !Array.isArray(parsed.convergent_crowd_types)) {
      return null;
    }

    logger.info(
      { scenarioType, crowdTypes: parsed.convergent_crowd_types.length },
      'Crowd dynamics research complete',
    );
    return parsed;
  } catch (err) {
    logger.warn({ err, scenarioType }, 'Crowd dynamics research error');
    return null;
  }
}

/**
 * Serialize CrowdDynamicsResearch into a prompt block for AI generation.
 */
export function crowdDynamicsToPromptBlock(research: CrowdDynamicsResearch): string {
  const types = research.convergent_crowd_types
    .map(
      (t) =>
        `  - ${t.type}: arrives ~T+${t.typical_arrival_minutes}min, size ${t.size_range}, ${t.behavior}`,
    )
    .join('\n');
  return (
    `Self-evacuation: ${research.self_evacuation_patterns}\n` +
    `Convergent crowd types:\n${types}\n` +
    `Movement notes: ${research.movement_notes}`
  );
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
