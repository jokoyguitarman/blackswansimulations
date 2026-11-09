import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CASUALTY_ANSWER_KEYS,
  PARTICIPANT_SCENE_FIELDS,
  SCENE_AUTHORING_FIELDS,
  canSeeScenarioAnswerKey,
  canSeeSessionAnswerKey,
  projectCasualtyForParticipant,
  projectSceneForParticipant,
} from './participantProjections.js';

const exitPoint = {
  id: 'exit-1',
  center: [1.3, 103.8],
  pos: 0.2,
  width: 1.2,
  edgeIndex: 1,
  status: 'open',
  exitType: 'door',
  photos: ['secret-photo'],
  description: 'the planted door',
};

const wall = {
  id: 'wall-1',
  start: [0, 0],
  end: [1, 1],
  hasDoor: false,
  doorWidth: 0,
  doorPosition: 0,
  material: 'concrete',
  photos: ['wall-photo'],
  description: 'behind the planter',
};

function sceneRow(): Record<string, unknown> {
  return {
    id: 'scene-1',
    scenario_id: 'scenario-1',
    name: 'Mall',
    building_polygon: [
      [1, 103],
      [1, 104],
      [2, 104],
    ],
    building_name: 'Plaza',
    center_lat: 1.3,
    center_lng: 103.8,
    exits: [exitPoint, 'not-an-exit', null],
    interior_walls: [wall],
    hazard_zones: [{ id: 'zone-1', kind: 'smoke' }],
    stairwells: [
      { id: 'stair-1', pos: [1, 1], connectsFloors: [1, 2], blocked: false, note: 'secret' },
    ],
    blast_site: { lat: 1.3, lng: 103.8 },
    casualty_clusters: [{ id: 'cluster-1' }],
    planted_items: [{ wall_point_id: 'wall-a' }, { wall_point_id: 'wall-b' }],
    wall_inspection_points: [{ id: 'inspect-1' }],
    wall_photo_urls: { 'wall-1': 'https://example.test/wall' },
    casualty_image_urls: { 'cas-1': 'https://example.test/cas' },
    pedestrian_count: 120,
    created_by: 'trainer-1',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
    enrichment_result: { summary: 'answer key' },
    schema_version: 1,
    involved_layouts: [{ osm_id: 'b1' }],
    crowd_zones: [{ id: 'crowd-1', headcount: 40 }],
    crowd_headcount: 40,
    authored: { devices: ['secret'] },
    site_snapshot: { address: 'secret' },
    draft_id: 'draft-1',
    future_sensor: { classified: true },
  };
}

describe('participant projections', () => {
  test('the scene projection is an allow-list', () => {
    const row = sceneRow();
    const projected = projectSceneForParticipant(row);
    assert.ok(projected);
    assert.deepEqual(Object.keys(projected).sort(), [...PARTICIPANT_SCENE_FIELDS].sort());
    assert.deepEqual(projected.exits, [
      {
        id: 'exit-1',
        center: [1.3, 103.8],
        pos: 0.2,
        width: 1.2,
        edgeIndex: 1,
        status: 'open',
        exitType: 'door',
      },
    ]);
    assert.deepEqual(projected.interior_walls, [
      {
        id: 'wall-1',
        start: [0, 0],
        end: [1, 1],
        hasDoor: false,
        doorWidth: 0,
        doorPosition: 0,
        material: 'concrete',
      },
    ]);
    assert.deepEqual(projected.involved_layouts, [{ osm_id: 'b1' }]);
    assert.deepEqual(projected.crowd_zones, [{ id: 'crowd-1', headcount: 40 }]);
    assert.equal(projected.crowd_headcount, 40);
    assert.equal(projected.schema_version, 1);
    assert.equal(projectSceneForParticipant(null), null);
    for (const name of SCENE_AUTHORING_FIELDS) {
      assert.equal((PARTICIPANT_SCENE_FIELDS as readonly string[]).includes(name), false);
    }
  });

  test('v2 rows keep the runtime columns and get photos', () => {
    const photos = [{ id: 'photo-1' }, { id: 'photo-2' }];
    const v2 = projectSceneForParticipant({ ...sceneRow(), schema_version: 2 }, { photos });
    assert.deepEqual(v2?.photos, photos);
    assert.equal(v2?.schema_version, 2);
    assert.deepEqual(v2?.involved_layouts, [{ osm_id: 'b1' }]);

    const legacy = projectSceneForParticipant(sceneRow(), { photos });
    assert.equal(Object.hasOwn(legacy ?? {}, 'photos'), false);

    const { schema_version: _version, ...withoutVersion } = sceneRow();
    const unversioned = projectSceneForParticipant(withoutVersion, { photos });
    assert.equal(Object.hasOwn(unversioned ?? {}, 'photos'), false);

    const noOptions = projectSceneForParticipant({ ...sceneRow(), schema_version: 2 });
    assert.equal(Object.hasOwn(noOptions ?? {}, 'photos'), false);
  });

  test('casualty answer keys never reach a participant', () => {
    const conditions: Record<string, unknown> = {
      mobility: 'walks',
      breathing: 'normal',
      visible_description: 'a cut on the arm',
      injuries: ['laceration'],
      accessibility: 'open',
      player_triage_color: 'yellow',
    };
    for (const key of CASUALTY_ANSWER_KEYS) conditions[key] = 'answer';
    const row: Record<string, unknown> = {
      id: 'cas-1',
      session_id: 'session-1',
      conditions,
      spawn_condition: { at_minutes: 5 },
      parent_pin_id: 'pin-1',
      player_triage_color: 'yellow',
    };
    const snapshot = structuredClone(row);
    const projected = projectCasualtyForParticipant(row);
    assert.deepEqual(row, snapshot);
    assert.equal('spawn_condition' in projected, false);
    assert.equal('parent_pin_id' in projected, false);
    const projectedConditions = projected.conditions as Record<string, unknown>;
    for (const key of CASUALTY_ANSWER_KEYS) assert.equal(key in projectedConditions, false);
    assert.equal(projectedConditions.mobility, 'walks');
    assert.equal(projectedConditions.breathing, 'normal');
    assert.equal(projectedConditions.visible_description, 'a cut on the arm');
    assert.deepEqual(projectedConditions.injuries, ['laceration']);
    assert.equal(projectedConditions.accessibility, 'open');
    assert.equal(projectedConditions.player_triage_color, 'yellow');
    assert.equal(projected.player_triage_color, 'yellow');
  });

  test('who sees the answer key', () => {
    const owner = { id: 'trainer-1', role: 'trainer' };
    const admin = { id: 'admin-1', role: 'admin' };
    const otherTrainer = { id: 'trainer-2', role: 'trainer' };
    const participant = { id: 'player-1', role: 'participant' };
    const session = { trainer_id: 'trainer-1' };
    assert.equal(canSeeSessionAnswerKey(owner, session), true);
    assert.equal(canSeeSessionAnswerKey(admin, session), true);
    assert.equal(canSeeSessionAnswerKey(otherTrainer, session), false);
    assert.equal(canSeeSessionAnswerKey(participant, session), false);

    const scenario = { created_by: 'trainer-1' };
    assert.equal(canSeeScenarioAnswerKey(owner, scenario), true);
    assert.equal(canSeeScenarioAnswerKey(admin, scenario), true);
    assert.equal(canSeeScenarioAnswerKey(otherTrainer, scenario), false);
    assert.equal(canSeeScenarioAnswerKey(participant, scenario), false);
  });

  test('zones follow the answer-key audience', () => {
    const owner = { id: 'trainer-1', role: 'trainer' };
    const admin = { id: 'admin-1', role: 'admin' };
    const otherTrainer = { id: 'trainer-2', role: 'trainer' };
    const participant = { id: 'player-1', role: 'participant' };
    const session = { trainer_id: 'trainer-1' };
    assert.equal(canSeeSessionAnswerKey(owner, session), true);
    assert.equal(canSeeSessionAnswerKey(admin, session), true);
    assert.equal(canSeeSessionAnswerKey(otherTrainer, session), false);
    assert.equal(canSeeSessionAnswerKey(participant, session), false);
  });
});
