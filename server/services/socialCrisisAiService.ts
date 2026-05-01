import { logger } from '../lib/logger.js';
import { env } from '../env.js';

export interface SocialInjectCancellationResult {
  cancel: boolean;
  cancel_reason?: string;
  adversary_inject?: { title: string; content: string; delivery_config?: Record<string, unknown> };
}

export async function shouldCancelSocialInject(
  inject: { title: string; content: string; delivery_config?: Record<string, unknown> },
  playerActions: Array<{
    action_type: string;
    content: string | null;
    created_at: string;
    metadata: Record<string, unknown>;
  }>,
  sentimentState: { overall: number; hate_speech_volume: number; trend: string },
  pendingResponseCount: number,
): Promise<SocialInjectCancellationResult> {
  if (!env.openAiApiKey) {
    return { cancel: false, cancel_reason: 'No API key' };
  }

  try {
    const systemPrompt = `You are the adversary engine for a social media crisis response simulation. You evaluate whether a scheduled inject (social media post, email, news article) should still be published based on what the response team has done so far.

=== STEP 1: HAS THE TEAM ADDRESSED THIS? ===
Review the team's recent actions. Have they collectively taken actions that make this inject redundant?

Set "cancel": true when:
- The team has already posted counter-narratives addressing this inject's concern
- The team has flagged and debunked the misinformation this inject would spread
- The team's responses have shifted sentiment enough that this inject would feel contradictory
- The team has engaged community leaders who would have prevented this narrative

Set "cancel": false when:
- The team has NOT taken any actions related to this inject's concern
- The team addressed something tangentially related but the specific problem still exists
- The inject introduces genuinely new information or a new angle of attack

=== STEP 2: ADVERSARY ADAPTATION (only if cancel = true) ===
If the team addressed the original concern, can the adversary still cause trouble on the SAME SUBJECT?
- A different social media platform (team responded on X, adversary moves to Facebook)
- A different angle (team debunked the claim, adversary posts "proof" photos)
- A second-order consequence (team addressed hate speech, but now community trust is damaged)

Return ONLY valid JSON:
{
  "cancel": boolean,
  "cancel_reason": "...",
  "adversary_inject": { "title": "...", "content": "..." }
}`;

    const actionsText =
      playerActions.length > 0
        ? playerActions
            .slice(0, 30)
            .map((a, i) => `${i + 1}. [${a.action_type}] ${a.content || '(no content)'}`)
            .join('\n')
        : 'No player actions taken yet.';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `SCHEDULED INJECT:\nTitle: ${inject.title}\nContent: ${inject.content}\nApp: ${(inject.delivery_config as Record<string, unknown>)?.app || 'social_feed'}\n\nTEAM ACTIONS:\n${actionsText}\n\nSENTIMENT: ${sentimentState.overall}/100 (${sentimentState.trend})\nPENDING RESPONSES: ${pendingResponseCount} posts still need response`,
          },
        ],
        temperature: 0.4,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      return { cancel: false, cancel_reason: 'AI check failed' };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { cancel: false, cancel_reason: 'Empty AI response' };

    return JSON.parse(content) as SocialInjectCancellationResult;
  } catch (err) {
    logger.error({ err }, 'Social inject cancellation check failed');
    return { cancel: false, cancel_reason: 'Error during check' };
  }
}
