import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../lib/logger.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { resetPeaceColumnsForTests } from '../../lib/peaceSchema.js';
import { env } from '../../env.js';
import { buildCharacterPrompt } from '../stakeholderReplyService.js';
import type { Stakeholder } from '../../lib/stakeholderContract.js';
import {
  emailFallbackRespondent,
  JUDGE_JSON_TAIL,
  judgeResponseSchema,
} from './channelPromptShared.js';
import {
  buildLegacyDmReplyMessages,
  buildLegacyEmailReplyMessages,
} from './legacyChannelPrompts.js';
import {
  buildTopicDmMessages,
  buildTopicEmailMessages,
  screenChannelReply,
  singleResponderStance,
  type ChannelChatClient,
} from './channelTopicCore.js';
import { triggerNPCDMReply } from '../npcMessengerService.js';
import { triggerNPCEmailReply, type PlayerEmail } from '../npcEmailReplyService.js';
import { gradePlayerEmailFromReply, labelPlayerDmFromReply } from './playerTopicGrade.js';
import {
  keptVerdicts,
  peaceStakeholderJudgeSystem,
  type JudgeInput,
} from '../stakeholderReconsiderationService.js';
import { gradeOutboundEmail, type OutboundEmailGradeRuntime } from './gradeOutboundEmail.js';
import {
  assignBridgeStances,
  readTopicClassification,
  TOPIC_CLASSIFICATION_OBJECT,
} from './topicPromptCore.js';
import { resetTopicSchemaForTests } from './topicColumns.js';

logger.level = 'silent';

const CRISIS = 'UNIQUE_CRISIS_TOKEN batteries overheated in the warehouse.';

function digestOf(system: string, user: string): string {
  return createHash('sha256').update(system).update('\n---\n').update(user).digest('hex');
}

/** The DM persona template as it stood on master, before this work package. */
function masterDmReply(input: {
  handle: string;
  name: string;
  personality: string;
  bias: string;
  type: string;
  crisisDescription: string;
  orgName: string;
  conversation: string;
  playerMessage: string;
}): { system: string; user: string } {
  const system = `You are ${input.handle} (${input.name}), an NPC in a crisis simulation. Reply to a direct message in character.

Your personality: ${input.personality}
Your bias: ${input.bias}
Your type: ${input.type}
Crisis context: ${input.crisisDescription.substring(0, 300)}${input.orgName ? `\nOrganization: ${input.orgName}` : ''}

Conversation so far:
${input.conversation}

Reply in 1-3 sentences. Stay in character. Be authentic to your personality and bias.

Return ONLY valid JSON:
{ "reply": "your reply text" }`;
  return { system, user: `The player just sent you this DM: "${input.playerMessage}"` };
}

function masterEmailReply(input: {
  respondentInfo: string;
  crisisDescription: string;
  orgName: string;
  factsContext: string;
  threadContext: string;
  isMedia: boolean;
  fromName: string;
  fromAddress: string;
  toAddress: string;
  ccAddresses?: string[];
  subject: string;
  body: string;
}): { system: string; user: string } {
  const system = `You are generating an NPC email reply during a crisis simulation. The player sent an email and you must respond in character.

${input.respondentInfo}

Crisis context: ${input.crisisDescription.substring(0, 400)}${input.orgName ? `\nOrganization under crisis: ${input.orgName}` : ''}
${input.factsContext}
${input.threadContext}

RULES:
- Reply in character as this specific person. Use appropriate formality for email.
- If this is an internal colleague or supervisor, reply at WORKING LEVEL (duty manager, ops coordinator, shift lead): share verified facts, request status, flag operational constraints. C-suite executives do not personally answer email during a crisis — if the address clearly belongs to an executive, the reply comes from their operations desk or assistant on their behalf. Internal replies must NEVER provide draft statements, talking points, suggested messaging, or PR strategy.
- If this is a community leader or external contact, reflect their concerns and needs.
- If this is media, be professional and guarded.
- Keep the reply realistic: 2-6 sentences for quick replies, longer for substantive responses.
- Determine if this email even warrants a reply (a "thank you" or FYI email might not need one).
- Assign an email_category for your reply. Valid categories: "general", "verified_facts", "sitrep_request", "leak_notice". Use "verified_facts" only to share confirmed information; use "general" for press/external correspondence; do NOT issue communication red lines, approval chains, or comms-process instructions.
- Assign a delay_seconds (10-90) based on how busy this person would realistically be. Executives: 30-90s. Community leaders: 15-60s. Media: 10-30s.
- Do NOT contradict confirmed facts from the fact sheet.
- ANTI-COACHING: If you are a senior leader, executive, or internal authority, you must NEVER tell the team what to say publicly, provide draft statements, talking points, suggested messaging, approved language, or PR strategy. You may share verified facts, set constraints (what NOT to do), request updates, and authorize resources — but the team must craft their own public response.
${
  input.isMedia
    ? `
MEDIA/JOURNALIST PUBLICATION RULES (1-2 STEPS MAX — do NOT gatekeep):
- You are a journalist who PUBLISHES quickly based on whatever the source provides.
- If the player's email contains ANY usable information, a statement, or a request to cover something: set "should_publish" to true on this FIRST email. Do NOT demand documentation, multiple confirmations, or quotable statements as a precondition.
- Only send ONE clarifying reply (without publishing) if the email contains NO usable information at all (e.g. it is purely a question to you). After that single exchange, publish with whatever you have.
- Publish based ONLY on what the player actually provided. If the info is incomplete, vague, or unverified, write a SHORTER, more speculative or critical article that reflects the gaps — e.g. note that "[the organization] did not provide specifics", "key questions remain unanswered", or lean on unverified public claims. Incomplete or weak input MUST result in an incomplete or unflattering article, not a request for more.
- When publishing, write a professional news article with headline, subheadline, and body. Quote the source appropriately ("a spokesperson for [org]", "according to the crisis response team").
- Your reply email should mention the story is being published.
- If the player is just asking a question (not providing info for publication), respond normally without publishing.
`
    : ''
}
Return ONLY valid JSON:
{
  "should_reply": true,
  "delay_seconds": 30,
  "from_name": "Respondent Name",
  "from_address": "respondent@example.com",
  "subject": "RE: ...",
  "body": "Reply text here...",
  "email_category": "general",
  "priority": "normal"${
    input.isMedia
      ? `,
  "should_publish": false,
  "article": {
    "headline": "Headline if publishing",
    "subheadline": "Optional subheadline",
    "body": "Full news article body text if publishing",
    "category": "breaking|developing|analysis"
  }`
      : ''
  }
}`;
  const cc = input.ccAddresses ?? [];
  const user = `Player email from ${input.fromName} (${input.fromAddress}):\nTo: ${input.toAddress}${cc.length > 0 ? `\nCc: ${cc.join(', ')}` : ''}\nSubject: ${input.subject}\n\n${input.body}`;
  return { system, user };
}

function masterCharacterPrompt(input: {
  name: string;
  title: string;
  organisation: string;
  relationship: string;
  personality: string;
  stance: string;
  knowledge: string[];
  will_not_disclose: string[];
  tier?: string;
  description: string;
  orgName: string;
  confirmed: string;
  claims: string;
  context?: string;
  mood?: string;
}): string {
  return `You are ${input.name}, ${input.title ? `${input.title} at ` : ''}${input.organisation}. You are a ${input.relationship} of the organisation under crisis${input.orgName ? ` (${input.orgName})` : ''}. You are an NPC in a crisis-response training simulation; players are staff of that organisation.

Personality and register: ${input.personality || 'professional, realistic, concise'}
Your current posture toward the organisation: ${input.stance || 'neutral, waiting to see how they handle this'}
Things you know and will share if asked:
${input.knowledge.length ? input.knowledge.map((item) => `- ${item}`).join('\n') : '- (nothing beyond public knowledge)'}
Things you will NOT disclose or do, however asked:
${input.will_not_disclose.length ? input.will_not_disclose.map((item) => `- ${item}`).join('\n') : '- (none)'}

Crisis context: ${input.description.slice(0, 600)}
${input.confirmed ? `Confirmed facts (do not contradict): ${input.confirmed}` : ''}
${input.claims ? `Unverified public claims: ${input.claims}` : ''}
${input.context ? `\nWhat you currently know and feel about recent events (this overrides your default posture where they conflict):\n${input.context}\n` : ''}${input.mood ? `\n${input.mood}\n` : ''}
Conduct rules:
- Stay in character as this specific person on every channel; you remember every previous exchange listed below regardless of channel.
- ${input.relationship === 'internal' ? 'You are staff of this organisation and the players are your colleagues; leadership and your own function lead can give you instructions, which you carry out (acknowledge, act, report — flag a risk once, do not argue). Share verified facts, request status, flag constraints. NEVER draft public statements, talking points, suggested messaging or PR strategy for the players — they must craft their own response.' : 'Reflect your own interests and concerns; you are not on the response team and do not coach them on messaging.'}
- ${input.relationship === 'media' ? 'You are a journalist: professional, guarded, you publish when you have something usable.' : 'Be authentic: a real person with limited time and their own agenda.'}
${input.tier === 'roster' ? '- You are one member of a larger workforce, not a spokesperson: reply briefly and personally (2-4 sentences), about your own situation, shift and family; you do not speak for colleagues or negotiate.' : ''}
- Do not invent facts that contradict the confirmed facts. Do not reveal anything from your private situation.`;
}

const JUDGE_SCHEMA_MASTER = `Return ONLY valid JSON:
{ "should_reply": true, "reply": { "text": "...", "subject": "RE: ...", "delay_seconds": 30 },
  "verdicts": [ { "inject_id": "...", "verdict": "keep|modify|delay|cancel", "reason": "...", "criteria_met": [1,3], "modified_content": "...", "delay_minutes": 10 } ] }`;

function speaker(overrides?: Partial<Stakeholder>): Stakeholder {
  return {
    id: 'officer_tan',
    name: 'Officer Tan',
    title: 'Inspector',
    organisation: 'MAS',
    relationship: 'regulator',
    owning_team: 'Engagement',
    org_key: null,
    email: 'tan@mas.sim',
    phone: null,
    handle: '@officer_tan',
    note: '',
    personality: 'formal',
    stance: 'waiting',
    knowledge: ['The batch number'],
    will_not_disclose: [],
    grievance: '',
    resolution_criteria: [],
    persuadability: 'medium',
    hard_constraints: [],
    ...overrides,
  } as Stakeholder;
}

test('flag-off DM, email and stakeholder prompts match the master templates', () => {
  const dm = {
    handle: '@sam',
    name: 'Sam Lee',
    personality: 'sceptical neighbour',
    bias: 'hostile',
    type: 'npc_public',
    crisisDescription: CRISIS,
    orgName: 'Dyson',
    conversation: '@player: Nice breakfast deal',
    playerMessage: 'Nice breakfast deal',
  };
  const dmNoOrg = { ...dm, orgName: '', conversation: '' };
  for (const sample of [dm, dmNoOrg]) {
    const original = masterDmReply(sample);
    const built = buildLegacyDmReplyMessages(sample);
    assert.equal(built.system, original.system);
    assert.equal(built.user, original.user);
  }
  const dmHash = digestOf(masterDmReply(dm).system, masterDmReply(dm).user);
  assert.equal(dmHash, '2d0489455583b34b18ed1628f3282e9e1576f1fd7ad412fb1ad214a9b2d68a05');

  const email = {
    respondentInfo:
      'You are Sam Lee (sam@contacts.sim).\nRole/Title: Sam Lee (public)\nPersonality: sceptical neighbour',
    crisisDescription: CRISIS,
    orgName: 'Dyson',
    factsContext:
      '\n\nFACT SHEET:\nConfirmed: two units overheated\nUnverified claims: "a cover-up" (UNVERIFIED)',
    threadContext:
      '\n\nEMAIL THREAD HISTORY (oldest first):\n[FROM: Sam Lee] Subject: Hello\nEarlier note',
    isMedia: false,
    fromName: 'Player',
    fromAddress: 'player@crisisresponse.sim',
    toAddress: 'sam@contacts.sim',
    ccAddresses: ['cc@crisisresponse.sim'],
    subject: 'Weekend plans',
    body: 'Are we still on for Saturday?',
  };
  const emailMedia = {
    ...email,
    isMedia: true,
    factsContext: '',
    threadContext: '',
    ccAddresses: [],
  };
  const emailPlain = {
    ...email,
    orgName: '',
    factsContext: '',
    threadContext: '',
    ccAddresses: [],
  };
  for (const sample of [email, emailMedia, emailPlain]) {
    const original = masterEmailReply(sample);
    const built = buildLegacyEmailReplyMessages(sample);
    assert.equal(built.system, original.system);
    assert.equal(built.user, original.user);
  }
  const emailHash = digestOf(masterEmailReply(email).system, masterEmailReply(email).user);
  assert.equal(emailHash, '5774a9dbcbb9bdd166a721c6929e5384e02877d227e7f5ccd13a9930c0a8d88f');

  assert.equal(JUDGE_JSON_TAIL, JUDGE_SCHEMA_MASTER);
  assert.equal(judgeResponseSchema(false), JUDGE_SCHEMA_MASTER);
  assert.equal(judgeResponseSchema(true).includes(TOPIC_CLASSIFICATION_OBJECT), true);
  assert.equal(judgeResponseSchema(true).includes('"verdicts"'), true);

  const cases = [
    {
      relationship: 'regulator' as const,
      tier: undefined,
      context: undefined,
      mood: undefined,
      confirmed: '',
      claims: '',
    },
    {
      relationship: 'internal' as const,
      tier: undefined,
      context: 'They have not written back.',
      mood: 'YOUR MOOD RIGHT NOW: Impatient',
      confirmed: 'the plant is open',
      claims: '"it is closing" (UNVERIFIED)',
    },
    {
      relationship: 'media' as const,
      tier: 'roster' as const,
      context: undefined,
      mood: undefined,
      confirmed: '',
      claims: '',
    },
  ];
  for (const item of cases) {
    const person = speaker({ relationship: item.relationship, tier: item.tier });
    const built = buildCharacterPrompt(
      person,
      [],
      {
        description: CRISIS,
        org_name: 'Acme',
        fact_sheet: item.confirmed
          ? {
              confirmed_facts: [item.confirmed],
              unconfirmed_claims: [{ claim: 'it is closing', status: 'UNVERIFIED' }],
            }
          : null,
      },
      item.context || item.mood ? { context: item.context, mood: item.mood } : undefined,
    );
    const original = masterCharacterPrompt({
      name: person.name,
      title: person.title,
      organisation: person.organisation,
      relationship: person.relationship,
      personality: person.personality,
      stance: person.stance,
      knowledge: [...person.knowledge],
      will_not_disclose: [...person.will_not_disclose],
      tier: person.tier,
      description: CRISIS,
      orgName: 'Acme',
      confirmed: item.confirmed,
      claims: item.claims,
      context: item.context,
      mood: item.mood,
    });
    assert.equal(built, original);
  }
  const characterHash = createHash('sha256')
    .update(
      masterCharacterPrompt({
        name: 'Officer Tan',
        title: 'Inspector',
        organisation: 'MAS',
        relationship: 'regulator',
        personality: 'formal',
        stance: 'waiting',
        knowledge: ['The batch number'],
        will_not_disclose: [],
        description: 'A plant closure.',
        orgName: 'Acme',
        confirmed: '',
        claims: '',
        context: 'They have not written back.',
      }),
    )
    .digest('hex');
  assert.equal(characterHash, 'd42bf576640cba0def8d9de51842cfe79c063d9a451c4f729b134437ba21eefb');
});

test('peace drops crisis facts from the stakeholder prompt and one responder has no stay floor', () => {
  const person = speaker();
  const ctx = {
    description: CRISIS,
    org_name: 'Acme',
    fact_sheet: {
      confirmed_facts: ['two people were hurt'],
      unconfirmed_claims: [{ claim: 'a cover-up', status: 'UNVERIFIED' }],
    },
  };
  const crisis = buildCharacterPrompt(person, [], ctx, {
    topic: { phase: 'crisis', thread: 'Subject: Saturday breakfast' },
  });
  assert.equal(crisis.includes(CRISIS), true);
  assert.equal(crisis.includes('Confirmed facts (do not contradict): two people were hurt'), true);
  assert.equal(crisis.includes('Saturday breakfast'), true);
  assert.match(crisis, /unless the label is `bridge` or `crisis`/);

  const peace = buildCharacterPrompt(person, [], ctx, {
    topic: { phase: 'peace', thread: 'Subject: Saturday breakfast' },
  });
  assert.equal(peace.includes(CRISIS), false);
  assert.equal(peace.includes('Confirmed facts'), false);
  assert.equal(peace.includes('Unverified public claims'), false);
  assert.equal(peace.includes('Crisis context:'), false);
  assert.equal(peace.includes('under crisis'), false);
  assert.equal(peace.includes('crisis-response'), false);
  assert.match(peace, /Ordinary day\. Nothing unusual has happened to Acme/);
  assert.equal(peace.includes('The batch number'), true);

  const alone = singleResponderStance(
    {
      handle: '@bee',
      type: 'npc_public',
      personality: 'ordinary',
      bias: 'none',
      tier: 'background',
    },
    'thread-1',
    0.4,
  );
  assert.equal(alone.forcedEngage, false);
  const engaged = assignBridgeStances(
    [{ persona: { handle: '@bee', type: 'npc_public', personality: 'ordinary', bias: 'none' } }],
    'post',
    { unit: () => 0 },
  );
  assert.equal(engaged.length, 1);
  assert.equal(engaged[0]?.stance, 'engage');
  assert.equal(readTopicClassification(undefined, false).label, 'unclassified');
  assert.equal(readTopicClassification({ label: 'nope' }, false).label, 'unclassified');
  assert.equal(
    readTopicClassification({ label: 'crisis', confidence: 0.9 }, true).label,
    'unclassified',
  );
  assert.equal(
    readTopicClassification({ label: 'bridge', confidence: 0.2, bridge_topic: 'jab' }, false).label,
    'bridge',
  );
});

test('a low-confidence bridge is downgraded and a peace leak is dropped', () => {
  const low = screenChannelReply({
    phase: 'crisis',
    classification: { label: 'bridge', confidence: 0.2, bridge_topic: 'jab' },
    replyText: 'Nice deal',
    authorHandle: '@sam',
    stance: 'engage',
    leakTerms: ['recall'],
    playerText: 'What about the recall?',
    isReply: true,
    minConfidence: 0.6,
  });
  assert.equal(low.label, 'off_topic');
  assert.equal(low.dropped, false);

  const leaked = screenChannelReply({
    phase: 'peace',
    classification: { label: 'on_topic', confidence: 0.9 },
    replyText: 'There is a recall underway',
    authorHandle: '@sam',
    stance: 'engage',
    leakTerms: ['recall'],
    playerText: 'Did you hear about the recall?',
    isReply: false,
    minConfidence: 0.6,
  });
  assert.equal(leaked.label, 'bridge');
  assert.equal(leaked.dropped, true);
  assert.equal(leaked.replyText, '');
});

interface DbCapture {
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  updates: Array<{ table: string; row: Record<string, unknown> }>;
  selects: string[];
  restore: () => void;
}

function installDb(handlers: {
  scenario: Record<string, unknown>;
  thread?: Array<Record<string, unknown>>;
  emailThread?: Array<Record<string, unknown>>;
  updateError?: unknown;
}): DbCapture {
  const inserts: DbCapture['inserts'] = [];
  const updates: DbCapture['updates'] = [];
  const selects: string[] = [];
  const original = supabaseAdmin.from;
  const chain = (table: string) => {
    let mode: 'read' | 'insert' | 'update' = 'read';
    let ascending = true;
    let lim: number | null = null;
    let selectArg = '';
    const q = {
      select(cols?: string) {
        selectArg = cols || '';
        selects.push(`${table}:${selectArg}`);
        return q;
      },
      eq() {
        return q;
      },
      order(_column?: string, opts?: { ascending?: boolean }) {
        ascending = opts?.ascending !== false;
        return q;
      },
      limit(count: number) {
        lim = count;
        return q;
      },
      or() {
        return q;
      },
      is() {
        return q;
      },
      in() {
        return q;
      },
      gte() {
        return q;
      },
      insert(row: Record<string, unknown>) {
        mode = 'insert';
        inserts.push({ table, row });
        return q;
      },
      update(row: Record<string, unknown>) {
        mode = 'update';
        updates.push({ table, row });
        return q;
      },
      async single() {
        if (mode === 'insert')
          return { data: { id: 'npc-1', ...inserts.at(-1)?.row }, error: null };
        if (table === 'sessions') return { data: { scenario_id: 'sc-1' }, error: null };
        if (table === 'scenarios') return { data: handlers.scenario, error: null };
        return { data: null, error: null };
      },
      async maybeSingle() {
        return { data: null, error: null };
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        const windowOf = (rows: Array<Record<string, unknown>>) => {
          const ordered = ascending ? rows : [...rows].reverse();
          return lim == null ? ordered : ordered.slice(0, lim);
        };
        const value =
          mode === 'update'
            ? { data: null, error: handlers.updateError ?? null }
            : table === 'sim_direct_messages'
              ? { data: windowOf(handlers.thread ?? []), error: null }
              : table === 'sim_emails' && selectArg.includes('body_text')
                ? { data: windowOf(handlers.emailThread ?? []), error: null }
                : { data: [], count: 0, error: null };
        return Promise.resolve(value).then(resolve, reject);
      },
    };
    return q;
  };
  (supabaseAdmin as unknown as { from: (table: string) => ReturnType<typeof chain> }).from = chain;
  return {
    inserts,
    updates,
    selects,
    restore() {
      supabaseAdmin.from = original;
    },
  };
}

function personaScenario(persona: Record<string, unknown>, leak: string[] = ['recall']) {
  return {
    description: CRISIS,
    initial_state: {
      org_name: 'Dyson',
      npc_personas: [persona],
      peace_period: { leak_terms: leak },
    },
  };
}

const sam = {
  handle: '@sam',
  name: 'Sam Lee',
  type: 'npc_public',
  personality: 'sceptical neighbour',
  bias: 'none',
  tier: 'background',
  follower_count: 12,
  specific_claims: [],
};

async function withFlags<T>(
  flags: { topic?: boolean; stakeholder?: boolean; ai?: boolean },
  run: () => Promise<T>,
): Promise<T> {
  const topic = env.enableTopicAwareReplies;
  const stakeholder = env.enableStakeholderEngine;
  const ai = env.aiEnabled;
  if (flags.topic !== undefined) env.enableTopicAwareReplies = flags.topic;
  if (flags.stakeholder !== undefined) env.enableStakeholderEngine = flags.stakeholder;
  if (flags.ai !== undefined) env.aiEnabled = flags.ai;
  resetTopicSchemaForTests();
  try {
    return await run();
  } finally {
    env.enableTopicAwareReplies = topic;
    env.enableStakeholderEngine = stakeholder;
    env.aiEnabled = ai;
    resetTopicSchemaForTests();
  }
}

test('flags off: a persona DM uses the master prompt and does not label', async () => {
  assert.equal(env.enableTopicAwareReplies, false);
  const seen: Array<{
    label?: string;
    temperature?: number;
    maxTokens?: number;
    messages: Array<{ content: string }>;
  }> = [];
  const db = installDb({
    scenario: personaScenario(sam),
    thread: [
      { sender_handle: '@player', content: 'Nice breakfast deal', recipient_handle: '@sam' },
    ],
  });
  try {
    await withFlags({ stakeholder: false, ai: true }, () =>
      triggerNPCDMReply('sess-1', 'thread-1', '@sam', 'Nice breakfast deal', 'user-1', {
        client: {
          async chatJson(options) {
            seen.push({
              label: options.label,
              temperature: options.temperature,
              maxTokens: options.maxTokens,
              messages: options.messages.map((message) => ({
                content: typeof message.content === 'string' ? message.content : '',
              })),
            });
            return { reply: 'See you Saturday' };
          },
        },
      }),
    );
  } finally {
    db.restore();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.label, 'npcMessenger.reply');
  assert.equal(seen[0]?.temperature, 0.85);
  assert.equal(seen[0]?.maxTokens, 300);
  const original = masterDmReply({
    handle: '@sam',
    name: 'Sam Lee',
    personality: 'sceptical neighbour',
    bias: 'none',
    type: 'npc_public',
    crisisDescription: CRISIS,
    orgName: 'Dyson',
    conversation: '@player: Nice breakfast deal',
    playerMessage: 'Nice breakfast deal',
  });
  assert.equal(seen[0]?.messages[0]?.content, original.system);
  assert.equal(seen[0]?.messages[1]?.content, original.user);
  assert.equal(
    db.selects.some((item) => item.includes('topic_class')),
    false,
  );
  assert.equal(db.inserts.length, 1);
  assert.equal('topic_class' in (db.inserts[0]?.row ?? {}), false);
  assert.equal(db.updates.length, 0);
});

test('a topic DM stays on the thread, a bridge may engage, and a stay leak is dropped', async () => {
  const thread = [
    {
      id: 'dm-1',
      sender_handle: '@player',
      content: 'Nice breakfast deal',
      recipient_handle: '@sam',
    },
  ];
  const onTopic = installDb({ scenario: personaScenario(sam), thread });
  const seen: string[] = [];
  try {
    await withFlags({ topic: true, stakeholder: false, ai: true }, () =>
      labelPlayerDmFromReply(
        'sess-1',
        'thread-stay',
        '@sam',
        'Nice breakfast deal',
        'user-1',
        'dm-1',
        {
          client: {
            async chatJson(options) {
              seen.push(String(options.messages[0]?.content || ''));
              return {
                classification: { label: 'on_topic', confidence: 0.9, bridge_topic: '' },
                reply: 'Saturday plans sound good',
              };
            },
          },
        },
      ),
    );
  } finally {
    onTopic.restore();
  }
  assert.match(seen[0] || '', /^Your reply is about THIS conversation/);
  assert.ok((seen[0] || '').indexOf('THREAD:') < (seen[0] || '').indexOf('CRISIS CONTEXT:'));
  assert.ok(
    (seen[0] || '').indexOf('MESSAGE BEING ANSWERED:') < (seen[0] || '').indexOf('CRISIS CONTEXT:'),
  );
  assert.match(seen[0] || '', /If bridge: (engage|stay)/);
  assert.equal(onTopic.inserts.length, 1);
  assert.equal(onTopic.inserts[0]?.row.content, 'Saturday plans sound good');
  assert.equal('topic_class' in (onTopic.inserts[0]?.row ?? {}), false);
  assert.deepEqual(onTopic.updates[0]?.row, { topic_class: 'on_topic' });

  const media = {
    ...sam,
    handle: '@maya',
    type: 'npc_media',
    bias: 'hostile',
    personality: 'rival reporter',
    tier: 'key',
  };
  const bridgeDb = installDb({
    scenario: personaScenario(media),
    thread: [
      {
        id: 'dm-2',
        sender_handle: '@player',
        content: 'What about the recall?',
        recipient_handle: '@maya',
      },
    ],
  });
  try {
    await withFlags({ topic: true, stakeholder: false, ai: true }, () =>
      labelPlayerDmFromReply(
        'sess-1',
        'thread-bridge',
        '@maya',
        'What about the recall?',
        'user-1',
        'dm-2',
        {
          client: {
            async chatJson() {
              return {
                classification: { label: 'bridge', confidence: 0.95, bridge_topic: 'recall' },
                reply: 'The recall is the story',
              };
            },
          },
        },
      ),
    );
  } finally {
    bridgeDb.restore();
  }
  assert.equal(bridgeDb.inserts.length, 1);
  assert.equal(bridgeDb.inserts[0]?.row.content, 'The recall is the story');
  assert.deepEqual(bridgeDb.updates[0]?.row, { topic_class: 'bridge' });

  const staySeed = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].find((seed) => {
    return (
      singleResponderStance(
        {
          handle: '@sam',
          type: 'npc_public',
          personality: 'sceptical neighbour',
          bias: 'none',
          tier: 'background',
        },
        seed,
        env.topicBridgeStayShare,
      ).stance === 'stay'
    );
  });
  assert.ok(staySeed);
  const stayDb = installDb({
    scenario: personaScenario(sam),
    thread: [
      {
        id: 'dm-3',
        sender_handle: '@player',
        content: 'Nice breakfast deal',
        recipient_handle: '@sam',
      },
    ],
  });
  try {
    await withFlags({ topic: true, stakeholder: false, ai: true }, () =>
      labelPlayerDmFromReply(
        'sess-1',
        'thread-stay-drop',
        '@sam',
        'Nice breakfast deal',
        'user-1',
        staySeed || '',
        {
          client: {
            async chatJson() {
              return {
                classification: { label: 'bridge', confidence: 0.9, bridge_topic: 'jab' },
                reply: 'This recall changes the breakfast',
              };
            },
          },
        },
      ),
    );
  } finally {
    stayDb.restore();
  }
  assert.equal(stayDb.inserts.length, 0);
  assert.deepEqual(stayDb.updates[0]?.row, { topic_class: 'bridge' });
});

test('peace removes the crisis description from the DM prompt and drops a leaked reply', async () => {
  const db = installDb({
    scenario: personaScenario({ ...sam, type: 'npc_media', bias: 'hostile' }),
    thread: [
      {
        id: 'dm-4',
        sender_handle: '@player',
        content: 'Nice breakfast deal',
        recipient_handle: '@sam',
      },
    ],
  });
  let system = '';
  try {
    await withFlags({ topic: true, stakeholder: false, ai: true }, () =>
      triggerNPCDMReply('sess-1', 'thread-peace', '@sam', 'Nice breakfast deal', 'user-1', {
        phase: 'peace',
        client: {
          async chatJson(options) {
            system = String(options.messages[0]?.content || '');
            return {
              classification: { label: 'on_topic', confidence: 0.8 },
              reply: 'The recall starts Monday',
            };
          },
        },
      }),
    );
  } finally {
    db.restore();
  }
  assert.equal(system.includes(CRISIS), false);
  assert.equal(system.includes('CRISIS CONTEXT:'), false);
  assert.match(system, /Ordinary day\. Nothing unusual has happened to Dyson/);
  assert.equal(db.inserts.length, 0);
  const built = buildTopicDmMessages({
    handle: '@sam',
    name: 'Sam',
    personality: 'calm',
    bias: 'none',
    type: 'npc_public',
    crisisDescription: CRISIS,
    orgName: 'Dyson',
    conversation: '',
    playerMessage: 'Hello',
    phase: 'crisis',
    stance: 'engage',
  });
  assert.equal(built.system.includes(CRISIS.substring(0, 300)), true);
});

function recordingGrade(): OutboundEmailGradeRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async loadSession() {
      calls.push('session');
      return { scenario_id: 'sc-1', start_time: null };
    },
    async loadScenario() {
      calls.push('scenario');
      return {
        description: CRISIS,
        initial_state: { org_name: 'Dyson', fact_sheet: { confirmed_facts: ['a fact'] } },
      };
    },
    async getPlayerTeamContext() {
      calls.push('team');
      return null;
    },
    async gradePlayerContent() {
      calls.push('grade');
      return {
        format: 'official_statement',
        accuracy: 80,
        tone: 80,
        cultural_sensitivity: 80,
        persuasiveness: 80,
        completeness: 80,
        clarity: 80,
        overall: 80,
        feedback: 'ok',
        strengths: [],
        improvements: [],
        dimensions: {},
        signals: {},
      };
    },
    async updateScore() {
      calls.push('update');
    },
    async startSnapshot() {
      calls.push('snapshot');
    },
  };
}

const playerEmail = {
  id: 'email-1',
  to_addresses: ['sam@contacts.sim'],
  subject: 'Weekend plans',
  body_text: 'Are we still on for Saturday?',
  from_name: 'Player',
  from_address: 'player@crisisresponse.sim',
  replied_to_id: null,
  thread_id: null,
  sender_user_id: 'user-1',
};

test('flags off: an email reply uses the master prompt and does not grade or label', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const seen: Array<{
    label?: string;
    temperature?: number;
    maxTokens?: number;
    system: string;
    user: string;
  }> = [];
  const db = installDb({ scenario: personaScenario({ ...sam, tier: 'key' }) });
  try {
    await withFlags({ stakeholder: false, ai: true }, () =>
      triggerNPCEmailReply(
        'sess-1',
        { ...playerEmail, to_addresses: ['sam.lee@contacts.sim'] },
        {
          client: {
            async chatJson(options) {
              const messages = options.messages;
              seen.push({
                label: options.label,
                temperature: options.temperature,
                maxTokens: options.maxTokens,
                system: String(messages[0]?.content || ''),
                user: String(messages[1]?.content || ''),
              });
              return { should_reply: true, body: 'Saturday works', delay_seconds: 30 };
            },
          },
        },
      ),
    );
  } finally {
    db.restore();
    mock.timers.reset();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.label, 'npcEmailReply.generate');
  assert.equal(seen[0]?.temperature, 0.8);
  assert.equal(seen[0]?.maxTokens, 1000);
  const original = masterEmailReply({
    respondentInfo: `You are Sam Lee (sam.lee@contacts.sim).\nRole/Title: Sam Lee (public)\nPersonality: sceptical neighbour`,
    crisisDescription: CRISIS,
    orgName: 'Dyson',
    factsContext: '',
    threadContext: '',
    isMedia: false,
    fromName: 'Player',
    fromAddress: 'player@crisisresponse.sim',
    toAddress: 'sam.lee@contacts.sim',
    subject: 'Weekend plans',
    body: 'Are we still on for Saturday?',
  });
  assert.equal(seen[0]?.system, original.system);
  assert.equal(seen[0]?.user, original.user);
  assert.equal(db.updates.length, 0);
});

test('email grading is skipped for off_topic and still runs for a bridge', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const off = recordingGrade();
  const offDb = installDb({ scenario: personaScenario(sam) });
  try {
    await withFlags({ topic: true, stakeholder: false, ai: true }, () =>
      gradePlayerEmailFromReply(
        'sess-1',
        playerEmail,
        {
          client: {
            async chatJson() {
              return {
                should_reply: true,
                body: 'Enjoy the weekend',
                classification: { label: 'off_topic', confidence: 0.9 },
              };
            },
          },
        },
        off,
      ),
    );
  } finally {
    offDb.restore();
  }
  assert.deepEqual(off.calls, []);
  assert.deepEqual(offDb.updates[0]?.row, { topic_class: 'off_topic' });

  const bridge = recordingGrade();
  const bridgeDb = installDb({
    scenario: personaScenario({ ...sam, type: 'npc_media', bias: 'hostile' }),
  });
  try {
    await withFlags({ topic: true, stakeholder: false, ai: true }, () =>
      gradePlayerEmailFromReply(
        'sess-1',
        { ...playerEmail, id: 'email-2', body_text: 'What about the recall?' },
        {
          client: {
            async chatJson() {
              return {
                should_reply: true,
                body: 'We will cover it',
                classification: { label: 'bridge', confidence: 0.92, bridge_topic: 'recall' },
              };
            },
          },
        },
        bridge,
      ),
    );
  } finally {
    bridgeDb.restore();
    mock.timers.reset();
  }
  assert.deepEqual(bridge.calls, ['session', 'scenario', 'team', 'grade', 'update', 'snapshot']);
  assert.deepEqual(bridgeDb.updates[0]?.row, { topic_class: 'bridge' });

  const direct = recordingGrade();
  await gradeOutboundEmail(
    {
      sessionId: 'sess-1',
      emailId: 'email-3',
      userId: 'user-1',
      subject: 'Hi',
      bodyText: 'Hello',
      topicAware: false,
      label: 'off_topic',
      phase: 'crisis',
      postKind: 'crisis',
      columnsAvailable: true,
    },
    direct,
  );
  assert.deepEqual(direct.calls, ['session', 'scenario', 'team', 'grade', 'update', 'snapshot']);

  const peace = recordingGrade();
  await gradeOutboundEmail(
    {
      sessionId: 'sess-1',
      emailId: 'email-4',
      userId: 'user-1',
      subject: 'Hi',
      bodyText: 'Hello',
      topicAware: true,
      label: 'bridge',
      phase: 'peace',
      postKind: 'crisis',
      columnsAvailable: true,
    },
    peace,
  );
  assert.deepEqual(peace.calls, []);
});

test('a missing topic column warns once and email grading falls back to unclassified', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  resetTopicSchemaForTests();
  const grade = recordingGrade();
  const db = installDb({
    scenario: personaScenario(sam),
    updateError: { code: '42703', message: 'column topic_class does not exist' },
  });
  try {
    await withFlags({ topic: true, stakeholder: false, ai: true }, () =>
      gradePlayerEmailFromReply(
        'sess-1',
        playerEmail,
        {
          client: {
            async chatJson() {
              return {
                should_reply: true,
                body: 'See you then',
                classification: { label: 'off_topic', confidence: 0.9 },
              };
            },
          },
        },
        grade,
      ),
    );
  } finally {
    db.restore();
    mock.timers.reset();
    resetTopicSchemaForTests();
  }
  assert.equal(db.updates.length, 1);
  assert.deepEqual(grade.calls, ['session', 'scenario', 'team', 'grade', 'update', 'snapshot']);
});

test('topic email peace prompt omits the crisis description and keeps the last three messages', () => {
  const history = [1, 2, 3, 4].map((n) => ({
    from_name: `Person ${n}`,
    direction: 'inbound',
    subject: `Note ${n}`,
    body_text: `Body ${n}`,
  }));
  const prompted = buildTopicEmailMessages({
    phase: 'peace',
    respondentInfo: 'You are Sam.',
    stanceLine: '@sam (Sam): calm, bias: none, type: npc_public. If bridge: stay.',
    crisisDescription: CRISIS,
    orgName: 'Dyson',
    factsContext: '\n\nFACT SHEET:\nConfirmed: secret fact\nUnverified claims: ',
    threadContext: '',
    isMedia: false,
    history,
    fromName: 'Player',
    fromAddress: 'p@sim',
    toAddress: 'sam@sim',
    subject: 'Saturday',
    body: 'Breakfast?',
  });
  assert.equal(prompted.system.includes(CRISIS), false);
  assert.equal(prompted.system.includes('secret fact'), false);
  assert.equal(prompted.system.includes('FACT SHEET'), false);
  assert.match(prompted.system, /Ordinary day/);
  assert.equal(prompted.system.includes('Note 1'), false);
  assert.equal(prompted.system.includes('Note 2'), true);
  assert.equal(prompted.system.indexOf('THREAD:') < prompted.system.indexOf('PEACE:'), true);
  assert.equal(prompted.system.includes('If bridge: stay'), true);
});

test('flags off: a persona with no bias still gets the master reply', async () => {
  const seen: string[] = [];
  const { bias: _bias, ...noBias } = sam;
  const db = installDb({
    scenario: personaScenario(noBias),
    thread: [
      { sender_handle: '@player', content: 'Nice breakfast deal', recipient_handle: '@sam' },
    ],
  });
  try {
    await withFlags({ stakeholder: false, ai: true }, () =>
      triggerNPCDMReply('sess-1', 'thread-1', '@sam', 'Nice breakfast deal', 'user-1', {
        client: {
          async chatJson(options) {
            seen.push(String(options.messages[0]?.content || ''));
            return { reply: 12 };
          },
        },
      }),
    );
  } finally {
    db.restore();
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0] || '', /Your bias: undefined/);
  assert.equal(seen[0]?.includes('If bridge:'), false);
  assert.equal(db.inserts[0]?.row.content, '12');
  assert.equal(db.updates.length, 0);
});

test('a reply client is not called when AI is disabled', async () => {
  let called = false;
  const db = installDb({ scenario: personaScenario(sam), thread: [] });
  try {
    await withFlags({ stakeholder: false, ai: false }, () =>
      triggerNPCDMReply('sess-1', 'thread-1', '@sam', 'Hi', 'user-1', {
        client: {
          async chatJson() {
            called = true;
            return { reply: 'no' };
          },
        },
      }),
    );
  } finally {
    db.restore();
  }
  assert.equal(called, false);
  assert.equal(db.inserts.length, 0);
});

test('a long DM thread is labelled by id and the prompt uses the latest messages', async () => {
  const thread = Array.from({ length: 12 }, (_, index) => ({
    id: `m-${index + 1}`,
    sender_handle: index % 2 === 0 ? '@sam' : '@player',
    recipient_handle: index % 2 === 0 ? '@player' : '@sam',
    content: `message ${index + 1}`,
    created_at: new Date(index).toISOString(),
  }));
  thread[11] = {
    id: 'player-new',
    sender_handle: '@player',
    recipient_handle: '@sam',
    content: 'Nice breakfast deal',
    created_at: new Date(20).toISOString(),
  };
  let system = '';
  const db = installDb({ scenario: personaScenario(sam), thread });
  try {
    await withFlags({ topic: true, stakeholder: false, ai: true }, () =>
      labelPlayerDmFromReply(
        'sess-1',
        'thread-long',
        '@sam',
        'Nice breakfast deal',
        'user-1',
        'player-new',
        {
          client: {
            async chatJson(options) {
              system = String(options.messages[0]?.content || '');
              return {
                classification: { label: 'on_topic', confidence: 0.8 },
                reply: 'Saturday it is',
              };
            },
          },
        },
      ),
    );
  } finally {
    db.restore();
  }
  assert.equal(system.includes('message 1\n') || system.includes('message 1"'), false);
  assert.equal(system.includes('message 2'), false);
  assert.equal(system.includes('Nice breakfast deal'), true);
  assert.deepEqual(db.updates[0]?.row, { topic_class: 'on_topic' });
  const topicSelect = db.selects.find((item) => item.startsWith('sim_direct_messages:'));
  assert.equal(topicSelect?.includes('id,'), true);
});

test('peace stakeholder judge omits crisis injects and drops their verdicts', () => {
  const system = peaceStakeholderJudgeSystem({
    sessionId: 's',
    stakeholder: { name: 'Officer Tan', relationship: 'regulator' },
    effective: {
      grievance: 'SECRET_GRIEVANCE',
      resolution_criteria: ['CRITERION_ONE'],
      persuadability: 'medium',
      hard_constraints: ['HARD_CONSTRAINT'],
      source: 'base',
    },
    pending: [
      {
        id: 'inj-1',
        title: 'CRISIS_INJECT_TITLE',
        content: 'The recall is underway',
        type: 'email',
        trigger_time_minutes: 4,
        delivery_config: { app: 'email' },
      },
    ],
    log: [],
    characterPrompt: 'Ordinary day. Nothing unusual has happened to Acme.',
    channel: 'email',
    latestPlayerMessage: 'Saturday breakfast?',
    topic: { phase: 'peace', thread: 'Saturday breakfast', isReply: false },
  } as unknown as JudgeInput);
  assert.equal(system.includes('SECRET_GRIEVANCE'), false);
  assert.equal(system.includes('CRITERION_ONE'), false);
  assert.equal(system.includes('HARD_CONSTRAINT'), false);
  assert.equal(system.includes('CRISIS_INJECT_TITLE'), false);
  assert.equal(system.includes('YOUR PLANNED ACTIONS'), false);
  assert.equal(system.includes('"verdicts"'), false);
  assert.match(system, /Ordinary day/);
  assert.deepEqual(keptVerdicts(true, [{ inject_id: 'inj-1', verdict: 'cancel' }]), []);
  assert.equal(keptVerdicts(false, [{ inject_id: 'inj-1', verdict: 'cancel' }]).length, 1);
});

test('peace AI-fallback email wording does not mention the crisis', () => {
  const peace = emailFallbackRespondent('desk@acme.sim', 'peace');
  const crisis = emailFallbackRespondent('desk@acme.sim', 'crisis');
  assert.equal(peace.toLowerCase().includes('crisis'), false);
  assert.match(crisis, /Based on the crisis context/);
  assert.match(crisis, /given the crisis situation/);
  const prompted = buildTopicEmailMessages({
    phase: 'peace',
    respondentInfo:
      'The player is emailing "desk@acme.sim". Based on this email address, determine:\n3. How they would respond on an ordinary day',
    stanceLine: '@desk (Desk): calm, bias: none, type: npc_public. If bridge: stay.',
    crisisDescription: CRISIS,
    orgName: 'Dyson',
    factsContext: '',
    threadContext: '',
    isMedia: false,
    history: [],
    fromName: 'Player',
    fromAddress: 'p@sim',
    toAddress: 'desk@acme.sim',
    subject: 'Saturday',
    body: 'Breakfast?',
  });
  assert.equal(prompted.system.includes('crisis context'), false);
  assert.equal(prompted.system.includes('crisis situation'), false);
  assert.equal(prompted.system.includes(CRISIS), false);
  assert.match(prompted.system, /ordinary day/);
});

test('NPC-initiated DMs are not labelled, and the player routes keep their call shape', () => {
  const messenger = readFileSync(new URL('../npcMessengerService.ts', import.meta.url), 'utf8');
  const npcStart = messenger.indexOf('export async function triggerNPCMessages');
  const npcEnd = messenger.indexOf('export async function sendNPCDirectMessage');
  const npcBody = messenger.slice(npcStart, npcEnd);
  assert.equal(npcBody.includes('topic_class'), false);
  assert.equal(npcBody.includes('enableTopicAwareReplies'), false);

  const route = readFileSync(new URL('../../routes/socialMessenger.ts', import.meta.url), 'utf8');
  assert.equal(
    route.includes(
      'void triggerNPCDMReply(session_id, threadId, recipient_handle, content, user.id);',
    ),
    true,
  );
  assert.equal(route.includes('await triggerNPCDMReply'), false);

  const social = readFileSync(new URL('../../routes/socialMedia.ts', import.meta.url), 'utf8');
  const gradeAt = social.indexOf('void gradeOutboundEmail');
  const decisionAt = social.indexOf('onPlayerEmailSent');
  const replyAt = social.indexOf('void triggerNPCEmailReply');
  assert.ok(gradeAt > 0 && gradeAt < decisionAt && decisionAt < replyAt);
  assert.equal(social.includes('await gradeOutboundEmail'), false);
  assert.equal(social.includes('await triggerNPCEmailReply'), false);
});

test('during peace a player DM, a stakeholder DM, and an email send no crisis text and no grade', async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scenarioId = 'scen-peace-wire';
  const scenario = {
    id: scenarioId,
    updated_at: '2026-01-01T00:00:00.000Z',
    title: 'Harbour',
    description: CRISIS,
    initial_state: {
      org_name: 'Dyson',
      npc_personas: [sam],
      stakeholders: [
        {
          id: 'priya_nair',
          name: 'Priya Nair',
          title: 'Market lead',
          organisation: 'Harbour Market',
          relationship: 'community',
          owning_team: 'communications',
          email: 'priya@market.test',
          handle: '@priya',
          personality: 'warm',
          knowledge: ['Saturday market opens at nine'],
          grievance: CRISIS,
          resolution_criteria: [CRISIS],
          persuadability: 'medium',
          hard_constraints: [CRISIS],
        },
      ],
      fact_sheet: { confirmed_facts: [CRISIS], unconfirmed_claims: [] },
      peace_period: { leak_terms: ['recall'] },
    },
  };
  const prompts: string[] = [];
  const tables: string[] = [];
  const graded: string[] = [];
  const originalFrom = supabaseAdmin.from;
  const peace = env.enablePeacePeriod;
  resetPeaceColumnsForTests();
  env.enablePeacePeriod = true;
  const client: ChannelChatClient = {
    async chatJson(options) {
      prompts.push(
        (options.messages ?? [])
          .map((message) => (typeof message.content === 'string' ? message.content : ''))
          .join('\n'),
      );
      if (options.label === 'stakeholder.judge') {
        return {
          should_reply: true,
          reply: { text: 'Saturday is fine.', delay_seconds: 15 },
          classification: { label: 'on_topic', confidence: 0.9, bridge_topic: '' },
        };
      }
      if (options.label === 'npcEmailReply.generate') {
        return {
          body: 'Saturday works.',
          should_reply: true,
          classification: { label: 'on_topic', confidence: 0.9, bridge_topic: '' },
          email_category: 'general',
          delay_seconds: 20,
        };
      }
      return {
        reply: 'See you Saturday.',
        classification: { label: 'on_topic', confidence: 0.9, bridge_topic: '' },
      };
    },
  };
  supabaseAdmin.from = ((table: string) => {
    tables.push(table);
    let columns = '';
    const row = () => {
      if (table === 'sessions') {
        if (columns.includes('scenario_id')) return { scenario_id: scenarioId };
        return { start_time: future, opened_at: '2026-01-01T00:00:00.000Z' };
      }
      if (table === 'scenarios') return scenario;
      return null;
    };
    const payload = () => ({ data: row(), error: null, count: 0 });
    const chain: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'neq', 'or', 'order', 'limit', 'in', 'gte', 'is', 'not', 'insert', 'update', 'delete']) {
      chain[name] = (...args: unknown[]) => {
        if (name === 'select') columns = String(args[0] ?? '');
        return chain;
      };
    }
    chain.single = () => Promise.resolve(payload());
    chain.maybeSingle = () => Promise.resolve(payload());
    chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(payload()).then(resolve, reject);
    return chain;
  }) as unknown as typeof supabaseAdmin.from;

  const runtime: OutboundEmailGradeRuntime = {
    async loadSession() {
      graded.push('session');
      return null;
    },
    async loadScenario() {
      graded.push('scenario');
      return null;
    },
    async getPlayerTeamContext() {
      graded.push('team');
      return null;
    },
    async gradePlayerContent() {
      graded.push('grade');
      throw new Error('graded during peace');
    },
    async updateScore() {
      graded.push('score');
    },
    async startSnapshot() {
      graded.push('snapshot');
    },
  };

  try {
    await withFlags({ topic: true, stakeholder: true, ai: true }, async () => {
      await triggerNPCDMReply('sess-peace', 'thread-peace', '@sam', 'Are you free Saturday?', 'user-1', {
        client,
      });
      await triggerNPCDMReply(
        'sess-peace',
        'thread-peace',
        '@priya',
        'Are you free Saturday?',
        'user-1',
        { client },
      );
      const playerEmail: PlayerEmail = {
        id: 'email-peace',
        to_addresses: ['sam.lee@contacts.sim'],
        subject: 'Saturday',
        body_text: 'Breakfast on the waterfront?',
        from_name: 'Player',
        from_address: 'player@sim',
        replied_to_id: null,
        thread_id: null,
        sender_user_id: 'user-1',
      };
      await gradePlayerEmailFromReply('sess-peace', playerEmail, { client }, runtime);
    });
    assert.equal(prompts.length, 3);
    assert.equal(tables.includes('scenario_injects'), false);
    for (const prompt of prompts) {
      assert.equal(prompt.includes(CRISIS), false);
      assert.equal(prompt.includes('Crisis context:'), false);
      assert.equal(prompt.includes('YOUR PRIVATE SITUATION'), false);
      assert.match(prompt, /Ordinary day/);
    }
    assert.deepEqual(graded, []);
  } finally {
    supabaseAdmin.from = originalFrom;
    env.enablePeacePeriod = peace;
    resetPeaceColumnsForTests();
  }
});
