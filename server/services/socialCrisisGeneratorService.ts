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

Given the crisis event, generate:

1. AFFECTED COMMUNITIES: 2-6 specific communities that will be targeted by hate speech and misinformation in this crisis. Name them concretely (e.g. "Malay-Muslim community" not "minority group"). If the crisis type is compound (multiple types separated by " + "), each crisis dimension may target different communities.

2. NPC PERSONAS: 10-15 fictional social media accounts that will populate the simulation. These are the characters whose posts the response team will encounter. Create a diverse, realistic cast:
   - 4-6 HOSTILE personas: people spreading hate speech, racist content, calls for violence, scapegoating. IMPORTANT: If the crisis type contains multiple dimensions (e.g. "racial_tension + religious_incident"), ensure hostile personas attack from DIFFERENT angles — some from the racial angle, some from the religious angle, some from the xenophobic angle. Each persona should have a distinct attack vector, not all the same.
   - 2-3 FEAR/AMPLIFIER personas: scared people who share unverified info, amplify rumors, demand extreme action out of fear.
   - 2-3 SUPPORTIVE personas: interfaith leaders, community advocates, reasonable voices calling for calm and unity.
   - 2 MEDIA personas: news outlets or journalists reporting facts.
   - 1 WILDCARD: a politician, influencer, or public figure whose stance is ambiguous and can swing either way.

   For EACH persona provide:
   - handle (e.g. @angry_citizen_42)
   - name (culturally appropriate display name for the country)
   - type (npc_public, npc_media, npc_politician, npc_influencer)
   - personality (2-3 sentence character description)
   - bias (what prejudice drives them, or "none" for neutral)
   - follower_count (realistic number)
   - backstory (2-3 sentences: who they are in real life, why they care about this crisis, what personal stake they have)
   - posting_pattern (how they behave online: frequency, style, what triggers them to post more)
   - specific_claims (array of 1-3 specific false claims or narratives THIS persona will push, or empty for factual/supportive personas)
   - image_prompts (array of 0-2 image descriptions for posts this persona would share. Hostile personas should have prompts for fake evidence photos, manipulated images, or inflammatory memes. Media personas should have news photo prompts. Supportive personas can have unity/community images. Leave empty for personas who mainly post text.)

3. FACT SHEET: The ground truth for the simulation.
   - confirmed_facts: 6-10 facts that emergency services and police have confirmed
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
    `Crisis type: ${crisisType}${crisisType.includes('+') ? '\nNOTE: This is a COMPOUND crisis — multiple crisis types are happening simultaneously. Generate NPCs that cover each dimension with distinct attack angles.' : ''}\n${location ? `Location: ${location}, ` : ''}Country: ${country}\nContext: ${context}`,
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
    `You are an expert in social media crisis response team structure. Given a crisis event, the communities being targeted online, and the country context, suggest 4-6 response teams that a racial harmony / social cohesion organization would deploy.

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

The injects should be a MIX of:
- SOCIAL MEDIA POSTS (app: "social_feed") from NPC personas spreading hate speech, misinformation, fear, and some supportive voices. For social_feed injects, set "platform" in delivery_config to either "x_twitter" or "facebook". Aim for 60% X/Twitter and 40% Facebook. X posts are short and hashtag-heavy; Facebook posts are longer and more personal.
- EMAILS (app: "email") from stakeholders, leadership, community leaders, journalists, and government officials demanding information, offering help, or applying pressure.
- GROUP CHAT messages (app: "group_chat") with internal coordination challenges, tips from the public, or leaked information.
- PHONE CALLS (app: "phone_call") from senior leadership or media wanting statements.

The storyline should have a clear PRESSURE ARC:
- OPENING (T+0 to T+5): Crisis breaks. First social media posts appear. Team becomes aware.
- BUILDING (T+5 to T+15): Hate speech and misinformation intensify. Pressure mounts from multiple channels.
- ESCALATION (T+15 to T+30): Crisis peaks. Rally calls, viral misinformation, media pressure, community fear.
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
      `You are an expert researcher in crisis communication, social media response, and racial/religious harmony.

Research general best practices for a social media crisis response team. This is NOT for a specific team role -- it covers the FULL range of crisis communication activities that any responder should know.

Based on real-world frameworks (UNESCO Handbook on Countering Online Hate Speech, Christchurch Call protocols, IMDA Singapore guidelines, EU Code of Practice on Disinformation), generate 8-12 specific, actionable guidelines.

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

Research best practices for coordinating a social media crisis response. Cover:

1. COORDINATION GUIDELINES: How the response team should share information and coordinate actions
2. ESCALATION PROTOCOLS: When and how to escalate issues to leadership, law enforcement, or platform operators
3. TIMING BENCHMARKS: Critical time thresholds (e.g., "first official response within 30 minutes", "misinformation debunked within 1 hour")
4. CASE STUDIES: 2-3 real-world examples of social media crises with lessons learned

Base this on established frameworks: UNESCO, Christchurch Call, IMDA, EU Code of Practice on Disinformation.

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

3. SHARED SOCIAL MEDIA CHAOS: 10-15 social posts that ALL teams see in their feeds. These create the ambient environment of a social media crisis — hate speech, misinformation, supportive voices, breaking news. These should use the NPC personas and their claims. These injects have inject_scope: "universal" and target_teams: []. IMPORTANT: For each social_feed inject, set "platform" in delivery_config to either "x_twitter" or "facebook". Aim for roughly 60% X/Twitter posts and 40% Facebook posts. X/Twitter posts should be short, punchy, hashtag-heavy. Facebook posts should be longer, more personal, community-oriented.

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
  "convergence_gates": [{ "title": "...", "content": "...", "type": "social_post", "severity": "critical", "inject_scope": "universal", "target_teams": [], "delivery_config": { "app": "social_feed", "author_handle": "@npc", "author_display_name": "Name", "author_type": "npc_public", ... }, "conditions_to_appear": { "threshold": 1, "conditions": ["..."] }, "conditions_to_cancel": ["..."], "eligible_after_minutes": 10 }]
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
    `You are an expert researcher in crisis communication, social media response, and racial harmony. Research the best practices for this team's role during this type of crisis.

Team: "${team.team_name}" — ${team.team_description}

Based on real-world frameworks, academic research, and documented case studies (e.g., UNESCO Handbook on Countering Online Hate Speech, Christchurch Call protocols, IMDA Singapore guidelines, EU Code of Practice on Disinformation), generate 4-8 specific, actionable guidelines.

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
        'avoid associating any ethnic/religious group with the attack',
        'use person-first language',
        'acknowledge community fears without validating hate',
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
): SocialCrisisPayload {
  // Support both team-based (legacy) and unified (new) storyline modes
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
        sentiment_curve: {
          baseline: 65,
          crisis_drop: -30,
          natural_recovery_per_10min: 2,
          good_response_boost: 10,
          poor_response_penalty: -8,
          hate_speech_penalty_per_unaddressed: -3,
          community_engagement_boost: 12,
        },
        affected_communities: communities,
        research_guidelines: research,
        facebook_groups: communities.slice(0, 3).map((c, i) => ({
          name: `${c} Community`,
          group_type: i === 0 ? 'community' : i === 1 ? 'religious' : 'neighborhood',
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
