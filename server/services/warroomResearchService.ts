/**
 * War Room Research Service
 * Uses OpenAI web search models for area and standards research.
 * Standards research is narrative-driven: first identifies relevant domains from the
 * scenario story, then fetches specific protocols per domain.
 */

import { logger } from '../lib/logger.js';

const SEARCH_MODEL = 'gpt-4o-search-preview';

export interface StandardsFinding {
  domain: string;
  source: string;
  key_points: string[];
  decision_thresholds?: string;
}

/**
 * Research the area around a location: geography, access, landmarks, local agencies.
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
 * Two-step narrative-driven standards research.
 *
 * Step 1: From the scenario story, identify which response disciplines apply and name
 *         the authoritative frameworks/doctrines for each.
 * Step 2: For each domain, fetch specific protocols, thresholds, and procedures.
 *
 * Returns structured StandardsFinding[] so each inject/phase generation call can
 * reference precise content rather than a generic summary blob.
 */
export async function researchStandards(
  openAiApiKey: string,
  scenarioType: string,
  teams?: string[],
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<StandardsFinding[]> {
  const teamContext =
    teams && teams.length > 0 ? ` Response teams involved: ${teams.join(', ')}.` : '';

  const narrativeBlock = narrative
    ? `\n\nScenario narrative:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : `\n\nScenario type: ${scenarioType}`;

  // Step 1: Identify relevant domains and named standards from the narrative
  const domainPrompt = `You are an expert in emergency management and crisis response.${narrativeBlock}${teamContext}

Based ONLY on what this specific incident requires — not generic templates — identify the 3-5 response disciplines that would actually be deployed. For each, name the specific authoritative standard, doctrine, or framework that governs it (e.g. "ICS NIMS 2017", "START Triage Protocol", "FBI Crisis Negotiation Unit Manual", "CBRN STANAG 2513", "Singapore Civil Defence Act").

Return ONLY valid JSON:
{
  "domains": [
    { "discipline": "string", "standard_name": "string", "reason": "why this applies to THIS incident" }
  ]
}`;

  let domains: Array<{ discipline: string; standard_name: string; reason: string }> = [];

  try {
    const step1Res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: domainPrompt }],
        max_tokens: 600,
      }),
    });

    if (step1Res.ok) {
      const data = await step1Res.json();
      const raw = data.choices?.[0]?.message?.content as string | undefined;
      if (raw) {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            domains?: Array<{ discipline: string; standard_name: string; reason: string }>;
          };
          domains = parsed.domains?.slice(0, 5) ?? [];
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Standards domain identification failed');
  }

  if (domains.length === 0) {
    logger.warn({ scenarioType }, 'No domains identified; skipping standards deep fetch');
    return [];
  }

  // Step 2: For each domain, fetch specific actionable content
  const findings: StandardsFinding[] = [];

  await Promise.all(
    domains.map(async ({ discipline, standard_name, reason }) => {
      const fetchPrompt = `You are an expert in ${discipline}.${narrativeBlock}

Look up "${standard_name}" and extract the specific content relevant to this incident.
Return ONLY valid JSON:
{
  "domain": "${discipline}",
  "source": "${standard_name}",
  "key_points": ["specific protocol or threshold 1", "specific protocol or threshold 2", "..."],
  "decision_thresholds": "any numeric thresholds or decision gates (e.g. triage colour criteria, response time targets, resource ratios)"
}

Focus on: decision gates, time thresholds, role responsibilities, command structure, and any criteria that determine correct vs incorrect team responses.
Context for why this matters here: ${reason}`;

      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAiApiKey}`,
          },
          body: JSON.stringify({
            model: SEARCH_MODEL,
            messages: [{ role: 'user', content: fetchPrompt }],
            max_tokens: 600,
          }),
        });

        if (!res.ok) return;
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content as string | undefined;
        if (!raw) return;

        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;

        const finding = JSON.parse(jsonMatch[0]) as StandardsFinding;
        if (finding.domain && finding.source && Array.isArray(finding.key_points)) {
          findings.push(finding);
        }
      } catch (err) {
        logger.warn({ err, discipline, standard_name }, 'Standards deep fetch failed for domain');
      }
    }),
  );

  logger.info(
    { scenarioType, domainCount: domains.length, fetchedCount: findings.length },
    'Standards research complete',
  );

  return findings;
}

/**
 * Serialize StandardsFinding[] to a compact string for embedding in AI prompts.
 */
export function standardsToPromptBlock(findings: StandardsFinding[]): string {
  if (findings.length === 0) return '';
  return findings
    .map(
      (f) =>
        `[${f.source}] ${f.domain}:\n` +
        f.key_points.map((p) => `  - ${p}`).join('\n') +
        (f.decision_thresholds ? `\n  Thresholds: ${f.decision_thresholds}` : ''),
    )
    .join('\n\n');
}
