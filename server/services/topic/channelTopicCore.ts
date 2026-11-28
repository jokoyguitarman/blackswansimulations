/**
 * Topic-aware DM and email replies. One responder, so the bridge stance is drawn
 * alone: the "at least one stay" floor only applies once three personas are selected.
 * Phase defaults to crisis. Callers pass `peace`; this module does not read the session.
 */
import type { ChatOptions } from '../ai/chatClient.js';
import { matchesLeakTerms } from '../generation/peaceFeedCore.js';
import {
  characterTopicBlock,
  DM_REPLY_BODY,
  DM_REPLY_VOICE,
  EMAIL_RULES,
  emailJsonBody,
  emailMediaBlock,
  emailReplyUser,
  formatEmailHistoryLine,
  type ChannelPhase,
  type EmailHistoryRow,
  type EmailUserInput,
} from './channelPromptShared.js';
import type { LegacyDmInput, LegacyEmailInput } from './legacyChannelPrompts.js';
import {
  assignBridgeStances,
  checkTopicReplies,
  TOPIC_CLASSIFICATION_OBJECT,
  topicPeaceBlock,
  type AssignedStance,
  type BridgeStance,
  type StancePersona,
  type TopicLabel,
} from './topicPromptCore.js';

export type { ChannelPhase };

export interface ChannelChatClient {
  chatJson(
    options: Pick<
      ChatOptions,
      'tier' | 'json' | 'temperature' | 'maxTokens' | 'label' | 'messages'
    >,
  ): Promise<unknown>;
}

export function asModelRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function channelPhase(phase: ChannelPhase | undefined): ChannelPhase {
  return phase === 'peace' ? 'peace' : 'crisis';
}

export function leakTermsFromState(initialState: unknown): string[] {
  if (!initialState || typeof initialState !== 'object') return [];
  const peace = (initialState as { peace_period?: { leak_terms?: unknown } }).peace_period;
  const terms = peace?.leak_terms;
  if (!Array.isArray(terms)) return [];
  return terms.map((term) => String(term));
}

export function singleResponderStance(
  persona: StancePersona,
  seed: string,
  stayShare = 0.4,
): AssignedStance {
  const [row] = assignBridgeStances([{ persona }], seed, { stayShare });
  return (
    row ?? {
      handle: persona.handle,
      stance: 'stay',
      engageProbability: Math.min(1, Math.max(0, 1 - stayShare)),
      forcedEngage: false,
    }
  );
}

function channelCrisisFence(description: string, orgName: string, orgLabel: string): string {
  const org = orgName ? `\n${orgLabel}: ${orgName}` : '';
  return `CRISIS CONTEXT: use ONLY if you label the message \`bridge\`, and ONLY if your stance is \`engage\`. If your stance is \`stay\`, reply about the thread as if the remark were a passing jab (ignore it, deflect, or tease back about the thread). For \`on_topic\` or \`off_topic\`, never mention the crisis.
${description}${org}`;
}

const CHANNEL_LABEL_RULE =
  "Labels: on_topic (this thread's subject), bridge (ties the thread to the crisis), off_topic, or crisis (only the first message of a thread, and only when that message is about the crisis).";

export function buildTopicDmMessages(
  input: LegacyDmInput & { phase?: ChannelPhase; stance: BridgeStance },
): { system: string; user: string } {
  const phase = channelPhase(input.phase);
  const stanceLine = `${input.handle} (${input.name}): ${input.personality}, bias: ${input.bias}, type: ${input.type}. If bridge: ${input.stance}.`;
  const context =
    phase === 'peace'
      ? `PEACE:\n${topicPeaceBlock(input.orgName)}`
      : channelCrisisFence(
          input.crisisDescription.substring(0, 300),
          input.orgName,
          'Organization',
        );
  const system = `Your reply is about THIS conversation.

THREAD:
${input.conversation || '(no earlier messages)'}

MESSAGE BEING ANSWERED:
"${input.playerMessage}"

YOU:
${stanceLine}

${context}

${DM_REPLY_VOICE}
${CHANNEL_LABEL_RULE}

Return ONLY valid JSON:
{ "classification": ${TOPIC_CLASSIFICATION_OBJECT}, "reply": ${DM_REPLY_BODY} }`;
  const user = `The player just sent you this DM: "${input.playerMessage}"`;
  return { system, user };
}

export function buildTopicEmailMessages(
  input: LegacyEmailInput & {
    phase?: ChannelPhase;
    stanceLine: string;
    history: readonly EmailHistoryRow[];
  },
): { system: string; user: string } {
  const phase = channelPhase(input.phase);
  const lastThree = input.history.slice(-3);
  const thread = [
    `Subject: ${input.subject}`,
    ...lastThree.map((row) => formatEmailHistoryLine(row)),
  ].join('\n---\n');
  const context =
    phase === 'peace'
      ? `PEACE:\n${topicPeaceBlock(input.orgName)}`
      : `${channelCrisisFence(input.crisisDescription.substring(0, 400), input.orgName, 'Organization under crisis')}${input.factsContext}`;
  const system = `Your reply is about THIS email thread.

THREAD:
${thread}

RESPONDENT:
${input.respondentInfo}
${input.stanceLine}

${context}

${EMAIL_RULES}
${CHANNEL_LABEL_RULE}
${emailMediaBlock(input.isMedia)}
Return ONLY valid JSON:
${emailJsonBody(input.isMedia, true)}`;
  return { system, user: emailReplyUser(input) };
}

export interface ChannelScreenInput {
  phase?: ChannelPhase;
  classification: unknown;
  replyText: string;
  authorHandle: string;
  stance: BridgeStance;
  leakTerms: readonly string[];
  playerText: string;
  isReply: boolean;
  minConfidence: number;
}

export interface ChannelScreenResult {
  label: TopicLabel;
  bridgeTopic: string;
  confidence: number | null;
  replyText: string;
  dropped: boolean;
}

/**
 * The comment post-check, for one reply. In peace, a player message that matches
 * leak terms is stored as bridge, and any reply that matches leak terms is dropped.
 */
export function screenChannelReply(input: ChannelScreenInput): ChannelScreenResult {
  const phase = channelPhase(input.phase);
  const checked = checkTopicReplies({
    classification: input.classification,
    reactions: [{ author_handle: input.authorHandle, content: input.replyText }],
    stances: { [input.authorHandle]: input.stance },
    leakTerms: input.leakTerms,
    postKind: 'crisis',
    isReply: input.isReply,
    minConfidence: input.minConfidence,
  });
  let label = checked.label;
  let replyText = checked.reactions.length > 0 ? input.replyText : '';
  let dropped = input.replyText.length > 0 && checked.reactions.length === 0;
  if (phase === 'peace' && matchesLeakTerms(input.playerText, input.leakTerms)) {
    label = 'bridge';
  }
  if (phase === 'peace' && replyText && matchesLeakTerms(replyText, input.leakTerms)) {
    replyText = '';
    dropped = true;
  }
  return {
    label,
    bridgeTopic: checked.bridgeTopic,
    confidence: checked.confidence,
    replyText,
    dropped,
  };
}

export function stakeholderTopicBlock(
  phase: ChannelPhase | undefined,
  orgName: string,
  thread: string,
): string {
  return characterTopicBlock(channelPhase(phase), orgName, thread);
}

export type { EmailUserInput };
