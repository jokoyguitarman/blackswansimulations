/**
 * Facts read out of pages that were fetched for one building. A number is
 * researched only when the fetched text agrees. Nothing here is a guess.
 */

export interface LayoutSource {
  title: string;
  url: string;
  quote: string;
}

export interface Cited<T> {
  value: T;
  sources: LayoutSource[];
}

export interface HawkerFacts {
  cookedStalls: Cited<number> | null;
  marketStalls: Cited<number> | null;
  /** Stall numbers on a fetched page are 01- and not 02- or higher. */
  singleStorey: Cited<true> | null;
  cookedStallAreaM2: Cited<number> | null;
  disagreements: string[];
}

export interface PageText {
  url: string;
  title: string;
  text: string;
}

export const EMPTY_HAWKER_FACTS: HawkerFacts = {
  cookedStalls: null,
  marketStalls: null,
  singleStorey: null,
  cookedStallAreaM2: null,
  disagreements: [],
};

const COMPRISES = /comprises\s+(\d+)\s+cooked food stalls and\s+(\d+)\s+market stalls/gi;
const STALL_01 = /\b01-\d{1,3}\b/g;
const STALL_UPPER = /\b0[2-9]-\d{1,3}\b/;
const NAME_WINDOW = 240;
const NAME_SKIP = new Set([
  'and',
  'the',
  'market',
  'food',
  'centre',
  'center',
  'hawker',
  'singapore',
]);

/** Words that identify the building, without the generic hawker-centre words. */
export function buildingTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !NAME_SKIP.has(word));
}

function hasTokens(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const hay = text.toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

function aboutThisBuilding(page: PageText, tokens: readonly string[], around: number): boolean {
  if (hasTokens(page.title, tokens)) return true;
  const start = Math.max(0, around - NAME_WINDOW);
  const end = Math.min(page.text.length, around + NAME_WINDOW);
  return hasTokens(page.text.slice(start, end), tokens);
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function clip(quote: string): string {
  const clean = quote.replace(/\s+/g, ' ').trim();
  return clean.length <= 180 ? clean : `${clean.slice(0, 177)}...`;
}

export function extractHawkerFacts(pages: readonly PageText[], buildingName: string): HawkerFacts {
  const tokens = buildingTokens(buildingName);
  const pairs = new Map<string, { cooked: number; market: number; sources: LayoutSource[] }>();
  for (const page of pages) {
    for (const match of page.text.matchAll(COMPRISES)) {
      if (!aboutThisBuilding(page, tokens, match.index ?? 0)) continue;
      const cooked = Number(match[1]);
      const market = Number(match[2]);
      const key = `${cooked}/${market}`;
      const end = (match.index ?? 0) + match[0].length;
      const source: LayoutSource = {
        title: page.title,
        url: page.url,
        quote: clip(page.text[end] === '.' ? `${match[0]}.` : match[0]),
      };
      const existing = pairs.get(key);
      if (!existing) {
        pairs.set(key, { cooked, market, sources: [source] });
      } else if (!existing.sources.some((item) => item.url === page.url)) {
        existing.sources.push(source);
      }
    }
  }

  const disagreements: string[] = [];
  let cookedStalls: Cited<number> | null = null;
  let marketStalls: Cited<number> | null = null;
  if (pairs.size === 1) {
    const only = [...pairs.values()][0];
    cookedStalls = { value: only.cooked, sources: only.sources };
    marketStalls = { value: only.market, sources: only.sources };
  } else if (pairs.size > 1) {
    disagreements.push(
      `Fetched pages disagree on the stall counts: ${[...pairs.keys()].join(', ')}.`,
    );
  }

  let singleStorey: Cited<true> | null = null;
  let cookedStallAreaM2: Cited<number> | null = null;
  for (const page of pages) {
    if (!hasTokens(`${page.title} ${page.text}`, tokens)) continue;
    const levelOne = page.text.match(STALL_01) ?? [];
    if (!singleStorey && levelOne.length >= 2 && !STALL_UPPER.test(page.text)) {
      const at = page.text.search(STALL_01);
      singleStorey = {
        value: true,
        sources: [
          {
            title: page.title,
            url: page.url,
            quote: clip(page.text.slice(Math.max(0, at - 40), at + 80)),
          },
        ],
      };
    }
    if (!cookedStallAreaM2) {
      const areaAt = page.text.search(/10\.75\s*m(?:²|2)?/i);
      if (areaAt >= 0) {
        const window = page.text.slice(Math.max(0, areaAt - 120), areaAt + 40);
        if (/cooked/i.test(window)) {
          cookedStallAreaM2 = {
            value: 10.75,
            sources: [
              {
                title: page.title,
                url: page.url,
                quote: clip(window),
              },
            ],
          };
        }
      }
    }
  }

  return { cookedStalls, marketStalls, singleStorey, cookedStallAreaM2, disagreements };
}

/**
 * URLs cited by an OpenAI Responses API web-search reply.
 * Each citation is `{ type: "url_citation", url, title }` on a message annotation.
 */
export function citationsFromOpenAiResponse(body: unknown): { title: string; url: string }[] {
  if (!body || typeof body !== 'object') return [];
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return [];
  const found: { title: string; url: string }[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const annotations = (part as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const note of annotations) {
        if (!note || typeof note !== 'object') continue;
        const typed = note as { type?: unknown; url?: unknown; title?: unknown };
        if (typed.type !== 'url_citation' || typeof typed.url !== 'string') continue;
        if (!/^https?:\/\//i.test(typed.url)) continue;
        if (found.some((hit) => hit.url === typed.url)) continue;
        found.push({
          url: typed.url,
          title: typeof typed.title === 'string' && typed.title.trim() ? typed.title : typed.url,
        });
      }
    }
  }
  return found;
}
