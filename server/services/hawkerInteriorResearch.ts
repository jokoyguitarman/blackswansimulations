/**
 * Live pages for one food centre. Search first. When a search engine returns
 * no links, the Holland Village pages below are fetched instead. The facts
 * come from the response text. This module does not write to a database.
 */

import {
  extractHawkerFacts,
  htmlToText,
  parseDuckDuckGoLinks,
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
}

const LISTED_HOLLAND_PAGES: { title: string; url: string }[] = [
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

async function readPages(
  targets: { title: string; url: string }[],
  fetchHtml: (url: string) => Promise<string>,
): Promise<{ pages: PageText[]; report: ResearchPage[] }> {
  const pages: PageText[] = [];
  const report: ResearchPage[] = [];
  for (const target of targets) {
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

export async function researchHawkerCentre(
  name: string,
  fetchHtml: (url: string) => Promise<string> = defaultFetchHtml,
): Promise<HawkerResearch> {
  const query = `${name} cooked food stalls NEA`;
  let mode: HawkerResearch['mode'] = 'none';
  let targets: { title: string; url: string }[] = [];

  try {
    const searchHtml = await fetchHtml(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    );
    const links = parseDuckDuckGoLinks(searchHtml).slice(0, 3);
    if (links.length > 0) {
      mode = 'search';
      targets = links.map((url) => ({ url, title: titleFromUrl(url) }));
    }
  } catch {
    // A blocked search engine falls through to the listed pages, or to none.
  }

  if (targets.length === 0 && isHollandVillageFoodCentre(name)) {
    mode = 'listed_pages';
    targets = LISTED_HOLLAND_PAGES;
  }

  if (targets.length === 0) {
    return { mode: 'none', facts: extractHawkerFacts([]), pages: [] };
  }

  const { pages, report } = await readPages(targets, fetchHtml);
  return { mode, facts: extractHawkerFacts(pages), pages: report };
}
