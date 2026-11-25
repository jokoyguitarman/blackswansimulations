import type { FuelCell } from '../../src/lib/rts/flameFront.ts';
import type { SpatialEffectsEngine } from '../../src/lib/rts/spatialEffects.ts';
import type { Enclosure } from '../../src/lib/rts/twoZone.ts';

/** Burn metadata the review read off the private fire sim. */
export interface BurnMeta {
  age: number;
}

export interface FireSimView {
  ignite(ids: string[]): void;
  fuelReleaseKw(id: string): number | null;
  burnFraction(id: string): number;
  burnPhi(id: string): number;
  flashedStuds: Set<string>;
  states: Map<string, { state: string }>;
  burningCell(id: string): FuelCell;
  burn: Map<string, BurnMeta>;
  rooms: Map<string, string[]>;
}

export interface LayerLive {
  active: boolean;
  members: string[];
  zone: {
    interfaceM: number;
    upperK: number;
    upperO2?: number;
    lowerO2?: number;
    sootG: number;
  };
}

/** The review harness read these private fields. They are not part of the engine API. */
export function effectsView(engine: SpatialEffectsEngine): {
  fireSim: FireSimView;
  layerState: Map<string, LayerLive>;
  layerEnclosures: Map<string, Enclosure | null>;
} {
  return engine as unknown as {
    fireSim: FireSimView;
    layerState: Map<string, LayerLive>;
    layerEnclosures: Map<string, Enclosure | null>;
  };
}
