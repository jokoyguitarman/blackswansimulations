/**
 * Bubble-feed system prompt. With topicAware false the text matches the inline
 * prompt previously in generatePlayerBubblePosts.
 */
export function buildPlayerBubbleSystemPrompt(input: {
  crisisDescription: string;
  elapsedMinutes: number;
  sentimentScore: number | string;
  npcList: string;
  normalTopics: string;
  topicAware: boolean;
}): string {
  const head = `You generate social media posts for a specific player's personalized feed in a crisis simulation. These posts should feel like what this person would naturally see in their social media bubble.

THE CRISIS: ${input.crisisDescription.substring(0, 300)}
Elapsed: ${input.elapsedMinutes}min. Sentiment: ${input.sentimentScore}/100.

NPCs IN THIS PLAYER'S BUBBLE:
${input.npcList}

CONTENT MIX — generate exactly 3 posts:
- 2 posts should be crisis-related: reactions, opinions, news sharing, demands, or commentary about the crisis. Each from a different NPC.
- 1 post should be NORMAL LIFE: an NPC posting about their regular interests (${input.normalTopics}) as if the crisis isn't the only thing happening. This makes the feed feel like real social media.

For crisis posts, set content_flags as appropriate:
- is_harmful_narrative, is_misinformation, is_inflammatory, incites_violence, is_organized_pressure
Leave content_flags as {} for neutral, supportive, or normal life posts.`;

  if (!input.topicAware) {
    return `${head}

Return ONLY valid JSON:
{ "posts": [{ "author_handle": "@user", "author_display_name": "Name", "author_type": "npc_public", "content": "text", "sentiment": "neutral|negative|supportive|hateful|inflammatory", "virality_score": 5, "content_flags": {}, "image_prompt": "" }] }`;
  }

  return `${head}

Set is_normal_life to true on exactly the one NORMAL LIFE post and false on the two crisis posts.

Return ONLY valid JSON:
{ "posts": [{ "author_handle": "@user", "author_display_name": "Name", "author_type": "npc_public", "content": "text", "sentiment": "neutral|negative|supportive|hateful|inflammatory", "virality_score": 5, "content_flags": {}, "image_prompt": "", "is_normal_life": false }] }`;
}

export function isNormalLifeFlag(value: unknown): boolean {
  return value === true || value === 'true';
}
