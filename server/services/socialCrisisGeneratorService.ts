import { logger } from '../lib/logger.js';
import { env } from '../env.js';

export interface NPCPersona {
  handle: string;
  name: string;
  type: 'npc_public' | 'npc_media' | 'npc_politician' | 'npc_influencer';
  personality: string;
  bias: string;
  follower_count: number;
}

export interface FactSheetEntry {
  claim: string;
  status: 'TRUE' | 'FALSE' | 'UNVERIFIED';
  truth: string;
}

export interface FactSheet {
  confirmed_facts: string[];
  unconfirmed_claims: FactSheetEntry[];
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

export interface SentimentCurve {
  baseline: number;
  crisis_drop: number;
  natural_recovery_per_10min: number;
  good_response_boost: number;
  poor_response_penalty: number;
  hate_speech_penalty_per_unaddressed: number;
  community_engagement_boost: number;
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
    };
  };
  teams: Array<{
    team_name: string;
    team_description: string;
    min_participants: number;
    max_participants: number;
  }>;
  objectives: Array<{
    objective_id: string;
    objective_name: string;
    description: string;
    weight: number;
    success_criteria?: Record<string, unknown>;
  }>;
  sop: SOPDefinition;
  time_injects: SocialInject[];
  condition_injects: SocialInject[];
  decision_injects: SocialInject[];
}

async function callAI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096,
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
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (err) {
    logger.error({ err }, 'Social crisis AI call failed');
    return null;
  }
}

const FALLBACK_COMMUNITIES: Record<string, string[]> = {
  racial_tension: [
    'Targeted ethnic minority community',
    'Mixed-race families and individuals',
    'Community leaders and advocacy groups',
  ],
  religious_incident: [
    'Targeted religious community',
    'Interfaith organizations',
    'Religious minority youth',
  ],
  xenophobic_attack: [
    'Foreign worker community',
    'Migrant families and dependents',
    'Employers of foreign workers',
  ],
  terror_aftermath: [
    'Muslim community',
    'South Asian community',
    'Interfaith and community harmony groups',
  ],
  police_incident: [
    'Targeted minority community',
    'Civil rights advocacy groups',
    'Law enforcement families',
  ],
  fake_news_spiral: [
    'Targeted ethnic community',
    'Small business owners from targeted community',
    'Parents and students from targeted community',
  ],
};

export async function suggestAffectedCommunities(
  crisisType: string,
  context: string,
  country: string,
): Promise<string[]> {
  const result = await callAI(
    `You are an expert in social cohesion and racial harmony crisis management. Given a crisis event, suggest which communities or demographic groups are most likely to be targeted by hate speech, misinformation, or scapegoating on social media in the aftermath.

Consider the country context and typical social media dynamics. Return 2-5 specific, named communities — not generic labels like "minority group" but concrete groups relevant to the crisis and country (e.g. "Muslim community", "South Asian migrant workers", "Indonesian domestic workers").

Return ONLY valid JSON: { "communities": ["community1", "community2", ...] }`,
    `Crisis type: ${crisisType}\nCountry: ${country}\nAdditional context: ${context || 'None'}`,
    512,
  );
  return (
    (result?.communities as string[]) ||
    FALLBACK_COMMUNITIES[crisisType] || ['Affected community', 'Advocacy groups']
  );
}

export async function suggestSocialCrisisTeams(
  crisisType: string,
  communities: string[],
): Promise<
  Array<{
    team_name: string;
    team_description: string;
    min_participants: number;
    max_participants: number;
  }>
> {
  const result = await callAI(
    `You are an expert in social media crisis response team structure. Given a crisis event and the communities being targeted online, suggest 4-6 response teams that a racial harmony / social cohesion organization would deploy.

Each team should have a clear, distinct role in the social media response effort.

Return ONLY valid JSON:
{ "teams": [{ "team_name": "...", "team_description": "...", "min_participants": 1, "max_participants": 4 }] }`,
    `Crisis: ${crisisType}\nTargeted communities: ${communities.join(', ')}`,
    1024,
  );

  return (
    (result?.teams as Array<{
      team_name: string;
      team_description: string;
      min_participants: number;
      max_participants: number;
    }>) || [
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

export async function generateSOPAndGuidelines(
  crisisType: string,
  communities: string[],
  teams: Array<{ team_name: string }>,
): Promise<SOPDefinition> {
  const result = await callAI(
    `You are an expert in crisis communication SOPs for racial harmony organizations. Generate a detailed Standard Operating Procedure for responding to hate speech and misinformation on social media during a crisis.

The SOP should have 8-12 sequential steps, each with a name, description, and time limit in minutes (from session start).

Also generate content guidelines specifying tone, language to avoid, mandatory inclusions, and cultural sensitivity rules.

Return ONLY valid JSON:
{
  "sop_name": "...",
  "description": "...",
  "steps": [{ "step_id": "monitor", "name": "...", "description": "...", "time_limit_minutes": 5 }],
  "response_time_limit_minutes": 60,
  "content_guidelines": {
    "tone": ["empathetic", "calm", ...],
    "avoid": ["defensive language", ...],
    "include": ["verified facts", ...],
    "language_sensitivity": ["avoid associating groups with attack", ...]
  }
}`,
    `Crisis: ${crisisType}\nAffected communities: ${communities.join(', ')}\nTeams: ${teams.map((t) => t.team_name).join(', ')}`,
    2048,
  );

  if (result) return result as unknown as SOPDefinition;

  return {
    sop_name: 'Social Media Crisis Response Protocol',
    description:
      'Standard procedure for responding to hate speech and misinformation during a crisis event',
    steps: [
      {
        step_id: 'monitor',
        name: 'Activate Monitoring',
        description: 'Begin real-time monitoring of all social media platforms',
        time_limit_minutes: 5,
      },
      {
        step_id: 'assess',
        name: 'Situation Assessment',
        description: 'Assess scale of online hate, identify key narratives',
        time_limit_minutes: 10,
      },
      {
        step_id: 'fact_check',
        name: 'Fact Verification',
        description: 'Cross-reference claims with official sources',
        time_limit_minutes: 15,
      },
      {
        step_id: 'escalate',
        name: 'Escalate to Leadership',
        description: 'Brief leadership, get approval for response strategy',
        time_limit_minutes: 20,
      },
      {
        step_id: 'draft',
        name: 'Draft Response',
        description: 'Prepare official counter-narrative',
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
        description: 'Publish across all official channels',
        time_limit_minutes: 35,
      },
      {
        step_id: 'engage',
        name: 'Community Engagement',
        description: 'Reach out to community leaders',
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
    ],
    response_time_limit_minutes: 60,
    content_guidelines: {
      tone: ['empathetic', 'calm', 'authoritative', 'factual'],
      avoid: ['defensive language', 'naming suspects', 'speculative claims', 'dismissive tone'],
      include: ['verified facts only', 'unity messaging', 'helpline numbers'],
      language_sensitivity: ['avoid associating any ethnic/religious group with the attack'],
    },
  };
}

export async function generateNPCPersonas(
  crisisType: string,
  communities: string[],
  country: string,
): Promise<NPCPersona[]> {
  const result = await callAI(
    `You are designing a social media crisis simulation. Generate 10 realistic NPC (non-player character) social media personas who will populate the simulated social media feed during a crisis.

Distribution:
- 3-4 hostile/hateful personas (spread hate, blame communities, share misinformation)
- 2 fearful/amplifier personas (scared, share unverified info, call for extreme action)
- 2-3 supportive/calm personas (call for unity, counter hate, share facts)
- 2 media personas (news outlets, factual reporting)

Each persona needs a realistic social media handle, display name appropriate to the country/culture, personality description, and bias indicator.

Country context: ${country}

Return ONLY valid JSON:
{ "personas": [{ "handle": "@username", "name": "Display Name", "type": "npc_public|npc_media|npc_politician|npc_influencer", "personality": "...", "bias": "anti-X|general xenophobia|none|...", "follower_count": 1000 }] }`,
    `Crisis: ${crisisType}\nTargeted communities: ${communities.join(', ')}\nCountry: ${country}`,
    2048,
  );

  return (result?.personas as NPCPersona[]) || [];
}

export async function generateFactSheet(
  crisisType: string,
  location: string,
  context: string,
): Promise<FactSheet> {
  const result = await callAI(
    `You are creating a fact sheet for a crisis simulation exercise. Generate realistic confirmed facts and false claims that would circulate on social media after a crisis event.

The confirmed facts should be things emergency services and police would confirm. The false claims should be the kind of misinformation and rumors that typically spread on social media after such events.

Return ONLY valid JSON:
{
  "confirmed_facts": ["fact1", "fact2", ...],
  "unconfirmed_claims": [{ "claim": "...", "status": "FALSE|UNVERIFIED", "truth": "..." }]
}`,
    `Crisis: ${crisisType}\nLocation: ${location}\nContext: ${context || 'Standard crisis scenario'}`,
    1536,
  );

  if (result) return result as unknown as FactSheet;

  return {
    confirmed_facts: [
      'Emergency services responding to the scene',
      'Police investigating the incident',
      'Area cordoned off for public safety',
    ],
    unconfirmed_claims: [
      { claim: 'Suspect identified', status: 'FALSE', truth: 'No suspect identified by police' },
    ],
  };
}

export async function generateFullScenario(input: {
  crisisType: string;
  location: string;
  country: string;
  context: string;
  communities: string[];
  teams: Array<{
    team_name: string;
    team_description: string;
    min_participants: number;
    max_participants: number;
  }>;
  sop: SOPDefinition;
  personas: NPCPersona[];
  factSheet: FactSheet;
  durationMinutes: number;
  difficulty: string;
  onProgress?: (phase: string, message: string) => void;
}): Promise<SocialCrisisPayload> {
  const {
    crisisType,
    location,
    country,
    context,
    communities,
    teams,
    sop,
    personas,
    factSheet,
    durationMinutes,
    difficulty,
    onProgress,
  } = input;

  onProgress?.('narrative', 'Generating scenario narrative and objectives...');

  const narrativeResult = await callAI(
    `You are an expert crisis simulation designer. Create a social media crisis response scenario.

The scenario is about a ${crisisType} in ${location}, ${country}. The crisis triggers hate speech and misinformation targeting ${communities.join(' and ')}.

Generate a compelling scenario with title, description (2-3 paragraphs setting the scene), briefing (instructions for the response team), and 4-6 measurable objectives.

Return ONLY valid JSON:
{
  "title": "...",
  "description": "...",
  "briefing": "...",
  "objectives": [{ "objective_id": "...", "objective_name": "...", "description": "...", "weight": 25 }]
}`,
    `Context: ${context || 'Standard crisis'}\nDuration: ${durationMinutes} minutes\nDifficulty: ${difficulty}\nTeams: ${teams.map((t) => t.team_name).join(', ')}`,
    2048,
  );

  const narrative = narrativeResult || {
    title: `${crisisType} - Social Media Crisis Response`,
    description: `A ${crisisType} has occurred in ${location}. Social media is flooding with hate speech targeting ${communities.join(' and ')}.`,
    briefing:
      'Your team must monitor social media, counter misinformation, and coordinate a response to maintain social harmony.',
    objectives: [
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
        objective_id: 'community_engagement',
        objective_name: 'Community Engagement',
        description: 'Coordinate with community leaders',
        weight: 25,
      },
    ],
  };

  onProgress?.('injects', 'Generating social media inject timeline...');

  const personaContext = personas
    .map(
      (p) =>
        `${p.handle} (${p.name}): ${p.type}, ${p.personality}, bias: ${p.bias}, followers: ${p.follower_count}`,
    )
    .join('\n');
  const factsContext = `Confirmed: ${factSheet.confirmed_facts.join('; ')}\nFalse claims: ${factSheet.unconfirmed_claims.map((c) => c.claim).join('; ')}`;

  const injectsResult = await callAI(
    `You are designing the inject timeline for a social media crisis simulation. Generate 18-25 timed injects that create a realistic escalation arc.

Available NPC personas:
${personaContext}

Facts and false claims:
${factsContext}

Teams: ${teams.map((t) => t.team_name).join(', ')}

Each inject must specify which simulated app it appears in via delivery_config:
- social_feed: Social media posts (most common, ~60% of injects)
- email: Emails from leadership, community leaders, journalists
- news: Breaking news articles
- group_chat: Internal team chat messages from NPCs
- phone_call: Incoming calls

Timeline should span 0 to ${durationMinutes} minutes. Early injects (T+0 to T+5) set the scene. Middle injects (T+5 to T+20) escalate with hate speech and misinformation. Late injects (T+20+) either continue escalation or show resolution depending on player actions.

Mark critical hate speech / misinformation posts with requires_response: true and a response_deadline_minutes.

For social_feed injects, include content_flags: { is_hate_speech, is_misinformation, is_racist, targets_group, factual_basis }.

Return ONLY valid JSON:
{ "time_injects": [{ "trigger_time_minutes": 0, "type": "social_post", "title": "...", "content": "...", "severity": "low|medium|high|critical", "inject_scope": "universal", "target_teams": [], "requires_response": false, "response_deadline_minutes": null, "delivery_config": { "app": "social_feed", "platform": "x_twitter", "author_handle": "@...", "author_display_name": "...", "author_type": "npc_public", "virality_score": 50, "content_flags": {}, "engagement_seed": { "likes": 100, "reposts": 30, "replies": 20 } } }] }`,
    `Crisis: ${crisisType} in ${location}, ${country}\nDuration: ${durationMinutes}min\nDifficulty: ${difficulty}`,
    8192,
    0.8,
  );

  onProgress?.('conditions', 'Generating escalation triggers...');

  const conditionsResult = await callAI(
    `You are designing condition-based escalation triggers for a social media crisis simulation. These injects fire when specific conditions are met (or not met) based on player actions.

Available condition keys:
- hate_post_unaddressed_count_gt_3 (more than 3 hate posts without response)
- misinformation_unaddressed_10min (misinfo unaddressed for 10+ min)
- sentiment_below_30 (public sentiment critically low)
- sentiment_above_60 (sentiment recovering)
- team_published_counter_narrative (team posted an official response)
- team_flagged_misinformation (team flagged a false claim)
- sop_step_monitor_completed, sop_step_assess_completed, sop_step_fact_check_completed, sop_step_escalate_completed, sop_step_draft_completed, sop_step_publish_completed
- sop_step_monitor_overdue, sop_step_assess_overdue, sop_step_draft_overdue, sop_step_publish_overdue
- player_post_count_gt_3 (team has posted 3+ responses)
- rally_call_active (NPC called for a rally, unaddressed)

Generate 6-10 condition-based injects. These create consequences for player action or inaction.

Return ONLY valid JSON:
{ "condition_injects": [{ "title": "...", "content": "...", "type": "social_post", "severity": "high", "inject_scope": "universal", "target_teams": [], "requires_response": false, "delivery_config": { "app": "social_feed", ... }, "conditions_to_appear": { "threshold": 1, "conditions": ["hate_post_unaddressed_count_gt_3"] }, "conditions_to_cancel": ["team_published_counter_narrative"], "eligible_after_minutes": 10 }] }`,
    `Crisis: ${crisisType}\nPersonas: ${personas.map((p) => p.handle).join(', ')}\nTeams: ${teams.map((t) => t.team_name).join(', ')}`,
    4096,
    0.7,
  );

  onProgress?.('decisions', 'Generating decision-based reactions...');

  const decisionsResult = await callAI(
    `You are designing decision-triggered reactions for a social media crisis simulation. These injects fire in response to specific types of player actions (posts, replies, flags).

Generate 4-6 decision-based injects that react to player behavior:
- When a player publishes a good counter-narrative → community leaders amplify
- When a player publishes without fact-checking → journalists question accuracy
- When a player engages a community leader → coalition forms
- When a player flags misinformation → platform takes notice

Each needs a trigger_condition in JSON format: { "type": "decision_based", "match_criteria": { "keywords": ["counter", "unity", "facts"] } }

Return ONLY valid JSON:
{ "decision_injects": [{ "trigger_condition": "{ ... JSON ... }", "title": "...", "content": "...", "type": "social_post", "severity": "medium", "inject_scope": "universal", "target_teams": [], "delivery_config": { "app": "social_feed", ... } }] }`,
    `Crisis: ${crisisType}\nPersonas: ${personas.map((p) => `${p.handle}: ${p.personality}`).join('; ')}`,
    2048,
    0.7,
  );

  onProgress?.('finalizing', 'Assembling scenario...');

  const timeInjects = (injectsResult?.time_injects || []) as SocialInject[];
  const conditionInjects = (conditionsResult?.condition_injects || []) as SocialInject[];
  const decisionInjects = (decisionsResult?.decision_injects || []) as SocialInject[];

  const sentimentCurve: SentimentCurve = {
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
      title: narrative.title as string,
      description: narrative.description as string,
      briefing: narrative.briefing as string,
      category: 'social_media_crisis',
      difficulty,
      duration_minutes: durationMinutes,
      initial_state: {
        npc_personas: personas,
        fact_sheet: factSheet,
        sentiment_curve: sentimentCurve,
        affected_communities: communities,
      },
    },
    teams,
    objectives: (narrative.objectives || []) as SocialCrisisPayload['objectives'],
    sop,
    time_injects: timeInjects,
    condition_injects: conditionInjects,
    decision_injects: decisionInjects,
  };
}
