import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyInjectGenStamp,
  fingerprintInject,
  inferLayer,
  injectProvenance,
  isAiOwned,
  type FingerprintInject,
} from './injectFingerprint.js';

function row(over: Partial<FingerprintInject> = {}): FingerprintInject {
  return {
    title: 'Supplier email',
    content: 'We need an answer today.',
    type: 'email_inbound',
    severity: 'high',
    trigger_time_minutes: 12,
    eligible_after_minutes: null,
    target_teams: ['Stakeholder Engagement'],
    inject_scope: 'team_specific',
    requires_response: true,
    conditions_to_appear: null,
    conditions_to_cancel: null,
    delivery_config: {
      app: 'email',
      from_name: 'Aisha',
      inject_key: 'supplier_email',
    },
    generation_source: 'war_room',
    ...over,
  };
}

describe('fingerprintInject', () => {
  test('is stable under object key order and ignores gen', () => {
    const left = row({
      delivery_config: { from_name: 'Aisha', app: 'email', inject_key: 'supplier_email' },
    });
    const right = row({
      delivery_config: {
        inject_key: 'supplier_email',
        app: 'email',
        from_name: 'Aisha',
        gen: { layer: 'shared', edit: 0, hash: 'stale' },
      },
    });
    assert.equal(fingerprintInject(left), fingerprintInject(right));
  });

  test('changes when editable content changes', () => {
    const original = fingerprintInject(row());
    assert.notEqual(fingerprintInject(row({ title: 'A different email' })), original);
    assert.notEqual(fingerprintInject(row({ content: 'Tomorrow is fine.' })), original);
    assert.notEqual(
      fingerprintInject(row({ target_teams: ['Communications'] })),
      original,
    );
  });
});

describe('isAiOwned', () => {
  test('matches a war-room row whose hash still equals the stamp', () => {
    const base = row();
    const hash = fingerprintInject(base);
    const stamped = row({
      delivery_config: { ...base.delivery_config, gen: { layer: 'team:abc', edit: 0, hash } },
    });
    assert.equal(isAiOwned(stamped), true);
    assert.equal(injectProvenance(stamped), 'ai_owned');
  });

  test('a content edit or a trainer source is not AI-owned', () => {
    const base = row();
    const hash = fingerprintInject(base);
    const edited = row({
      content: 'Edited by hand',
      delivery_config: { ...base.delivery_config, gen: { hash, edit: 0, layer: 'shared' } },
    });
    assert.equal(isAiOwned(edited), false);
    assert.equal(injectProvenance(edited), 'hand_edited');
    const trainer = row({
      generation_source: 'trainer',
      delivery_config: { ...base.delivery_config, gen: { hash: fingerprintInject(base), edit: 0, layer: 'shared' } },
    });
    assert.equal(isAiOwned(trainer), false);
  });

  test('an unedited promoted inject is AI-owned until its text changes', () => {
    const base = row({
      generation_source: 'trainer',
      delivery_config: {
        ...row().delivery_config,
        promoted_from: 'proposal-1',
      },
    });
    const hash = fingerprintInject(base);
    const promoted = row({
      generation_source: 'trainer',
      delivery_config: {
        ...base.delivery_config,
        gen: { layer: 'promoted', edit: 0, hash },
      },
    });
    assert.equal(isAiOwned(promoted), true);
    assert.equal(injectProvenance(promoted), 'ai_owned');
    assert.equal(inferLayer(base), 'promoted');
    const edited = row({
      generation_source: 'trainer',
      content: 'Trainer changed the wording',
      delivery_config: promoted.delivery_config,
    });
    assert.equal(isAiOwned(edited), false);
    assert.equal(injectProvenance(edited), 'hand_edited');
    const marked = row({
      generation_source: 'trainer',
      delivery_config: {
        ...base.delivery_config,
        gen: { layer: 'promoted', edit: 1 },
      },
    });
    assert.equal(isAiOwned(marked), false);
  });

  test('a legacy war-room row with no gen hash is AI-owned and unverified', () => {
    const legacy = row();
    assert.equal(isAiOwned(legacy), true);
    assert.equal(injectProvenance(legacy), 'unverified');
  });
});

describe('applyInjectGenStamp', () => {
  test('rewrites a team layer to the persisted team_uid and stores the hash', () => {
    const stamped = applyInjectGenStamp(
      { ...row(), gen_layer: 'team:Stakeholder Engagement' },
      {
        teamUidByName: new Map([['Stakeholder Engagement', '22222222-2222-4222-8222-222222222222']]),
        persistTeamUid: true,
      },
    );
    const gen = stamped.delivery_config.gen as { layer: string; team_uid: string; hash: string; edit: number };
    assert.equal(gen.layer, 'team:22222222-2222-4222-8222-222222222222');
    assert.equal(gen.team_uid, '22222222-2222-4222-8222-222222222222');
    assert.equal(gen.edit, 0);
    assert.equal(gen.hash, fingerprintInject(stamped));
    assert.equal('gen_layer' in stamped, false);
  });

  test('omits team_uid when the column was not stored', () => {
    const stamped = applyInjectGenStamp(
      { ...row(), gen_layer: 'team:Stakeholder Engagement' },
      {
        teamUidByName: new Map([['Stakeholder Engagement', '22222222-2222-4222-8222-222222222222']]),
        persistTeamUid: false,
      },
    );
    const gen = stamped.delivery_config.gen as { layer: string; team_uid?: string };
    assert.equal(gen.layer, 'team:Stakeholder Engagement');
    assert.equal(gen.team_uid, undefined);
  });
});
