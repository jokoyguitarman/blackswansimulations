import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isPublicHttpUrl, researchHawkerCentre } from './hawkerInteriorResearch.js';
import type { PageSearchResult } from './hawkerInteriorResearch.js';

const CENTRE = `
  <html><body>
    <p>Holland Village Market and Food Centre.</p>
    <p>Comprises 21 cooked food stalls and 48 market stalls.</p>
  </body></html>
`;
const STALLS = `
  <html><body>
    <p>Holland Village stall notes 01-33 and 01-37. Cooked food area 10.75 m².</p>
  </body></html>
`;
const OTHER = `
  <html><body>
    <p>A directory of hawker centres. Bedok Market comprises 21 cooked food stalls and 48 market stalls.</p>
  </body></html>
`;

const none: PageSearchResult = { pages: [], reason: 'no_key' };

describe('hawker interior research', () => {
  test('uses live search links and does not fall back to the listed pages', async () => {
    const calls: string[] = [];
    const research = await researchHawkerCentre(
      'Holland Village Market and Food Centre',
      async (url) => {
        calls.push(url);
        if (url === 'https://example.test/centre') return CENTRE;
        throw new Error(`unexpected ${url}`);
      },
      async () => ({
        pages: [
          { title: 'Holland Village Market and Food Centre', url: 'https://example.test/centre' },
        ],
        reason: 'ok',
      }),
    );
    assert.equal(research.mode, 'search');
    assert.equal(research.facts.cookedStalls?.value, 21);
    assert.equal(research.facts.marketStalls?.value, 48);
    assert.match(research.note, /live web search/);
    assert.ok(calls.every((url) => !url.includes('bedokstudio')));
  });

  test('fetches the listed pages when search returns no links', async () => {
    const calls: string[] = [];
    const research = await researchHawkerCentre(
      'Holland Village Market and Food Centre',
      async (url) => {
        calls.push(url);
        if (url.includes('datainsg')) return STALLS;
        return CENTRE;
      },
      async () => none,
    );
    assert.equal(research.mode, 'listed_pages');
    assert.equal(research.facts.singleStorey?.value, true);
    assert.equal(research.facts.cookedStallAreaM2?.value, 10.75);
    assert.equal(research.facts.cookedStalls?.value, 21);
    assert.match(research.note, /No web-search key/);
    assert.equal(research.pages.filter((page) => page.ok).length, 3);
    assert.ok(calls.some((url) => url.includes('bedokstudio.com')));
  });

  test('falls back when search pages do not state this building’s counts', async () => {
    const calls: string[] = [];
    const research = await researchHawkerCentre(
      'Holland Village Market and Food Centre',
      async (url) => {
        calls.push(url);
        if (url === 'https://example.test/directory') return OTHER;
        if (url.includes('datainsg')) return STALLS;
        return CENTRE;
      },
      async () => ({
        pages: [{ title: 'A directory of centres', url: 'https://example.test/directory' }],
        reason: 'ok',
      }),
    );
    assert.equal(research.mode, 'listed_pages');
    assert.equal(research.facts.cookedStalls?.value, 21);
    assert.equal(research.facts.marketStalls?.value, 48);
    assert.match(research.note, /did not state/);
    assert.ok(calls.some((url) => url.includes('bedokstudio.com')));
  });

  test('another building is not given the Holland Village pages', async () => {
    const research = await researchHawkerCentre(
      'Chinatown Complex',
      async () => {
        throw new Error('should not fetch');
      },
      async () => none,
    );
    assert.equal(research.mode, 'none');
    assert.equal(research.facts.cookedStalls, null);
    assert.deepEqual(research.pages, []);
  });

  test('a private search hit is not fetched', () => {
    assert.equal(isPublicHttpUrl('https://example.test/centre'), true);
    assert.equal(isPublicHttpUrl('http://127.0.0.1/secret'), false);
    assert.equal(isPublicHttpUrl('http://10.0.0.4/secret'), false);
    assert.equal(isPublicHttpUrl('http://192.168.0.2/secret'), false);
  });
});
