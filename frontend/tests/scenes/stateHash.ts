import type { PolygonEvacuationEngine } from '../../src/lib/evacuation/engine.ts';
import type { SpatialEffectsEngine } from '../../src/lib/rts/spatialEffects.ts';
import { effectsView } from './effectsView.ts';

/**
 * Every stud and every layer, unrounded. The per-PR check hashes this once
 * smoke exists. A rounded summary of the same moment is still all zeros.
 */
export function effectsState(effects: SpatialEffectsEngine) {
  const view = effectsView(effects);
  const sootK = (effects as unknown as { sootK: Map<string, number> }).sootK;
  const studs = [...effects.studStates.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, state]) => ({
      id,
      fire: state.fire.state,
      timer: state.fire.timer,
      fuel: state.fire.fuelFactor,
      approach: state.fire.approach ?? null,
      dose: state.fire.dose ?? null,
      output: state.fire.output ?? null,
      smoke: state.smoke,
      soot: sootK.get(id) ?? 0,
      fumes: state.fumes ?? null,
      gas: state.gas,
      flood: state.flood,
      structural: state.structural,
      wet: state.wet === true,
      oxygen: state.oxygenVolumePercent ?? null,
      co2: state.co2VolumePercent ?? null,
    }));
  const layers = [...view.layerState.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, live]) => {
      const zone = live.zone as typeof live.zone & { ageS?: number };
      return {
        id,
        active: live.active,
        members: [...live.members].sort(),
        interfaceM: zone.interfaceM,
        upperK: zone.upperK,
        sootG: zone.sootG,
        lowerO2: zone.lowerO2 ?? null,
        upperO2: zone.upperO2 ?? null,
        ageS: zone.ageS ?? null,
      };
    });
  return { studs, layers };
}

interface CrowdBody {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  __ped: {
    pedId: number;
    state?: string;
    posture?: string;
    injury?: string;
    evacuated: boolean;
    targetExitId: string;
    fed?: number;
    fec?: number;
    fumeDown?: boolean;
    familiarity?: string;
  };
}

/** Positions and states of the seeded crowd, in pedestrian id order. */
export function crowdState(evac: PolygonEvacuationEngine) {
  const bodies = (evac as unknown as { pedestrians: CrowdBody[] }).pedestrians;
  return bodies
    .map((body) => ({
      id: body.__ped.pedId,
      x: body.position.x,
      y: body.position.y,
      vx: body.velocity.x,
      vy: body.velocity.y,
      state: body.__ped.state ?? null,
      posture: body.__ped.posture ?? null,
      injury: body.__ped.injury ?? null,
      evacuated: body.__ped.evacuated,
      exit: body.__ped.targetExitId,
      fed: body.__ped.fed ?? null,
      fec: body.__ped.fec ?? null,
      fumeDown: body.__ped.fumeDown === true,
      familiarity: body.__ped.familiarity ?? null,
    }))
    .sort((a, b) => a.id - b.id);
}
