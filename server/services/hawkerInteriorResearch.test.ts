import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { researchHawkerCentre } from './hawkerInteriorResearch.js';

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

describe('hawker interior research', () => {
  test('uses live search links and does not fall back to the listed pages', async () => {
    const calls: string[] = [];
    const research = await researchHawkerCentre(
      'Holland Village Market and Food Centre',
      async (url) => {
        calls.push(url);
        if (url.includes('duckduckgo.com')) {
          return '<a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fcentre&rut=1">Centre</a>';
        }
        if (url === 'https://example.test/centre') return CENTRE;
        throw new Error(`unexpected ${url}`);
      },
    );
    assert.equal(research.mode, 'search');
    assert.equal(research.facts.cookedStalls?.value, 21);
    assert.equal(research.facts.marketStalls?.value, 48);
    assert.ok(calls.every((url) => !url.includes('bedokstudio')));
  });

  test('fetches the listed pages when search returns nothing', async () => {
    const calls: string[] = [];
    const research = await researchHawkerCentre(
      'Holland Village Market and Food Centre',
      async (url) => {
        calls.push(url);
        if (url.includes('duckduckgo.com')) return '<html><title>DuckDuckGo</title></html>';
        if (url.includes('datainsg')) return STALLS;
        return CENTRE;
      },
    );
    assert.equal(research.mode, 'listed_pages');
    assert.equal(research.facts.singleStorey?.value, true);
    assert.equal(research.facts.cookedStallAreaM2?.value, 10.75);
    assert.equal(research.pages.filter((page) => page.ok).length, 3);
    assert.ok(calls.some((url) => url.includes('bedokstudio.com')));
  });

  test('another building is not given the Holland Village pages', async () => {
    const research = await researchHawkerCentre(
      'Chinatown Complex',
      async () => '<html><title>DuckDuckGo</title></html>',
    );
    assert.equal(research.mode, 'none');
    assert.equal(research.facts.cookedStalls, null);
    assert.deepEqual(research.pages, []);
  });
});
