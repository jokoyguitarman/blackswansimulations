/**
 * The reaction prompt shipped on master (4abae864), moved here unchanged.
 * `ENABLE_TOPIC_AWARE_REPLIES` off uses this and nothing else.
 */
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
}

export function buildLegacyReactionMessages(input: LegacyReactionPromptInput): {
  system: string;
  user: string;
} {
  const system = `You are generating NPC reactions to a player's social media post during a crisis simulation.

The player posted a ${input.postFormat} format post. Their handle is ${input.playerHandle}. Generate realistic reactions from these NPCs:

${input.npcContext}

Reaction types:
- "attack": ${
    input.isOfficialComms
      ? 'critical challenge -- engage with the SUBSTANCE of the statement: quote its exact words, point out what it fails to address, question unverified claims, demand specifics (numbers, timelines, affected scope, next update). Sceptical and demanding, never sarcastic or mocking.'
      : 'hostile reply -- twist their words, mock them, double down on misinformation, accuse them of bias'
  }
- "cover": media-style coverage -- ${
    input.isOfficialComms
      ? 'report what the statement said and what remains unanswered, like a journalist covering a press release'
      : "neutral to positive news angle about the response team's communication"
  }
- "support": endorsing reply or repost with supportive commentary, OR just "like" the post
- "neutral": ambiguous reaction that could go either way
- "position": subtle competitive messaging -- highlight own values, imply superiority without directly attacking. Professional and strategic, not aggressive. Used by competitor brands.

IMPORTANT RULES:
- When replying, START the reply by tagging the player: "${input.playerHandle} ..." so they get notified
- Some NPCs can just LIKE the post instead of replying. Use action: "like" for this.
- Supportive NPCs are more likely to like; hostile NPCs are more likely to reply attacking.
${input.officialScrutinyBlock}
Crisis context: ${input.crisisDescription}${input.orgName ? `\nOrganization: ${input.orgName}` : ''}
${input.threadContext}

Each reaction should be 1-3 sentences, feel like a real social media reply/post. Stay in character.${input.isReply ? ' Since this is a thread reply, respond DIRECTLY to what the player said -- argue, agree, counter, or react to their specific words.' : ''}
If the player attached media (photo/video), the description is shown as [Attached media: ...]. React to the visual content as if you can see it -- reference what it shows, comment on its impact, or use it to fuel your argument.

Return ONLY valid JSON:
{ "reactions": [{ "author_handle": "@exact_handle", "author_display_name": "Exact Name", "author_type": "npc_public|npc_media|npc_politician|npc_influencer", "content": "reaction text", "sentiment": "negative|supportive|neutral|hateful", "is_reply": true, "action": "reply|repost_with_comment|new_post|like" }] }`;

  const user = `Player post by ${input.userHandle}:\n"${input.playerContent}"${input.imagePrompt ? `\n\n[Attached media: ${input.imagePrompt}]` : ''}`;
  return { system, user };
}
