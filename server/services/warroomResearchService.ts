/**
 * War Room Research Service
 * Uses OpenAI web search models for area and standards research.
 */

import { logger } from '../lib/logger.js';

const SEARCH_MODEL = 'gpt-4o-search-preview';

/**
 * Research the area around a location: geography, access, landmarks, local agencies.
 * Returns empty string on failure so the main flow can continue without research.
 */
export async function researchArea(
  openAiApiKey: string,
  location: string,
  venueName?: string,
): Promise<string> {
  const venue = venueName || location;
  const prompt = `Research the area around ${venue} in ${location}: geography, access routes, landmarks, local emergency agencies (hospitals, police, fire), and constraints. Return a concise 200-word summary.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = (err as { error?: { message?: string } }).error?.message || response.statusText;
      logger.warn({ status: response.status, msg }, 'Area research failed');
      return '';
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim() : '';
  } catch (err) {
    logger.warn({ err }, 'Area research error');
    return '';
  }
}

/**
 * Research response standards for a scenario type: ICS, WHO MCI, ICRC, media handling.
 * When teams are provided, includes team-specific protocols (e.g. media, coastguard).
 * Returns empty string on failure so the main flow can continue without research.
 */
export async function researchStandards(
  openAiApiKey: string,
  scenarioType: string,
  teams?: string[],
): Promise<string> {
  const teamContext =
    teams && teams.length > 0
      ? ` Include protocols specific to these teams: ${teams.join(', ')}.`
      : '';
  const prompt = `What are key response standards for ${scenarioType} incidents: ICS structure, WHO MCI triage, ICRC principles, media handling?${teamContext} Return a concise 150-word summary.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = (err as { error?: { message?: string } }).error?.message || response.statusText;
      logger.warn({ status: response.status, msg }, 'Standards research failed');
      return '';
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim() : '';
  } catch (err) {
    logger.warn({ err }, 'Standards research error');
    return '';
  }
}
