/**
 * Prompt pieces shared by the flag-off DM, email and stakeholder builders and the
 * topic-aware builders. The flag-off builders interpolate these into the templates
 * that shipped on master.
 */
import {
  peacePromptSection,
  TOPIC_CLASSIFICATION_OBJECT,
  type TopicPhase,
} from './topicPromptCore.js';

export type ChannelPhase = 'peace' | 'crisis';

/** `not_started` and a missing phase are crisis. Only an explicit peace phase drops the crisis brief. */
export function channelPhase(phase: TopicPhase | undefined): ChannelPhase {
  return phase === 'peace' ? 'peace' : 'crisis';
}

export const DM_REPLY_VOICE =
  'Reply in 1-3 sentences. Stay in character. Be authentic to your personality and bias.';

export const DM_REPLY_BODY = '"your reply text"';

export const DM_REPLY_JSON = `{ "reply": ${DM_REPLY_BODY} }`;

export function formatDmConversation(
  messages: readonly { sender_handle: string; content: string }[],
): string {
  return messages
    .map((message) => `${message.sender_handle}: ${String(message.content).substring(0, 150)}`)
    .join('\n');
}

export interface EmailHistoryRow {
  from_name: string;
  direction: string;
  subject: string;
  body_text: string;
}

export function formatEmailHistoryLine(email: EmailHistoryRow): string {
  return `[${email.direction === 'inbound' ? 'FROM' : 'TO'}: ${email.from_name}] Subject: ${email.subject}\n${String(email.body_text).substring(0, 300)}`;
}

/** Empty when there is no history. Otherwise the legacy thread block, including its leading blank line. */
export function formatEmailThread(emails: readonly EmailHistoryRow[]): string {
  if (emails.length === 0) return '';
  return (
    '\n\nEMAIL THREAD HISTORY (oldest first):\n' +
    emails.map((email) => formatEmailHistoryLine(email)).join('\n---\n')
  );
}

export function formatEmailFacts(
  factSheet: {
    confirmed_facts?: string[];
    unconfirmed_claims?: Array<{ claim: string; status: string }>;
  } | null,
): string {
  if (!factSheet) return '';
  const confirmed = (factSheet.confirmed_facts || []).slice(0, 6).join('; ');
  const claims = (factSheet.unconfirmed_claims || [])
    .slice(0, 4)
    .map((claim) => `"${claim.claim}" (${claim.status})`)
    .join('; ');
  if (!confirmed && !claims) return '';
  return `\n\nFACT SHEET:\nConfirmed: ${confirmed}\nUnverified claims: ${claims}`;
}

export const EMAIL_RULES = `RULES:
- Reply in character as this specific person. Use appropriate formality for email.
- If this is an internal colleague or supervisor, reply at WORKING LEVEL (duty manager, ops coordinator, shift lead): share verified facts, request status, flag operational constraints. C-suite executives do not personally answer email during a crisis — if the address clearly belongs to an executive, the reply comes from their operations desk or assistant on their behalf. Internal replies must NEVER provide draft statements, talking points, suggested messaging, or PR strategy.
- If this is a community leader or external contact, reflect their concerns and needs.
- If this is media, be professional and guarded.
- Keep the reply realistic: 2-6 sentences for quick replies, longer for substantive responses.
- Determine if this email even warrants a reply (a "thank you" or FYI email might not need one).
- Assign an email_category for your reply. Valid categories: "general", "verified_facts", "sitrep_request", "leak_notice". Use "verified_facts" only to share confirmed information; use "general" for press/external correspondence; do NOT issue communication red lines, approval chains, or comms-process instructions.
- Assign a delay_seconds (10-90) based on how busy this person would realistically be. Executives: 30-90s. Community leaders: 15-60s. Media: 10-30s.
- Do NOT contradict confirmed facts from the fact sheet.
- ANTI-COACHING: If you are a senior leader, executive, or internal authority, you must NEVER tell the team what to say publicly, provide draft statements, talking points, suggested messaging, approved language, or PR strategy. You may share verified facts, set constraints (what NOT to do), request updates, and authorize resources — but the team must craft their own public response.`;

/** The media addendum, including the leading newline the legacy template inserts. Empty when this is not a media reply. */
export function emailMediaBlock(isMedia: boolean): string {
  if (!isMedia) return '';
  return `
MEDIA/JOURNALIST PUBLICATION RULES (1-2 STEPS MAX — do NOT gatekeep):
- You are a journalist who PUBLISHES quickly based on whatever the source provides.
- If the player's email contains ANY usable information, a statement, or a request to cover something: set "should_publish" to true on this FIRST email. Do NOT demand documentation, multiple confirmations, or quotable statements as a precondition.
- Only send ONE clarifying reply (without publishing) if the email contains NO usable information at all (e.g. it is purely a question to you). After that single exchange, publish with whatever you have.
- Publish based ONLY on what the player actually provided. If the info is incomplete, vague, or unverified, write a SHORTER, more speculative or critical article that reflects the gaps — e.g. note that "[the organization] did not provide specifics", "key questions remain unanswered", or lean on unverified public claims. Incomplete or weak input MUST result in an incomplete or unflattering article, not a request for more.
- When publishing, write a professional news article with headline, subheadline, and body. Quote the source appropriately ("a spokesperson for [org]", "according to the crisis response team").
- Your reply email should mention the story is being published.
- If the player is just asking a question (not providing info for publication), respond normally without publishing.
`;
}

const EMAIL_ARTICLE_FIELDS = `,
  "should_publish": false,
  "article": {
    "headline": "Headline if publishing",
    "subheadline": "Optional subheadline",
    "body": "Full news article body text if publishing",
    "category": "breaking|developing|analysis"
  }`;

export function emailJsonBody(isMedia: boolean, classification: boolean): string {
  const classificationField = classification
    ? `\n  "classification": ${TOPIC_CLASSIFICATION_OBJECT},`
    : '';
  return `{${classificationField}
  "should_reply": true,
  "delay_seconds": 30,
  "from_name": "Respondent Name",
  "from_address": "respondent@example.com",
  "subject": "RE: ...",
  "body": "Reply text here...",
  "email_category": "general",
  "priority": "normal"${isMedia ? EMAIL_ARTICLE_FIELDS : ''}
}`;
}

export interface EmailUserInput {
  fromName: string;
  fromAddress: string;
  toAddress: string;
  ccAddresses?: string[];
  subject: string;
  body: string;
}

export function emailReplyUser(input: EmailUserInput): string {
  const cc = input.ccAddresses ?? [];
  return `Player email from ${input.fromName} (${input.fromAddress}):\nTo: ${input.toAddress}${cc.length > 0 ? `\nCc: ${cc.join(', ')}` : ''}\nSubject: ${input.subject}\n\n${input.body}`;
}

export interface CharacterSpeaker {
  name: string;
  title: string;
  organisation: string;
  relationship: string;
  personality: string;
  stance: string;
  knowledge: readonly string[];
  will_not_disclose: readonly string[];
  tier?: string;
}

const JUDGE_REPLY = '{ "text": "...", "subject": "RE: ...", "delay_seconds": 30 }';

const JUDGE_VERDICTS =
  '[ { "inject_id": "...", "verdict": "keep|modify|delay|cancel", "reason": "...", "criteria_met": [1,3], "modified_content": "...", "delay_minutes": 10 } ]';

/** The judge's closing schema. Flag off, this is the schema `callJudge` has always sent. */
export const JUDGE_JSON_TAIL = `Return ONLY valid JSON:
{ "should_reply": true, "reply": ${JUDGE_REPLY},
  "verdicts": ${JUDGE_VERDICTS} }`;

export function judgeResponseSchema(includeClassification: boolean): string {
  if (!includeClassification) return JUDGE_JSON_TAIL;
  return `Return ONLY valid JSON:
{ "should_reply": true, "classification": ${TOPIC_CLASSIFICATION_OBJECT}, "reply": ${JUDGE_REPLY},
  "verdicts": ${JUDGE_VERDICTS} }`;
}

/** Peace replies are not asked to modify or cancel injects. */
export function judgePeaceSchema(): string {
  return `Return ONLY valid JSON:
{ "should_reply": true, "classification": ${TOPIC_CLASSIFICATION_OBJECT}, "reply": ${JUDGE_REPLY} }`;
}

/** AI-fallback respondent text. Peace must not mention the crisis. The crisis wording is the master template. */
export function emailFallbackRespondent(address: string, phase: ChannelPhase): string {
  if (phase === 'peace') {
    return `The player is emailing "${address}". Based on this email address, determine:
1. Whether someone at this address would realistically respond (set should_reply to false if not)
2. Who that person would be (invent a realistic name and title — if this is an internal/organisational address, the respondent is GROUND-LEVEL OPERATIONAL STAFF such as a duty manager, shift supervisor, or operations coordinator, never a C-suite executive)
3. How they would respond on an ordinary day`;
  }
  return `The player is emailing "${address}". Based on the crisis context and this email address, determine:
1. Whether someone at this address would realistically respond (set should_reply to false if not)
2. Who that person would be (invent a realistic name and title — if this is an internal/organisational address, the respondent is GROUND-LEVEL OPERATIONAL STAFF such as a duty manager, shift supervisor, or operations coordinator, never a C-suite executive)
3. How they would respond given the crisis situation`;
}

export function characterTopicBlock(phase: ChannelPhase, orgName: string, thread: string): string {
  const subject = thread.trim() || 'the message you were just sent';
  if (phase === 'peace') {
    return `THREAD:\n${subject}\n\n${peacePromptSection(orgName)}\nStay on this thread. Do not introduce an incident the thread has not raised.`;
  }
  return `THREAD:\n${subject}\nStay on this thread's subject. Use the crisis context ONLY if you label the player's message \`bridge\` or \`crisis\`. If your role is part of the crisis, you still keep to the thread's topic unless the label is \`bridge\` or \`crisis\`. For \`on_topic\` or \`off_topic\`, never mention the crisis.`;
}

function characterOpening(speaker: CharacterSpeaker, orgName: string, peace: boolean): string {
  const titled = `${speaker.name}, ${speaker.title ? `${speaker.title} at ` : ''}${speaker.organisation}`;
  const org = orgName ? ` (${orgName})` : '';
  if (peace) {
    return `You are ${titled}. You are a ${speaker.relationship} of the organisation${org}. You are an NPC in a training simulation; players are staff of that organisation.`;
  }
  return `You are ${titled}. You are a ${speaker.relationship} of the organisation under crisis${org}. You are an NPC in a crisis-response training simulation; players are staff of that organisation.`;
}

function characterKnowledge(speaker: CharacterSpeaker): string {
  const known = speaker.knowledge.length
    ? speaker.knowledge.map((item) => `- ${item}`).join('\n')
    : '- (nothing beyond public knowledge)';
  const withheld = speaker.will_not_disclose.length
    ? speaker.will_not_disclose.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  return `Personality and register: ${speaker.personality || 'professional, realistic, concise'}
Your current posture toward the organisation: ${speaker.stance || 'neutral, waiting to see how they handle this'}
Things you know and will share if asked:
${known}
Things you will NOT disclose or do, however asked:
${withheld}`;
}

function characterConduct(speaker: CharacterSpeaker): string {
  const internal =
    speaker.relationship === 'internal'
      ? 'You are staff of this organisation and the players are your colleagues; leadership and your own function lead can give you instructions, which you carry out (acknowledge, act, report — flag a risk once, do not argue). Share verified facts, request status, flag constraints. NEVER draft public statements, talking points, suggested messaging or PR strategy for the players — they must craft their own response.'
      : 'Reflect your own interests and concerns; you are not on the response team and do not coach them on messaging.';
  const media =
    speaker.relationship === 'media'
      ? 'You are a journalist: professional, guarded, you publish when you have something usable.'
      : 'Be authentic: a real person with limited time and their own agenda.';
  const roster =
    speaker.tier === 'roster'
      ? '- You are one member of a larger workforce, not a spokesperson: reply briefly and personally (2-4 sentences), about your own situation, shift and family; you do not speak for colleagues or negotiate.'
      : '';
  return `- Stay in character as this specific person on every channel; you remember every previous exchange listed below regardless of channel.
- ${internal}
- ${media}
${roster}
- Do not invent facts that contradict the confirmed facts. Do not reveal anything from your private situation.`;
}

export function composeStakeholderCharacter(input: {
  speaker: CharacterSpeaker;
  description: string;
  orgName: string;
  confirmed: string;
  claims: string;
  context?: string;
  mood?: string;
  topic?: { phase: ChannelPhase; thread: string } | null;
}): string {
  const peace = input.topic?.phase === 'peace';
  const topicBlock = input.topic
    ? `${characterTopicBlock(input.topic.phase, input.orgName, input.topic.thread)}\n`
    : '';
  const contextMood = `${input.context ? `\nWhat you currently know and feel about recent events (this overrides your default posture where they conflict):\n${input.context}\n` : ''}${input.mood ? `\n${input.mood}\n` : ''}`;
  const opening = `${characterOpening(input.speaker, input.orgName, peace)}

${characterKnowledge(input.speaker)}

`;
  const conduct = `Conduct rules:
${characterConduct(input.speaker)}`;
  if (peace) {
    return `${opening}${topicBlock}${contextMood}
${conduct}`;
  }
  return `${opening}Crisis context: ${input.description.slice(0, 600)}
${input.confirmed ? `Confirmed facts (do not contradict): ${input.confirmed}` : ''}
${input.claims ? `Unverified public claims: ${input.claims}` : ''}
${topicBlock}${contextMood}
${conduct}`;
}
