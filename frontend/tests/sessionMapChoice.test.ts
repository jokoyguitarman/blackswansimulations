import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chooseSessionMap, sessionMapAudience } from '../src/lib/sessionMapChoice';

const staffLive = { showAllPins: true, bypassExitGate: true, hidePrebuiltZones: true };
const playerLive = { showAllPins: false, bypassExitGate: false, hidePrebuiltZones: false };

describe('session map choice', () => {
  test('participants always get the live map', () => {
    for (const hasSceneConfig of [true, false, null]) {
      assert.deepEqual(
        chooseSessionMap({
          audience: 'participant',
          hasSceneConfig,
          trainerMapMode: 'scene',
        }),
        { view: 'live_map', showSceneToggle: false, liveMap: playerLive },
      );
    }
  });

  test('the trainer defaults to the live map and may preview the scene', () => {
    assert.deepEqual(
      chooseSessionMap({ audience: 'trainer', hasSceneConfig: true, trainerMapMode: 'live' }),
      { view: 'live_map', showSceneToggle: true, liveMap: staffLive },
    );
    assert.deepEqual(
      chooseSessionMap({ audience: 'trainer', hasSceneConfig: true, trainerMapMode: 'scene' }),
      { view: 'scene_preview', showSceneToggle: true, liveMap: staffLive },
    );
    assert.deepEqual(
      chooseSessionMap({ audience: 'trainer', hasSceneConfig: false, trainerMapMode: 'scene' }),
      { view: 'live_map', showSceneToggle: false, liveMap: staffLive },
    );
    assert.deepEqual(
      chooseSessionMap({ audience: 'trainer', hasSceneConfig: null, trainerMapMode: 'scene' }),
      { view: 'live_map', showSceneToggle: false, liveMap: staffLive },
    );
  });

  test('spectator props follow the role', () => {
    const staff = chooseSessionMap({
      audience: 'spectator_staff',
      hasSceneConfig: true,
      trainerMapMode: 'scene',
    });
    assert.equal(staff.view, 'live_map');
    assert.equal(staff.showSceneToggle, false);
    assert.equal(staff.liveMap.showAllPins, true);
    assert.equal(staff.liveMap.bypassExitGate, true);

    const player = chooseSessionMap({
      audience: 'spectator_participant',
      hasSceneConfig: true,
      trainerMapMode: 'scene',
    });
    assert.equal(player.view, 'live_map');
    assert.equal(player.showSceneToggle, false);
    assert.equal(player.liveMap.showAllPins, false);
    assert.equal(player.liveMap.bypassExitGate, false);
    assert.equal(player.liveMap.hidePrebuiltZones, true);
  });

  test('sessionMapAudience for the four combinations', () => {
    assert.equal(sessionMapAudience({ isSpectator: false, isStaff: false }), 'participant');
    assert.equal(sessionMapAudience({ isSpectator: false, isStaff: true }), 'trainer');
    assert.equal(sessionMapAudience({ isSpectator: true, isStaff: true }), 'spectator_staff');
    assert.equal(
      sessionMapAudience({ isSpectator: true, isStaff: false }),
      'spectator_participant',
    );
  });
});
