/**
 * Topic-aware DM and email replies. One responder, so the bridge stance is drawn
 * alone: the "at least one stay" floor only applies once three personas are selected.
 * Phase defaults to crisis. Callers pass `peace`; this module does not read the session.
 */
import type { ChatOptions } from '../ai/chatClient.js';
import {
  channelPhase,
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
  leakTermsFromInitialState,
  peacePromptSection,
  TOPIC_CLASSIFICATION_OBJECT,
  type AssignedStance,
  type BridgeStance,
  type ParsedTopic,
  type StancePersona,
  type TopicLabel,
} from './topicPromptCore.js';

export type { ChannelPhase };
export { channelPhase, leakTermsFromInitialState };

export interface ChannelTopicResult {
  label: TopicLabel;
  confidence: number | null;
  bridgeTopic: string;
  rowId: string;
}

export function channelTopicResult(
  enabled: boolean,
  rowId: string,
  screen: { label: TopicLabel; confidence: number | null; bridgeTopic: string } | null,
): ChannelTopicResult | null {
  if (!enabled || !rowId) return null;
  return {
    label: screen?.label ?? 'unclassified',
    confidence: screen?.confidence ?? null,
    bridgeTopic: screen?.bridgeTopic ?? '',
    rowId,
  };
}

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
      ? peacePromptSection(input.orgName)
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
      ? peacePromptSection(input.orgName)
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
  classification?: unknown;
  /** Already parsed. When set, `classification` is not read again. */
  parsed?: ParsedTopic | null;
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
  const checked = checkTopicReplies({
    classification: input.classification,
    parsed: input.parsed,
    reactions: [{ author_handle: input.authorHandle, content: input.replyText }],
    stances: { [input.authorHandle]: input.stance },
    leakTerms: input.leakTerms,
    postKind: 'crisis',
    isReply: input.isReply,
    minConfidence: input.minConfidence,
    phase: input.phase,
    playerText: input.playerText,
  });
  const replyText = checked.reactions.length > 0 ? input.replyText : '';
  return {
    label: checked.label,
    bridgeTopic: checked.bridgeTopic,
    confidence: checked.confidence,
    replyText,
    dropped: input.replyText.length > 0 && checked.reactions.length === 0,
  };
}

/** One stakeholder responder. The parsed classification is not turned back into model JSON. */
export function screenStakeholderReply(input: {
  phase?: ChannelPhase;
  classification?: ParsedTopic;
  replyText: string;
  authorHandle: string;
  leakTerms: readonly string[];
  playerText: string;
  isReply: boolean;
  minConfidence: number;
}): ChannelScreenResult {
  return screenChannelReply({
    phase: input.phase,
    parsed: input.classification ?? { label: 'unclassified', bridgeTopic: '', confidence: null },
    replyText: input.replyText,
    authorHandle: input.authorHandle,
    stance: 'engage',
    leakTerms: input.leakTerms,
    playerText: input.playerText,
    isReply: input.isReply,
    minConfidence: input.minConfidence,
  });
}

export type { EmailUserInput };
