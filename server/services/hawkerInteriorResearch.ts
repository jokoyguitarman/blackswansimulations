/**
 * Live pages for one food centre. Search first, using the OpenAI web-search
 * tool when OPENAI_API_KEY is set. DuckDuckGo's HTML endpoint answers this
 * server with a bot challenge, so it is not used. When search yields no stall
 * counts, the Holland Village pages below are fetched instead. The facts come
 * from the response text. This module does not write to a database and does
 * not import the server env module.
 */

import {
  citationsFromOpenAiResponse,
  extractHawkerFacts,
  htmlToText,
  type HawkerFacts,
  type PageText,
} from '../../shared/hawkerFacts.js';

export interface ResearchPage {
  url: string;
  title: string;
  ok: boolean;
}

export interface HawkerResearch {
  mode: 'search' | 'listed_pages' | 'none';
  facts: HawkerFacts;
  pages: ResearchPage[];
  /** Why this path was used. Shown to the trainer with the session. */
  note: string;
}

export interface PageSearchHit {
  title: string;
  url: string;
}

export interface PageSearchResult {
  pages: PageSearchHit[];
  /** Why the search returned what it returned. */
  reason: 'ok' | 'no_key' | 'failed' | 'no_links';
}

const LISTED_HOLLAND_PAGES: PageSearchHit[] = [
  {
    title: 'Holland Village Market & Food Centre',
    url: 'https://bedokstudio.com/centres/holland-village-market-and-food-centre',
  },
  {
    title: 'Holland Village Market and Food Centre',
    url: 'https://www.anything.sg/hawker-centres-singapore/holland-village-market-and-food-centre/',
  },
  {
    title: 'Holland Village Market and Food Centre stall notes',
    url: 'https://hawker.datainsg.com/holland-village-market-and-food-centre/',
  },
];

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
/** The standard-tier model this server already uses for OpenAI chat. */
const OPENAI_SEARCH_MODEL = 'gpt-5.2';

export function isHollandVillageFoodCentre(name: string): boolean {
  return /holland village/i.test(name) && /market|food/i.test(name);
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** http(s) only, and not a loopback or private address. */
export function isPublicHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host === '::1' || host === '0.0.0.0') return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return true;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 169 && b === 254) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  return true;
}

async function defaultFetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'prophyion-blackswansimulations/1.0 (building interior research)',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/**
 * Ask the OpenAI Responses API to search the web and return the cited pages.
 * No key, a failed call, or a reply with no citations all come back empty
 * with a reason, so the caller can fetch the known pages instead.
 */
export async function openAiPageSearch(name: string): Promise<PageSearchResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { pages: [], reason: 'no_key' };
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_SEARCH_MODEL,
        tools: [{ type: 'web_search' }],
        input: `Find public web pages about "${name}" that say how many cooked food stalls and market stalls it has. Cite the pages.`,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { pages: [], reason: 'failed' };
    const pages = citationsFromOpenAiResponse(await response.json())
      .filter((page) => isPublicHttpUrl(page.url))
      .slice(0, 3)
      .map((page) => ({ title: page.title || titleFromUrl(page.url), url: page.url }));
    return pages.length > 0 ? { pages, reason: 'ok' } : { pages: [], reason: 'no_links' };
  } catch {
    return { pages: [], reason: 'failed' };
  }
}

async function readPages(
  targets: PageSearchHit[],
  fetchHtml: (url: string) => Promise<string>,
): Promise<{ pages: PageText[]; report: ResearchPage[] }> {
  const pages: PageText[] = [];
  const report: ResearchPage[] = [];
  for (const target of targets) {
    if (!isPublicHttpUrl(target.url)) {
      report.push({ url: target.url, title: target.title, ok: false });
      continue;
    }
    try {
      const html = await fetchHtml(target.url);
      const text = htmlToText(html);
      if (text.length < 40) throw new Error('page had no text');
      pages.push({ url: target.url, title: target.title, text });
      report.push({ url: target.url, title: target.title, ok: true });
    } catch {
      report.push({ url: target.url, title: target.title, ok: false });
    }
  }
  return { pages, report };
}

function listedNote(reason: PageSearchResult['reason'], hadPages: boolean): string {
  if (hadPages) {
    return 'Web search did not state this building’s stall counts, so the public centre pages were fetched instead.';
  }
  if (reason === 'no_key') {
    return 'No web-search key is set on this server, so the public centre pages were fetched instead.';
  }
  if (reason === 'failed') {
    return 'The web search failed, so the public centre pages were fetched instead.';
  }
  return 'Web search returned no pages, so the public centre pages were fetched instead.';
}

export async function researchHawkerCentre(
  name: string,
  fetchHtml: (url: string) => Promise<string> = defaultFetchHtml,
  search: (name: string) => Promise<PageSearchResult> = openAiPageSearch,
): Promise<HawkerResearch> {
  let searched: PageSearchResult = { pages: [], reason: 'failed' };
  try {
    searched = await search(name);
  } catch {
    searched = { pages: [], reason: 'failed' };
  }

  if (searched.pages.length > 0) {
    const { pages, report } = await readPages(searched.pages.slice(0, 3), fetchHtml);
    const facts = extractHawkerFacts(pages, name);
    if (facts.cookedStalls || facts.marketStalls) {
      return {
        mode: 'search',
        facts,
        pages: report,
        note: 'Interior pages came from a live web search.',
      };
    }
    if (isHollandVillageFoodCentre(name)) {
      const listed = await readPages(LISTED_HOLLAND_PAGES, fetchHtml);
      return {
        mode: 'listed_pages',
        facts: extractHawkerFacts(listed.pages, name),
        pages: [...report, ...listed.report],
        note: listedNote(searched.reason, true),
      };
    }
    return {
      mode: 'search',
      facts,
      pages: report,
      note: 'Web search did not state this building’s stall counts.',
    };
  }

  if (isHollandVillageFoodCentre(name)) {
    const listed = await readPages(LISTED_HOLLAND_PAGES, fetchHtml);
    return {
      mode: 'listed_pages',
      facts: extractHawkerFacts(listed.pages, name),
      pages: listed.report,
      note: listedNote(searched.reason, false),
    };
  }

  return {
    mode: 'none',
    facts: extractHawkerFacts([], name),
    pages: [],
    note: 'No page could be fetched, so the interior is assumed.',
  };
}
