import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getOrResearchTeamDoctrines } from './doctrineCacheService.js';
import { runWithAbortSignal } from './ai/abortContext.js';
import type { ResearchGuidelines, TeamDef } from './socialCrisisGeneratorService.js';

logger.level = 'silent';

const team: TeamDef = {
  team_name: 'Comms',
  team_description: 'press office',
  min_participants: 1,
  max_participants: 4,
};

const emptyGroup: ResearchGuidelines['group_wide'] = {
  coordination_guidelines: [],
  escalation_protocols: [],
  timing_benchmarks: {},
  case_studies: [],
};

const filledGroup: ResearchGuidelines['group_wide'] = {
  coordination_guidelines: ['Share the holding line before anyone posts.'],
  escalation_protocols: [],
  timing_benchmarks: {},
  case_studies: [],
};

const filledTeam = {
  team_name: 'Comms',
  guidelines: [
    {
      guideline_id: 'ack-fast',
      best_practice: 'Acknowledge within 15 minutes.',
      source_basis: 'case',
      if_violated: 'The vacuum fills.',
      if_followed: 'The account stays credible.',
      detection_signals: ['no public post'],
    },
  ],
};

function installFromSpy(): {
  writes: Array<{ table: string; row: unknown }>;
  restore: () => void;
} {
  const writes: Array<{ table: string; row: unknown }> = [];
  const original = supabaseAdmin.from;
  let current = '';
  const fake = {
    select() {
      return fake;
    },
    eq() {
      return fake;
    },
    async single() {
      return { data: null, error: null };
    },
    async upsert(row: unknown) {
      writes.push({ table: current, row });
      return { error: null };
    },
  };
  (supabaseAdmin as unknown as { from: (table: string) => unknown }).from = (table: string) => {
    current = table;
    return fake;
  };
  return {
    writes,
    restore() {
      supabaseAdmin.from = original;
    },
  };
}

async function research(
  result: ResearchGuidelines,
  signal?: AbortSignal,
): Promise<ResearchGuidelines> {
  const run = () =>
    getOrResearchTeamDoctrines([team], 'data breach at the bank', 'ctx', {}, async () => result);
  return signal ? runWithAbortSignal(signal, run) : run();
}

test('an aborted research does not cache doctrines', async () => {
  const spy = installFromSpy();
  const ac = new AbortController();
  ac.abort();
  try {
    await research({ per_team: [filledTeam], group_wide: filledGroup }, ac.signal);
    assert.deepEqual(spy.writes, []);
  } finally {
    spy.restore();
  }
});

test('an empty group_wide is never cached', async () => {
  const spy = installFromSpy();
  try {
    await research({ per_team: [filledTeam], group_wide: emptyGroup });
    assert.deepEqual(
      spy.writes.map((write) => write.table),
      ['social_crisis_doctrines'],
    );
  } finally {
    spy.restore();
  }
});

test('a non-empty group_wide is cached', async () => {
  const spy = installFromSpy();
  try {
    await research({ per_team: [], group_wide: filledGroup });
    const groupWrite = spy.writes.find((write) => write.table === 'social_crisis_group_doctrines');
    assert.ok(groupWrite);
    assert.equal((groupWrite.row as { crisis_category: string }).crisis_category, 'data_breach');
  } finally {
    spy.restore();
  }
});
