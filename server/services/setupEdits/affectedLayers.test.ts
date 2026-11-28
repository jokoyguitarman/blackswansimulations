import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { affectedLayers, emptyBriefDiff, type BriefDiff, type LayeredInject } from './affectedLayers.js';

function diff(partial: Partial<BriefDiff> = {}): BriefDiff {
  return { ...emptyBriefDiff('facts'), ...partial };
}

const injects: LayeredInject[] = [
  { layer: 'team:comms', title: 'Chlorine leak', content: 'A chlorine drum vented at the Jurong plant.' },
  { layer: 'team:legal', title: 'Shift rota', content: 'Legal reviews the contractor shift rota.' },
  { layer: 'pressure:org_union', title: 'Leaflet', content: 'The union printed a leaflet.' },
];

describe('affectedLayers', () => {
  test('a cosmetic diff with no flags selects nothing', () => {
    assert.deepEqual(affectedLayers(emptyBriefDiff('cosmetic'), injects), []);
  });

  test('a changed fact selects only the layer whose text overlaps it', () => {
    const selected = affectedLayers(
      diff({ fact_changes: [{ kind: 'change', old: 'chlorine drum', new: 'ammonia drum' }] }),
      injects,
    );
    assert.deepEqual(selected, ['team:comms']);
  });

  test('a removed premise selects the layer that states it', () => {
    const selected = affectedLayers(
      diff({ removed_premises: ['contractor shift rota'] }),
      injects,
    );
    assert.deepEqual(selected, ['team:legal']);
  });

  test('the model flag selects a layer the keywords missed', () => {
    const selected = affectedLayers(diff({ affected_layers: ['pressure:org_union'] }), injects);
    assert.deepEqual(selected, ['pressure:org_union']);
  });

  test('severity story selects every layer that still has an inject', () => {
    assert.deepEqual(affectedLayers(diff({ severity: 'story' }), injects), [
      'pressure:org_union',
      'team:comms',
      'team:legal',
    ]);
  });

  test('a flag for a layer with no inject is ignored', () => {
    assert.deepEqual(affectedLayers(diff({ affected_layers: ['backbone'] }), injects), []);
  });
});
