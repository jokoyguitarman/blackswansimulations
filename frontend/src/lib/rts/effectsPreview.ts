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
 * Effects seconds between rollback points while stepping coarsely. A copy
 * costs a few steps, and a rollback replays at most this much.
 */
export const PREVIEW_CHECKPOINT_S = 10;

interface FineWindow {
  from: number;
  to: number;
}

interface ClockState {
  t: number;
  windows: FineWindow[];
  index: number;
  inWindow: boolean;
  until: number;
  dt: number;
  tail: boolean;
}

/**
 * The preview's step schedule, one step at a time, so a fine window can be
 * added while it runs. Every event gets the same fine window: from the step
 * ending on it to PREVIEW_FINE_S after it. Between windows the steps are
 * whole seconds before the blast and PREVIEW_COARSE_DT after it.
 */
class PreviewClock {
  private readonly t0: number;
  private readonly end: number;
  private s: ClockState;
  private replay: number[] = [];
  private pending: FineWindow | null = null;

  constructor(t0: number, end: number, eventTimes: readonly number[]) {
    this.t0 = t0;
    this.end = end;
    // A step that reaches an event fires it and then integrates it over the
    // whole step, so the step ending on an event must already be a fine one.
    const windows = [t0, ...eventTimes]
      .filter((e) => e >= t0 && e < end)
      .sort((a, b) => a - b)
      .map((e) => ({
        from: Math.max(0, e - FX.EFFECTS_DT),
        to: Math.min(end, e + PREVIEW_FINE_S),
      }));
    this.s = { t: 0, windows, index: 0, inWindow: false, until: 0, dt: 0, tail: false };
  }

  get t(): number {
    return this.s.t;
  }

  /** True while the steps before a rollback point are being taken again. */
  get replaying(): boolean {
    return this.replay.length > 0;
  }

  /** The next step, or 0 when the run has reached the end. */
  next(): number {
    if (this.replay.length > 0) return this.replay[0] ?? 0;
    const s = this.s;
    for (;;) {
      if (s.until - s.t > 1e-9) return Math.min(s.dt, s.until - s.t);
      const w = s.windows[s.index];
      if (w) {
        if (!s.inWindow) {
          if (w.to <= s.t + 1e-9) {
            s.index += 1;
            continue;
          }
          s.inWindow = true;
          s.until = w.from;
          s.dt = s.t < this.t0 - 1e-9 ? PREVIEW_PRE_BLAST_DT : PREVIEW_COARSE_DT;
          continue;
        }
        if (s.until !== w.to || s.dt !== FX.EFFECTS_DT) {
          s.until = w.to;
          s.dt = FX.EFFECTS_DT;
          continue;
        }
        s.index += 1;
        s.inWindow = false;
        continue;
      }
      if (!s.tail) {
        s.tail = true;
        s.until = this.end;
        s.dt = PREVIEW_COARSE_DT;
        continue;
      }
      return 0;
    }
  }

  advance(h: number): void {
    if (this.replay.length > 0) {
      this.replay.shift();
      this.s.t += h;
      if (this.replay.length === 0 && this.pending) {
        const w = this.pending;
        this.pending = null;
        this.addWindow(w.from, w.to);
      }
      return;
    }
    this.s.t += h;
  }

  /**
   * A fine window from `from`, which must not be after the current time.
   * Inside a fine window it extends that window. Otherwise it starts now.
   */
  addWindow(from: number, to: number): void {
    const s = this.s;
    const end = Math.min(this.end, to);
    const current = s.windows[s.index];
    if (current && s.inWindow && s.dt === FX.EFFECTS_DT && from <= current.to + 1e-9) {
      if (end > current.to) current.to = end;
      s.until = current.to;
      return;
    }
    s.windows.splice(s.index, 0, { from: Math.min(from, s.t), to: end });
    s.inWindow = false;
    s.until = s.t;
    s.tail = false;
  }

  save(): ClockState {
    return { ...this.s, windows: this.s.windows.map((w) => ({ ...w })) };
  }

  /**
   * Back to `state`, then the exact steps of `steps`, then a fine window
   * from where they end. The replay reaches that point on the same sums.
   */
  rewind(state: ClockState, steps: readonly number[], window: FineWindow): void {
    this.s = { ...state, windows: state.windows.map((w) => ({ ...w })) };
    this.replay = [...steps];
    this.pending = window;
    if (this.replay.length === 0) {
      this.pending = null;
      this.addWindow(window.from, window.to);
    }
  }
}

/**
 * Steps to `seconds` after the blast when nothing starts on its own: every
 * event, the blast at t0 and any enrichment event in `eventTimes`, gets the
 * same fine window, from the step ending on it to PREVIEW_FINE_S after it.
 */
export function previewSteps(
  t0: number,
  seconds: number,
  eventTimes: readonly number[] = [],
): number[] {
  const clock = new PreviewClock(t0, t0 + Math.max(0, seconds), eventTimes);
  const steps: number[] = [];
  for (let h = clock.next(); h > 0; h = clock.next()) {
    steps.push(h);
    clock.advance(h);
  }
  return steps;
}

/** Trigger times of every hazard event the engine has registered. */
function eventTimesOf(engine: SpatialEffectsEngine): number[] {
  return [...engine.hazardStates.values()].flatMap((h) => h.events.map((e) => e.triggerTimeSec));
}

/**
 * The setup preview, one step at a time. Registered events get their fine
 * windows up front. An event the engine makes itself, a cell catching fire
 * or a jet lighting (see `SpatialEffectsEngine.onsets`), is only seen after
 * the step that made it. If that step was coarse, the run goes back to the
 * last checkpoint, replays the same steps to the start of that step, and
 * takes it again in fine steps, so it gets the same window as a registered
 * event.
 */
export class PreviewRun {
  engine: SpatialEffectsEngine;
  readonly t0: number;
  readonly hazards: HazardZone[];
  private readonly clock: PreviewClock;
  private readonly end: number;
  private readonly keep: object[];
  private readonly walls: InteriorWall[];
  private onsetsSeen: number;
  private checkpoint: {
    engine: SpatialEffectsEngine;
    clock: ClockState;
    onsets: number;
    taken: number;
  } | null = null;
  /** Steps behind the current engine, from the start. A rollback cuts it back. */
  private taken: number[] = [];
  private sinceCheckpoint: number[] = [];
  private reached = 0;
  /** Steps taken, rollbacks included. */
  steps = 0;
  rollbacks = 0;

  constructor(input: PreviewInput, seconds: number, walls: InteriorWall[]) {
    const built = buildPreviewEngine(input);
    this.walls = walls;
    this.engine = built.engine;
    this.t0 = built.t0;
    this.hazards = built.hazards;
    this.end = built.t0 + Math.max(0, seconds);
    this.clock = new PreviewClock(built.t0, this.end, eventTimesOf(built.engine));
    this.onsetsSeen = built.engine.onsets();
    this.keep = [walls, ...walls, this.hazards, ...this.hazards];
  }

  get done(): boolean {
    return !(this.clock.next() > 0);
  }

  /** Share of the effects time reached, 0 to 1. A rollback does not lower it. */
  get progress(): number {
    return this.end > 0 ? Math.min(1, this.reached / this.end) : 1;
  }

  /** The steps the current engine has taken, in order. */
  schedule(): number[] {
    return [...this.taken];
  }

  /** One engine step. Returns false once the run is done. */
  advance(): boolean {
    const h = this.clock.next();
    if (!(h > 0)) return false;
    if (this.clock.replaying) {
      // The same steps from the same state: nothing new can start here.
      this.engine.step(h, this.walls, this.hazards);
      this.clock.advance(h);
      this.taken.push(h);
      this.steps += 1;
      this.onsetsSeen = this.engine.onsets();
      return true;
    }
    const coarse = h > FX.EFFECTS_DT + 1e-9;
    if (!coarse) {
      this.checkpoint = null;
    } else if (
      !this.checkpoint ||
      this.clock.t - this.checkpoint.clock.t >= PREVIEW_CHECKPOINT_S - 1e-9
    ) {
      this.checkpoint = {
        engine: this.engine.snapshot(this.keep),
        clock: this.clock.save(),
        onsets: this.onsetsSeen,
        taken: this.taken.length,
      };
      this.sinceCheckpoint = [];
    }
    const start = this.clock.t;
    this.engine.step(h, this.walls, this.hazards);
    this.clock.advance(h);
    this.taken.push(h);
    this.steps += 1;
    if (coarse) this.sinceCheckpoint.push(h);
    if (this.clock.t > this.reached) this.reached = this.clock.t;
    const onsets = this.engine.onsets();
    if (onsets === this.onsetsSeen) return true;
    this.onsetsSeen = onsets;
    const cp = this.checkpoint;
    if (!coarse || !cp) {
      this.clock.addWindow(this.clock.t - FX.EFFECTS_DT, this.clock.t + PREVIEW_FINE_S);
      return true;
    }
    this.engine = cp.engine;
    this.onsetsSeen = cp.onsets;
    this.taken.length = cp.taken;
    this.checkpoint = null;
    this.rollbacks += 1;
    this.clock.rewind(cp.clock, this.sinceCheckpoint.slice(0, -1), {
      from: start,
      to: start + PREVIEW_FINE_S,
    });
    this.sinceCheckpoint = [];
    return true;
  }
}

/** Build the preview engine and run it to `seconds` after the blast. */
export function runEffectsPreview(
  input: PreviewInput,
  seconds: number,
  walls: InteriorWall[],
): SpatialEffectsEngine {
  const run = new PreviewRun(input, seconds, walls);
  while (run.advance());
  return run.engine;
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
  const run = new PreviewRun(input, seconds, walls);
  const sliceMs = opts.sliceMs ?? 40;
  while (!run.done) {
    if (opts.signal?.aborted) return null;
    const start = performance.now();
    while (performance.now() - start < sliceMs && run.advance());
    opts.onProgress?.(run.done ? 1 : run.progress);
    if (!run.done) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return opts.signal?.aborted ? null : run.engine;
}
