import { logger } from '../lib/logger.js';
import { env } from '../env.js';

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
      sentiment_profile?: PublicSentimentProfile;
      dimension_labels?: {
        public_trust: string;
        community_safety: string;
        narrative_control: string;
        escalation_risk: string;
      };
      facebook_groups?: Array<{ name: string; group_type: string; member_count: number }>;
      dm_scenarios?: Array<{ trigger: string; delay_minutes: number; type: string }>;
      event_triggers?: Array<{ condition: string; event_type: string }>;
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

// ─── Stage 1: NPCs + Fact Sheet + Communities ───────────────────────────────

export async function generateNPCsAndFactSheet(
  crisisType: string,
  context: string,
  country: string,
  location: string,
): Promise<{ personas: NPCPersona[]; factSheet: FactSheet; communities: string[] }> {
  const result = await callAI(
    `You are an expert social media crisis simulation designer. You are creating a CHARACTER BIBLE for a crisis response training exercise.

IMPORTANT: First, carefully analyze the crisis description provided below. Identify the TYPE of crisis (e.g., product recall, corporate PR disaster, racial tension, religious incident, data breach, layoffs, environmental disaster, political scandal, etc.) and tailor ALL output to match the specific crisis dynamics. Do NOT assume the crisis is about racial or religious tension unless the description explicitly states so.

Given the crisis event, generate:

1. AFFECTED STAKEHOLDER GROUPS: 2-6 specific groups that will be most vocal and affected by this crisis. Name them concretely based on the crisis type. For example:
   - Product recall: "affected customers", "consumer safety advocates", "company shareholders", "industry competitors"
   - Corporate layoffs: "laid-off employees", "remaining workforce", "labor unions", "local community businesses"
   - Racial tension: specific ethnic/religious communities by name
   - Data breach: "affected users", "privacy advocates", "cybersecurity community", "regulators"

2. NPC PERSONAS: 10-15 fictional social media accounts that will populate the simulation. These are the characters whose posts the response team will encounter. Create a diverse, realistic cast appropriate to the crisis:
   - 4-6 HOSTILE/OUTRAGED personas: people spreading anger, misinformation, demands for accountability, calls for boycotts, or amplifying negative narratives. Each should have a distinct angle of attack relevant to this specific crisis.
   - 2-3 FEAR/AMPLIFIER personas: scared people who share unverified info, amplify rumors, demand extreme action out of fear or uncertainty.
   - 2-3 SUPPORTIVE/DEFENDER personas: voices of reason, industry experts, community advocates, or company defenders calling for calm and balanced perspective.
   - 2 MEDIA personas: news outlets or journalists reporting facts and seeking statements.
   - 1 WILDCARD: a politician, influencer, or public figure whose stance is ambiguous and can swing either way.

   For EACH persona provide:
   - handle (e.g. @angry_citizen_42)
   - name (culturally appropriate display name for the country)
   - type (npc_public, npc_media, npc_politician, npc_influencer)
   - personality (2-3 sentence character description)
   - bias (what drives their perspective, or "none" for neutral)
   - follower_count (realistic number)
   - backstory (2-3 sentences: who they are in real life, why they care about this crisis, what personal stake they have)
   - posting_pattern (how they behave online: frequency, style, what triggers them to post more)
   - specific_claims (array of 1-3 specific false claims, exaggerated narratives, or misleading angles THIS persona will push, or empty for factual/supportive personas)
   - image_prompts (array of 0-2 image descriptions for posts this persona would share — fake evidence, leaked documents, protest photos, product failure images, etc. Leave empty for personas who mainly post text.)

3. FACT SHEET: The ground truth for the simulation.
   - confirmed_facts: 6-10 facts that official sources have confirmed
   - unconfirmed_claims: 5-8 false or unverified claims circulating on social media, each with:
     - claim: what people are saying
     - status: FALSE or UNVERIFIED
     - truth: the actual truth
     - spread_by: array of NPC handles who spread this claim

Country: ${country}

Return ONLY valid JSON:
{
  "communities": ["..."],
  "personas": [{ "handle": "...", "name": "...", "type": "...", "personality": "...", "bias": "...", "follower_count": 0, "backstory": "...", "posting_pattern": "...", "specific_claims": ["..."], "image_prompts": ["..."] }],
  "fact_sheet": {
    "confirmed_facts": ["..."],
    "unconfirmed_claims": [{ "claim": "...", "status": "FALSE", "truth": "...", "spread_by": ["@handle1"] }]
  }
}`,
    `Crisis scenario: ${crisisType}\n${location ? `Location: ${location}, ` : ''}Country: ${country}\nDetailed context: ${context}`,
    8000,
    0.8,
  );

  const personas = (result?.personas as NPCPersona[]) || [];
  const factSheet = (result?.fact_sheet as FactSheet) || {
    confirmed_facts: [],
    unconfirmed_claims: [],
  };
  const communities = (result?.communities as string[]) || [];

  return { personas, factSheet, communities };
}

// ─── Stage 2: Teams ─────────────────────────────────────────────────────────

export async function suggestSocialCrisisTeams(
  crisisType: string,
  communities: string[],
  context: string,
  country: string,
): Promise<TeamDef[]> {
  const result = await callAI(
    `You are an expert in social media crisis response team structure. Given a crisis event, the affected stakeholder groups, and the country context, suggest 4-6 response teams that a crisis response organization would deploy.

Each team should have a clear, distinct role in the social media response effort. Consider the specific dynamics of this crisis and country when naming and describing teams.

Return ONLY valid JSON:
{ "teams": [{ "team_name": "...", "team_description": "...", "min_participants": 1, "max_participants": 4 }] }`,
    `Crisis: ${crisisType}\nCountry: ${country}\nTargeted communities: ${communities.join(', ')}\nContext: ${context}`,
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
- EMAILS (app: "email") addressed to this team from stakeholders relevant to their role. Use from_name and from_address matching real-world senders this team would hear from.
- DIRECT MESSAGES or GROUP CHAT (app: "group_chat") from NPCs or colleagues with tips, requests, or pressure.
- SOCIAL MEDIA POSTS (app: "social_feed") that are particularly relevant to this team's monitoring responsibility. Use the NPC personas and their specific claims. For social_feed injects, set "platform" in the delivery_config to either "x_twitter" or "facebook". Vary the platform -- short reactions and hashtag trends go on X/Twitter, longer community posts and group discussions go on Facebook.
- PHONE CALLS (app: "phone_call") from leadership or stakeholders demanding updates.

Each inject should create PRESSURE specific to this team's role. The storyline should have:
- An OPENING phase (T+0 to T+5): the team becomes aware of the crisis
- A BUILDING phase (T+5 to T+20): pressure intensifies, specific challenges emerge
- A PEAK phase (T+20 to T+40): maximum pressure, critical decisions needed
- A RESOLUTION phase (T+40+): consequences of actions start appearing

Mark critical injects with requires_response: true and response_deadline_minutes.

ALL injects must have target_teams: ["${team.team_name}"].

Available NPCs:
${npcContext}

Facts and claims:
${factsContext}

Return ONLY valid JSON:
{ "injects": [{ "trigger_time_minutes": 0, "type": "social_post|email_inbound|group_chat_message|phone_call", "title": "...", "content": "...", "severity": "low|medium|high|critical", "inject_scope": "team_specific", "target_teams": ["${team.team_name}"], "requires_response": false, "response_deadline_minutes": null, "delivery_config": { "app": "social_feed|email|group_chat|phone_call", ... } }] }`,
    `Crisis: ${crisisContext.crisisType} in ${crisisContext.location}, ${crisisContext.country}\nContext: ${crisisContext.context}\nDuration: ${crisisContext.duration} minutes`,
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
  crisisContext: { crisisType: string; country: string; context: string; duration: number },
  npcs: NPCPersona[],
  factSheet: FactSheet,
  onProgress?: (msg: string) => void,
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
- EMAILS (app: "email") from stakeholders, leadership, affected parties, journalists, regulators, and officials demanding information, offering help, or applying pressure.
- GROUP CHAT messages (app: "group_chat") with internal coordination challenges, tips from the public, leaked information, or whistleblower messages.
- PHONE CALLS (app: "phone_call") from senior leadership or media wanting statements.

The storyline should have a clear PRESSURE ARC:
- OPENING (T+0 to T+5): Crisis breaks. First social media posts appear. Team becomes aware.
- BUILDING (T+5 to T+15): Public outrage and misinformation intensify. Pressure mounts from multiple channels.
- ESCALATION (T+15 to T+30): Crisis peaks. Viral content, media pressure, stakeholder demands, and public anger reach maximum intensity.
- TURNING POINT (T+30 to T+45): Consequences of team actions (or inaction) start appearing. Narrative shifts based on response quality.
- RESOLUTION (T+45 to T+60): Final consequences. Either stabilization or further deterioration.

Mark critical injects with requires_response: true and response_deadline_minutes.
ALL injects must have inject_scope: "universal" and target_teams: [].

CRITICAL: For every social_feed inject, you MUST set "author_handle" and "author_display_name" in the delivery_config using one of the NPC personas below. Do NOT leave them blank or use "@system". Each social post must come from a specific NPC character.

Available NPCs:
${npcContext}

Facts and claims:
${factsContext}

Return ONLY valid JSON:
{ "injects": [{ "trigger_time_minutes": 0, "type": "social_post|email_inbound|group_chat_message|phone_call", "title": "...", "content": "...", "severity": "low|medium|high|critical", "inject_scope": "universal", "target_teams": [], "requires_response": false, "response_deadline_minutes": null, "delivery_config": { "app": "social_feed|email|group_chat|phone_call", "platform": "x_twitter|facebook", "author_handle": "@npc_handle", "author_display_name": "NPC Name", "author_type": "npc_public|npc_media|npc_politician|npc_influencer", ... } }] }`,
    `Crisis: ${crisisContext.crisisType}\nCountry: ${crisisContext.country}\nContext: ${crisisContext.context}\nDuration: ${crisisContext.duration} minutes`,
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

// ─── Research: General Best Practices (no teams) ────────────────────────────

export async function researchGeneralBestPractices(
  crisisType: string,
  context: string,
  onProgress?: (msg: string) => void,
): Promise<ResearchGuidelines> {
  onProgress?.('Researching crisis communication best practices...');

  const [perTeamResult, groupResult] = await Promise.all([
    callAI(
      `You are an expert researcher in crisis communication and social media response.

IMPORTANT: First analyze the crisis description below to identify the type of crisis, then research best practices RELEVANT to that specific crisis type. For example, a product recall crisis needs consumer safety and supply chain communication frameworks, while a racial tension crisis needs community cohesion frameworks.

Research general best practices for a social media crisis response team handling this specific type of crisis. This covers the FULL range of crisis communication activities that any responder should know.

Based on real-world frameworks relevant to this crisis type (e.g., crisis communication standards, industry-specific guidelines, regulatory frameworks, established PR crisis management protocols), generate 8-12 specific, actionable guidelines.

Each guideline should specify:
- What the best practice IS (concrete, not vague)
- What source/framework it comes from
- What happens narratively if VIOLATED (consequence in simulation)
- What happens narratively if FOLLOWED (reward in simulation)
- What player actions would SIGNAL violation or compliance

Return ONLY valid JSON:
{
  "team_name": "Crisis Response Team",
  "guidelines": [{
    "guideline_id": "...",
    "best_practice": "...",
    "source_basis": "...",
    "timing_window": "...",
    "if_violated": "...",
    "if_followed": "...",
    "detection_signals": ["..."]
  }]
}`,
      `Crisis: ${crisisType}\nContext: ${context}`,
      8000,
    ),
    callAI(
      `You are an expert researcher in crisis coordination and social media crisis management.

IMPORTANT: First analyze the crisis description below to identify the type of crisis, then research coordination practices RELEVANT to that specific crisis type.

Research best practices for coordinating a social media crisis response for this specific type of crisis. Cover:

1. COORDINATION GUIDELINES: How the response team should share information and coordinate actions
2. ESCALATION PROTOCOLS: When and how to escalate issues to leadership, regulators, law enforcement, or platform operators (adapt to the crisis type)
3. TIMING BENCHMARKS: Critical time thresholds relevant to this crisis type (e.g., "first official response within 30 minutes", "corrective statement within 2 hours")
4. CASE STUDIES: 2-3 real-world examples of similar crises with lessons learned — choose cases that match the crisis type described below

Base this on established frameworks relevant to this crisis type (crisis communication standards, industry regulations, PR best practices, etc.).

Return ONLY valid JSON:
{
  "coordination_guidelines": ["..."],
  "escalation_protocols": ["..."],
  "timing_benchmarks": { "first_response_minutes": 30, "misinformation_debunk_minutes": 60 },
  "case_studies": [{ "name": "...", "summary": "...", "lessons": ["..."] }]
}`,
      `Crisis: ${crisisType}\nContext: ${context}`,
      8000,
    ),
  ]);

  onProgress?.('Best practices research complete');

  const teamBP = (perTeamResult as unknown as TeamBestPractice) || {
    team_name: 'Crisis Response Team',
    guidelines: [],
  };

  const groupBP = (groupResult as unknown as ResearchGuidelines['group_wide']) || {
    coordination_guidelines: [],
    escalation_protocols: [],
    timing_benchmarks: {},
    case_studies: [],
  };

  return {
    per_team: [teamBP],
    group_wide: groupBP,
  };
}

// ─── Public Sentiment Research ──────────────────────────────────────────────

export interface PublicSentimentProfile {
  analogous_cases: Array<{
    name: string;
    year: number;
    similarity_rationale: string;
    key_lessons: string[];
    sentiment_timeline: string;
  }>;
  expected_reaction_arc: {
    phase_1_shock: {
      duration_minutes: number;
      dominant_emotions: string[];
      key_behaviors: string[];
    };
    phase_2_outrage: {
      duration_minutes: number;
      dominant_emotions: string[];
      key_behaviors: string[];
    };
    phase_3_blame: {
      duration_minutes: number;
      dominant_emotions: string[];
      key_behaviors: string[];
    };
    phase_4_demand: {
      duration_minutes: number;
      dominant_emotions: string[];
      key_behaviors: string[];
    };
    phase_5_resolution: { dominant_emotions: string[]; key_behaviors: string[] };
  };
  platform_behaviors: Array<{
    platform: string;
    typical_content_style: string;
    virality_pattern: string;
    key_hashtag_patterns: string[];
  }>;
  demographic_splits: Array<{
    group: string;
    likely_stance: string;
    intensity: number;
    key_concerns: string[];
  }>;
  cultural_factors: string[];
  counter_narrative_effectiveness: Array<{
    strategy: string;
    historical_success_rate: string;
    timing_requirement: string;
    risk: string;
  }>;
}

export async function researchPublicSentiment(
  crisisDescription: string,
  country: string,
  onProgress?: (msg: string) => void,
): Promise<PublicSentimentProfile> {
  onProgress?.('Analyzing crisis scenario to identify analogous real-world cases...');

  const [casesResult, reactionsResult] = await Promise.all([
    callAI(
      `You are an expert social media analyst and crisis communications researcher. Your task is to deeply analyze a crisis scenario and research how the PUBLIC actually reacts on social media and public forums to analogous real-world crises.

Given the crisis description, you must:

1. IDENTIFY 3-5 ANALOGOUS REAL-WORLD CRISES that are similar in nature. For example:
   - If the crisis is a product recall: Samsung Galaxy Note 7 (2016), Boeing 737 MAX (2019), Johnson & Johnson Tylenol (1982)
   - If the crisis is corporate layoffs: Twitter/X mass layoffs (2022), Google layoffs (2023), Meta layoffs (2022)
   - If the crisis is a data breach: Equifax (2017), Facebook-Cambridge Analytica (2018), Yahoo (2016)
   - If the crisis is racial tension: Christchurch shooting aftermath (2019), George Floyd protests (2020)

2. For EACH analogous case, provide:
   - name: the case name
   - year: when it happened
   - similarity_rationale: why this is analogous to the current scenario
   - key_lessons: 2-3 key lessons about how public sentiment evolved
   - sentiment_timeline: a 1-2 sentence description of how public sentiment shifted over time

3. Analyze PLATFORM-SPECIFIC BEHAVIORS for this type of crisis:
   - X/Twitter: typical content style, virality patterns, common hashtag patterns
   - Facebook: typical content style, group dynamics, community formation patterns
   - Reddit: typical content style, subreddit dynamics, analysis patterns
   - TikTok: typical content style, video trends, commentary patterns

4. Identify DEMOGRAPHIC SPLITS in sentiment:
   - Which groups support which sides
   - Intensity of each group's reaction (1-10 scale)
   - Key concerns for each group

Country context: ${country} — factor in how this country's population specifically tends to react to this type of crisis. Consider cultural norms, media landscape, government trust levels, and social media penetration.

Return ONLY valid JSON:
{
  "analogous_cases": [{ "name": "...", "year": 2020, "similarity_rationale": "...", "key_lessons": ["..."], "sentiment_timeline": "..." }],
  "platform_behaviors": [{ "platform": "X/Twitter", "typical_content_style": "...", "virality_pattern": "...", "key_hashtag_patterns": ["#..."] }],
  "demographic_splits": [{ "group": "...", "likely_stance": "...", "intensity": 7, "key_concerns": ["..."] }],
  "cultural_factors": ["..."]
}`,
      `Crisis scenario: ${crisisDescription}\nCountry: ${country}`,
      10000,
      0.5,
    ),
    callAI(
      `You are an expert in public sentiment dynamics and crisis communication strategy. Analyze how the public typically reacts to this type of crisis and what counter-narrative strategies are most effective.

1. EXPECTED REACTION ARC: Map out the typical emotional trajectory of public response in 5 phases. For each phase, specify:
   - duration_minutes: how long this phase typically lasts in a social media crisis (compressed for simulation, so scale to a 60-minute exercise)
   - dominant_emotions: the primary emotions driving public behavior in this phase
   - key_behaviors: what people actually DO on social media during this phase

   Phases:
   - phase_1_shock: Initial reaction when the crisis becomes public
   - phase_2_outrage: Peak anger and viral spread
   - phase_3_blame: Public assigns blame and demands accountability
   - phase_4_demand: Organized calls for action (boycotts, investigations, resignations, etc.)
   - phase_5_resolution: The crisis begins to resolve or fatigue sets in

2. COUNTER-NARRATIVE EFFECTIVENESS: For each common response strategy, analyze:
   - strategy: what the response team might do
   - historical_success_rate: how often this strategy has worked historically (low/medium/high)
   - timing_requirement: when this strategy must be deployed to be effective
   - risk: what can go wrong if this strategy backfires

Country: ${country} — consider how this country's population responds to corporate/institutional apologies, government intervention, and community organizing.

Return ONLY valid JSON:
{
  "expected_reaction_arc": {
    "phase_1_shock": { "duration_minutes": 5, "dominant_emotions": ["..."], "key_behaviors": ["..."] },
    "phase_2_outrage": { "duration_minutes": 10, "dominant_emotions": ["..."], "key_behaviors": ["..."] },
    "phase_3_blame": { "duration_minutes": 15, "dominant_emotions": ["..."], "key_behaviors": ["..."] },
    "phase_4_demand": { "duration_minutes": 15, "dominant_emotions": ["..."], "key_behaviors": ["..."] },
    "phase_5_resolution": { "dominant_emotions": ["..."], "key_behaviors": ["..."] }
  },
  "counter_narrative_effectiveness": [{ "strategy": "...", "historical_success_rate": "medium", "timing_requirement": "within first 30 minutes", "risk": "..." }]
}`,
      `Crisis scenario: ${crisisDescription}\nCountry: ${country}`,
      8000,
      0.5,
    ),
  ]);

  onProgress?.('Compiling public sentiment profile...');

  const cases = casesResult || {};
  const reactions = reactionsResult || {};

  const profile: PublicSentimentProfile = {
    analogous_cases: (cases.analogous_cases as PublicSentimentProfile['analogous_cases']) || [],
    expected_reaction_arc:
      (reactions.expected_reaction_arc as PublicSentimentProfile['expected_reaction_arc']) || {
        phase_1_shock: {
          duration_minutes: 5,
          dominant_emotions: ['shock', 'disbelief'],
          key_behaviors: ['sharing news'],
        },
        phase_2_outrage: {
          duration_minutes: 10,
          dominant_emotions: ['anger', 'frustration'],
          key_behaviors: ['demanding answers'],
        },
        phase_3_blame: {
          duration_minutes: 15,
          dominant_emotions: ['blame', 'suspicion'],
          key_behaviors: ['finger-pointing'],
        },
        phase_4_demand: {
          duration_minutes: 15,
          dominant_emotions: ['determination', 'solidarity'],
          key_behaviors: ['organized pressure'],
        },
        phase_5_resolution: {
          dominant_emotions: ['fatigue', 'cautious optimism'],
          key_behaviors: ['monitoring'],
        },
      },
    platform_behaviors:
      (cases.platform_behaviors as PublicSentimentProfile['platform_behaviors']) || [],
    demographic_splits:
      (cases.demographic_splits as PublicSentimentProfile['demographic_splits']) || [],
    cultural_factors: (cases.cultural_factors as string[]) || [],
    counter_narrative_effectiveness:
      (reactions.counter_narrative_effectiveness as PublicSentimentProfile['counter_narrative_effectiveness']) ||
      [],
  };

  onProgress?.(
    `Sentiment research complete: ${profile.analogous_cases.length} analogous cases analyzed`,
  );

  return profile;
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
  },
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

Per-team storylines already created:
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
    `Crisis: ${crisisContext.crisisType} in ${crisisContext.location}, ${crisisContext.country}\nDuration: ${crisisContext.duration} minutes\nContext: ${crisisContext.context}`,
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
    `Crisis: ${crisisType}\nContext: ${context}\nTeam's storyline includes: ${injectSummary}`,
    8000,
  );

  return (result as unknown as TeamBestPractice) || { team_name: team.team_name, guidelines: [] };
}

async function researchGroupBestPractices(
  crisisType: string,
  context: string,
  teams: TeamDef[],
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
    `Crisis: ${crisisType}\nContext: ${context}`,
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
    `Crisis: ${crisisType}\nContext: ${context}`,
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
    `Crisis: ${crisisContext.crisisType} in ${crisisContext.location}, ${crisisContext.country}\nContext: ${crisisContext.context}\nDuration: ${crisisContext.duration} minutes`,
    8000,
    0.8,
  );

  const windows = (result?.windows as StrategyWindow[]) || [];
  return windows;
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
  sentimentProfile?: PublicSentimentProfile | null,
  dimensionLabels?: {
    public_trust: string;
    community_safety: string;
    narrative_control: string;
    escalation_risk: string;
  } | null,
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

  const sentimentCurve = sentimentProfile?.expected_reaction_arc
    ? {
        baseline: 65,
        crisis_drop: -35,
        natural_recovery_per_10min: 2,
        good_response_boost: 10,
        poor_response_penalty: -8,
        hate_speech_penalty_per_unaddressed: -3,
        community_engagement_boost: 12,
      }
    : {
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
        ...(sentimentProfile ? { sentiment_profile: sentimentProfile } : {}),
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
        dm_scenarios: [
          { trigger: 'session_start', delay_minutes: 2, type: 'journalist_inquiry' },
          { trigger: 'escalation_high', delay_minutes: 0, type: 'community_leader_plea' },
          { trigger: 'player_good_response', delay_minutes: 1, type: 'supportive_dm' },
        ],
        event_triggers: [
          { condition: 'escalation_risk > 60', event_type: 'protest' },
          { condition: 'narrative_control > 60', event_type: 'solidarity' },
          { condition: 'elapsed_minutes > 15', event_type: 'vigil' },
        ],
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
