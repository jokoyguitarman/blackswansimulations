import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CONDITION_CATALOG } from '../../server/services/conditions/conditionCatalog.ts';
import {
  compileDraft,
  draftFromStored,
  emptyConditionNames,
} from '../src/components/Scenario/conditionDraft.ts';
import {
  causeChipText,
  dependencyPreviewSentence,
  dependencyTableCells,
  type DependencyPreviewInput,
} from '../src/components/Scenario/dependencyPreview.ts';

const TITLES = { bay3_headcount_request: 'Bay 3 headcount' };

function sentence(brokenKeys: string[], extra: Partial<DependencyPreviewInput> = {}): string {
  return dependencyPreviewSentence({
    upstream: 'Operations',
    downstream: ['Communications'],
    brokenKeys,
    brokenQuantifier: 'any',
    metKeys: ['responded_relevant:bay3_headcount_request|team=@upstream'],
    lagMinutes: 5,
    consequences: [{ team: 'Communications', title: 'Reporter presses for numbers' }],
    injectTitles: TITLES,
    ...extra,
  });
}

describe('dependency preview sentences', () => {
  test('no reply matches the worked example, including the cancel', () => {
    assert.equal(
      sentence(['unresponded:bay3_headcount_request:10|team=@upstream']),
      "When Operations doesn't reply to ‘Bay 3 headcount’ within 10 minutes, Communications receives ‘Reporter presses for numbers’ 5 minutes later. Cancelled if Operations delivers first.",
    );
  });

  test('each signal template names how the upstream team fails', () => {
    assert.match(
      sentence(['reply_failed:bay3_headcount_request|team=@upstream']),
      /replies poorly to ‘Bay 3 headcount’/,
    );
    assert.match(
      sentence(['duty_missed:legal_review_statement|team=@upstream']),
      /misses ‘legal review statement’/,
    );
    assert.match(sentence(['team_silent:12|team=@upstream']), /stays silent for 12 minutes/);
    assert.match(sentence(['content_failed:1:45|team=@upstream']), /has content scored below 45/);
    assert.match(
      sentence(['decision_made:public_statement|team=@upstream']),
      /makes a public statement decision/,
    );
    assert.match(
      sentence(['action_count_gte:post_created:1|team=@upstream']),
      /does ‘post created’/,
    );
    assert.match(
      sentence(['intel_missing:vessel_manifest|team=@upstream'], {
        injectTitles: { ...TITLES, vessel_manifest: 'vessel manifest' },
      }),
      /hasn't shared ‘vessel manifest’/,
    );
  });

  test('lag 0 says immediately', () => {
    assert.equal(
      sentence(['unresponded:bay3_headcount_request:10|team=@upstream'], { lagMinutes: 0 }),
      "When Operations doesn't reply to ‘Bay 3 headcount’ within 10 minutes, Communications receives ‘Reporter presses for numbers’ immediately. Cancelled if Operations delivers first.",
    );
  });

  test('two downstream teams each receive their own consequence', () => {
    assert.equal(
      dependencyPreviewSentence({
        upstream: 'Legal',
        downstream: ['Communications', 'Customer Service'],
        brokenKeys: ['team_silent:12|team=@upstream'],
        lagMinutes: 3,
        consequences: [
          { team: 'Communications', title: "CEO's office asks why there's still no statement" },
          { team: 'Customer Service', title: 'Angry callers: no official line' },
        ],
        metKeys: ['duty_done:legal_review_statement|team=@upstream'],
      }),
      "When Legal stays silent for 12 minutes, Communications receives ‘CEO's office asks why there's still no statement’ and Customer Service receives ‘Angry callers: no official line’ 3 minutes later. Cancelled if Legal meets it first.",
    );
  });

  test('the cause chip names who breaks the deliverable and who receives it', () => {
    assert.equal(
      causeChipText('Operations', 'Confirmed headcount', ['Communications']),
      'Fires when Operations breaks ‘Confirmed headcount’ · lands on Communications',
    );
    assert.equal(
      causeChipText('Legal', 'Approval of the holding statement', [
        'Communications',
        'Customer Service',
      ]),
      'Fires when Legal breaks ‘Approval of the holding statement’ · lands on Communications and Customer Service',
    );
  });
});

describe('dependency orphan display', () => {
  test('a removed upstream team is an orphan row', () => {
    assert.deepEqual(
      dependencyTableCells({
        upstreamName: 'Logistics',
        upstreamRemoved: true,
        downstream: [{ name: 'Operations', removed: false }],
        deliverable: 'Truck availability',
        brokenKeys: ['unresponded:truck_request:10|team=@upstream'],
        lagMinutes: 5,
        consequences: [{ title: 'Ops waits', found: true }],
      }),
      {
        upstream: '⚠ Logistics (removed)',
        downstream: 'Operations',
        deliverable: 'Truck availability',
        breaksWhen: '—',
        lag: '—',
        consequences: 'orphan: fix or retire',
      },
    );
  });

  test('a live row keeps the short break, the lag, and a found consequence', () => {
    assert.deepEqual(
      dependencyTableCells({
        upstreamName: 'Operations',
        upstreamRemoved: false,
        downstream: [
          { name: 'Communications', removed: false },
          { name: 'Customer Service', removed: true },
        ],
        deliverable: 'Confirmed headcount for Bay 3',
        brokenKeys: [
          'unresponded:bay3_headcount_request:10|team=@upstream',
          'reply_failed:bay3_headcount_request|team=@upstream',
        ],
        lagMinutes: 5,
        consequences: [{ title: 'Reporter presses', found: true }],
      }),
      {
        upstream: 'Operations',
        downstream: 'Communications and ⚠ Customer Service (removed)',
        deliverable: 'Confirmed headcount for Bay 3',
        breaksWhen: 'no reply 10',
        lag: '5 min',
        consequences: 'Reporter presses (✓)',
      },
    );
  });

  test('several consequences collapse to a count', () => {
    assert.equal(
      dependencyTableCells({
        upstreamName: 'Legal',
        upstreamRemoved: false,
        downstream: [{ name: 'Communications', removed: false }],
        deliverable: 'Approval of the holding statement',
        brokenKeys: ['team_silent:12|team=@upstream'],
        lagMinutes: 3,
        consequences: [
          { title: 'CEO asks', found: true },
          { title: 'Angry callers', found: true },
        ],
      }).consequences,
      '2 injects',
    );
  });
});

describe('dependency condition builder', () => {
  test('a fixed upstream scope round-trips |team=@upstream', () => {
    const draft = draftFromStored(
      {
        any: [
          'unresponded:bay3_headcount_request:10|team=@upstream',
          'reply_failed:bay3_headcount_request|team=@upstream',
        ],
      },
      [],
      null,
      CONDITION_CATALOG,
      { allowPlaceholders: true },
    );
    assert.equal(draft.raw, false);
    assert.equal(draft.quantifier, 'any');
    assert.equal(draft.appear[0]?.team, '@upstream');
    assert.equal(draft.appear[1]?.team, '@upstream');
    const compiled = compileDraft(draft, CONDITION_CATALOG, emptyConditionNames(), [], [], {
      allowPlaceholders: true,
    });
    assert.deepEqual(compiled.errors, []);
    assert.deepEqual(compiled.conditions_to_appear, {
      threshold: 1,
      conditions: [
        'unresponded:bay3_headcount_request:10|team=@upstream',
        'reply_failed:bay3_headcount_request|team=@upstream',
      ],
    });
  });
});
