import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import type { ScenarioBlueprint } from './blueprint/blueprintTypes.js';
import { BLUEPRINT_HONOR_THRESHOLD } from './blueprint/blueprintConfig.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NPCPersona {
  handle: string;
  name: string;
  type: 'npc_public' | 'npc_media' | 'npc_politician' | 'npc_influencer';
  personality: string;
  bias: string;
  follower_count: number;
  backstory: string;
  posting_pattern: string;
  specific_claims: string[];
  image_prompts?: string[];
  tier?: 'key' | 'background';
  normal_interests?: string[];
  // Document-driven blueprint linkage (optional, backward-compatible): ties a
  // persona to a blueprint faction so the trainer's groups survive as first-class
  // entities. Absent for personas generated without a document.
  faction_id?: string;
  alignment?: string;
}

export interface FactSheetEntry {
  claim: string;
  status: 'TRUE' | 'FALSE' | 'UNVERIFIED';
  truth: string;
  spread_by?: string[];
}

export interface FactSheet {
  confirmed_facts: string[];
  unconfirmed_claims: FactSheetEntry[];
  // Crisis responsibility cluster (Coombs SCCT). Used to judge victim-centring: how much empathy /
  // apology is appropriate. victim = org not at fault; accidental = moderate; preventable = at fault.
  crisis_cluster?: 'victim' | 'accidental' | 'preventable';
}

export interface TeamDef {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
}

export interface SocialInjectDeliveryConfig {
  app: 'social_feed' | 'email' | 'news' | 'group_chat' | 'phone_call';
  platform?: string;
  author_handle?: string;
  author_display_name?: string;
  author_type?: string;
  virality_score?: number;
  content_flags?: Record<string, unknown>;
  engagement_seed?: { likes: number; reposts: number; replies: number };
  spawn_replies?: number;
  reply_sentiment_distribution?: Record<string, number>;
  from_address?: string;
  from_name?: string;
  priority?: string;
  outlet_name?: string;
  headline?: string;
  category?: string;
  sender_name?: string;
  channel_type?: string;
}

export interface SocialInject {
  trigger_time_minutes?: number;
  type: string;
  title: string;
  content: string;
  severity: string;
  inject_scope: string;
  target_teams: string[];
  requires_response?: boolean;
  response_deadline_minutes?: number;
  delivery_config: SocialInjectDeliveryConfig;
  conditions_to_appear?: { threshold?: number; conditions?: string[] } | { all: string[] };
  conditions_to_cancel?: string[];
  eligible_after_minutes?: number;
  state_effect?: Record<string, unknown>;
  trigger_condition?: string;
}

export interface TeamBestPractice {
  team_name: string;
  guidelines: Array<{
    guideline_id: string;
    best_practice: string;
    source_basis: string;
    timing_window?: string;
    if_violated: string;
    if_followed: string;
    detection_signals: string[];
  }>;
}

export interface ResearchGuidelines {
  per_team: TeamBestPractice[];
  group_wide: {
    coordination_guidelines: string[];
    escalation_protocols: string[];
    timing_benchmarks: Record<string, number>;
    case_studies: Array<{ name: string; summary: string; lessons: string[] }>;
  };
}

export interface StrategicActionBenchmark {
  action_id: string;
  description: string;
  tier: 1 | 2 | 3;
  team: string;
  doctrine_source: string;
  detection_action_type: string;
  timing_benchmark_minutes: number | null;
  sentiment_dimension: string;
  impact_if_done: number;
  impact_if_missed: number;
  consequence_if_done: string;
  consequence_if_missed: string;
}

export interface SentimentCurve {
  baseline: number;
  crisis_drop: number;
  natural_recovery_per_10min: number;
  good_response_boost: number;
  poor_response_penalty: number;
  hate_speech_penalty_per_unaddressed: number;
  community_engagement_boost: number;
}

export interface ObjectiveDef {
  objective_id: string;
  objective_name: string;
  description: string;
  weight: number;
  success_criteria?: Record<string, unknown>;
}

export interface SOPStep {
  step_id: string;
  name: string;
  description: string;
  time_limit_minutes: number;
}

export interface SOPDefinition {
  sop_name: string;
  description: string;
  steps: SOPStep[];
  response_time_limit_minutes: number;
  content_guidelines: {
    tone: string[];
    avoid: string[];
    include: string[];
    language_sensitivity: string[];
  };
}

export interface OrgPagePlatformConfig {
  page_name: string;
  page_handle: string;
  page_bio: string;
  follower_count: number;
  page_logo_url?: string;
}

export interface BrandedHistoryPost {
  content: string;
  platform: 'facebook' | 'x_twitter';
  post_format: string;
  days_ago: number;
  media_description?: string;
}

export type OrgRole = 'protagonist' | 'antagonist';
export type OrgControlMode = 'player' | 'ai' | 'trainer';

export interface OrgConfig {
  org_key: string;
  display_name: string;
  is_primary: boolean;
  /** protagonist = player-assignable; antagonist = trainer/AI-driven rival. */
  role: OrgRole;
  /** who drives the page at runtime. Antagonists default to 'ai'. */
  control_mode: OrgControlMode;
  /** Short adversarial positioning used to steer the antagonist AI engine. */
  stance?: string;
  /** True when the antagonist was auto-invented (no competitor names given). */
  auto_generated?: boolean;
  facebook: OrgPagePlatformConfig;
  x_twitter: OrgPagePlatformConfig;
  /** Per-org pre-crisis timeline. Falls back to the flat OrgPageConfig.branded_history for the primary. */
  branded_history?: BrandedHistoryPost[];
}

export interface OrgPageConfig {
  // Multi-page shape (primary crisis org + optional extras)
  orgs?: OrgConfig[];
  // Legacy single-org fields (retained for the primary org / backward compatibility)
  facebook: OrgPagePlatformConfig;
  x_twitter: OrgPagePlatformConfig;
  branded_history: BrandedHistoryPost[];
}

/**
 * Normalize an org_page config (new multi-org `orgs[]` shape OR legacy single-org
 * `{ facebook, x_twitter }` shape) into a flat list of OrgConfig. Guarantees exactly
 * one org is flagged is_primary.
 */
export function normalizeOrgPages(
  orgPage: OrgPageConfig | Record<string, unknown> | null | undefined,
): OrgConfig[] {
  if (!orgPage) return [];
  const op = orgPage as OrgPageConfig;
  let orgs: OrgConfig[] = [];

  if (Array.isArray(op.orgs) && op.orgs.length > 0) {
    orgs = op.orgs.map((o, i) => ({
      ...o,
      org_key: o.org_key || (o.is_primary ? 'primary' : `org_${i + 1}`),
      display_name:
        o.display_name || o.facebook?.page_name || o.x_twitter?.page_name || 'Organization',
      is_primary: !!o.is_primary,
      role: o.role === 'antagonist' ? 'antagonist' : 'protagonist',
      control_mode:
        o.control_mode === 'ai' || o.control_mode === 'trainer' ? o.control_mode : 'player',
      facebook: o.facebook,
      x_twitter: o.x_twitter,
    }));
  } else if (op.facebook || op.x_twitter) {
    orgs = [
      {
        org_key: 'primary',
        display_name: op.facebook?.page_name || op.x_twitter?.page_name || 'Organization',
        is_primary: true,
        role: 'protagonist',
        control_mode: 'player',
        facebook: op.facebook,
        x_twitter: op.x_twitter,
        branded_history: op.branded_history,
      },
    ];
  }

  if (orgs.length > 0 && !orgs.some((o) => o.is_primary)) {
    orgs[0].is_primary = true;
  }
  return orgs;
}

export interface SocialCrisisPayload {
  scenario: {
    title: string;
    description: string;
    briefing: string;
    category: 'social_media_crisis';
    difficulty: string;
    duration_minutes: number;
    initial_state: {
      npc_personas: NPCPersona[];
      fact_sheet: FactSheet;
      sentiment_curve: SentimentCurve;
      affected_communities: string[];
      research_guidelines: ResearchGuidelines;
      strategic_benchmarks?: StrategicActionBenchmark[];
      dimension_labels?: {
        public_trust: string;
        community_safety: string;
        narrative_control: string;
        escalation_risk: string;
      };
      org_name?: string;
      org_page?: OrgPageConfig;
      facebook_groups?: Array<{ name: string; group_type: string; member_count: number }>;
      // Document-driven blueprint (optional). Runtime engines read it from here.
      blueprint?: ScenarioBlueprint;
    };
  };
  teams: TeamDef[];
  objectives: ObjectiveDef[];
  sop: SOPDefinition;
  time_injects: SocialInject[];
  condition_injects: SocialInject[];
  decision_injects: SocialInject[];
}

// ─── AI Helper ──────────────────────────────────────────────────────────────

async function callAI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 8000,
  temperature = 0.7,
): Promise<Record<string, unknown> | null> {
  if (!env.openAiApiKey) return null;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_completion_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Social crisis AI call returned non-OK');
      return null;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (err) {
    logger.error({ err }, 'Social crisis AI call failed');
    return null;
  }
}

function orgNameLine(orgName?: string): string {
  return orgName ? `\nOrganization under crisis: ${orgName}\n` : '';
}

// ─── Stage 1: NPCs + Fact Sheet + Communities ───────────────────────────────

function buildFactionGuidance(blueprint?: ScenarioBlueprint | null): string {
  if (!blueprint) return '';
  const coverage = blueprint.coverage?.factions ?? 0;
  if (blueprint.factions.length === 0 || coverage < BLUEPRINT_HONOR_THRESHOLD) return '';
  const lines = blueprint.factions
    .map((f) => {
      const drivers = f.emotional_drivers.slice(0, 4).join(', ');
      const narratives = f.typical_narratives.slice(0, 3).join(' | ');
      return `- id="${f.id}" name="${f.name}" alignment="${f.alignment}"; drivers: ${drivers}; narratives: ${narratives}`;
    })
    .join('\n');
  return `\n\nBLUEPRINT FACTIONS (the trainer's document defined these groups -- honor them). For EACH persona you create, set "faction_id" to the matching faction id below and "alignment" to that faction's alignment. Distribute the key personas across these factions in proportion to their importance:\n${lines}`;
}

// ─── Option A blueprint guidance helpers ────────────────────────────────────
// Each returns '' when its field/blueprint is empty, so an empty blueprint leaves
// the prompt byte-identical to before (no-regression hinge).
//
// FIELD -> CONSUMER REGISTRY (explicit routing):
//   incident_types             -> generateNPCsAndFactSheet (fact-sheet seed)
//   cross_cutting_constraints  -> generateConvergenceLayer (objectives + briefing CONTEXT)
//   cross_stakeholder_dynamics -> generateConvergenceLayer (convergence gates) + runtime Director
//   global_tone_guidance       -> NPC + storyline + convergence prompts (global style)
//   example_vignettes          -> generateUnifiedStoryline (few-shot arc)

/** Document-wide tone/realism guidance applied across all generators. */
function buildGlobalToneGuidance(blueprint?: ScenarioBlueprint | null): string {
  const tone = blueprint?.global_tone_guidance?.trim();
  return tone ? `\n\nGLOBAL TONE & REALISM (apply to every post/voice): ${tone}` : '';
}

/** Incident sub-types -> fact-sheet seeding for the NPC/fact-sheet generator. */
function buildIncidentTypesGuidance(blueprint?: ScenarioBlueprint | null): string {
  const types = blueprint?.incident_types ?? [];
  if (types.length === 0) return '';
  return `\n\nINCIDENT TYPES this crisis may involve (ground the fact sheet in these): ${types.join('; ')}`;
}

/** example_vignettes + global tone -> storyline few-shot guidance. */
function buildStorylineGuidance(blueprint?: ScenarioBlueprint | null): string {
  if (!blueprint) return '';
  const parts: string[] = [];
  if (blueprint.example_vignettes.length > 0) {
    parts.push(
      `EXAMPLE DYNAMICS to emulate in the inject arc:\n- ${blueprint.example_vignettes.join('\n- ')}`,
    );
  }
  const tone = blueprint.global_tone_guidance?.trim();
  if (tone) parts.push(`GLOBAL TONE & REALISM: ${tone}`);
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : '';
}

/** cross_stakeholder_dynamics + cross_cutting_constraints (as context) + tone -> convergence. */
function buildConvergenceGuidance(blueprint?: ScenarioBlueprint | null): string {
  if (!blueprint) return '';
  const parts: string[] = [];
  if (blueprint.cross_stakeholder_dynamics.length > 0) {
    parts.push(
      `CROSS-STAKEHOLDER DYNAMICS (design convergence gates around these inter-group interactions):\n- ${blueprint.cross_stakeholder_dynamics.join('\n- ')}`,
    );
  }
  if (blueprint.cross_cutting_constraints.length > 0) {
    const lines = blueprint.cross_cutting_constraints
      .map((c) => `${c.area}: ${c.consideration}`)
      .join('; ');
    parts.push(
      `CROSS-CUTTING CONSTRAINTS the response must balance (reflect in objectives & briefing -- do NOT invent extra weighted objectives): ${lines}`,
    );
  }
  const tone = blueprint.global_tone_guidance?.trim();
  if (tone) parts.push(`GLOBAL TONE & REALISM: ${tone}`);
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : '';
}

export async function generateNPCsAndFactSheet(
  crisisType: string,
  context: string,
  country: string,
  location: string,
  orgName?: string,
  blueprint?: ScenarioBlueprint | null,
): Promise<{ personas: NPCPersona[]; factSheet: FactSheet; communities: string[] }> {
  const factionGuidance = buildFactionGuidance(blueprint);
  // Call 1: Generate 18-20 key NPCs + fact sheet + communities
  const keyResult = await callAI(
    `You are an expert social media crisis simulation designer. You are creating a CHARACTER BIBLE for a crisis response training exercise.

IMPORTANT: First, carefully analyze the crisis description provided below. Identify the TYPE of crisis (e.g., product recall, corporate PR disaster, racial tension, religious incident, data breach, layoffs, environmental disaster, political scandal, etc.) and tailor ALL output to match the specific crisis dynamics. Do NOT assume the crisis is about racial or religious tension unless the description explicitly states so.

Given the crisis event, generate:

1. AFFECTED STAKEHOLDER GROUPS: 2-6 specific groups that will be most vocal and affected by this crisis. Name them concretely based on the crisis type.

2. KEY NPC PERSONAS: 18-20 fictional social media accounts that are the MAIN CHARACTERS driving the crisis narrative. Create a diverse, realistic cast appropriate to the crisis:
   - 6-8 HOSTILE/OUTRAGED personas: people spreading anger, misinformation, demands for accountability, calls for boycotts, or amplifying negative narratives. Each should have a distinct angle of attack.
   - 3-4 FEAR/AMPLIFIER personas: scared people who share unverified info, amplify rumors, demand extreme action.
   - 3-4 SUPPORTIVE/DEFENDER personas: voices of reason, industry experts, community advocates, or defenders calling for calm.
   - 3 MEDIA personas: news outlets or journalists reporting facts and seeking statements.
   - 1-2 WILDCARD: politicians, influencers, or public figures whose stance is ambiguous.

   For EACH persona provide:
   - handle (e.g. @angry_citizen_42)
   - name (culturally appropriate display name for the country)
   - type (npc_public, npc_media, npc_politician, npc_influencer)
   - personality (2-3 sentence character description)
   - bias (what drives their perspective, or "none" for neutral)
   - follower_count (realistic number)
   - backstory (2-3 sentences)
   - posting_pattern (how they behave online)
   - specific_claims (array of 1-3 specific false claims or narratives, or empty for factual personas)
   - image_prompts (array of 0-2 image descriptions for posts)

3. FACT SHEET: The ground truth for the simulation.
   - confirmed_facts: 6-10 facts that official sources have confirmed
   - unconfirmed_claims: 5-8 false or unverified claims, each with claim, status, truth, spread_by
   - crisis_cluster: classify the organisation's responsibility (Coombs SCCT) as one of "victim" (org is itself a victim - e.g. rumor, sabotage, natural disaster; low responsibility), "accidental" (technical/unintended error; moderate responsibility), or "preventable" (org misdeed or known negligence; high responsibility).

Country: ${country}

Return ONLY valid JSON:
{
  "communities": ["..."],
  "personas": [{ "handle": "...", "name": "...", "type": "...", "personality": "...", "bias": "...", "follower_count": 0, "backstory": "...", "posting_pattern": "...", "specific_claims": ["..."], "image_prompts": ["..."] }],
  "fact_sheet": {
    "confirmed_facts": ["..."],
    "unconfirmed_claims": [{ "claim": "...", "status": "FALSE", "truth": "...", "spread_by": ["@handle1"] }],
    "crisis_cluster": "victim|accidental|preventable"
  }
}`,
    `Crisis scenario: ${crisisType}${orgNameLine(orgName)}\n${location ? `Location: ${location}, ` : ''}Country: ${country}\nDetailed context: ${context}${factionGuidance}${buildIncidentTypesGuidance(blueprint)}${buildGlobalToneGuidance(blueprint)}`,
    8000,
    0.8,
  );

  const keyPersonas = ((keyResult?.personas as NPCPersona[]) || []).map((p) => ({
    ...p,
    tier: 'key' as const,
  }));
  const factSheet = (keyResult?.fact_sheet as FactSheet) || {
    confirmed_facts: [],
    unconfirmed_claims: [],
  };
  const communities = (keyResult?.communities as string[]) || [];

  // Calls 2 & 3: Generate 80 background NPCs in two batches of 40
  const bgPrompt = (batchNum: number, existingHandles: string[]) =>
    `You are generating BACKGROUND social media users for a crisis simulation. These are regular people who populate the feed with a mix of crisis reactions and normal life content. They make the simulated social media feel like a real platform.

Crisis context: ${crisisType.substring(0, 300)}${orgNameLine(orgName)}Country: ${country}

Generate exactly 40 unique background personas. Each should feel like a real social media user.
${existingHandles.length > 0 ? `\nIMPORTANT: Do NOT reuse any of these handles: ${existingHandles.join(', ')}\n` : ''}
For each persona provide:
- handle (unique, realistic username)
- name (culturally appropriate for ${country})
- type: always "npc_public"
- personality (1 sentence describing who they are)
- bias (their general stance on the crisis: "angry", "sympathetic", "indifferent", "skeptical", "supportive", or "none")
- follower_count (realistic, mostly 50-2000 for regular users)
- normal_interests (array of 2-3 topics they normally post about when NOT talking about the crisis, e.g. "cooking", "football", "parenting", "fitness", "gaming", "photography", "music", "travel", "pets", "work life", "tech", "fashion")

Return ONLY valid JSON:
{ "personas": [{ "handle": "@user", "name": "Name", "type": "npc_public", "personality": "...", "bias": "...", "follower_count": 200, "normal_interests": ["cooking", "football"] }] }`;

  const keyHandles = keyPersonas.map((p) => p.handle);

  const [bg1Result, bg2Result] = await Promise.all([
    callAI(
      bgPrompt(1, keyHandles),
      `Batch 1 of background users for: ${crisisType.substring(0, 200)}`,
      6000,
      0.9,
    ),
    callAI(
      bgPrompt(2, keyHandles),
      `Batch 2 of background users (different from batch 1) for: ${crisisType.substring(0, 200)}`,
      6000,
      0.9,
    ),
  ]);

  const toBgPersona = (p: Record<string, unknown>): NPCPersona => ({
    handle: String(p.handle || ''),
    name: String(p.name || ''),
    type: 'npc_public',
    personality: String(p.personality || ''),
    bias: String(p.bias || 'none'),
    follower_count: Number(p.follower_count) || 200,
    backstory: '',
    posting_pattern: '',
    specific_claims: [],
    tier: 'background',
    normal_interests: Array.isArray(p.normal_interests)
      ? (p.normal_interests as string[]).map(String)
      : [],
  });

  const bg1 = ((bg1Result?.personas as Array<Record<string, unknown>>) || []).map(toBgPersona);
  const bg2 = ((bg2Result?.personas as Array<Record<string, unknown>>) || []).map(toBgPersona);

  // Deduplicate handles across all batches
  const usedHandles = new Set(keyHandles);
  const deduped = [...bg1, ...bg2].filter((p) => {
    if (usedHandles.has(p.handle)) return false;
    usedHandles.add(p.handle);
    return true;
  });

  const allPersonas = [...keyPersonas, ...deduped];
  logger.info(
    { key: keyPersonas.length, background: deduped.length, total: allPersonas.length },
    'Tiered NPC generation complete',
  );

  return { personas: allPersonas, factSheet, communities };
}

// ─── Stage 2: Teams ─────────────────────────────────────────────────────────

export async function suggestSocialCrisisTeams(
  crisisType: string,
  communities: string[],
  context: string,
  country: string,
  orgName?: string,
): Promise<TeamDef[]> {
  const result = await callAI(
    `You are an expert in social media crisis response team structure. Given a crisis event, the affected stakeholder groups, and the country context, suggest 4-6 response teams that a crisis response organization would deploy.

Each team should have a clear, distinct role in the social media response effort. Consider the specific dynamics of this crisis and country when naming and describing teams.

Return ONLY valid JSON:
{ "teams": [{ "team_name": "...", "team_description": "...", "min_participants": 1, "max_participants": 4 }] }`,
    `Crisis: ${crisisType}${orgNameLine(orgName)}\nCountry: ${country}\nTargeted communities: ${communities.join(', ')}\nContext: ${context}`,
    8000,
  );

  return (
    (result?.teams as TeamDef[]) || [
      {
        team_name: 'Social Media Monitoring',
        team_description: 'Monitor feeds, flag hate speech and misinformation',
        min_participants: 2,
        max_participants: 4,
      },
      {
        team_name: 'Content Response',
        team_description: 'Draft and publish counter-narratives and corrections',
        min_participants: 2,
        max_participants: 4,
      },
      {
        team_name: 'Community Liaison',
        team_description: 'Coordinate with community leaders and grassroots networks',
        min_participants: 1,
        max_participants: 3,
      },
      {
        team_name: 'Escalation & Coordination',
        team_description: 'Escalate to authorities, manage inter-agency comms',
        min_participants: 1,
        max_participants: 2,
      },
    ]
  );
}

// ─── Stage 3: Per-Team Storylines (parallel) ────────────────────────────────

export async function generateTeamStoryline(
  team: TeamDef,
  crisisContext: {
    crisisType: string;
    location: string;
    country: string;
    context: string;
    duration: number;
    orgName?: string;
  },
  npcs: NPCPersona[],
  factSheet: FactSheet,
  allTeams: TeamDef[],
): Promise<SocialInject[]> {
  const otherTeams = allTeams.filter((t) => t.team_name !== team.team_name);
  const npcContext = npcs
    .map(
      (p) =>
        `${p.handle} (${p.name}): ${p.type}, ${p.personality}, bias: ${p.bias}, backstory: ${p.backstory}, claims: ${p.specific_claims.join('; ')}`,
    )
    .join('\n');
  const factsContext = `Confirmed: ${factSheet.confirmed_facts.join('; ')}\nFalse claims: ${factSheet.unconfirmed_claims.map((c) => `"${c.claim}" (${c.status}) - spread by ${(c.spread_by || []).join(', ')}`).join('; ')}`;

  const result = await callAI(
    `You are designing the STORYLINE for a specific team in a social media crisis simulation.

TEAM: "${team.team_name}" — ${team.team_description}

Other teams in the exercise: ${otherTeams.map((t) => `${t.team_name} (${t.team_description})`).join(', ')}

You must generate 8-15 injects that ONLY this team will experience. These create a unique pressure arc for this team's specific role.

The injects should be a MIX of:
- EMAILS (app: "email") — these provide VERIFIED FACTS, STATUS REQUESTS, and EXTERNAL/PRESS correspondence ONLY. Generate at least 2-4 email injects. Each email MUST include "email_category" in its delivery_config. Use from_name and from_address matching the real-world supervisors and authorities this team would hear from. The ONLY allowed categories are:
  * "verified_facts": Team's supervisor or authorities share confirmed facts relevant to this team's domain and address circulating rumours. E.g. for a health team: "Confirmed: 12 injured, 2 critical at SGH. SCDF deployed 5 emergency vehicles. No official cause released." Include ONLY confirmed information — no language to use, no talking points, no draft statements.
  * "sitrep_request": Leadership asks this team for a status update — what they have observed and actioned. It requests information FROM the team; it does NOT instruct them how to handle the public.
  * "general": Journalist inquiries directed to this team, community/faith leader outreach, affected-party messages. External pressure only — never instructions on what to do.

ANTI-COACHING RULE (CRITICAL): Emails must NEVER tell the team what to say publicly, provide draft statements, talking points, suggested messaging, approved language, PR strategy, communication red lines, approval chains, or stakeholder priority/comms-process instructions. Internal emails are limited to verified facts and status requests. The players must figure out their own procedures and public response. This is a training simulation — spoonfeeding the process or the message defeats the purpose.

- DIRECT MESSAGES or GROUP CHAT (app: "group_chat") from NPCs or colleagues with tips, requests, or pressure.
- SOCIAL MEDIA POSTS (app: "social_feed") that are particularly relevant to this team's monitoring responsibility. Use the NPC personas and their specific claims. For social_feed injects, set "platform" in the delivery_config to either "x_twitter" or "facebook". Vary the platform -- short reactions and hashtag trends go on X/Twitter, longer community posts and group discussions go on Facebook.
- PHONE CALLS (app: "phone_call") from leadership or stakeholders demanding updates.

Each inject should create PRESSURE specific to this team's role. The storyline should have:
- An OPENING phase (T+0 to T+5): the team becomes aware of the crisis. Early email: verified_facts (confirmed information for their domain).
- A BUILDING phase (T+5 to T+20): pressure intensifies. Emails: updated verified_facts, a press request for comment (general).
- A PEAK phase (T+20 to T+40): maximum pressure. Emails: sitrep_request (leadership asks for status), more external/press inquiries (general).
- A RESOLUTION phase (T+40+): consequences appear. Emails: new verified_facts that change the situation.

Mark critical injects with requires_response: true and response_deadline_minutes.

CRITICAL: For every email inject, you MUST set "email_category" in the delivery_config to one of: "verified_facts", "sitrep_request", or "general". Do NOT use any other category. Also set realistic "from_name", "from_address", and "priority". Use names and titles appropriate to this team's leadership chain or external contacts.

ALL injects must have target_teams: ["${team.team_name}"].

Available NPCs:
${npcContext}

Facts and claims:
${factsContext}

Return ONLY valid JSON:
{ "injects": [{ "trigger_time_minutes": 0, "type": "social_post|email_inbound|group_chat_message|phone_call", "title": "...", "content": "...", "severity": "low|medium|high|critical", "inject_scope": "team_specific", "target_teams": ["${team.team_name}"], "requires_response": false, "response_deadline_minutes": null, "delivery_config": { "app": "social_feed|email|group_chat|phone_call", "email_category": "verified_facts|sitrep_request|general", "from_name": "...", "from_address": "...", "priority": "normal|high|urgent", ... } }] }`,
    `Crisis: ${crisisContext.crisisType}${orgNameLine(crisisContext.orgName)} in ${crisisContext.location}, ${crisisContext.country}\nContext: ${crisisContext.context}\nDuration: ${crisisContext.duration} minutes`,
    8000,
    0.8,
  );

  const injects = (result?.injects as SocialInject[]) || [];
  return injects.map((inj) => ({
    ...inj,
    target_teams: [team.team_name],
    inject_scope: 'team_specific',
  }));
}

export async function generateAllTeamStorylines(
  teams: TeamDef[],
  crisisContext: {
    crisisType: string;
    location: string;
    country: string;
    context: string;
    duration: number;
    orgName?: string;
  },
  npcs: NPCPersona[],
  factSheet: FactSheet,
  onTeamComplete?: (teamName: string, injectCount: number) => void,
): Promise<Record<string, SocialInject[]>> {
  const results: Record<string, SocialInject[]> = {};

  await Promise.all(
    teams.map(async (team) => {
      const injects = await generateTeamStoryline(team, crisisContext, npcs, factSheet, teams);
      results[team.team_name] = injects;
      onTeamComplete?.(team.team_name, injects.length);
    }),
  );

  return results;
}

// ─── Stage 3b: Unified Storyline (no teams) ─────────────────────────────────

export async function generateUnifiedStoryline(
  crisisContext: {
    crisisType: string;
    country: string;
    context: string;
    duration: number;
    orgName?: string;
  },
  npcs: NPCPersona[],
  factSheet: FactSheet,
  onProgress?: (msg: string) => void,
  blueprint?: ScenarioBlueprint | null,
): Promise<SocialInject[]> {
  const npcContext = npcs
    .map(
      (p) =>
        `${p.handle} (${p.name}): ${p.type}, ${p.personality}, bias: ${p.bias}, claims: ${p.specific_claims.join('; ')}`,
    )
    .join('\n');
  const factsContext = `Confirmed: ${factSheet.confirmed_facts.join('; ')}\nFalse claims: ${factSheet.unconfirmed_claims.map((c) => `"${c.claim}" (${c.status})`).join('; ')}`;

  onProgress?.('Generating unified crisis storyline...');

  const result = await callAI(
    `You are designing the STORYLINE for a social media crisis simulation. There are NO teams -- all players see the same feed and work together as one crisis response group.

Generate 20-30 injects that create a cohesive, escalating crisis narrative. These are the events the response team will face.

IMPORTANT: Analyze the crisis description to understand the type of crisis (product recall, corporate scandal, data breach, racial tension, environmental disaster, etc.) and generate content appropriate to that specific crisis. Do NOT assume this is about racial/religious tensions unless the scenario explicitly describes that.

The injects should be a MIX of:
- SOCIAL MEDIA POSTS (app: "social_feed") from NPC personas spreading outrage, misinformation, fear, criticism, support, or defense. The tone and content must match the crisis type (e.g., boycott calls for a product recall, employee anger for layoffs, privacy outrage for data breaches). For social_feed injects, set "platform" in delivery_config to either "x_twitter" or "facebook". Aim for 60% X/Twitter and 40% Facebook. X posts are short and hashtag-heavy; Facebook posts are longer and more personal.
- EMAILS (app: "email") — these provide VERIFIED FACTS, STATUS REQUESTS, and EXTERNAL/PRESS correspondence ONLY. Generate at least 4-6 email injects. Each email MUST include "email_category" in its delivery_config. Use realistic from_name and from_address. The ONLY allowed categories are:
  * "verified_facts" (T+3-5, T+15-20, T+30-35): Leadership or authorities share confirmed information and explicitly address/debunk circulating rumours. Include ONLY confirmed facts, numbers, timelines, and official advisories (e.g. "Authorities reiterated there is no basis for claims of multiple attackers. Police confirmed the cordon and investigation remain ongoing. No official casualty figures have been released."). Do NOT include language for the team to use, talking points, draft statements, or PR strategy.
  * "sitrep_request" (T+10-30): Leadership asks the team for a status update. It requests information FROM the team (what have you observed, what have you actioned) — it does NOT instruct them on how to handle the public or what to say.
  * "general": Press briefings, journalist requests for comment, community/faith leader outreach, affected-party messages. These create external pressure but never tell the team what to do.

ANTI-COACHING RULE (CRITICAL): Emails must NEVER tell the team what to say publicly, provide draft statements, talking points, suggested messaging, approved language, PR strategy, communication red lines, approval chains, or stakeholder priority/comms-process instructions. Internal emails are limited to verified facts and status requests. The players must figure out their own procedures and public response. This is a training simulation — spoonfeeding the process or the message defeats the purpose.

- GROUP CHAT messages (app: "group_chat") with internal coordination challenges, tips from the public, leaked information, or whistleblower messages.
- PHONE CALLS (app: "phone_call") from senior leadership or media wanting statements.

The storyline should have a clear PRESSURE ARC:
- OPENING (T+0 to T+5): Crisis breaks. First social media posts appear. Team becomes aware. Early email: verified_facts (initial confirmed information).
- BUILDING (T+5 to T+15): Public outrage and misinformation intensify. Emails: updated verified_facts (rumours addressed by authorities), a press request for comment (general).
- ESCALATION (T+15 to T+30): Crisis peaks. Emails: sitrep_request (leadership asks for status), more press inquiries (general).
- TURNING POINT (T+30 to T+45): Consequences appear. Emails: new verified_facts that change the situation.
- RESOLUTION (T+45 to T+60): Final consequences. Either stabilization or further deterioration.

Mark critical injects with requires_response: true and response_deadline_minutes.
ALL injects must have inject_scope: "universal" and target_teams: [].

CRITICAL: For every social_feed inject, you MUST set "author_handle" and "author_display_name" in the delivery_config using one of the NPC personas below. Do NOT leave them blank or use "@system". Each social post must come from a specific NPC character.

CRITICAL: For every email inject, you MUST set "email_category" in the delivery_config to one of: "verified_facts", "sitrep_request", or "general". Do NOT use any other category. Also set realistic "from_name", "from_address", and "priority" values. Use names and titles appropriate to the organization and crisis type (CEO, Director of Communications, journalists, community leaders, etc.).

Available NPCs:
${npcContext}

Facts and claims:
${factsContext}

Return ONLY valid JSON:
{ "injects": [{ "trigger_time_minutes": 0, "type": "social_post|email_inbound|group_chat_message|phone_call", "title": "...", "content": "...", "severity": "low|medium|high|critical", "inject_scope": "universal", "target_teams": [], "requires_response": false, "response_deadline_minutes": null, "delivery_config": { "app": "social_feed|email|group_chat|phone_call", "platform": "x_twitter|facebook", "author_handle": "@npc_handle", "author_display_name": "NPC Name", "author_type": "npc_public|npc_media|npc_politician|npc_influencer", "email_category": "verified_facts|sitrep_request|general", "from_name": "...", "from_address": "...", "priority": "normal|high|urgent", ... } }] }`,
    `Crisis: ${crisisContext.crisisType}${orgNameLine(crisisContext.orgName)}\nCountry: ${crisisContext.country}\nContext: ${crisisContext.context}\nDuration: ${crisisContext.duration} minutes${buildStorylineGuidance(blueprint)}`,
    12000,
    0.8,
  );

  const injects = (result?.injects as SocialInject[]) || [];
  onProgress?.(`Generated ${injects.length} storyline injects`);

  return injects.map((inj) => ({
    ...inj,
    target_teams: [],
    inject_scope: 'universal',
  }));
}

// ─── Stage 4: Convergence Layer ─────────────────────────────────────────────

export async function generateConvergenceLayer(
  teamStorylines: Record<string, SocialInject[]>,
  npcs: NPCPersona[],
  factSheet: FactSheet,
  crisisContext: {
    crisisType: string;
    location: string;
    country: string;
    context: string;
    duration: number;
    orgName?: string;
  },
  blueprint?: ScenarioBlueprint | null,
): Promise<{
  sharedInjects: SocialInject[];
  convergenceGates: SocialInject[];
  narrative: { title: string; description: string; briefing: string };
  objectives: ObjectiveDef[];
  dimensionLabels: {
    public_trust: string;
    community_safety: string;
    narrative_control: string;
    escalation_risk: string;
  };
}> {
  const storylineSummary = Object.entries(teamStorylines)
    .map(
      ([team, injects]) =>
        `${team} (${injects.length} injects): ${injects.map((i) => `T+${i.trigger_time_minutes || '?'} ${i.title}`).join(', ')}`,
    )
    .join('\n\n');

  const npcHandles = npcs
    .map((p) => `${p.handle} (${p.name}, ${p.type}, bias: ${p.bias})`)
    .join(', ');

  const result = await callAI(
    `You are designing the SHARED EXPERIENCE layer for a social media crisis simulation. Multiple teams are running their own storylines in parallel. You must now create:

1. SCENARIO NARRATIVE: A compelling title, description (2-3 paragraphs), and team briefing.

2. OBJECTIVES: 4-6 measurable objectives for the overall exercise.

3. SHARED SOCIAL MEDIA CHAOS: 10-15 social posts that ALL teams see in their feeds. These create the ambient environment of a social media crisis — outrage, misinformation, supportive voices, breaking news, stakeholder reactions. The content should be appropriate to the specific crisis type described. These injects have inject_scope: "universal" and target_teams: []. IMPORTANT: For each social_feed inject, set "platform" in delivery_config to either "x_twitter" or "facebook". Aim for roughly 60% X/Twitter posts and 40% Facebook posts. X/Twitter posts should be short, punchy, hashtag-heavy. Facebook posts should be longer, more personal, community-oriented.

4. CONVERGENCE GATES: 5-8 condition-based injects that create CROSS-TEAM consequences. These fire based on what players do or don't do. Use these condition keys:
   - hate_post_unaddressed_count_gt_3
   - misinformation_unaddressed_10min
   - sentiment_below_30
   - sentiment_above_60
   - team_published_counter_narrative
   - team_flagged_misinformation
   - community_leader_contacted
   - player_post_count_gt_3
   - player_post_count_gt_5
   - rally_call_active
   - sop_step_monitor_completed / sop_step_monitor_overdue
   - sop_step_draft_completed / sop_step_draft_overdue
   - sop_step_publish_completed / sop_step_publish_overdue

   Each convergence gate should be a MAJOR escalation or de-escalation moment that feels like an organic consequence.

5. DIMENSION LABELS: Provide context-appropriate display names for the 4 scoring dimensions based on the crisis type. The dimensions measure the same underlying concepts but should be labeled to match this specific crisis:
   - public_trust: measures public/stakeholder trust in the response (e.g., "Consumer Trust", "Public Confidence", "Community Trust", "Investor Confidence")
   - community_safety: measures how safe/confident affected parties feel (e.g., "Brand Perception", "Customer Safety", "Community Safety", "Employee Morale")
   - narrative_control: measures who is winning the information narrative (e.g., "Media Narrative", "PR Control", "Narrative Control", "Information Dominance")
   - escalation_risk: measures risk of the crisis getting worse (e.g., "Boycott Risk", "Protest Risk", "Escalation Risk", "Regulatory Action Risk")

Storyline injects already created (design the shared chaos and convergence gates as organic consequences of these beats):
${storylineSummary}

NPCs: ${npcHandles}

Confirmed facts: ${factSheet.confirmed_facts.join('; ')}
False claims: ${factSheet.unconfirmed_claims.map((c) => c.claim).join('; ')}

CRITICAL: For ALL social_feed injects (shared and convergence), you MUST include "author_handle", "author_display_name", and "author_type" in delivery_config from the NPC list above. Never use "@system" or "System".

Return ONLY valid JSON:
{
  "narrative": { "title": "...", "description": "...", "briefing": "..." },
  "objectives": [{ "objective_id": "...", "objective_name": "...", "description": "...", "weight": 25 }],
  "shared_injects": [{ "trigger_time_minutes": 0, "type": "social_post", "title": "...", "content": "...", "severity": "...", "inject_scope": "universal", "target_teams": [], "delivery_config": { "app": "social_feed", "author_handle": "@npc", "author_display_name": "Name", "author_type": "npc_public", "platform": "x_twitter|facebook", ... } }],
  "convergence_gates": [{ "title": "...", "content": "...", "type": "social_post", "severity": "critical", "inject_scope": "universal", "target_teams": [], "delivery_config": { "app": "social_feed", "author_handle": "@npc", "author_display_name": "Name", "author_type": "npc_public", ... }, "conditions_to_appear": { "threshold": 1, "conditions": ["..."] }, "conditions_to_cancel": ["..."], "eligible_after_minutes": 10 }],
  "dimension_labels": { "public_trust": "...", "community_safety": "...", "narrative_control": "...", "escalation_risk": "..." }
}`,
    `Crisis: ${crisisContext.crisisType}${orgNameLine(crisisContext.orgName)} in ${crisisContext.location}, ${crisisContext.country}\nDuration: ${crisisContext.duration} minutes\nContext: ${crisisContext.context}${buildConvergenceGuidance(blueprint)}`,
    8000,
    0.8,
  );

  return {
    sharedInjects: (result?.shared_injects as SocialInject[]) || [],
    convergenceGates: (result?.convergence_gates as SocialInject[]) || [],
    narrative: (result?.narrative as { title: string; description: string; briefing: string }) || {
      title: `${crisisContext.crisisType} - Social Media Crisis`,
      description: `A crisis simulation set in ${crisisContext.location}.`,
      briefing: 'Monitor social media and coordinate your response.',
    },
    objectives: (result?.objectives as ObjectiveDef[]) || [
      {
        objective_id: 'response_time',
        objective_name: 'Timely Response',
        description: 'Respond to critical posts within deadlines',
        weight: 25,
      },
      {
        objective_id: 'counter_narrative',
        objective_name: 'Counter-Narrative',
        description: 'Publish effective counter-narratives',
        weight: 25,
      },
      {
        objective_id: 'misinfo_addressed',
        objective_name: 'Misinformation Addressed',
        description: 'Flag and debunk false claims',
        weight: 25,
      },
      {
        objective_id: 'coordination',
        objective_name: 'Team Coordination',
        description: 'Coordinate effectively across teams',
        weight: 25,
      },
    ],
    dimensionLabels: (result?.dimension_labels as {
      public_trust: string;
      community_safety: string;
      narrative_control: string;
      escalation_risk: string;
    }) || {
      public_trust: 'Public Trust',
      community_safety: 'Stakeholder Confidence',
      narrative_control: 'Narrative Control',
      escalation_risk: 'Escalation Risk',
    },
  };
}

// ─── Stage 5: Research + Best Practices ─────────────────────────────────────

async function researchTeamBestPractices(
  team: TeamDef,
  crisisType: string,
  context: string,
  storylineInjects: SocialInject[],
  orgName?: string,
): Promise<TeamBestPractice> {
  const injectSummary = storylineInjects
    .slice(0, 10)
    .map((i) => `T+${i.trigger_time_minutes || '?'}: ${i.title}`)
    .join(', ');

  const result = await callAI(
    `You are an expert researcher in crisis communication and social media response. Research the best practices for this team's role during this type of crisis. Analyze the crisis description to identify the specific type of crisis and tailor your research accordingly.

Team: "${team.team_name}" — ${team.team_description}

Based on real-world frameworks, academic research, and documented case studies relevant to this specific crisis type (e.g., crisis communication standards, industry regulations, PR best practices, regulatory guidelines), generate 4-8 specific, actionable guidelines.

Each guideline should specify:
- What the best practice IS (concrete, not vague)
- What source/framework it comes from
- What happens narratively if the team VIOLATES it (a consequence that would happen in-simulation)
- What happens narratively if the team FOLLOWS it (a reward that would happen in-simulation)
- What player actions would SIGNAL violation or compliance (detection signals the AI can monitor)

These guidelines will be used as a HIDDEN SCORING RUBRIC — players don't see them, but their actions are judged against them, and violations trigger organic in-world consequences rather than system warnings.

Return ONLY valid JSON:
{
  "team_name": "${team.team_name}",
  "guidelines": [{
    "guideline_id": "...",
    "best_practice": "...",
    "source_basis": "...",
    "timing_window": "within 15 minutes of incident",
    "if_violated": "...",
    "if_followed": "...",
    "detection_signals": ["player action or inaction that indicates this"]
  }]
}`,
    `Crisis: ${crisisType}${orgNameLine(orgName)}\nContext: ${context}\nTeam's storyline includes: ${injectSummary}`,
    8000,
  );

  return (result as unknown as TeamBestPractice) || { team_name: team.team_name, guidelines: [] };
}

async function researchGroupBestPractices(
  crisisType: string,
  context: string,
  teams: TeamDef[],
  orgName?: string,
): Promise<ResearchGuidelines['group_wide']> {
  const result = await callAI(
    `You are an expert researcher in inter-agency crisis coordination and social media crisis management.

Research GROUP-WIDE best practices for coordinating a multi-team social media crisis response. This covers:

1. COORDINATION GUIDELINES: How teams should share information and coordinate actions
2. ESCALATION PROTOCOLS: When and how to escalate issues up the chain or across teams
3. TIMING BENCHMARKS: Critical time thresholds (e.g., "first official response within 30 minutes", "misinformation debunked within 1 hour")
4. CASE STUDIES: 2-3 real-world examples of social media crises (positive or negative outcomes) with lessons learned

Teams in this exercise: ${teams.map((t) => `${t.team_name} (${t.team_description})`).join(', ')}

Return ONLY valid JSON:
{
  "coordination_guidelines": ["..."],
  "escalation_protocols": ["..."],
  "timing_benchmarks": { "first_response_minutes": 30, "misinformation_debunk_minutes": 60, ... },
  "case_studies": [{ "name": "...", "summary": "...", "lessons": ["..."] }]
}`,
    `Crisis: ${crisisType}${orgNameLine(orgName)}\nContext: ${context}`,
    8000,
  );

  return (
    (result as unknown as ResearchGuidelines['group_wide']) || {
      coordination_guidelines: [],
      escalation_protocols: [],
      timing_benchmarks: {},
      case_studies: [],
    }
  );
}

export async function researchBestPractices(
  crisisType: string,
  context: string,
  teams: TeamDef[],
  teamStorylines: Record<string, SocialInject[]>,
  onTeamComplete?: (teamName: string) => void,
): Promise<ResearchGuidelines> {
  const [teamResults, groupResult] = await Promise.all([
    Promise.all(
      teams.map(async (team) => {
        const bp = await researchTeamBestPractices(
          team,
          crisisType,
          context,
          teamStorylines[team.team_name] || [],
        );
        onTeamComplete?.(team.team_name);
        return bp;
      }),
    ),
    researchGroupBestPractices(crisisType, context, teams),
  ]);

  return {
    per_team: teamResults,
    group_wide: groupResult,
  };
}

// ─── Stage 5b: Strategic Action Benchmarks ──────────────────────────────────

export async function generateStrategicBenchmarks(
  crisisType: string,
  context: string,
  teams: TeamDef[],
  orgName?: string,
): Promise<StrategicActionBenchmark[]> {
  const result = await callAI(
    `You are generating strategic action benchmarks for a social media crisis simulation. These benchmarks define what the response team SHOULD do (based on crisis communication doctrine) and when they should do it.

For each benchmark, specify:
- What action is expected
- Which tier it belongs to (1=reactive like flagging, 2=strategic like drafting statements, 3=advanced like contacting leaders)
- Which team is primarily responsible
- What player_action type would detect it (post_flagged, email_sent, draft_published, fact_checked, post_created, escalated, etc.)
- Timing benchmark in minutes from session start (when should this be done by?)
- Which sentiment dimension it affects (public_trust, community_safety, narrative_control, escalation_risk)
- Numeric impact (+/- points on that dimension)
- Narrative consequence if done or missed (what NPC posts as a result)

Teams: ${teams.map((t) => t.team_name).join(', ')}

Generate 10-15 benchmarks covering the full response lifecycle.

Return ONLY valid JSON:
{ "benchmarks": [{ "action_id": "monitor_hate", "description": "Monitor and flag hate speech", "tier": 1, "team": "Social Media Monitoring", "doctrine_source": "UNESCO Handbook", "detection_action_type": "post_flagged", "timing_benchmark_minutes": 5, "sentiment_dimension": "narrative_control", "impact_if_done": 5, "impact_if_missed": -3, "consequence_if_done": "Monitoring team has identified key threats", "consequence_if_missed": "Hate speech is spreading unchecked" }] }`,
    `Crisis: ${crisisType}${orgNameLine(orgName)}\nContext: ${context}`,
    8000,
  );

  return (result?.benchmarks as StrategicActionBenchmark[]) || [];
}

// ─── Stage 6: Generate SOP from Research ────────────────────────────────────

export function buildSOPFromResearch(research: ResearchGuidelines): SOPDefinition {
  const steps: SOPStep[] = [
    {
      step_id: 'monitor',
      name: 'Activate Monitoring',
      description:
        'Begin real-time monitoring of all social media platforms for hate speech, misinformation, and inflammatory content',
      time_limit_minutes: 5,
    },
    {
      step_id: 'assess',
      name: 'Situation Assessment',
      description:
        'Assess the scale of online hate, identify key narratives and affected communities',
      time_limit_minutes: 10,
    },
    {
      step_id: 'fact_check',
      name: 'Fact Verification',
      description:
        'Cross-reference claims with official sources, document confirmed facts and debunk false claims',
      time_limit_minutes: 15,
    },
    {
      step_id: 'escalate',
      name: 'Escalate to Leadership',
      description: 'Brief leadership on situation, get approval for response strategy',
      time_limit_minutes: 20,
    },
    {
      step_id: 'draft',
      name: 'Draft Response',
      description:
        'Prepare official counter-narrative addressing key false claims and promoting unity',
      time_limit_minutes: 25,
    },
    {
      step_id: 'approve',
      name: 'Approve Response',
      description: 'Submit draft through approval channels',
      time_limit_minutes: 30,
    },
    {
      step_id: 'publish',
      name: 'Publish Response',
      description: 'Publish across all official channels simultaneously',
      time_limit_minutes: 35,
    },
    {
      step_id: 'engage',
      name: 'Community Engagement',
      description: 'Reach out to community leaders for amplification',
      time_limit_minutes: 40,
    },
    {
      step_id: 'monitor_impact',
      name: 'Monitor Impact',
      description: 'Track sentiment shift after response',
      time_limit_minutes: 50,
    },
    {
      step_id: 'report',
      name: 'Situation Report',
      description: 'Compile report with metrics',
      time_limit_minutes: 60,
    },
  ];

  const benchmarks = research.group_wide.timing_benchmarks || {};
  if (benchmarks.first_response_minutes) {
    const publishStep = steps.find((s) => s.step_id === 'publish');
    if (publishStep) publishStep.time_limit_minutes = benchmarks.first_response_minutes as number;
  }

  return {
    sop_name: 'Social Media Crisis Response Protocol',
    description: 'Generated from research-based best practices for social media crisis response',
    steps,
    response_time_limit_minutes: 60,
    content_guidelines: {
      tone: ['empathetic', 'calm', 'authoritative', 'factual'],
      avoid: [
        'defensive language',
        'naming suspects',
        'speculative claims',
        'dismissive tone',
        'victim blaming',
      ],
      include: [
        'verified facts only',
        'unity messaging',
        'helpline numbers',
        'official source references',
      ],
      language_sensitivity: [
        'avoid scapegoating any group, organization, or community',
        'use clear, factual language without speculation',
        'acknowledge stakeholder concerns without amplifying harmful narratives',
      ],
    },
  };
}

// ─── Stage 4b: Strategy Windows ──────────────────────────────────────────────

export interface StrategyWindow {
  strategy_id: string;
  strategy_name: string;
  success_injects: SocialInject[];
  backlash_injects: SocialInject[];
}

export async function generateStrategyWindows(
  crisisContext: {
    crisisType: string;
    location: string;
    country: string;
    context: string;
    duration: number;
    orgName?: string;
  },
  npcs: NPCPersona[],
  factSheet: FactSheet,
): Promise<StrategyWindow[]> {
  const npcHandles = npcs
    .slice(0, 8)
    .map((p) => `${p.handle} (${p.name}, ${p.type}, bias: ${p.bias})`)
    .join(', ');

  const result = await callAI(
    `You are designing STRATEGY WINDOWS for a social media crisis simulation. Strategy windows define what happens when the player team tries different communication strategies.

For each strategy below, generate:
1. SUCCESS BRANCH: 3 social media posts that appear as organic consequences when the strategy is well-timed (prerequisites met). These should feel like genuine public reactions.
2. BACKLASH BRANCH: 3 social media posts that appear when the strategy is poorly timed (prerequisites NOT met). These should feel like genuine backlash.

Strategies to cover:
- "humor_creative": Team posts humor/meme content
- "leader_amplification": Team contacts a community leader who then amplifies their message
- "multi_platform_blitz": Team publishes coordinated messaging across platforms
- "strategic_silence": Team deliberately does NOT engage with bait/troll posts

NPCs available: ${npcHandles}
Facts: ${factSheet.confirmed_facts.slice(0, 5).join('; ')}

Each inject should have: title, content (the social media post text), severity, delivery_config with app="social_feed" and appropriate author details from the NPC list.

SUCCESS injects should have conditions_to_appear requiring the strategy format + prerequisites (fact_check completed, official statement published, etc).
BACKLASH injects should fire when the strategy format is used WITHOUT prerequisites.

Return ONLY valid JSON:
{
  "windows": [
    {
      "strategy_id": "humor_creative",
      "strategy_name": "Humor/Creative Format",
      "success_injects": [
        { "title": "...", "content": "...", "type": "social_post", "severity": "medium", "inject_scope": "universal", "target_teams": [], "delivery_config": { "app": "social_feed", "author_handle": "@npc", "author_display_name": "Name", "author_type": "npc_public", "virality_score": 70 }, "conditions_to_appear": { "threshold": 3, "conditions": ["player_posted_creative_format", "sop_step_fact_check_completed", "official_response_exists"] }, "conditions_to_cancel": [], "eligible_after_minutes": 15 }
      ],
      "backlash_injects": [
        { "title": "...", "content": "...", "type": "social_post", "severity": "high", "inject_scope": "universal", "target_teams": [], "delivery_config": { "app": "social_feed", "author_handle": "@npc", "author_display_name": "Name", "author_type": "npc_public", "virality_score": 80 }, "conditions_to_appear": { "threshold": 1, "conditions": ["player_posted_creative_format"] }, "conditions_to_cancel": ["sop_step_fact_check_completed", "official_response_exists"] }
      ]
    }
  ]
}`,
    `Crisis: ${crisisContext.crisisType}${orgNameLine(crisisContext.orgName)} in ${crisisContext.location}, ${crisisContext.country}\nContext: ${crisisContext.context}\nDuration: ${crisisContext.duration} minutes`,
    8000,
    0.8,
  );

  const windows = (result?.windows as StrategyWindow[]) || [];
  return windows;
}

// ─── Org Page Generation ────────────────────────────────────────────────────

export interface OrgRosterEntry {
  name: string;
  facebook_handle?: string;
  x_handle?: string;
}

export interface OrgRosterInput {
  /** Extra protagonist-side organizations the players can control. */
  allies?: OrgRosterEntry[];
  /** Antagonist competitor brands. Trainer/AI-controlled rivals. */
  competitors?: OrgRosterEntry[];
  /** When true (default) and no competitors are named, invent one antagonist. */
  auto_antagonist?: boolean;
}

export async function generateOrgPageConfig(
  crisisDescription: string,
  country: string,
  orgName?: string,
  onProgress?: (msg: string) => void,
  logoUrl?: string,
  roster?: OrgRosterInput,
): Promise<OrgPageConfig> {
  onProgress?.('Generating organization page identity and branded history...');

  const result = await callAI(
    `You are creating the social media presence for the ORGANIZATION AT THE CENTER of a crisis simulation.
${orgName ? `\nIMPORTANT: The organization's name is "${orgName}". Use this exact name as the basis for the Facebook page name, X/Twitter handle, and all branded content.\n` : ''}
Based on the crisis description, generate:

1. The organization's FACEBOOK PAGE identity:
   - page_name: Official page name (e.g., "Meridian Pharmaceuticals", "NovaTech Solutions")
   - page_handle: Facebook handle (e.g., "@MeridianPharma")
   - page_bio: 1-2 sentence bio that sounds like a real company page
   - follower_count: realistic number for this type of organization

2. The organization's X/TWITTER account identity:
   - page_name: Display name (often shorter than Facebook)
   - page_handle: Twitter handle (e.g., "@MeridianPharma")
   - page_bio: shorter bio suited for Twitter
   - follower_count: realistic number

3. BRANDED HISTORY: 10-20 pre-crisis posts that this organization would have published in the weeks before the crisis broke. These create a realistic page timeline. Mix of:
   - Product/service announcements
   - Corporate social responsibility posts
   - Employee spotlights or team culture posts
   - Industry thought leadership
   - Customer testimonials or success stories
   - Event announcements
   - Seasonal/topical content

   For each post provide:
   - content: the post text (2-5 sentences, professional tone matching the org's voice)
   - platform: "facebook" or "x_twitter" (roughly 60% facebook, 40% twitter)
   - post_format: "text" for most, occasionally "infographic" or "video_concept"
   - days_ago: how many days before the crisis (range from 1 to 30)
   - media_description: optional description of an image/video attached (product photo, team photo, infographic, etc.)

Country: ${country}

Return ONLY valid JSON:
{
  "facebook": { "page_name": "...", "page_handle": "@...", "page_bio": "...", "follower_count": 50000 },
  "x_twitter": { "page_name": "...", "page_handle": "@...", "page_bio": "...", "follower_count": 30000 },
  "branded_history": [{ "content": "...", "platform": "facebook", "post_format": "text", "days_ago": 7, "media_description": "" }]
}`,
    `Crisis scenario: ${crisisDescription.substring(0, 500)}${orgNameLine(orgName)}\nCountry: ${country}`,
    8000,
    0.8,
  );

  onProgress?.('Organization page identity generated');

  const fb = (result?.facebook as OrgPagePlatformConfig) || {
    page_name: 'Organization Official',
    page_handle: '@OrgOfficial',
    page_bio: 'Official page',
    follower_count: 50000,
  };
  const tw = (result?.x_twitter as OrgPagePlatformConfig) || {
    page_name: 'Organization',
    page_handle: '@Org',
    page_bio: 'Official account',
    follower_count: 30000,
  };
  const history = ((result?.branded_history as BrandedHistoryPost[]) || []).slice(0, 20);

  let resolvedLogoUrl = logoUrl || '';
  if (!resolvedLogoUrl) {
    try {
      const { generatePostImage } = await import('./mediaGenerationService.js');
      const brandName = orgName || fb.page_name || 'Organization';
      onProgress?.('Generating brand logo...');
      const generatedUrl = await generatePostImage(
        `Professional company logo for "${brandName}". Clean, modern, suitable for a social media profile picture. Square format, centered icon or monogram on a solid background.`,
        'social_media_photo',
        `A ${country}-based organization involved in: ${crisisDescription.substring(0, 200)}`,
      );
      if (generatedUrl) resolvedLogoUrl = generatedUrl;
    } catch {
      // logo generation is non-critical
    }
  }

  if (resolvedLogoUrl) {
    fb.page_logo_url = resolvedLogoUrl;
    tw.page_logo_url = resolvedLogoUrl;
  }

  const primaryOrg: OrgConfig = {
    org_key: 'primary',
    display_name: orgName || fb.page_name || 'Organization',
    is_primary: true,
    role: 'protagonist',
    control_mode: 'player',
    facebook: fb,
    x_twitter: tw,
    branded_history: history,
  };

  const secondaryOrgs = await generateSecondaryOrgPages(
    crisisDescription,
    country,
    primaryOrg.display_name,
    roster,
    onProgress,
  );

  return {
    orgs: [primaryOrg, ...secondaryOrgs],
    facebook: fb,
    x_twitter: tw,
    branded_history: history,
  };
}

/**
 * Generate identities + per-org branded history for protagonist allies and
 * antagonist competitors. If no competitors are named and auto_antagonist is
 * not disabled, invent exactly one hostile rival brand.
 */
async function generateSecondaryOrgPages(
  crisisDescription: string,
  country: string,
  primaryName: string,
  roster: OrgRosterInput | undefined,
  onProgress?: (msg: string) => void,
): Promise<OrgConfig[]> {
  const allies = roster?.allies ?? [];
  const competitors = roster?.competitors ?? [];
  const autoAntagonist = roster?.auto_antagonist !== false;
  const inventAntagonist = competitors.length === 0 && autoAntagonist;

  if (allies.length === 0 && competitors.length === 0 && !inventAntagonist) {
    return [];
  }

  onProgress?.('Generating allied and rival brand pages...');

  const allyLines = allies.map((a, i) => `  ALLY ${i + 1}: ${a.name}`).join('\n');
  const compLines = competitors.map((c, i) => `  COMPETITOR ${i + 1}: ${c.name}`).join('\n');

  const result = await callAI(
    `You are creating social media presences for the SUPPORTING CAST of organizations around a crisis.
Primary organization in crisis: "${primaryName}". Country: ${country}.

For each organization below, generate a Facebook + X/Twitter identity and a short pre-crisis branded history (4-8 posts) in that brand's voice.

PROTAGONIST ALLIES (friendly to the primary org):
${allyLines || '  (none)'}

ANTAGONIST COMPETITORS (rival brands that will pressure the primary org; their voice should be competitive and opportunistic):
${compLines || '  (none)'}
${inventAntagonist ? '\nNO competitors were named: INVENT exactly ONE realistic rival/competitor brand appropriate to this crisis. Mark it auto_generated.' : ''}

For each org provide:
- org_role: "protagonist" for allies, "antagonist" for competitors/invented rival
- display_name
- facebook: { page_name, page_handle, page_bio, follower_count }
- x_twitter: { page_name, page_handle, page_bio, follower_count }
- stance: (antagonists only) 1 sentence on how this rival positions itself against "${primaryName}" (e.g. "positions itself as the safer, more transparent alternative")
- auto_generated: true ONLY for an invented antagonist
- branded_history: 4-8 pre-crisis posts: { content, platform ("facebook"|"x_twitter"), post_format ("text"|"infographic"|"video_concept"), days_ago (1-30), media_description }

Return ONLY valid JSON:
{ "orgs": [{ "org_role": "antagonist", "display_name": "...", "facebook": { "page_name": "...", "page_handle": "@...", "page_bio": "...", "follower_count": 40000 }, "x_twitter": { "page_name": "...", "page_handle": "@...", "page_bio": "...", "follower_count": 25000 }, "stance": "...", "auto_generated": false, "branded_history": [{ "content": "...", "platform": "facebook", "post_format": "text", "days_ago": 7, "media_description": "" }] }] }`,
    `Crisis scenario: ${crisisDescription.substring(0, 500)}`,
    9000,
    0.8,
  );

  const rawOrgs = (result?.orgs as Array<Record<string, unknown>>) || [];

  // Map requested handles by name so trainer-provided handles win where given.
  const handleByName = new Map<string, OrgRosterEntry>();
  for (const a of allies) handleByName.set(a.name.toLowerCase(), a);
  for (const c of competitors) handleByName.set(c.name.toLowerCase(), c);

  const orgs: OrgConfig[] = [];
  for (let i = 0; i < rawOrgs.length; i++) {
    const o = rawOrgs[i];
    const role: OrgRole = o.org_role === 'antagonist' ? 'antagonist' : 'protagonist';
    const displayName = String(o.display_name || `Organization ${i + 1}`);
    const requested = handleByName.get(displayName.toLowerCase());
    const fbCfg = (o.facebook as OrgPagePlatformConfig) || {
      page_name: displayName,
      page_handle: `@${displayName.replace(/[^\w]/g, '')}`,
      page_bio: '',
      follower_count: 20000,
    };
    const twCfg = (o.x_twitter as OrgPagePlatformConfig) || {
      page_name: displayName,
      page_handle: `@${displayName.replace(/[^\w]/g, '')}`,
      page_bio: '',
      follower_count: 15000,
    };
    if (requested?.facebook_handle) fbCfg.page_handle = requested.facebook_handle;
    if (requested?.x_handle) twCfg.page_handle = requested.x_handle;

    orgs.push({
      org_key: `org_${role}_${displayName.toLowerCase().replace(/[^\w]/g, '_')}_${i}`,
      display_name: displayName,
      is_primary: false,
      role,
      control_mode: role === 'antagonist' ? 'ai' : 'player',
      stance: o.stance ? String(o.stance) : undefined,
      auto_generated: o.auto_generated === true,
      facebook: fbCfg,
      x_twitter: twCfg,
      branded_history: (o.branded_history as BrandedHistoryPost[]) || [],
    });
  }

  logger.info(
    {
      allies: orgs.filter((o) => o.role === 'protagonist').length,
      antagonists: orgs.filter((o) => o.role === 'antagonist').length,
    },
    'Secondary org pages generated',
  );

  return orgs;
}

// ─── Full Assembly ──────────────────────────────────────────────────────────

export function assemblePayload(
  narrative: { title: string; description: string; briefing: string },
  teams: TeamDef[],
  objectives: ObjectiveDef[],
  npcs: NPCPersona[],
  factSheet: FactSheet,
  communities: string[],
  teamStorylines: Record<string, SocialInject[]>,
  sharedInjects: SocialInject[],
  convergenceGates: SocialInject[],
  research: ResearchGuidelines,
  sop: SOPDefinition,
  duration: number,
  strategyWindows?: StrategyWindow[],
  storylineInjects?: SocialInject[],
  dimensionLabels?: {
    public_trust: string;
    community_safety: string;
    narrative_control: string;
    escalation_risk: string;
  } | null,
  orgPageConfig?: OrgPageConfig | null,
  orgName?: string,
  blueprint?: ScenarioBlueprint | null,
): SocialCrisisPayload {
  const allStoryInjects: SocialInject[] = storylineInjects || [];
  if (!storylineInjects) {
    for (const injects of Object.values(teamStorylines)) {
      allStoryInjects.push(...injects);
    }
  }

  const strategyInjects: SocialInject[] = [];
  if (strategyWindows) {
    for (const window of strategyWindows) {
      if (window.success_injects) strategyInjects.push(...window.success_injects);
      if (window.backlash_injects) strategyInjects.push(...window.backlash_injects);
    }
  }

  const timeInjects = [
    ...allStoryInjects.filter((i) => i.trigger_time_minutes != null),
    ...sharedInjects,
  ];
  const conditionInjects = [...convergenceGates, ...strategyInjects];
  const decisionInjects = allStoryInjects.filter((i) => i.trigger_condition);

  const sentimentCurve = {
    baseline: 65,
    crisis_drop: -30,
    natural_recovery_per_10min: 2,
    good_response_boost: 10,
    poor_response_penalty: -8,
    hate_speech_penalty_per_unaddressed: -3,
    community_engagement_boost: 12,
  };

  return {
    scenario: {
      title: narrative.title,
      description: narrative.description,
      briefing: narrative.briefing,
      category: 'social_media_crisis',
      difficulty: 'expert',
      duration_minutes: duration,
      initial_state: {
        npc_personas: npcs,
        fact_sheet: factSheet,
        sentiment_curve: sentimentCurve,
        affected_communities: communities,
        research_guidelines: research,
        ...(orgPageConfig ? { org_page: orgPageConfig } : {}),
        ...(orgName ? { org_name: orgName } : {}),
        dimension_labels: dimensionLabels || {
          public_trust: 'Public Trust',
          community_safety: 'Stakeholder Confidence',
          narrative_control: 'Narrative Control',
          escalation_risk: 'Escalation Risk',
        },
        facebook_groups: communities.slice(0, 3).map((c, i) => ({
          name: `${c} Community`,
          group_type: i === 0 ? 'community' : i === 1 ? 'neighborhood' : 'official',
          member_count: 200 + Math.floor(Math.random() * 2000),
        })),
        ...(blueprint ? { blueprint } : {}),
      },
    },
    teams,
    objectives,
    sop,
    time_injects: timeInjects,
    condition_injects: conditionInjects,
    decision_injects: decisionInjects,
  };
}
