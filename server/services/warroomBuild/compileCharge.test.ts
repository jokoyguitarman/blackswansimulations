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

function stub(initial: BuildRow): CompileChargeStore & { row: BuildRow } {
  const row = structuredClone(initial);
  return {
    row,
    async get() {
      return structuredClone(row);
    },
    async claimCompile(_id, now) {
      if (row.status !== 'succeeded' || !compileClaimable(row, now)) return null;
      row.compile_status = 'running';
      row.compile_heartbeat_at = now.toISOString();
      return {
        credit_ledger_id: row.credit_ledger_id,
        credit_invoice_id: row.credit_invoice_id,
      };
    },
    async saveCompileCredit(_id, ledgerId, invoiceId) {
      row.credit_ledger_id = ledgerId;
      row.credit_invoice_id = invoiceId;
    },
    async failCompile() {
      row.compile_status = 'failed';
      row.credit_ledger_id = null;
      row.credit_invoice_id = null;
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
      consume,
    });
    store.row.compile_heartbeat_at = new Date(NOW.getTime() - 91_000).toISOString();
    const again = await beginCompileCharge({
      store,
      buildId: store.row.id,
      userId: 'trainer-1',
      isAdmin: false,
      now: NOW,
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
      consume,
    });
    assert.equal(first.outcome, 'claimed');
    if (first.outcome !== 'claimed') return;
    await failCompileCharge({
      store,
      buildId: store.row.id,
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
      consume: async () => ({ ok: true, ledgerId: 'ledger-x', invoiceId: null }),
    });
    assert.equal(result.outcome, 'in_progress');
  });
});
