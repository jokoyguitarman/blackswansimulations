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
import { FX } from './fx/fxConstants';
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
import type { HoodFanWhen } from './twoZone';
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
  /** The scene's kitchen hood-fan rule. Leave out for the engine default. */
  hoodFanWhen?: HoodFanWhen;
  /**
   * Wind at the openings. The same speed and direction the live engine is
   * given each frame. Leave out for still air.
   */
  wind?: { speedMs: number; directionRad: number };
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
  if (input.hoodFanWhen) engine.setHoodFanWhen(input.hoodFanWhen);
  if (input.wind) engine.setWind(input.wind.speedMs, input.wind.directionRad);
  syncIgnition(engine, input.objects, input.hazardZones, input.charge, input.building.levels);

  const t0 = blastEffectsTriggerSec(engine.timeScale);
  for (const ha of input.hazardAnalysis ?? []) {
    const events = (ha.events ?? []) as HazardEvent[];
    if (events.length > 0 || ha.hazardStates) {
      engine.registerHazard(
        ha.hazardId,
        shiftEvents(events, t0),
        ha.hazardStates ?? UNKNOWN_STATES,
      );
    }
  }

  // The live showcase registers the blast whether or not enrichment added events.
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
  const blastZone = blastIgnitionZone(blast.pos, blast.spreadRadius, blast.level);
  return { engine, t0, hazards: hazardsForEffects(input.hazardZones, blastZone) };
}

/**
 * Effects steps of the setup preview, seconds. The live run steps EFFECTS_DT
 * (0.1 s) throughout, about 10x the cost of the old 1 s preview. Measured on
 * the office fire against that live stepping:
 * - before the blast nothing changes, so whole seconds are exact;
 * - the step that reaches t0 fires the blast and integrates it over the whole
 *   step, so a 1 s step there put in a second of heavy smoke at once: peak
 *   ground-floor smoke at T+60 was 0.55 against 0.29 live. The step ending on
 *   t0 and the first PREVIEW_FINE_S after it are EFFECTS_DT, as live;
 * - after that, 0.5 s steps keep the peak at T+60 at 0.288 and every smoke
 *   total within 0.3% to T+300.
 * About twice the steps of the old preview and a fifth of live stepping.
 */
export const PREVIEW_FINE_S = 5;
export const PREVIEW_COARSE_DT = 0.5;
export const PREVIEW_PRE_BLAST_DT = 1;

/**
 * Steps to `seconds` after the blast. Every event, the blast at t0 and any
 * enrichment event in `eventTimes`, gets the same fine window: from the step
 * ending on it to PREVIEW_FINE_S after it.
 */
export function previewSteps(
  t0: number,
  seconds: number,
  eventTimes: readonly number[] = [],
): number[] {
  const end = t0 + Math.max(0, seconds);
  // A step that reaches an event fires it and then integrates it over the whole
  // step, so the step ending on an event must already be a fine one.
  const windows = [t0, ...eventTimes]
    .filter((e) => e >= t0 && e < end)
    .sort((a, b) => a - b)
    .map((e) => [Math.max(0, e - FX.EFFECTS_DT), Math.min(end, e + PREVIEW_FINE_S)]);
  const steps: number[] = [];
  let t = 0;
  const pushUntil = (until: number, dt: number) => {
    while (until - t > 1e-9) {
      const h = Math.min(dt, until - t);
      steps.push(h);
      t += h;
    }
  };
  for (const [from, to] of windows) {
    if (to <= t + 1e-9) continue;
    pushUntil(from, t < t0 - 1e-9 ? PREVIEW_PRE_BLAST_DT : PREVIEW_COARSE_DT);
    pushUntil(to, FX.EFFECTS_DT);
  }
  pushUntil(end, PREVIEW_COARSE_DT);
  return steps;
}

/** Trigger times of every hazard event the engine has registered. */
function eventTimesOf(engine: SpatialEffectsEngine): number[] {
  return [...engine.hazardStates.values()].flatMap((h) => h.events.map((e) => e.triggerTimeSec));
}

/** Build the preview engine and run it to `seconds` after the blast. */
export function runEffectsPreview(
  input: PreviewInput,
  seconds: number,
  walls: InteriorWall[],
): SpatialEffectsEngine {
  const { engine, t0, hazards } = buildPreviewEngine(input);
  for (const dt of previewSteps(t0, seconds, eventTimesOf(engine))) {
    engine.step(dt, walls, hazards);
  }
  return engine;
}

/**
 * runEffectsPreview in slices of about `sliceMs`, yielding to the browser
 * between them so the page stays responsive. Resolves null if `signal` aborts.
 */
export async function runEffectsPreviewAsync(
  input: PreviewInput,
  seconds: number,
  walls: InteriorWall[],
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal; sliceMs?: number } = {},
): Promise<SpatialEffectsEngine | null> {
  const { engine, t0, hazards } = buildPreviewEngine(input);
  const steps = previewSteps(t0, seconds, eventTimesOf(engine));
  const sliceMs = opts.sliceMs ?? 40;
  let i = 0;
  while (i < steps.length) {
    if (opts.signal?.aborted) return null;
    const start = performance.now();
    while (i < steps.length && performance.now() - start < sliceMs) {
      engine.step(steps[i], walls, hazards);
      i++;
    }
    opts.onProgress?.(i / steps.length);
    if (i < steps.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return opts.signal?.aborted ? null : engine;
}
