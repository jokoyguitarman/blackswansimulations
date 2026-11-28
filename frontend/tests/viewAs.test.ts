import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import {
  buildViewAsRoster,
  staffViewVisible,
  viewAsBannerText,
  viewAsOptionLabel,
  viewedByText,
} from '../src/lib/viewAsRoster.ts';
import {
  messengerEventForUser,
  releaseViewAsFrame,
  retainViewAsFrame,
  shellFilterUserId,
  withViewAsHeaders,
} from '../src/lib/viewAsFrame.ts';

describe('view-as roster and socket filter', () => {
  test('participants are listed with team and controlled page', () => {
    const players = buildViewAsRoster({
      players: {
        data: {
          players: [
            { user_id: 'b', name: 'Bea' },
            { user_id: 'a', name: 'Ada' },
            { user_id: 'c', name: '' },
          ],
        },
      },
      teams: {
        data: [
          { user_id: 'a', team_name: 'Communications' },
          { user_id: 'a', team_name: 'Legal' },
        ],
      },
      pages: {
        data: [
          { display_name: 'Acme', org_key: 'acme', controllers: ['a'] },
          { display_name: 'Rival', org_key: 'rival', controllers: ['b'] },
        ],
      },
    });
    assert.deepEqual(
      players.map((player) => viewAsOptionLabel(player)),
      ['Ada (Communications) · Acme', 'Bea (No team) · Rival', 'Player (No team) · No page'],
    );
    assert.equal(
      viewAsBannerText('Ada', 'Communications'),
      'Viewing as Ada (Communications) · read-only',
    );
    assert.equal(viewedByText(['Ada', 'Bea']), 'Viewed by Ada, Bea');
    assert.equal(viewedByText([]), '');
  });

  test('only a 200 from the staff-view probe shows the dropdown', () => {
    assert.equal(staffViewVisible(null), false);
    assert.equal(staffViewVisible(404), false);
    assert.equal(staffViewVisible(403), false);
    assert.equal(staffViewVisible(200), true);
  });

  test('socket filtering uses the subject id, and the signed-in id when nobody is being viewed', () => {
    assert.equal(shellFilterUserId('subject', 'staff'), 'subject');
    assert.equal(shellFilterUserId(null, 'staff'), 'staff');
    assert.equal(messengerEventForUser('subject', 'subject'), true);
    assert.equal(messengerEventForUser('staff', 'subject'), false);
    assert.equal(messengerEventForUser('', 'subject'), false);
    assert.equal(messengerEventForUser('staff', 'staff'), true);
    assert.equal(messengerEventForUser('subject', null), true);
  });

  test('view-as headers are added only while a shell holds the frame', () => {
    const plain: Record<string, string> = {
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    };
    assert.equal(withViewAsHeaders(plain), plain);
    const claim = retainViewAsFrame({ sessionId: 'session-1', userId: 'player-1', name: 'Ada' });
    const sent = withViewAsHeaders(plain);
    assert.equal(sent['X-Sim-Session'], 'session-1');
    assert.equal(sent['X-Sim-View-As'], 'player-1');
    assert.equal(plain['X-Sim-View-As'], undefined);
    releaseViewAsFrame(claim);
    assert.equal(withViewAsHeaders(plain), plain);
  });
});

mock.module('../src/lib/supabase.ts', {
  namedExports: {
    isSupabaseConfigured: true,
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: { access_token: 'tok' } },
          error: null,
        }),
      },
    },
  },
});

const { getAuthHeaders, api } = await import('../src/lib/api.ts');
const { retainViewAsFrame: retain, releaseViewAsFrame: release } =
  await import('../src/lib/viewAsFrame.ts');

describe('getAuthHeaders', () => {
  after(() => {
    mock.restoreAll();
  });

  test('with the frame clear, headers are only Authorization and Content-Type', async () => {
    release(retain(null));
    const headers = await getAuthHeaders();
    assert.deepEqual(headers, {
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
    assert.equal('X-Sim-Session' in headers, false);
    assert.equal('X-Sim-View-As' in headers, false);
    assert.equal('X-Sim-Spectator' in headers, false);
  });

  test('a view-as shell adds the session and subject headers on every client call', async () => {
    const seen: Array<Record<string, string>> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
    const claim = retain({ sessionId: 'session-1', userId: 'player-1', name: 'Ada' });
    try {
      await getAuthHeaders();
      await api.profile.get();
      await api.profile.update({ full_name: 'Ada' });
    } finally {
      globalThis.fetch = original;
      release(claim);
    }
    assert.equal(seen.length, 2);
    for (const headers of seen) {
      assert.equal(headers['X-Sim-Session'], 'session-1');
      assert.equal(headers['X-Sim-View-As'], 'player-1');
      assert.equal(headers.Authorization, 'Bearer tok');
    }
    const cleared = await getAuthHeaders();
    assert.equal('X-Sim-View-As' in cleared, false);
  });

  test('an explicit spectator frame does not also send view-as headers', async () => {
    const claim = retain({ sessionId: 'session-1', userId: 'player-1', name: 'Ada' });
    try {
      const headers = await getAuthHeaders({ sessionId: 'session-9', spectator: true });
      assert.equal(headers['X-Sim-Session'], 'session-9');
      assert.equal(headers['X-Sim-Spectator'], '1');
      assert.equal(headers['X-Sim-View-As'], undefined);
    } finally {
      release(claim);
    }
  });
});
