/**
 * The setup preview's effects engine: the RTS page's "Preview Hazard Effects"
 * button builds it here, and the tests build the same one. It is wired like
 * the live showcase engine: the building, fuel, charge and ignition sources,
 * enrichment events and the blast all shifted to the blast time t0, and the
 * blast's heavy-smoke source on the storey it went off on.
 */
import type { Vec2 } from '../evacuation/types';
import { blastEffectsTriggerSec, shiftEvents } from '../evacuation/showcase';
import type { ChargeSpec } from './blast/blastModel';
import { attachBuilding, type EffectsBuilding } from './effectsBuilding';
import type { FireParams } from './fireSimulation';
import {
  confirmedElectricalSources,
  confirmedFuelCells,
  confirmedGasLines,
  confirmedSuppression,
  type PlacedObject,
} from './materialLibrary';
import {
  SpatialEffectsEngine,
  blastSmokeStudIds,
  type HazardEvent,
  type HazardStateProgression,
} from './spatialEffects';
import type { HazardZone, InteriorWall } from './types';

/** Effects-only ignition marker. Kept off the renderer: it has no trainer-facing zone. */
export function blastIgnitionZone(pos: Vec2, radius: number, level?: string): HazardZone {
  return {
    id: 'blast-direct',
    pos,
    radius,
    hazardType: 'ignitable',
    severity: 'high',
    label: 'Blast',
    description: 'Direct blast ignition',
    photos: [],
    ...(level ? { level } : {}),
  };
}

export function hazardsForEffects(zones: HazardZone[], blast: HazardZone | null): HazardZone[] {
  const rest = zones.filter((z) => z.id !== 'blast-direct');
  return blast ? [...rest, blast] : rest;
}

/** Charge, gas lines, arcs, and suppression heads. Called every effects step. */
export function syncIgnition(
  engine: SpatialEffectsEngine,
  objects: readonly PlacedObject[],
  zones: readonly HazardZone[],
  charge: ChargeSpec,
  levels: readonly { id: string; heightM?: number }[],
) {
  engine.setBlastCharge(charge);
  engine.setGasLines(confirmedGasLines(objects));
  engine.setElectricalSources(confirmedElectricalSources(objects, zones));
  const ceilings: Record<string, number> = {};
  for (const level of levels) {
    if (typeof level.heightM === 'number' && level.heightM > 0) ceilings[level.id] = level.heightM;
  }
  engine.setSuppression(confirmedSuppression(objects, ceilings));
}

export interface PreviewStud {
  id: string;
  simPos: Vec2;
  spatialContext: 'inside_building' | 'road' | 'open_air' | null;
  level: string;
}

export interface PreviewHazardAnalysis {
  hazardId: string;
  events?: unknown[];
  hazardStates?: HazardStateProgression;
}

export interface PreviewInput {
  studs: readonly PreviewStud[];
  fireParams?: FireParams;
  building: EffectsBuilding;
  objects: readonly PlacedObject[];
  hazardZones: HazardZone[];
  charge: ChargeSpec;
  blast: {
    pos: Vec2;
    /** Storey the blast is on. Leave out on a one-storey building. */
    level?: string;
    /** Ignition radius. */
    spreadRadius: number;
    /** Heavy-smoke radius. */
    affectRadius: number;
  };
  hazardAnalysis?: readonly PreviewHazardAnalysis[];
}

export interface PreviewEngine {
  engine: SpatialEffectsEngine;
  /** Effects time of the blast. A preview runs to t0 plus the preview time. */
  t0: number;
  hazards: HazardZone[];
}

const UNKNOWN_STATES: HazardStateProgression = {
  initial: 'Unknown',
  triggered: 'Unknown',
  worsening: 'Unknown',
  critical: 'Unknown',
};

export function buildPreviewEngine(input: PreviewInput): PreviewEngine {
  const { studs, blast } = input;
  const engine = new SpatialEffectsEngine(input.fireParams);
  engine.init(studs.map((s) => ({ ...s })));
  const fuelCells = confirmedFuelCells(input.objects, studs);
  engine.setFuelCells(fuelCells);
  attachBuilding(engine, input.building);
  syncIgnition(engine, input.objects, input.hazardZones, input.charge, input.building.levels);

  const t0 = blastEffectsTriggerSec(engine.timeScale);
  let hasEvents = false;
  for (const ha of input.hazardAnalysis ?? []) {
    const events = (ha.events ?? []) as HazardEvent[];
    if (events.length > 0) hasEvents = true;
    if (events.length > 0 || ha.hazardStates) {
      engine.registerHazard(
        ha.hazardId,
        shiftEvents(events, t0),
        ha.hazardStates ?? UNKNOWN_STATES,
      );
    }
  }

  let blastZone: HazardZone | null = null;
  if (!hasEvents) {
    const affectedStuds = blastSmokeStudIds(
      studs
        .filter(
          (s) =>
            (blast.level == null || s.level === blast.level) &&
            Math.hypot(s.simPos.x - blast.pos.x, s.simPos.y - blast.pos.y) <= blast.affectRadius,
        )
        .map((s) => s.id),
      new Set(fuelCells.keys()),
    );
    engine.registerHazard(
      'blast-direct',
      [
        {
          triggerTimeSec: t0,
          eventType: 'explode',
          spreadType: 'fire',
          spreadRadius: blast.spreadRadius,
          spreadRate: 10,
          description: 'Direct blast ignition',
          severity: 'critical',
          smokeGeneration: 'heavy',
          affectedStuds,
        },
      ],
      {
        initial: 'Pre-detonation',
        triggered: 'Blast wave',
        worsening: 'Fire spreading',
        critical: 'Engulfed',
      },
    );
    blastZone = blastIgnitionZone(blast.pos, blast.spreadRadius, blast.level);
  }
  return { engine, t0, hazards: hazardsForEffects(input.hazardZones, blastZone) };
}

/** Build the preview engine and run it to `seconds` after the blast. */
export function runEffectsPreview(
  input: PreviewInput,
  seconds: number,
  walls: InteriorWall[],
): SpatialEffectsEngine {
  const { engine, t0, hazards } = buildPreviewEngine(input);
  engine.runPreview(t0 + seconds, walls, hazards);
  return engine;
}
