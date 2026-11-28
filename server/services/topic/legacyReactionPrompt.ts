/**
 * The reaction prompt shipped on master, moved here unchanged.
 * `ENABLE_TOPIC_AWARE_REPLIES` off uses this and nothing else.
 */
import { peaceContextBlock, type TopicPhase } from './topicPromptCore.js';
import {
  MEDIA_REACT_LINE,
  reactionTypesAndRules,
  REACTION_ITEM_SCHEMA,
} from './reactionPromptShared.js';

export interface LegacyReactionPromptInput {
  postFormat: string;
  playerHandle: string;
  npcContext: string;
  isOfficialComms: boolean;
  officialScrutinyBlock: string;
  crisisDescription: string;
  orgName: string;
  threadContext: string;
  isReply: boolean;
  playerContent: string;
  imagePrompt?: string;
  /** Legacy user message stringifies author_handle with no '@player' fallback. */
  userHandle: string;
  /** Omitted or crisis keeps the prompt byte-identical to today. */
  phase?: TopicPhase;
}

export function buildLegacyReactionMessages(input: LegacyReactionPromptInput): {
  system: string;
  user: string;
} {
  const system = `You are generating NPC reactions to a player's social media post during a crisis simulation.

The player posted a ${input.postFormat} format post. Their handle is ${input.playerHandle}. Generate realistic reactions from these NPCs:

${input.npcContext}

${reactionTypesAndRules(input.playerHandle, input.isOfficialComms)}
${input.phase === 'peace' ? '' : input.officialScrutinyBlock}
${
  input.phase === 'peace'
    ? `PEACE:\n${peaceContextBlock(input.orgName)}`
    : `Crisis context: ${input.crisisDescription}${input.orgName ? `\nOrganization: ${input.orgName}` : ''}`
}
${input.threadContext}

Each reaction should be 1-3 sentences, feel like a real social media reply/post. Stay in character.${input.isReply ? ' Since this is a thread reply, respond DIRECTLY to what the player said -- argue, agree, counter, or react to their specific words.' : ''}
${MEDIA_REACT_LINE}

Return ONLY valid JSON:
{ "reactions": [${REACTION_ITEM_SCHEMA}] }`;

  const user = `Player post by ${input.userHandle}:\n"${input.playerContent}"${input.imagePrompt ? `\n\n[Attached media: ${input.imagePrompt}]` : ''}`;
  return { system, user };
}
