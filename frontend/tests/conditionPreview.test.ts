import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONDITION_CATALOG } from '../../server/services/conditions/conditionCatalog.ts';
import { timingWarnings } from '../src/components/Scenario/conditionDraft.ts';
import { conditionPreviewSentence } from '../src/components/Scenario/conditionPreview.ts';

describe('condition preview', () => {
  test('all, with cancel and not-before', () => {
    assert.equal(
      conditionPreviewSentence({
        quantifier: 'all',
        threshold: 1,
        appear: [
          'Nobody replied to ‘Supplier batch 4471’ by email within 10 min',
          'The call ‘Supplier calls Ops’ was missed',
        ],
        cancel: ['Someone replied to the email ‘Supplier batch 4471’'],
        notBefore: 12,
      }),
      'Fires when nobody replied to ‘Supplier batch 4471’ by email within 10 min AND the call ‘Supplier calls Ops’ was missed. Cancelled if someone replied to the email ‘Supplier batch 4471’. Not before T+12.',
    );
  });

  test('any joins with OR and does not mention not-before when it is empty', () => {
    assert.equal(
      conditionPreviewSentence({
        quantifier: 'any',
        threshold: 1,
        appear: [
          'Someone replied to the email ‘Supplier batch 4471’',
          'The call ‘Supplier calls Ops’ was missed',
        ],
        cancel: [],
        notBefore: null,
      }),
      'Fires when any of these hold: someone replied to the email ‘Supplier batch 4471’ OR the call ‘Supplier calls Ops’ was missed.',
    );
  });

  test('at least N lists the clauses and keeps the cancel', () => {
    assert.equal(
      conditionPreviewSentence({
        quantifier: 'at_least',
        threshold: 2,
        appear: [
          'Nobody replied to ‘Supplier batch 4471’ by email within 15 min',
          'The call ‘Supplier calls Ops’ was missed',
          'The latest reply to ‘Supplier batch 4471’ is defensive',
        ],
        cancel: ['A reply to ‘Supplier batch 4471’ passed'],
        notBefore: 0,
      }),
      'Fires when at least 2 of these hold: nobody replied to ‘Supplier batch 4471’ by email within 15 min, the call ‘Supplier calls Ops’ was missed, and the latest reply to ‘Supplier batch 4471’ is defensive. Cancelled if a reply to ‘Supplier batch 4471’ passed.',
    );
  });

  test('a referenced inject timed later is a warning', () => {
    const warnings = timingWarnings(
      ['email_unreplied:supplier_4471:15', 'call_missed:supplier_4471_call'],
      CONDITION_CATALOG,
      [
        { inject_key: 'supplier_4471', title: 'Supplier batch 4471', trigger_time_minutes: null },
        { inject_key: 'supplier_4471_call', title: 'Supplier calls Ops', trigger_time_minutes: 30 },
      ],
    );
    assert.deepEqual(warnings, [
      "Inject ‘Supplier calls Ops’ is timed at T+30; this inject can't fire before then.",
    ]);
  });
});
