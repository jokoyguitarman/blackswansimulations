import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readSessionIdleSettings } from '../lib/sessionIdleSettings.js';
import {
  decideIdleAction,
  latestHumanActivityFromReads,
  readIdleMarkers,
  recordKeepalive,
  runIdleSweep,
  type ActivityQuery,
  type ActivityQueryClient,
  type IdleMarker,
  type IdleReason,
  type IdleSettings,
  type IdleSweepStore,
} from './sessionIdleSweeper.js';

const DAY = '2026-11-04';
const defaults: IdleSettings = { idleEndMinutes: 30, idleWarnMinutes: 5, maxHours: 12 };

function at(hours: number, minutes: number): number {
  return Date.parse(
    `${DAY}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000Z`,
  );
}

function iso(hours: number, minutes: number): string {
  return new Date(at(hours, minutes)).toISOString();
}

function journal(input: {
  id: string;
  startTime: string;
  lastHumanAt: string | null;
  markers?: readonly IdleMarker[];
}) {
  let lastHumanAt = input.lastHumanAt;
  let clock = Date.parse(input.startTime);
  const recorded: Array<{
    session_id: string;
    event_type: 'trainer_alert' | 'status_update';
    actor_id: string | null;
    description: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }> = [];
  const broadcasts: Array<{ type: string; data: Record<string, unknown> }> = [];
  const store: IdleSweepStore = {
    async listRunningSessions() {
      return [{ id: input.id, start_time: input.startTime }];
    },
    async listBotUserIds() {
      return [];
    },
    async latestHumanActivity() {
      return lastHumanAt;
    },
    async listIdleMarkers() {
      const written: IdleMarker[] = recorded.flatMap((event) => {
        const kind = event.metadata.kind;
        if (kind !== 'idle_warning' && kind !== 'idle_cleared' && kind !== 'idle_keepalive') {
          return [];
        }
        const reason = kind === 'idle_warning' ? event.metadata.reason : null;
        return [
          {
            kind,
            reason: reason === 'idle' || reason === 'max_duration' ? reason : null,
            created_at: event.created_at,
          },
        ];
      });
      return [...(input.markers ?? []), ...written];
    },
    async completeIfRunning() {
      return true;
    },
    async recordEvent(row) {
      recorded.push({ ...row, created_at: new Date(clock).toISOString() });
    },
    async isBotUser() {
      return false;
    },
    async latestKeepalive() {
      return null;
    },
  };
  return {
    recorded,
    broadcasts,
    activity(isoTime: string) {
      lastHumanAt = isoTime;
    },
    at(hours: number, minutes: number) {
      clock = at(hours, minutes);
      return runIdleSweep({
        store,
        settings: defaults,
        now: () => clock,
        broadcast: (_sessionId, type, data) => {
          broadcasts.push({ type, data });
        },
      });
    },
  };
}

describe('session idle sweeper', () => {
  test('the rule', () => {
    const start = iso(10, 0);
    const lastHuman = iso(10, 20);

    assert.deepEqual(
      decideIdleAction({
        now: at(10, 44),
        startTime: start,
        lastHumanAt: lastHuman,
        warnedFor: [],
        settings: defaults,
      }),
      { kind: 'none' },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(10, 45),
        startTime: start,
        lastHumanAt: lastHuman,
        warnedFor: [],
        settings: defaults,
      }),
      { kind: 'warn', reason: 'idle', endsAt: iso(10, 50) },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(10, 46),
        startTime: start,
        lastHumanAt: lastHuman,
        warnedFor: ['idle'],
        settings: defaults,
      }),
      { kind: 'none' },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(10, 50),
        startTime: start,
        lastHumanAt: lastHuman,
        warnedFor: ['idle'],
        settings: defaults,
      }),
      { kind: 'end', reason: 'idle', idleMinutes: 30 },
    );

    assert.deepEqual(
      decideIdleAction({
        now: at(10, 25),
        startTime: start,
        lastHumanAt: null,
        warnedFor: [],
        settings: defaults,
      }),
      { kind: 'warn', reason: 'idle', endsAt: iso(10, 30) },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(10, 30),
        startTime: start,
        lastHumanAt: null,
        warnedFor: [],
        settings: defaults,
      }),
      { kind: 'end', reason: 'idle', idleMinutes: 30 },
    );

    assert.deepEqual(
      decideIdleAction({
        now: at(21, 55),
        startTime: start,
        lastHumanAt: iso(21, 55),
        warnedFor: [],
        settings: defaults,
      }),
      { kind: 'warn', reason: 'max_duration', endsAt: iso(22, 0) },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(22, 0),
        startTime: start,
        lastHumanAt: iso(22, 0),
        warnedFor: [],
        settings: defaults,
      }),
      { kind: 'end', reason: 'max_duration', idleMinutes: 0 },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(21, 57),
        startTime: start,
        lastHumanAt: iso(21, 56),
        warnedFor: ['max_duration'],
        settings: defaults,
      }),
      { kind: 'none' },
    );

    const noIdle: IdleSettings = { ...defaults, idleEndMinutes: 0 };
    assert.deepEqual(
      decideIdleAction({
        now: at(10, 50),
        startTime: start,
        lastHumanAt: null,
        warnedFor: [],
        settings: noIdle,
      }),
      { kind: 'none' },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(22, 0),
        startTime: start,
        lastHumanAt: iso(22, 0),
        warnedFor: [],
        settings: noIdle,
      }),
      { kind: 'end', reason: 'max_duration', idleMinutes: 0 },
    );

    const noLimit: IdleSettings = { ...defaults, maxHours: 0 };
    assert.deepEqual(
      decideIdleAction({
        now: at(22, 0),
        startTime: start,
        lastHumanAt: iso(22, 0),
        warnedFor: [],
        settings: noLimit,
      }),
      { kind: 'none' },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(10, 50),
        startTime: start,
        lastHumanAt: lastHuman,
        warnedFor: [],
        settings: noLimit,
      }),
      { kind: 'end', reason: 'idle', idleMinutes: 30 },
    );

    const noWarn: IdleSettings = { ...defaults, idleWarnMinutes: 0 };
    assert.deepEqual(
      decideIdleAction({
        now: at(10, 45),
        startTime: start,
        lastHumanAt: lastHuman,
        warnedFor: [],
        settings: noWarn,
      }),
      { kind: 'none' },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(10, 50),
        startTime: start,
        lastHumanAt: lastHuman,
        warnedFor: [],
        settings: noWarn,
      }),
      { kind: 'end', reason: 'idle', idleMinutes: 30 },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(21, 55),
        startTime: start,
        lastHumanAt: iso(21, 55),
        warnedFor: [],
        settings: noWarn,
      }),
      { kind: 'none' },
    );
    assert.deepEqual(
      decideIdleAction({
        now: at(22, 0),
        startTime: start,
        lastHumanAt: iso(22, 0),
        warnedFor: [],
        settings: noWarn,
      }),
      { kind: 'end', reason: 'max_duration', idleMinutes: 0 },
    );
  });

  test('what counts as a person', async () => {
    const sessionId = 'session-1';
    const since = iso(10, 0);
    const nowIso = iso(11, 0);
    const bot = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const human = 'hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh';

    interface StoredRow {
      table: string;
      session_id: string;
      values: Record<string, unknown>;
    }

    const noise: StoredRow[] = [
      {
        table: 'chat_messages',
        session_id: sessionId,
        values: { created_at: iso(10, 40), sender_id: bot },
      },
      {
        table: 'chat_messages',
        session_id: sessionId,
        values: { created_at: iso(10, 41), sender_id: null, sender_stakeholder_id: 'npc-1' },
      },
      {
        table: 'session_events',
        session_id: sessionId,
        values: { created_at: iso(10, 42), actor_id: null },
      },
      {
        table: 'session_events',
        session_id: sessionId,
        values: { created_at: iso(10, 43), actor_id: null },
      },
      {
        table: 'social_posts',
        session_id: sessionId,
        values: { created_at: iso(10, 44), posted_by_user_id: bot },
      },
      {
        table: 'chat_messages',
        session_id: sessionId,
        values: { created_at: since, sender_id: human },
      },
      {
        table: 'chat_messages',
        session_id: 'other-session',
        values: { created_at: iso(10, 59), sender_id: human },
      },
    ];

    const client = (
      rows: StoredRow[],
      failing: ReadonlySet<string> = new Set(),
    ): ActivityQueryClient => ({
      async latestTime(query: ActivityQuery) {
        if (failing.has(query.table)) return 'failed';
        const excluded = new Set(query.excludeActorIds);
        let best: string | null = null;
        for (const row of rows) {
          if (row.table !== query.table || row.session_id !== query.sessionId) continue;
          const actor = row.values[query.actorColumn];
          if (typeof actor !== 'string' || excluded.has(actor)) continue;
          const time = row.values[query.timeColumn];
          if (typeof time !== 'string' || !(time > query.sinceIso)) continue;
          if (best === null || time > best) best = time;
        }
        return best;
      },
    });

    const latest = (rows: StoredRow[], failing?: ReadonlySet<string>) =>
      latestHumanActivityFromReads(client(rows, failing), sessionId, since, [bot], nowIso);

    assert.equal(await latest(noise), null);

    const humans: Array<{ table: string; timeColumn: string; actorColumn: string; time: string }> =
      [
        {
          table: 'session_participants',
          timeColumn: 'joined_at',
          actorColumn: 'user_id',
          time: iso(10, 10),
        },
        {
          table: 'chat_messages',
          timeColumn: 'created_at',
          actorColumn: 'sender_id',
          time: iso(10, 11),
        },
        {
          table: 'decisions',
          timeColumn: 'created_at',
          actorColumn: 'proposed_by',
          time: iso(10, 12),
        },
        {
          table: 'player_actions',
          timeColumn: 'created_at',
          actorColumn: 'player_id',
          time: iso(10, 13),
        },
        {
          table: 'social_posts',
          timeColumn: 'created_at',
          actorColumn: 'posted_by_user_id',
          time: iso(10, 14),
        },
        {
          table: 'session_events',
          timeColumn: 'created_at',
          actorColumn: 'actor_id',
          time: iso(10, 15),
        },
      ];
    for (const row of humans) {
      const found = await latest([
        ...noise,
        {
          table: row.table,
          session_id: sessionId,
          values: { [row.timeColumn]: row.time, [row.actorColumn]: human },
        },
      ]);
      assert.equal(found, row.time, row.table);
    }

    const failed = await latest(
      [
        ...noise,
        {
          table: 'decisions',
          session_id: sessionId,
          values: { created_at: iso(10, 12), proposed_by: human },
        },
      ],
      new Set(['session_participants']),
    );
    assert.equal(failed, nowIso);
  });

  test('a sweep', async () => {
    const start = iso(10, 0);
    const lastHuman = iso(10, 20);
    const settings = defaults;

    interface Row {
      id: string;
      start_time: string;
      lastHumanAt: string | null;
      warnedFor: readonly IdleReason[];
      complete: boolean;
      fail: boolean;
    }

    function harness(rows: Row[], nowMs: number) {
      const events: Array<{
        session_id: string;
        event_type: string;
        actor_id: string | null;
        description: string;
        metadata: Record<string, unknown>;
      }> = [];
      const completed: string[] = [];
      const order: string[] = [];
      const broadcasts: Array<{ type: string; data: Record<string, unknown> }> = [];
      const ended: string[] = [];
      const store: IdleSweepStore = {
        async listRunningSessions() {
          return rows.map((row) => ({ id: row.id, start_time: row.start_time }));
        },
        async listBotUserIds() {
          return [];
        },
        async latestHumanActivity(sessionId) {
          const row = rows.find((item) => item.id === sessionId);
          if (!row || row.fail) throw new Error('query failed');
          return row.lastHumanAt;
        },
        async listIdleMarkers(sessionId) {
          const row = rows.find((item) => item.id === sessionId);
          const created_at = new Date(nowMs - 60_000).toISOString();
          return (row?.warnedFor ?? []).map(
            (reason): IdleMarker => ({ kind: 'idle_warning', reason, created_at }),
          );
        },
        async completeIfRunning(sessionId) {
          order.push(`complete:${sessionId}`);
          completed.push(sessionId);
          return rows.find((item) => item.id === sessionId)?.complete ?? false;
        },
        async recordEvent(row) {
          order.push(`event:${row.session_id}`);
          events.push(row);
        },
        async isBotUser() {
          return false;
        },
        async latestKeepalive() {
          return null;
        },
      };
      return {
        events,
        completed,
        order,
        broadcasts,
        ended,
        run: () =>
          runIdleSweep({
            store,
            settings,
            now: () => nowMs,
            onEnded: async (sessionId) => {
              order.push(`hook:${sessionId}`);
              ended.push(sessionId);
            },
            broadcast: (sessionId, type, data) => {
              order.push(`broadcast:${sessionId}`);
              broadcasts.push({ type, data });
            },
          }),
      };
    }

    const ending = harness(
      [
        {
          id: 'ending',
          start_time: start,
          lastHumanAt: lastHuman,
          warnedFor: ['idle'],
          complete: true,
          fail: false,
        },
      ],
      at(10, 50),
    );
    const endedResult = await ending.run();
    assert.deepEqual(endedResult, { warned: 0, ended: 1 });
    assert.deepEqual(ending.completed, ['ending']);
    assert.deepEqual(ending.ended, ['ending']);
    assert.deepEqual(ending.order, [
      'complete:ending',
      'hook:ending',
      'event:ending',
      'broadcast:ending',
    ]);
    assert.equal(ending.events.length, 1);
    assert.equal(ending.events[0]?.event_type, 'status_update');
    assert.equal(ending.events[0]?.actor_id, null);
    assert.equal(ending.events[0]?.metadata.kind, 'idle_auto_end');
    assert.equal(ending.events[0]?.metadata.reason, 'idle');
    assert.equal(ending.events[0]?.metadata.idle_minutes, 30);
    assert.equal(ending.events[0]?.metadata.last_human_activity_at, lastHuman);
    assert.equal(
      ending.events[0]?.description,
      'This session has ended: no player activity for 30 minutes.',
    );
    assert.deepEqual(ending.broadcasts, [
      {
        type: 'session.auto_ended',
        data: {
          session_id: 'ending',
          reason: 'idle',
          ended_at: iso(10, 50),
          idle_end_minutes: 30,
          idle_warn_minutes: 5,
          max_hours: 12,
        },
      },
    ]);

    const lost = harness(
      [
        {
          id: 'lost',
          start_time: start,
          lastHumanAt: lastHuman,
          warnedFor: [],
          complete: false,
          fail: false,
        },
      ],
      at(10, 50),
    );
    const lostResult = await lost.run();
    assert.deepEqual(lostResult, { warned: 0, ended: 0 });
    assert.deepEqual(lost.completed, ['lost']);
    assert.deepEqual(lost.ended, []);
    assert.deepEqual(lost.events, []);
    assert.deepEqual(lost.broadcasts, []);

    const broken = harness(
      [
        {
          id: 'bad',
          start_time: start,
          lastHumanAt: null,
          warnedFor: [],
          complete: true,
          fail: true,
        },
        {
          id: 'good',
          start_time: start,
          lastHumanAt: lastHuman,
          warnedFor: [],
          complete: true,
          fail: false,
        },
      ],
      at(10, 50),
    );
    const brokenResult = await broken.run();
    assert.deepEqual(brokenResult, { warned: 0, ended: 1 });
    assert.deepEqual(broken.completed, ['good']);
    assert.deepEqual(broken.ended, ['good']);

    const warning = harness(
      [
        {
          id: 'warn',
          start_time: start,
          lastHumanAt: lastHuman,
          warnedFor: [],
          complete: true,
          fail: false,
        },
      ],
      at(10, 45),
    );
    const warningResult = await warning.run();
    assert.deepEqual(warningResult, { warned: 1, ended: 0 });
    assert.deepEqual(warning.completed, []);
    assert.equal(warning.events[0]?.event_type, 'trainer_alert');
    assert.equal(warning.events[0]?.metadata.kind, 'idle_warning');
    assert.equal(warning.events[0]?.metadata.reason, 'idle');
    assert.equal(warning.events[0]?.metadata.ends_at, iso(10, 50));
    assert.equal(
      warning.events[0]?.description,
      'No player activity for 25 minutes. This session ends automatically at 10:50 UTC unless someone acts.',
    );
    assert.equal(warning.broadcasts[0]?.type, 'session.idle_warning');
    assert.equal(warning.broadcasts[0]?.data.idle_end_minutes, 30);
    assert.equal(warning.broadcasts[0]?.data.idle_warn_minutes, 5);
    assert.equal(warning.broadcasts[0]?.data.max_hours, 12);

    const repeat = harness(
      [
        {
          id: 'repeat',
          start_time: start,
          lastHumanAt: lastHuman,
          warnedFor: ['idle'],
          complete: true,
          fail: false,
        },
      ],
      at(10, 46),
    );
    const repeatResult = await repeat.run();
    assert.deepEqual(repeatResult, { warned: 0, ended: 0 });
    assert.deepEqual(repeat.events, []);
    assert.deepEqual(repeat.broadcasts, []);
    assert.deepEqual(repeat.completed, []);

    const limit = harness(
      [
        {
          id: 'limit',
          start_time: start,
          lastHumanAt: iso(21, 55),
          warnedFor: [],
          complete: true,
          fail: false,
        },
      ],
      at(21, 55),
    );
    const limitResult = await limit.run();
    assert.deepEqual(limitResult, { warned: 1, ended: 0 });
    assert.equal(
      limit.events[0]?.description,
      'This session reaches its 12-hour limit at 22:00 UTC and will end then.',
    );
    const limitEnd = harness(
      [
        {
          id: 'limit-end',
          start_time: start,
          lastHumanAt: iso(22, 0),
          warnedFor: ['max_duration'],
          complete: true,
          fail: false,
        },
      ],
      at(22, 0),
    );
    await limitEnd.run();
    assert.equal(
      limitEnd.events[0]?.description,
      'This session has ended: it reached its 12-hour limit.',
    );

    const steady = journal({
      id: 'steady',
      startTime: iso(10, 0),
      lastHumanAt: iso(21, 55),
      markers: [{ kind: 'idle_warning', reason: 'max_duration', created_at: iso(21, 55) }],
    });
    for (const minute of [56, 57, 58, 59]) {
      steady.activity(iso(21, minute));
      const result = await steady.at(21, minute);
      assert.deepEqual(result, { warned: 0, ended: 0 });
    }
    assert.equal(
      steady.recorded.filter((event) => event.metadata.kind === 'idle_warning').length,
      0,
    );

    const resumed = journal({
      id: 'resumed',
      startTime: iso(10, 0),
      lastHumanAt: iso(10, 47),
      markers: [{ kind: 'idle_warning', reason: 'idle', created_at: iso(10, 45) }],
    });
    await resumed.at(10, 48);
    assert.equal(resumed.recorded.length, 1);
    assert.equal(resumed.recorded[0]?.event_type, 'status_update');
    assert.equal(resumed.recorded[0]?.metadata.kind, 'idle_cleared');
    assert.equal(
      resumed.recorded[0]?.description,
      'Player activity resumed, so the session continues.',
    );
    assert.deepEqual(resumed.broadcasts, [
      { type: 'session.idle_cleared', data: { session_id: 'resumed' } },
    ]);
    await resumed.at(10, 49);
    assert.equal(resumed.recorded.length, 1);
    assert.equal(resumed.broadcasts.length, 1);

    const kept = journal({
      id: 'kept',
      startTime: iso(10, 0),
      lastHumanAt: iso(10, 46),
      markers: [
        { kind: 'idle_warning', reason: 'idle', created_at: iso(10, 45) },
        { kind: 'idle_keepalive', reason: null, created_at: iso(10, 46) },
      ],
    });
    await kept.at(10, 48);
    assert.deepEqual(kept.recorded, []);
    assert.deepEqual(kept.broadcasts, []);

    const both = journal({
      id: 'both',
      startTime: iso(0, 0),
      lastHumanAt: iso(11, 28),
    });
    for (const minute of [53, 54, 55, 56, 57, 58]) {
      await both.at(11, minute);
    }
    const idleWarnings = both.recorded.filter(
      (event) => event.metadata.kind === 'idle_warning' && event.metadata.reason === 'idle',
    );
    const maxWarnings = both.recorded.filter(
      (event) => event.metadata.kind === 'idle_warning' && event.metadata.reason === 'max_duration',
    );
    const endings = both.recorded.filter((event) => event.metadata.kind === 'idle_auto_end');
    assert.equal(idleWarnings.length, 1);
    assert.equal(idleWarnings[0]?.created_at, iso(11, 53));
    assert.equal(maxWarnings.length, 1);
    assert.equal(maxWarnings[0]?.created_at, iso(11, 55));
    assert.equal(endings.length, 1);
    assert.equal(endings[0]?.metadata.reason, 'idle');
    assert.equal(endings[0]?.created_at, iso(11, 58));
  });

  test('the markers', () => {
    const maxStands = readIdleMarkers(
      [{ kind: 'idle_warning', reason: 'max_duration', created_at: iso(21, 55) }],
      iso(21, 56),
    );
    assert.deepEqual(maxStands.warnedFor, ['max_duration']);
    assert.equal(maxStands.clearIdleWarning, false);

    const idleOld = [
      { kind: 'idle_warning' as const, reason: 'idle' as const, created_at: iso(10, 45) },
    ];
    assert.deepEqual(readIdleMarkers(idleOld, iso(10, 47)), {
      warnedFor: [],
      clearIdleWarning: true,
    });
    assert.deepEqual(
      readIdleMarkers(
        [...idleOld, { kind: 'idle_cleared', reason: null, created_at: iso(10, 46) }],
        iso(10, 47),
      ),
      { warnedFor: [], clearIdleWarning: false },
    );
    assert.deepEqual(
      readIdleMarkers(
        [...idleOld, { kind: 'idle_keepalive', reason: null, created_at: iso(10, 46) }],
        iso(10, 47),
      ),
      { warnedFor: [], clearIdleWarning: false },
    );

    const idleFresh = readIdleMarkers(idleOld, iso(10, 20));
    assert.deepEqual(idleFresh.warnedFor, ['idle']);
    assert.equal(idleFresh.clearIdleWarning, false);
  });

  test("I'm still here", async () => {
    let nowMs = at(10, 45);
    const events: Array<{
      session_id: string;
      event_type: 'trainer_alert' | 'status_update';
      actor_id: string | null;
      description: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }> = [];
    const broadcasts: Array<{ type: string; data: Record<string, unknown> }> = [];
    const store: IdleSweepStore = {
      async listRunningSessions() {
        return [];
      },
      async listBotUserIds() {
        return [];
      },
      async latestHumanActivity() {
        return null;
      },
      async listIdleMarkers() {
        return [];
      },
      async completeIfRunning() {
        return false;
      },
      async recordEvent(row) {
        events.push({ ...row, created_at: new Date(nowMs).toISOString() });
      },
      async isBotUser(userId) {
        return userId === 'bot';
      },
      async latestKeepalive(sessionId, userId, sinceIso) {
        let latest: string | null = null;
        for (const event of events) {
          if (event.session_id !== sessionId || event.actor_id !== userId) continue;
          if (event.event_type !== 'status_update' || event.metadata.kind !== 'idle_keepalive')
            continue;
          if (event.created_at <= sinceIso) continue;
          if (latest === null || event.created_at > latest) latest = event.created_at;
        }
        return latest;
      },
    };
    const deps = {
      store,
      now: () => nowMs,
      broadcast: (_sessionId: string, type: string, data: Record<string, unknown>) => {
        broadcasts.push({ type, data });
      },
    };

    const first = await recordKeepalive(deps, {
      sessionId: 's1',
      sessionStatus: 'in_progress',
      userId: 'human',
    });
    assert.equal(first.status, 204);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, 'status_update');
    assert.equal(events[0]?.actor_id, 'human');
    assert.equal(events[0]?.description, 'Still here');
    assert.deepEqual(events[0]?.metadata, { kind: 'idle_keepalive' });
    assert.deepEqual(broadcasts, [{ type: 'session.idle_cleared', data: { session_id: 's1' } }]);

    nowMs += 30_000;
    const second = await recordKeepalive(deps, {
      sessionId: 's1',
      sessionStatus: 'in_progress',
      userId: 'human',
    });
    assert.equal(second.status, 204);
    assert.equal(events.length, 1);
    assert.equal(broadcasts.length, 1);

    const bot = await recordKeepalive(deps, {
      sessionId: 's1',
      sessionStatus: 'in_progress',
      userId: 'bot',
    });
    assert.equal(bot.status, 204);
    assert.equal(events.length, 1);
    assert.equal(broadcasts.length, 1);

    const paused = await recordKeepalive(deps, {
      sessionId: 's1',
      sessionStatus: 'paused',
      userId: 'human',
    });
    assert.equal(paused.status, 409);
    assert.equal(events.length, 1);
    assert.equal(broadcasts.length, 1);
  });

  test('settings', () => {
    assert.deepEqual(readSessionIdleSettings({}), {
      idleEndMinutes: 30,
      idleWarnMinutes: 5,
      maxHours: 12,
    });
    assert.equal(
      readSessionIdleSettings({ SESSION_IDLE_END_MINUTES: '5000' }).idleEndMinutes,
      1440,
    );
    assert.equal(
      readSessionIdleSettings({ SESSION_IDLE_WARN_MINUTES: '5000' }).idleWarnMinutes,
      60,
    );
    assert.equal(readSessionIdleSettings({ SESSION_MAX_HOURS: '5000' }).maxHours, 72);
    assert.equal(readSessionIdleSettings({ SESSION_IDLE_END_MINUTES: '-3' }).idleEndMinutes, 0);
    assert.equal(readSessionIdleSettings({ SESSION_IDLE_END_MINUTES: '1.5' }).idleEndMinutes, 30);
    assert.deepEqual(
      readSessionIdleSettings({
        SESSION_IDLE_END_MINUTES: 'abc',
        SESSION_IDLE_WARN_MINUTES: 'abc',
        SESSION_MAX_HOURS: 'abc',
      }),
      { idleEndMinutes: 30, idleWarnMinutes: 5, maxHours: 12 },
    );
  });
});
