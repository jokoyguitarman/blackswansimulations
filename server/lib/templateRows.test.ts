import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRowFilters,
  activeTeams,
  isTemplateVersioningMissing,
  orgsForSession,
  resetTemplateVersioningForTests,
  rowValidAt,
  rowsValidAt,
  stampOrgIdentity,
  templateInjectValidityOr,
  templateVersioningState,
  templateVersioningWarningCount,
  validAtRowFilters,
} from './templateRows.js';

afterEach(() => {
  resetTemplateVersioningForTests();
});

describe('template row filters', () => {
  test('active filters drop retired rows only when versioning is present', () => {
    assert.deepEqual(activeRowFilters('present'), [{ column: 'retired_at', op: 'is', value: 'null' }]);
    assert.deepEqual(activeRowFilters('absent'), []);
  });

  test('valid-at filters bound both ends of the row lifetime', () => {
    const at = '2026-06-01T00:00:00.000Z';
    assert.deepEqual(validAtRowFilters(at, 'present'), [
      { column: 'valid_from', op: 'lte', value: at },
      { column: 'or', op: 'or', value: `retired_at.is.null,retired_at.gt.${at}` },
    ]);
    assert.deepEqual(validAtRowFilters(at, 'absent'), []);
  });

  test('a renamed team keeps the old name before the rename and the new name after', () => {
    const uid = '11111111-1111-4111-8111-111111111111';
    const rows = [
      {
        team_uid: uid,
        team_name: 'Response Cell',
        valid_from: '2026-01-01T00:00:00.000Z',
        retired_at: '2026-06-01T00:00:00.000Z',
      },
      {
        team_uid: uid,
        team_name: 'Crisis Response',
        valid_from: '2026-06-01T00:00:00.000Z',
        retired_at: null,
      },
    ];
    const names = (at: string) => rowsValidAt(rows, at).map((row) => row.team_name);
    assert.deepEqual(names('2026-03-01T00:00:00.000Z'), ['Response Cell']);
    assert.deepEqual(names('2026-06-01T00:00:00.000Z'), ['Crisis Response']);
    assert.deepEqual(names('2026-07-01T00:00:00.000Z'), ['Crisis Response']);
    assert.equal(rowValidAt(rows[0], '2026-05-31T23:59:59.000Z'), true);
    assert.equal(rowValidAt(rows[0], '2026-06-01T00:00:00.000Z'), false);
  });

  test('session copies stay in the valid-at inject filter', () => {
    const at = '2026-03-01T00:00:00.000Z';
    const filter = templateInjectValidityOr('sess-1', at);
    assert.match(filter, /^session_id\.eq\.sess-1,/);
    assert.match(filter, /and\(session_id\.is\.null,valid_from\.lte\./);
    assert.doesNotMatch(filter, /session_id\.eq\.sess-1,valid_from/);
  });
});

describe('versioning degrade', () => {
  function fakeQuery(failRetired: boolean) {
    const url = new URL('http://db.local/scenario_teams?scenario_id=eq.1');
    const calls: string[] = [];
    const query = {
      url,
      is(column: string, value: null) {
        calls.push(`${column}=is.${value}`);
        url.searchParams.append(column, `is.${value}`);
        return this;
      },
      then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        const retired = url.searchParams.get('retired_at');
        const result =
          failRetired && retired
            ? {
                data: null,
                error: {
                  code: '42703',
                  message: 'column scenario_teams.retired_at does not exist',
                },
              }
            : { data: [{ team_name: 'Alpha' }], error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return { query, url, calls };
  }

  test('a missing retired_at column is detected once and the filter is dropped', async () => {
    const first = fakeQuery(true);
    const result = (await activeTeams(first.query)) as {
      data: Array<{ team_name: string }> | null;
      error: null;
    };
    assert.deepEqual(result.data, [{ team_name: 'Alpha' }]);
    assert.equal(result.error, null);
    assert.equal(first.url.searchParams.get('retired_at'), null);
    assert.equal(templateVersioningState(), 'absent');
    assert.equal(templateVersioningWarningCount(), 1);

    const second = fakeQuery(true);
    const again = (await activeTeams(second.query)) as {
      data: Array<{ team_name: string }> | null;
    };
    assert.deepEqual(again.data, [{ team_name: 'Alpha' }]);
    assert.deepEqual(second.calls, []);
    assert.equal(templateVersioningWarningCount(), 1);
  });

  test('a filter chained after the wrap is kept when the column is missing', async () => {
    const url = new URL('http://db.local/scenario_teams?scenario_id=eq.1');
    const fetches: string[] = [];
    const query = {
      url,
      is(column: string, value: null) {
        url.searchParams.append(column, `is.${value}`);
        return this;
      },
      eq(column: string, value: string) {
        url.searchParams.append(column, `eq.${value}`);
        return this;
      },
      then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        fetches.push(url.searchParams.toString());
        const retired = url.searchParams.get('retired_at');
        const result = retired
          ? {
              data: null,
              error: {
                code: 'PGRST204',
                message: "Could not find the 'retired_at' column of 'scenario_teams' in the schema cache",
              },
            }
          : { data: [{ team_name: 'Alpha' }], error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    const wrapped = activeTeams(query) as typeof query;
    wrapped.eq('org_key', 'org_slm_my');
    url.searchParams.append('valid_from', 'lte.2026-01-01T00:00:00.000Z');
    const result = (await wrapped) as { data: Array<{ team_name: string }> | null; error: null };
    assert.deepEqual(result.data, [{ team_name: 'Alpha' }]);
    assert.equal(fetches.length, 2);
    assert.match(fetches[0], /retired_at=is\.null/);
    assert.match(fetches[0], /org_key=eq\.org_slm_my/);
    assert.match(fetches[0], /valid_from=/);
    assert.equal(url.searchParams.get('retired_at'), null);
    assert.equal(url.searchParams.get('valid_from'), null);
    assert.equal(url.searchParams.get('org_key'), 'eq.org_slm_my');
    assert.equal(url.searchParams.get('scenario_id'), 'eq.1');
    assert.doesNotMatch(fetches[1], /retired_at|valid_from/);
    assert.match(fetches[1], /org_key=eq\.org_slm_my/);
  });

  test('a different missing column does not turn versioning off', async () => {
    const url = new URL('http://db.local/scenario_teams');
    const query = {
      url,
      is(column: string, value: null) {
        url.searchParams.append(column, `is.${value}`);
        return this;
      },
      then(onFulfilled?: (value: unknown) => unknown) {
        return Promise.resolve({
          data: null,
          error: { code: '42703', message: 'column scenario_teams.org_key does not exist' },
        }).then(onFulfilled);
      },
    };
    const result = (await activeTeams(query)) as { error: { code?: string; message?: string } };
    assert.equal(isTemplateVersioningMissing(result.error), false);
    assert.equal(templateVersioningState(), 'unknown');
    assert.equal(templateVersioningWarningCount(), 0);
  });
});

describe('orgsForSession', () => {
  const live = {
    orgs: [{ org_key: 'primary', display_name: 'New Primary', side: 'protagonist', is_primary: true }],
  };
  const current = {
    orgs: [{ org_key: 'primary', display_name: 'Old Primary', side: 'protagonist', is_primary: true }],
  };

  test('a started session is labelled from its snapshot', () => {
    const orgs = orgsForSession({
      start_time: '2026-01-01T00:00:00.000Z',
      current_state: current,
      initial_state: live,
    });
    assert.equal(orgs[0]?.display_name, 'Old Primary');
  });

  test('a session without start_time uses the live initial state', () => {
    const orgs = orgsForSession({
      start_time: null,
      current_state: current,
      initial_state: live,
    });
    assert.equal(orgs[0]?.display_name, 'New Primary');
  });

  test('an empty snapshot does not fall back to the live scenario', () => {
    assert.deepEqual(
      orgsForSession({
        start_time: '2026-01-01T00:00:00.000Z',
        current_state: {},
        initial_state: live,
      }),
      [],
    );
  });
});

describe('stampOrgIdentity', () => {
  test('stamps a shared org_uid and one history row, and is idempotent', () => {
    const stamped = stampOrgIdentity({
      orgs: [{ org_key: 'primary', display_name: 'HQ' }],
      org_page: { orgs: [{ org_key: 'primary', display_name: 'HQ page' }] },
    }) as unknown as {
      orgs: Array<{ org_uid: string }>;
      org_page: { orgs: Array<{ org_uid: string }> };
      org_key_history: Array<{ org_uid: string; org_key: string; from_edit: null; until_edit: null }>;
    };
    const uid = stamped.orgs[0].org_uid;
    assert.match(uid, /^[0-9a-f-]{36}$/);
    assert.equal(stamped.org_page.orgs[0].org_uid, uid);
    assert.deepEqual(stamped.org_key_history, [
      { org_uid: uid, org_key: 'primary', from_edit: null, until_edit: null },
    ]);
    const again = stampOrgIdentity(stamped);
    assert.equal(again.orgs[0].org_uid, uid);
    assert.equal(again.org_key_history.length, 1);
  });
});
