/** Same competitor test the reaction selector has always used. */
export function isCompetitorPersona(persona: { personality: string; bias: string }): boolean {
  return (
    /competitor|rival|competing|alternative/i.test(persona.personality) ||
    /competitive/i.test(persona.bias)
  );
}

export function formatPersonaReactionLine(
  persona: { handle: string; name: string; personality: string; bias: string; type: string },
  reactionType: string,
): string {
  return `${persona.handle} (${persona.name}): ${persona.personality}, bias: ${persona.bias}, type: ${persona.type}. React with: ${reactionType}`;
}

export function formatPersonaStanceLine(
  persona: { handle: string; name: string; personality: string; bias: string; type: string },
  reactionType: string,
  stance: 'engage' | 'stay',
): string {
  return `${formatPersonaReactionLine(persona, reactionType)}. If bridge: ${stance}.`;
}

export const ATTACK_OFFICIAL =
  'critical challenge -- engage with the SUBSTANCE of the statement: quote its exact words, point out what it fails to address, question unverified claims, demand specifics (numbers, timelines, affected scope, next update). Sceptical and demanding, never sarcastic or mocking.';

export const ATTACK_HOSTILE =
  'hostile reply -- twist their words, mock them, double down on misinformation, accuse them of bias';

export const COVER_OFFICIAL =
  'report what the statement said and what remains unanswered, like a journalist covering a press release';

export const COVER_ORDINARY =
  "neutral to positive news angle about the response team's communication";

export const SUPPORT_REACTION =
  'endorsing reply or repost with supportive commentary, OR just "like" the post';

export const NEUTRAL_REACTION = 'ambiguous reaction that could go either way';

export const POSITION_REACTION =
  'subtle competitive messaging -- highlight own values, imply superiority without directly attacking. Professional and strategic, not aggressive. Used by competitor brands.';

export const MEDIA_REACT_LINE =
  'If the player attached media (photo/video), the description is shown as [Attached media: ...]. React to the visual content as if you can see it -- reference what it shows, comment on its impact, or use it to fuel your argument.';

export const REACTION_ITEM_SCHEMA =
  '{ "author_handle": "@exact_handle", "author_display_name": "Exact Name", "author_type": "npc_public|npc_media|npc_politician|npc_influencer", "content": "reaction text", "sentiment": "negative|supportive|neutral|hateful", "is_reply": true, "action": "reply|repost_with_comment|new_post|like" }';

export function attackWording(isOfficialComms: boolean): string {
  return isOfficialComms ? ATTACK_OFFICIAL : ATTACK_HOSTILE;
}

export function coverWording(isOfficialComms: boolean): string {
  return isOfficialComms ? COVER_OFFICIAL : COVER_ORDINARY;
}

/** Reaction-type list and the tagging rules. Both prompt builders use this text. */
export function reactionTypesAndRules(playerHandle: string, isOfficialComms: boolean): string {
  return `Reaction types:
- "attack": ${attackWording(isOfficialComms)}
- "cover": media-style coverage -- ${coverWording(isOfficialComms)}
- "support": ${SUPPORT_REACTION}
- "neutral": ${NEUTRAL_REACTION}
- "position": ${POSITION_REACTION}

IMPORTANT RULES:
- When replying, START the reply by tagging the player: "${playerHandle} ..." so they get notified
- Some NPCs can just LIKE the post instead of replying. Use action: "like" for this.
- Supportive NPCs are more likely to like; hostile NPCs are more likely to reply attacking.`;
}
