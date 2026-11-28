import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { showComposer } from '../src/lib/readOnlySurface.ts';
import {
  explorerPageGroups,
  explorerPages,
  pageExplorerVisible,
  spectatorRequestHeaders,
} from '../src/lib/simSpectator.ts';

describe('staff page explorer', () => {
  test('a 404 hides the explorer and any other status shows it', () => {
    assert.equal(pageExplorerVisible(null), false);
    assert.equal(pageExplorerVisible(404), false);
    assert.equal(pageExplorerVisible(400), true);
    assert.equal(pageExplorerVisible(200), true);
  });

  test('spectator calls name the session and the spectator frame', () => {
    assert.deepEqual(spectatorRequestHeaders('session-1'), {
      'X-Sim-Session': 'session-1',
      'X-Sim-Spectator': '1',
    });
  });

  test('a pages response that is not a list yields no rows', () => {
    assert.deepEqual(explorerPageGroups(null), []);
    assert.deepEqual(explorerPageGroups({ error: 'nope' }), []);
    assert.equal(explorerPageGroups({ data: [{ org_key: 'acme' }] }).length, 1);
  });

  test('the list is one row per org and platform', () => {
    const pages = explorerPages([
      {
        org_key: 'acme',
        display_name: 'Acme',
        role: 'protagonist',
        control_mode: 'player',
        facebook: { page_name: 'Acme', page_handle: '@acme' },
        x_twitter: { page_name: 'Acme X', page_handle: '@acme_x' },
      },
      {
        org_key: 'rival',
        display_name: 'Rival',
        role: 'antagonist',
        control_mode: 'ai',
        facebook: { page_name: 'Rival', page_handle: '@rival' },
        x_twitter: null,
      },
    ]);
    assert.deepEqual(
      pages.map((page) => `${page.orgKey}:${page.platform}:${page.pageHandle}:${page.role}`),
      [
        'acme:facebook:@acme:protagonist',
        'acme:x_twitter:@acme_x:protagonist',
        'rival:facebook:@rival:antagonist',
      ],
    );
  });

  test('read-only hides a composer and an editable surface shows it', () => {
    assert.equal(showComposer(true), false);
    assert.equal(showComposer(false), true);
    assert.equal(showComposer(undefined), true);
  });
});
