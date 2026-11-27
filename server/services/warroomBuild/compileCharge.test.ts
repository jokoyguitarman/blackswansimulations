import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { initialStageStates } from './buildCore.js';
import { beginCompileCharge, failCompileCharge, type CompileChargeStore } from './compileCharge.js';
import { compileClaimable } from './buildStore.js';
import type { BuildRow } from './buildTypes.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function succeeded(patch: Partial<BuildRow> = {}): BuildRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    draft_id: '22222222-2222-4222-8222-222222222222',
    created_by: 'trainer-1',
    pool: 'test',
    status: 'succeeded',
    current_stage: null,
    stage_states: initialStageStates(),
    request: {
      crisis_type: 'Plant fire',
      context: '',
      country: 'Singapore',
      organisations: [],
      competitors: [],
      pressure_organisations: [],
      auto_antagonist: true,
      duration: 60,
    },
    request_hash: 'hash',
    idempotency_key: '33333333-3333-4333-8333-333333333333',
    error: null,
    error_code: null,
    cancel_requested_at: null,
    cancel_reason: null,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    interruptions: 0,
    last_seen_at: NOW.toISOString(),
    log_count: 0,
    compile_status: null,
    compile_heartbeat_at: null,
    credit_ledger_id: null,
    credit_invoice_id: null,
    scenario_id: null,
    started_at: NOW.toISOString(),
    finished_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...patch,
  };
}

function stub(initial: BuildRow): CompileChargeStore & {
  row: BuildRow;
  succeedCompile(buildId: string, scenarioId: string, heartbeatAt: string): Promise<boolean>;
} {
  const row = structuredClone(initial);
  return {
    row,
    async get() {
      return structuredClone(row);
    },
    async claimCompile(_id, now) {
      if (row.status !== 'succeeded' || !compileClaimable(row, now)) return null;
      const iso = now.toISOString();
      row.compile_status = 'running';
      row.compile_heartbeat_at = iso;
      return {
        credit_ledger_id: row.credit_ledger_id,
        credit_invoice_id: row.credit_invoice_id,
        compile_heartbeat_at: iso,
      };
    },
    async saveCompileCredit(_id, ledgerId, invoiceId, heartbeatAt) {
      if (row.compile_status !== 'running' || row.compile_heartbeat_at !== heartbeatAt)
        return false;
      row.credit_ledger_id = ledgerId;
      row.credit_invoice_id = invoiceId;
      return true;
    },
    async failCompile(_id, heartbeatAt) {
      if (row.compile_status !== 'running' || row.compile_heartbeat_at !== heartbeatAt)
        return false;
      row.compile_status = 'failed';
      row.credit_ledger_id = null;
      row.credit_invoice_id = null;
      return true;
    },
    async succeedCompile(_id: string, scenarioId: string, heartbeatAt: string) {
      if (row.compile_status !== 'running' || row.compile_heartbeat_at !== heartbeatAt)
        return false;
      row.compile_status = 'succeeded';
      row.scenario_id = scenarioId;
      return true;
    },
  };
}

describe('compile charge', () => {
  test('K1 the first compile consumes once', async () => {
    const store = stub(succeeded());
    const calls: string[] = [];
    const begun = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
      refund: async () => {},
      consume: async () => {
        calls.push('consume');
        return { ok: true, ledgerId: 'ledger-1', invoiceId: 'invoice-1' };
      },
    });
    assert.equal(begun.outcome, 'claimed');
    assert.deepEqual(calls, ['consume']);
    assert.equal(store.row.credit_ledger_id, 'ledger-1');
    assert.equal(store.row.compile_status, 'running');
  });

  test('K2 a stale heartbeat reuses the charge', async () => {
    const store = stub(succeeded());
    let n = 0;
    const consume = async () => {
      n += 1;
      return { ok: true, ledgerId: 'ledger-1', invoiceId: 'invoice-1' };
    };
    await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
      refund: async () => {},
      consume,
    });
    store.row.compile_heartbeat_at = new Date(NOW.getTime() - 91_000).toISOString();
    const again = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
      refund: async () => {},
      consume,
    });
    assert.equal(again.outcome, 'claimed');
    if (again.outcome === 'claimed') assert.equal(again.ledgerId, 'ledger-1');
    assert.equal(n, 1);
  });

  test('K3 a failure refunds and the retry consumes again', async () => {
    const store = stub(succeeded());
    let consumes = 0;
    let refunds = 0;
    const consume = async () => {
      consumes += 1;
      return { ok: true, ledgerId: `ledger-${consumes}`, invoiceId: 'invoice-1' };
    };
    const first = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
      refund: async () => {},
      consume,
    });
    assert.equal(first.outcome, 'claimed');
    if (first.outcome !== 'claimed') return;
    await failCompileCharge({
      store,
      buildId: store.row.id,
      heartbeatAt: first.heartbeatAt,
      ledgerId: first.ledgerId,
      invoiceId: first.invoiceId,
      refund: async () => {
        refunds += 1;
      },
    });
    assert.equal(store.row.credit_ledger_id, null);
    assert.equal(store.row.compile_status, 'failed');
    const retry = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
      refund: async () => {},
      consume,
    });
    assert.equal(retry.outcome, 'claimed');
    assert.equal(consumes, 2);
    assert.equal(refunds, 1);
  });

  test('K4 an already compiled build returns the scenario without consuming', async () => {
    const store = stub(succeeded({ compile_status: 'succeeded', scenario_id: 'scenario-1' }));
    let consumes = 0;
    const result = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
      refund: async () => {},
      consume: async () => {
        consumes += 1;
        return { ok: true, ledgerId: 'ledger-x', invoiceId: null };
      },
    });
    assert.deepEqual(result, { outcome: 'completed', scenarioId: 'scenario-1' });
    assert.equal(consumes, 0);
  });

  test('a fresh running compile is in progress', async () => {
    const store = stub(
      succeeded({
        compile_status: 'running',
        compile_heartbeat_at: NOW.toISOString(),
      }),
    );
    const result = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
      refund: async () => {},
      consume: async () => ({ ok: true, ledgerId: 'ledger-x', invoiceId: null }),
    });
    assert.equal(result.outcome, 'in_progress');
  });

  test('a save that matches no row refunds the unstored credit', async () => {
    const store = stub(succeeded());
    store.saveCompileCredit = async () => false;
    let refunds = 0;
    const result = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
      consume: async () => ({ ok: true, ledgerId: 'ledger-1', invoiceId: 'invoice-1' }),
      refund: async () => {
        refunds += 1;
      },
    });
    assert.equal(result.outcome, 'unavailable');
    assert.equal(refunds, 1);
    assert.equal(store.row.credit_ledger_id, null);
  });

  test('a stale process does not refund a charge the next process reused', async () => {
    const store = stub(succeeded());
    let consumes = 0;
    let refunds = 0;
    const consume = async () => {
      consumes += 1;
      return { ok: true, ledgerId: 'ledger-1', invoiceId: 'invoice-1' };
    };
    const refund = async () => {
      refunds += 1;
    };
    const first = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
      consume,
      refund,
    });
    assert.equal(first.outcome, 'claimed');
    if (first.outcome !== 'claimed') return;
    store.row.compile_heartbeat_at = new Date(NOW.getTime() - 91_000).toISOString();
    const later = new Date(NOW.getTime() + 120_000);
    const second = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: later,
      consume,
      refund,
    });
    assert.equal(second.outcome, 'claimed');
    if (second.outcome !== 'claimed') return;
    assert.equal(second.ledgerId, 'ledger-1');
    assert.equal(consumes, 1);
    const cleared = await failCompileCharge({
      store,
      buildId: store.row.id,
      heartbeatAt: first.heartbeatAt,
      ledgerId: first.ledgerId,
      invoiceId: first.invoiceId,
      refund,
    });
    assert.equal(cleared, false);
    assert.equal(refunds, 0);
    assert.equal(store.row.compile_status, 'running');
    assert.equal(store.row.credit_ledger_id, 'ledger-1');
    assert.equal(store.row.compile_heartbeat_at, second.heartbeatAt);
    const third = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: later,
      consume,
      refund,
    });
    assert.equal(third.outcome, 'in_progress');
    assert.equal(
      await store.succeedCompile(store.row.id, 'scenario-orphan', first.heartbeatAt),
      false,
    );
    assert.equal(store.row.scenario_id, null);
    assert.equal(store.row.compile_status, 'running');
  });
});
