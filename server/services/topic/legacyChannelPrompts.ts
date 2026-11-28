/**
 * The DM and email persona prompts shipped on master, moved here unchanged.
 * `ENABLE_TOPIC_AWARE_REPLIES` off uses these and nothing else.
 */
import {
  DM_REPLY_JSON,
  DM_REPLY_VOICE,
  EMAIL_RULES,
  emailJsonBody,
  emailMediaBlock,
  emailReplyUser,
  type EmailUserInput,
} from './channelPromptShared.js';

export interface LegacyDmInput {
  handle: string;
  name: string;
  personality: string;
  bias?: string | null;
  type: string;
  /** Full scenario description. The template keeps the first 300 characters. */
  crisisDescription: string;
  orgName: string;
  conversation: string;
  playerMessage: string;
}

export function buildLegacyDmReplyMessages(input: LegacyDmInput): { system: string; user: string } {
  const description = input.crisisDescription.substring(0, 300);
  const system = `You are ${input.handle} (${input.name}), an NPC in a crisis simulation. Reply to a direct message in character.

Your personality: ${input.personality}
Your bias: ${input.bias}
Your type: ${input.type}
Crisis context: ${description}${input.orgName ? `\nOrganization: ${input.orgName}` : ''}

Conversation so far:
${input.conversation}

${DM_REPLY_VOICE}

Return ONLY valid JSON:
${DM_REPLY_JSON}`;
  const user = `The player just sent you this DM: "${input.playerMessage}"`;
  return { system, user };
}

export interface LegacyEmailInput extends EmailUserInput {
  respondentInfo: string;
  /** Full scenario description. The template keeps the first 400 characters. */
  crisisDescription: string;
  orgName: string;
  /** Already formatted, including the leading blank line, or empty. */
  factsContext: string;
  /** Already formatted, including the leading blank line, or empty. */
  threadContext: string;
  isMedia: boolean;
}

export function buildLegacyEmailReplyMessages(input: LegacyEmailInput): {
  system: string;
  user: string;
} {
  const description = input.crisisDescription.substring(0, 400);
  const system = `You are generating an NPC email reply during a crisis simulation. The player sent an email and you must respond in character.

${input.respondentInfo}

Crisis context: ${description}${input.orgName ? `\nOrganization under crisis: ${input.orgName}` : ''}
${input.factsContext}
${input.threadContext}

${EMAIL_RULES}
${emailMediaBlock(input.isMedia)}
Return ONLY valid JSON:
${emailJsonBody(input.isMedia, false)}`;
  return { system, user: emailReplyUser(input) };
}
