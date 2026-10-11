// Synthetic, fictional fixtures used ONLY to populate the unmodified Prophyion frontend for
// documentation screenshots. No LLM call, database or client data is involved. The scenario,
// organisation and every persona below are invented for this case study.

export const SESSION_ID = '00000000-0000-4000-8000-0000000000a1';
export const SCENARIO_ID = '00000000-0000-4000-8000-0000000000b1';
export const USER_ID = '00000000-0000-4000-8000-0000000000c1';
export const TRAINER_ID = '00000000-0000-4000-8000-0000000000c2';

const now = Date.now();
const minsAgo = (m) => new Date(now - m * 60_000).toISOString();

export const personas = [
  {
    handle: '@mara_vance',
    name: 'Mara Vance',
    type: 'npc_media',
    personality:
      'Methodical regional reporter. Asks for batch numbers and timelines; publishes on one usable fact.',
    bias: 'none',
    follower_count: 48200,
    backstory: 'Ten years covering food safety; burned once by a retracted recall story.',
    posting_pattern: 'Replies within minutes to official statements; quotes the wording back.',
    specific_claims: [],
    country: 'Singapore',
    tier: 'key',
  },
  {
    handle: '@tomasz_kowal',
    name: 'Tomasz Kowal',
    type: 'npc_public',
    personality:
      'Anxious father of two. Believes the first thing he reads; calms down when answered directly.',
    bias: 'distrusts large food companies',
    follower_count: 640,
    backstory: 'Bought two cartons from the affected chiller last Thursday.',
    posting_pattern: 'Posts at night, tags brands and journalists.',
    specific_claims: ['Both children were unwell after drinking the milk'],
    country: 'Singapore',
    tier: 'key',
  },
  {
    handle: '@dr_ines_okafor',
    name: 'Dr Ines Okafor',
    type: 'npc_public',
    personality:
      'Paediatrician who keeps a balanced, reasonable tone and cites official guidance. Supportive of clear, specific advice.',
    bias: 'none',
    follower_count: 12900,
    backstory: 'Sees the clinic cases first-hand and wants usable guidance for parents.',
    posting_pattern: 'Short, calm threads; corrects rumours politely.',
    specific_claims: [],
    country: 'Singapore',
    tier: 'key',
  },
  {
    handle: '@freshfield_foods',
    name: 'Freshfield Foods',
    type: 'npc_public',
    personality:
      'Rival dairy brand. Professional, strategic; positions its own testing record. A competitor.',
    bias: 'competitive',
    follower_count: 88400,
    backstory: 'Competes for the same supermarket shelf space.',
    posting_pattern: 'Opportunistic, polished brand voice.',
    specific_claims: [],
    country: 'Singapore',
    tier: 'key',
  },
  {
    handle: '@cllr_dan_reyes',
    name: 'Cllr Dan Reyes',
    type: 'npc_politician',
    personality:
      'Local councillor under pressure from parents in his ward. Demands an inquiry and a named accountable executive.',
    bias: 'populist',
    follower_count: 21800,
    backstory: 'Faces re-election; has campaigned on food-safety enforcement.',
    posting_pattern: 'Formal statements, picks up viral posts.',
    specific_claims: [],
    country: 'Singapore',
    tier: 'key',
  },
  {
    handle: '@wellness_wren',
    name: 'Wren | Clean Eating',
    type: 'npc_influencer',
    personality:
      'Wellness influencer who amplifies unverified claims; dismisses official statements as spin.',
    bias: 'anti-institution',
    follower_count: 312000,
    backstory: 'Her audience grew 40% during the last food scare.',
    posting_pattern: 'Emotive short posts with a product link in the thread.',
    specific_claims: ['The recall batch was "hidden for a week"'],
    country: 'Singapore',
    tier: 'key',
  },
  {
    handle: '@grace_lim_farm',
    name: 'Grace Lim',
    type: 'npc_public',
    personality:
      'Dairy-farm co-op member and community advocate. Supportive, defends the farmers, asks what support is available.',
    bias: 'none',
    follower_count: 2100,
    backstory: 'Her family supplies milk to the co-op.',
    posting_pattern: 'Warm, community-minded replies.',
    specific_claims: [],
    country: 'Singapore',
    tier: 'key',
  },
];

const base = (o) => ({
  hashtags: [],
  like_count: 0,
  repost_count: 0,
  reply_count: 0,
  view_count: 0,
  sentiment: 'neutral',
  content_flags: {},
  is_flagged_by_player: false,
  requires_response: false,
  responded_at: null,
  is_repost: false,
  platform: 'x_twitter',
  virality_score: 20,
  reply_to_post_id: null,
  post_format: 'text',
  media_urls: [],
  session_id: SESSION_ID,
  ...o,
});

const P = Object.fromEntries(personas.map((p) => [p.handle, p]));
const npcPost = (id, handle, content, mins, extra = {}) =>
  base({
    id,
    author_handle: handle,
    author_display_name: P[handle].name,
    author_type: P[handle].type,
    content,
    created_at: minsAgo(mins),
    ...extra,
  });

const ID = (n) => `00000000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;

export const posts = [
  npcPost(
    ID(101),
    '@wellness_wren',
    'Three families in my DMs already. They knew about the Northgate batch for a WEEK and said nothing. Switch to something you can trust. Link in thread. #NorthgateRecall',
    26,
    {
      hashtags: ['NorthgateRecall'],
      sentiment: 'hateful',
      like_count: 3184,
      repost_count: 1210,
      reply_count: 214,
      view_count: 96400,
      virality_score: 82,
      content_flags: { is_misinformation: true },
    },
  ),
  npcPost(
    ID(102),
    '@tomasz_kowal',
    '@northgatedairy both my kids were sick after your milk. Is it safe or not? Nobody will tell me which cartons. #FoodSafety',
    21,
    {
      hashtags: ['FoodSafety'], sentiment: 'negative', like_count: 410, repost_count: 96, reply_count: 7, view_count: 8700, virality_score: 41 },
  ),
  base({
    id: ID(103),
    author_handle: '@northgatedairy',
    author_display_name: 'Northgate Dairy Co-op',
    author_type: 'official_account',
    content:
      'Update 14:05. We have withdrawn chilled milk batch NG-2209 (use-by 14 Oct) from all retailers while testing continues. If you hold this batch, do not drink it; return it for a full refund. Families with symptoms should contact a doctor. Next update by 14:35. #NorthgateRecall',
    hashtags: ['NorthgateRecall'],
    created_at: minsAgo(9),
    post_format: 'official_statement',
    like_count: 268,
    repost_count: 141,
    reply_count: 5,
    view_count: 31200,
    virality_score: 55,
    sentiment: 'neutral',
    posted_by_display_name: 'Jordan Ellis',
    sop_compliance_score: {
      accuracy: 86,
      tone: 78,
      cultural_sensitivity: 82,
      persuasiveness: 71,
      overall: 80,
      feedback:
        'Names the batch, the action and the next update time. Does not yet say how many cases are confirmed or what testing is under way.',
    },
  }),
  npcPost(
    ID(104),
    '@mara_vance',
    'Northgate says batch NG-2209 is withdrawn and next update is 14:35. Questions still open: how many illnesses are confirmed, and when was the first complaint received? Asking now.',
    7,
    {
      reply_to_post_id: ID(103),
      sentiment: 'neutral',
      like_count: 188,
      repost_count: 52,
      view_count: 14100,
      virality_score: 48,
    },
  ),
  npcPost(
    ID(105),
    '@dr_ines_okafor',
    'Useful: batch number and clear advice to see a doctor. For parents reading: keep the carton, note the use-by date, and do not give it to children while testing continues.',
    6,
    { reply_to_post_id: ID(103), sentiment: 'supportive', like_count: 342, repost_count: 74, view_count: 9800, virality_score: 40 },
  ),
  npcPost(
    ID(106),
    '@freshfield_foods',
    'Every Freshfield batch is tested before it leaves the plant, and results are published on our site. Families deserve to know what is in their fridge.',
    6,
    { reply_to_post_id: ID(103), sentiment: 'neutral', like_count: 97, repost_count: 12, view_count: 6100, virality_score: 28 },
  ),
  npcPost(
    ID(107),
    '@cllr_dan_reyes',
    'Parents in my ward are frightened. Northgate must name an accountable executive and commit to an independent inquiry. A holding statement is not enough.',
    5,
    { reply_to_post_id: ID(103), sentiment: 'negative', like_count: 221, repost_count: 83, view_count: 11300, virality_score: 45 },
  ),
  npcPost(
    ID(108),
    '@grace_lim_farm',
    'Our co-op families have supplied this milk for thirty years. Please tell us what support is available while testing is done. Farmers did not cause this.',
    4,
    { reply_to_post_id: ID(103), sentiment: 'supportive', like_count: 119, repost_count: 18, view_count: 3200, virality_score: 22 },
  ),
  base({
    id: ID(109),
    author_handle: '@northgatedairy',
    author_display_name: 'Northgate Dairy Co-op',
    author_type: 'official_account',
    content:
      '@tomasz_kowal thank you for telling us. The affected batch is NG-2209 (printed beside the use-by date). Please keep any carton you have and message us your pack photo so we can arrange a refund and a call from our quality team.',
    created_at: minsAgo(3),
    reply_to_post_id: ID(102),
    like_count: 61,
    repost_count: 2,
    view_count: 2400,
    virality_score: 18,
    posted_by_display_name: 'Jordan Ellis',
    sop_compliance_score: {
      accuracy: 88,
      tone: 90,
      cultural_sensitivity: 84,
      persuasiveness: 76,
      overall: 85,
      feedback: 'Direct, specific answer to the named parent; offers a concrete next step.',
    },
  }),
  npcPost(
    ID(110),
    '@tomasz_kowal',
    '@northgatedairy ok. Found the batch number on my carton, it IS NG-2209. Sending the photo now. Thank you for actually answering.',
    1,
    { reply_to_post_id: ID(102), sentiment: 'supportive', like_count: 24, view_count: 900, virality_score: 12 },
  ),
];

posts.find((p) => p.id === ID(109)).reply_to_post_id = ID(102);

const comp = (pt, cs, nc, er) => {
  let s = Math.round(0.2 * pt + 0.2 * cs + 0.4 * nc + 0.2 * (100 - er));
  return s;
};

export const socialState = {
  public_trust: 57,
  community_safety: 61,
  narrative_control: 53,
  escalation_risk: 38,
  sentiment_score: comp(57, 61, 53, 38),
  unaddressed_hate_count: 1,
  unaddressed_misinfo_count: 1,
  oldest_unaddressed_hate_minutes: 26,
  oldest_unaddressed_misinfo_minutes: 26,
  player_post_count: 2,
  total_posts: posts.length,
  counter_narratives_published: 0,
  misinformation_flagged_count: 0,
  community_leader_contacted: false,
  official_statement_published: true,
  rally_call_active: false,
  tier1_reactive_actions: 3,
  tier2_strategic_actions: 2,
  tier3_advanced_actions: 0,
  strategic_ratio: 0.4,
  sop_monitor_completed: true,
  sop_assess_completed: true,
  sop_fact_check_completed: false,
  sop_escalate_completed: false,
  sop_draft_completed: true,
  sop_publish_completed: true,
  sop_monitor_overdue: false,
  sop_assess_overdue: false,
  sop_draft_overdue: false,
  sop_publish_overdue: false,
  total_reports: 0,
  valid_reports: 0,
  invalid_reports: 0,
  report_precision: 0,
  time_to_first_response_minutes: 4,
  time_to_first_statement_minutes: 17,
  transparency_score: 72,
  consistency_score: 90,
  rdap_level: 'Rebuild',
  rdap_score: 70,
  victim_centring_match: 'Partial',
  victim_centring_score: 60,
};

export const stakeholders = [
  {
    id: 'mara-vance',
    name: 'Mara Vance',
    title: 'Food-safety reporter',
    organisation: 'Harbour Ledger',
    relationship: 'media',
    owning_team: 'Communications',
    org_key: null,
    email: 'mara.vance@harbourledger.sim',
    phone: null,
    handle: '@mara_vance',
    note: 'Regional reporter. Answers fast, publishes on one usable fact.',
    personality:
      'Methodical and guarded. Asks for batch numbers, dates and counts; never speculates in print; remembers what she was told earlier in the day.',
    stance: 'Neutral but sceptical until the company shows its timeline.',
    knowledge: [
      'A parent group has sent her three complaints about batch NG-2209.',
      'The retailer confirmed the withdrawal at 13:50.',
    ],
    will_not_disclose: ['The identity of her parent-group source', 'Which rival outlet is chasing the same story'],
    grievance: 'Wants the date the first complaint reached Northgate before she files.',
    resolution_criteria: [
      'A confirmed case count is given',
      'The date of the first complaint is stated',
      'A named spokesperson is available on the record',
    ],
    persuadability: 'medium',
    hard_constraints: ['Will not hold a story once she has two confirmed facts'],
    kind: 'person',
    tier: 'principal',
  },
  {
    id: 'ines-okafor',
    name: 'Dr Ines Okafor',
    title: 'Consultant paediatrician',
    organisation: 'Eastbank Children\u2019s Clinic',
    relationship: 'community',
    owning_team: 'Community Liaison',
    org_key: null,
    email: 'ines.okafor@eastbankclinic.sim',
    phone: null,
    handle: '@dr_ines_okafor',
    note: 'Trusted clinical voice for parents.',
    personality:
      'Calm, precise and practical. Gives parents usable steps and corrects rumours politely. Not on the response team and does not coach messaging.',
    stance: 'Supportive if the guidance is specific; will say so publicly if it is not.',
    knowledge: ['Four children seen with gastro symptoms since Thursday, all reported the same brand.'],
    will_not_disclose: ['Patient names or ages'],
    grievance: 'Needs a clear clinical advice line she can point parents to.',
    resolution_criteria: ['A symptoms-and-advice line is published', 'A health-authority contact is named'],
    persuadability: 'high',
    hard_constraints: ['Will not endorse any product claim'],
    kind: 'person',
    tier: 'principal',
  },
];

export const scenario = {
  id: SCENARIO_ID,
  title: 'Northgate Dairy: Chilled-Milk Illness Reports (fictional demo)',
  description:
    'A regional dairy co-op faces social-media reports of children falling ill after drinking a chilled-milk batch. Influencers amplify an unverified "hidden for a week" claim while a local councillor demands an inquiry.',
  category: 'social_media_crisis',
  status: 'active',
  sim_mode: 'social_media',
  duration_minutes: 45,
  briefing: 'You are the communications cell for Northgate Dairy Co-op. Reports of illness are trending.',
  objectives: [],
  initial_state: {
    org_name: 'Northgate Dairy Co-op',
    npc_personas: personas,
    stakeholders,
    fact_sheet: {
      confirmed_facts: [
        'Batch NG-2209 (use-by 14 Oct) has been withdrawn from all retailers.',
        'Testing of retained samples is under way.',
      ],
      unconfirmed_claims: [
        { claim: 'The batch was known to be unsafe for a week', status: 'UNVERIFIED' },
        { claim: 'Other batches are also affected', status: 'UNVERIFIED' },
      ],
    },
  },
  created_at: minsAgo(60 * 24),
};

export const profile = {
  id: USER_ID,
  email: 'demo.trainer@example.invalid',
  username: 'demo.trainer',
  full_name: 'Jordan Ellis',
  role: 'trainer',
  agency_name: 'Prophyion Demo',
  contract_required: false,
};

export const trainerSession = {
  id: SESSION_ID,
  scenario_id: SCENARIO_ID,
  status: 'in_progress',
  start_time: minsAgo(31),
  sim_mode: 'social_media',
  trainer_id: USER_ID,
  join_token: 'demo',
  current_state: { social_state: socialState },
  scenarios: { title: scenario.title, description: scenario.description, category: 'social_media_crisis' },
};

export const injects = [
  { id: ID(201), title: 'Parents forum amplifies illness reports', severity: 'high', status: 'published', conditions: [{ key: 'official_statement_published', met: true }] },
];

export const orchestration = [
  {
    id: ID(301),
    title: 'Councillor demands inquiry',
    severity: 'high',
    status: 'published',
    published_at: minsAgo(5),
    conditions: [
      { key: 'misinformation_unaddressed_10min', met: true },
      { key: 'player_posted_official_statement', met: true },
    ],
    met_count: 2,
    total_count: 2,
    mode: 'all',
  },
  {
    id: ID(302),
    title: 'Retailer asks for written assurance',
    severity: 'medium',
    status: 'eligible',
    conditions: [
      { key: 'player_posted_official_statement', met: true },
      { key: 'facts_confirmed', met: true },
    ],
    met_count: 2,
    total_count: 2,
    mode: 'all',
  },
  {
    id: ID(303),
    title: 'Influencer pushes raw-milk alternative',
    severity: 'medium',
    status: 'waiting',
    conditions: [
      { key: 'misinformation_unaddressed_10min', met: true },
      { key: 'team_published_counter_narrative', met: false },
    ],
    met_count: 1,
    total_count: 2,
    mode: 'all',
  },
  {
    id: ID(304),
    title: 'Community leader asks for a briefing',
    severity: 'low',
    status: 'waiting',
    conditions: [
      { key: 'community_leader_contacted', met: false },
      { key: 'player_pinned_verified_update', met: true },
    ],
    met_count: 1,
    total_count: 2,
    mode: 'all',
  },
];

export const gradedReplies = posts
  .filter((p) => p.sop_compliance_score)
  .map((p) => ({
    ...p,
    parent_content: p.reply_to_post_id
      ? posts.find((q) => q.id === p.reply_to_post_id)?.content
      : undefined,
  }));

export const authUser = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'demo.trainer@example.invalid',
  app_metadata: {},
  user_metadata: { full_name: 'Jordan Ellis' },
  created_at: minsAgo(60 * 24 * 30),
};

const bot = (n, name, team, status, actions, kind, summary, ago, llm) => ({
  user_id: `00000000-0000-4000-8000-00000000d${n}00`.slice(0, 36),
  display_name: name,
  team_name: team,
  is_ready: true,
  slot: n,
  status,
  stats: {
    actions,
    failures: 0,
    byKind: { [kind]: actions },
    llmCalls: llm,
    llmFallbacks: 0,
    lastAction: { kind, at: minsAgo(ago), summary },
    lastError: null,
  },
});

export const botsView = {
  enabled: true,
  running: true,
  intellect: 68,
  max_per_session: 8,
  llm_budget: { used: 37, limit: 400, resets_in_ms: 1_500_000 },
  teams: [
    { team_name: 'Communications', team_description: null, max_participants: 4, members: 3, bots: 2 },
    { team_name: 'Community Liaison', team_description: null, max_participants: 3, members: 2, bots: 1 },
  ],
  bots: [
    bot(1, 'Alex Rowan', 'Communications', 'acting', 6, 'reply', 'replied to @tomasz_kowal with batch guidance', 1, 11),
    bot(2, 'Priya Nair', 'Communications', 'idle', 4, 'chat', 'posted fact-check summary to team chat', 3, 8),
    bot(3, 'Jamie Cole', 'Community Liaison', 'paused', 3, 'dm', 'briefed Dr Okafor via direct message', 8, 6),
  ],
};

const mk = (pt, cs, nc, er, extra = {}) => ({
  ...socialState,
  public_trust: pt,
  community_safety: cs,
  narrative_control: nc,
  escalation_risk: er,
  sentiment_score: comp(pt, cs, nc, er),
  ...extra,
});

// Scripted series of seeded states served on successive polls (earliest first).
export const stateSeries = [
  mk(44, 52, 31, 55, { official_statement_published: false, time_to_first_statement_minutes: null, transparency_score: null, consistency_score: null }),
  mk(41, 50, 29, 62, { official_statement_published: false, time_to_first_statement_minutes: null, transparency_score: null, consistency_score: null }),
  mk(50, 55, 40, 58, { transparency_score: 64 }),
  mk(54, 58, 47, 48, { transparency_score: 68 }),
  mk(57, 61, 53, 38),
];

export const consequenceEvents = [
  {
    id: ID(401),
    description:
      'A concerned stakeholder posts that harmful content has circulated for over 10 minutes with no response from the team.',
    metadata: { trigger_id: 'hate_unaddressed_10min', is_positive: false },
    created_at: minsAgo(14),
  },
  {
    id: ID(402),
    description: 'Local voices acknowledge the specific batch guidance and ask for the next update.',
    metadata: { trigger_id: 'narrative_control_above_50', is_positive: true },
    created_at: minsAgo(2),
  },
];

export const stakeholderEvents = [
  {
    id: ID(501),
    event_type: 'inject_modified',
    description:
      'Held her planned follow-up story about "silence on the first complaint" and revised it to wait for the 14:35 update, after the player gave the batch number and next-update time.',
    metadata: {
      source: 'stakeholder',
      stakeholder_name: 'Mara Vance',
      stakeholder_id: 'mara-vance',
      inject_id: ID(601),
      credited_team: 'Communications',
      criteria_met: [2],
    },
    created_at: minsAgo(6),
  },
];
