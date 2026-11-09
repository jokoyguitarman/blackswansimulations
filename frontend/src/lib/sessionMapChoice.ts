// frontend/src/lib/sessionMapChoice.ts. WS0. Pure; tested from frontend/tests/.

export type SessionMapAudience =
  | 'participant'
  | 'trainer'
  | 'spectator_staff'
  | 'spectator_participant';
export type TrainerMapMode = 'live' | 'scene';

export interface SessionMapChoice {
  view: 'live_map' | 'scene_preview';
  showSceneToggle: boolean;
  liveMap: { showAllPins: boolean; bypassExitGate: boolean; hidePrebuiltZones: boolean };
}

const STAFF_LIVE = { showAllPins: true, bypassExitGate: true, hidePrebuiltZones: true };
const PLAYER_LIVE = { showAllPins: false, bypassExitGate: false, hidePrebuiltZones: false };
const SPECTATOR_PLAYER_LIVE = {
  showAllPins: false,
  bypassExitGate: false,
  hidePrebuiltZones: true,
};

export function sessionMapAudience(input: {
  isSpectator: boolean;
  isStaff: boolean;
}): SessionMapAudience {
  if (input.isSpectator) return input.isStaff ? 'spectator_staff' : 'spectator_participant';
  return input.isStaff ? 'trainer' : 'participant';
}

export function chooseSessionMap(input: {
  audience: SessionMapAudience;
  hasSceneConfig: boolean | null;
  trainerMapMode: TrainerMapMode;
}): SessionMapChoice {
  if (input.audience === 'participant') {
    return { view: 'live_map', showSceneToggle: false, liveMap: PLAYER_LIVE };
  }
  if (input.audience === 'spectator_staff') {
    return { view: 'live_map', showSceneToggle: false, liveMap: STAFF_LIVE };
  }
  if (input.audience === 'spectator_participant') {
    return { view: 'live_map', showSceneToggle: false, liveMap: SPECTATOR_PLAYER_LIVE };
  }
  const showSceneToggle = input.hasSceneConfig === true;
  const view: SessionMapChoice['view'] =
    input.trainerMapMode === 'scene' && showSceneToggle ? 'scene_preview' : 'live_map';
  return { view, showSceneToggle, liveMap: STAFF_LIVE };
}
