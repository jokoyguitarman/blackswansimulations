import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { env } from '../../env.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { resetPeaceColumnsForTests } from '../../lib/peaceSchema.js';
import { resetTopicSchemaForTests } from '../topic/topicColumns.js';
import { publishPeaceFeed, resetPeaceScenarioCacheForTests } from './peacePublisher.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OPENED = '2026-06-01T12:00:00.000Z';
const OPENED_MS = Date.parse(OPENED);

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalPeace = env.enablePeacePeriod;

interface Row {
  id: string;
  peace_ref?: string;
  reply_to_post_id?: string | null;
  reply_count?: number;
  topic_kind?: string;
  content?: string;
}

function feed() {
  return {
    version: 1,
    seconds: 300,
    enabled: true,
    leak_terms: ['recall'],
    posts: [
      {
        ref: 'P1',
        author: { kind: 'page', org_key: 'primary', platform: 'facebook' },
        platform: 'facebook',
        post_format: 'text',
        content: 'Weekend breakfast',
        media_description: '',
        offset_seconds: 20,
        comments: [
          { author_handle: '@sam', content: 'See you there', offset_seconds: 50 },
          { author_handle: '@sam', content: 'too late', offset_seconds: 280 },
        ],
      },
      {
        ref: 'P2',
        author: { kind: 'page', org_key: 'gone', platform: 'facebook' },
        platform: 'facebook',
        post_format: 'text',
        content: 'No page',
        media_description: '',
        offset_seconds: 30,
        comments: [],
      },
      {
        ref: 'P3',
        author: { kind: 'persona', handle: '@sam' },
        platform: 'x_twitter',
        post_format: 'text',
        content: 'Saturday',
        media_description: '',
        offset_seconds: 40,
        comments: [],
      },
    ],
  };
}

function install(peace: Record<string, unknown> = feed()) {
  const rows: Row[] = [];
  let nextId = 1;
  const engaged: Array<{ id: string; ambient: boolean | undefined }> = [];
  (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
    let op = 'select';
    let payload: Record<string, unknown> | null = null;
    const filters: Array<{ col: string; val: unknown }> = [];
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'not', 'order', 'limit', 'in', 'is', 'gte']) {
      builder[method] = (...args: unknown[]) => {
        if (method === 'eq') filters.push({ col: String(args[0]), val: args[1] });
        return builder;
      };
    }
    builder.insert = (body: Record<string, unknown>) => {
      op = 'insert';
      payload = body;
      return builder;
    };
    builder.update = (body: Record<string, unknown>) => {
      op = 'update';
      payload = body;
      return builder;
    };
    const finish = () => {
      if (table === 'sessions') {
        return {
          data: { scenario_id: 'sc-1', start_time: '2026-06-01T12:05:00.000Z', opened_at: OPENED },
          error: null,
        };
      }
      if (table === 'scenarios') {
        return {
          data: {
            initial_state: {
              peace_period: peace,
              npc_personas: [{ handle: '@sam', name: 'Sam', type: 'npc_public' }],
            },
          },
          error: null,
        };
      }
      if (table === 'sim_org_pages') {
        return {
          data: [{ org_key: 'primary', platform: 'facebook', page_handle: '@brand', page_name: 'Brand' }],
          error: null,
        };
      }
      if (table === 'social_posts' && op === 'select') {
        const idFilter = filters.find((filter) => filter.col === 'id');
        if (idFilter) {
          const row = rows.find((item) => item.id === idFilter.val);
          return { data: row ? { reply_count: row.reply_count ?? 0 } : null, error: null };
        }
        return {
          data: rows.filter((row) => row.peace_ref).map((row) => ({ id: row.id, peace_ref: row.peace_ref })),
          error: null,
        };
      }
      if (table === 'social_posts' && op === 'insert' && payload) {
        if (rows.some((row) => row.peace_ref === payload?.peace_ref)) {
          return { data: null, error: { code: '23505', message: 'duplicate peace_ref' } };
        }
        const row: Row = {
          id: `post-${nextId++}`,
          peace_ref: String(payload.peace_ref),
          reply_to_post_id: (payload.reply_to_post_id as string | null) ?? null,
          reply_count: 0,
          topic_kind: payload.topic_kind as string | undefined,
          content: String(payload.content),
        };
        rows.push(row);
        return { data: { id: row.id }, error: null };
      }
      if (table === 'social_posts' && op === 'update' && payload) {
        const idFilter = filters.find((filter) => filter.col === 'id');
        const row = rows.find((item) => item.id === idFilter?.val);
        if (row && typeof payload.reply_count === 'number') row.reply_count = payload.reply_count;
        return { data: row ?? null, error: null };
      }
      return { data: [], error: null };
    };
    builder.single = async () => finish();
    builder.maybeSingle = async () => finish();
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(finish()).then(resolve, reject);
    return builder;
  };
  return {
    rows,
    engaged,
    engage: async (id: string, options?: { ambient?: boolean }) => {
      engaged.push({ id, ambient: options?.ambient });
    },
  };
}

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  env.enablePeacePeriod = originalPeace;
  resetPeaceColumnsForTests();
  resetTopicSchemaForTests();
  resetPeaceScenarioCacheForTests();
});

test('flag off does not read or publish', async () => {
  env.enablePeacePeriod = false;
  const db = install();
  await publishPeaceFeed({ id: SESSION }, { engage: db.engage, now: OPENED_MS + 80_000 });
  assert.deepEqual(db.rows, []);
  assert.deepEqual(db.engaged, []);
});

test('publishes due rows in parent-then-comment order, skips the rest, and is idempotent', async () => {
  env.enablePeacePeriod = true;
  const db = install();
  const now = OPENED_MS + 80_000;
  await publishPeaceFeed({ id: SESSION }, { engage: db.engage, now });
  assert.deepEqual(
    db.rows.map((row) => row.peace_ref),
    ['P1', 'P1#0', 'P3'],
  );
  assert.equal(db.rows[0]?.topic_kind, 'normal');
  assert.equal(db.rows[1]?.reply_to_post_id, db.rows[0]?.id);
  assert.equal(db.rows[0]?.reply_count, 1);
  assert.ok(db.rows.every((row) => row.topic_kind === 'normal' && row.peace_ref));
  assert.deepEqual(db.engaged, [{ id: SESSION, ambient: false }]);

  db.engaged.length = 0;
  await publishPeaceFeed({ id: SESSION }, { engage: db.engage, now });
  assert.equal(db.rows.length, 3);
  assert.deepEqual(db.engaged, [{ id: SESSION, ambient: false }]);
});

test('a short authored length does not hide posts that fit the live peace', async () => {
  env.enablePeacePeriod = true;
  const short = feed();
  short.seconds = 40;
  const db = install(short);
  await publishPeaceFeed({ id: SESSION }, { engage: db.engage, now: OPENED_MS + 80_000 });
  assert.deepEqual(
    db.rows.map((row) => row.peace_ref),
    ['P1', 'P1#0', 'P3'],
  );
});

test('a feed without seconds still publishes inside the live peace', async () => {
  env.enablePeacePeriod = true;
  const bare = feed() as { seconds?: number };
  delete bare.seconds;
  const db = install(bare);
  await publishPeaceFeed({ id: SESSION }, { engage: db.engage, now: OPENED_MS + 80_000 });
  assert.deepEqual(
    db.rows.map((row) => row.peace_ref),
    ['P1', 'P1#0', 'P3'],
  );
});

test('a disabled feed publishes nothing and still runs engagement without ambient posts', async () => {
  env.enablePeacePeriod = true;
  const db = install({ ...feed(), enabled: false });
  await publishPeaceFeed({ id: SESSION }, { engage: db.engage, now: OPENED_MS + 80_000 });
  assert.deepEqual(db.rows, []);
  assert.deepEqual(db.engaged, [{ id: SESSION, ambient: false }]);
});
