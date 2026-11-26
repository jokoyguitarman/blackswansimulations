/**
 * Headless smoke corridor test block, effects only. The studs, walls, fuel
 * and blast ignition are built the way the debug page's showcase loader
 * builds them, in the editor frame. The effects step at the page's fixed
 * 0.1 s. There is no crowd, so no leaf moves.
 */
import { defaultCharge } from '../../src/lib/rts/blast/blastModel.ts';
import { blastEffectsTriggerSec } from '../../src/lib/evacuation/showcase.ts';
import { FX } from '../../src/lib/rts/fx/fxConstants.ts';
import { DEFAULT_FIRE_PARAMS } from '../../src/lib/rts/fireSimulation.ts';
import { confirmedFuelCells } from '../../src/lib/rts/materialLibrary.ts';
import { generateSceneStuds, projectSceneStuds } from '../../src/lib/rts/sceneStuds.ts';
import {
  blastSmokeStudIds,
  SpatialEffectsEngine,
  type HazardEvent,
} from '../../src/lib/rts/spatialEffects.ts';
import {
  smokeCorridorFuelObjects,
  smokeCorridorRoomAt,
  smokeCorridorSample,
  smokeCorridorToPlan,
} from '../../src/lib/rts/smokeCorridorTest.ts';
import type { ExitDef, Vec2 } from '../../src/lib/evacuation/types.ts';
import { effectsView } from './effectsView.ts';
import type { HazardZone, InteriorWall } from '../../src/lib/rts/types.ts';

export interface RoomSample {
  /** Mean stud smoke, 0–1, the value the page's stud tint reads. */
  smoke: number;
  /** Upper-layer soot extinction, 1/m. 0 before the room forms a layer. */
  layerK: number;
  /** Interface height, metres. The ceiling when there is no layer. */
  interfaceM: number;
  burning: number;
}

export interface SmokeCorridorRun {
  /** Room id → stud ids. */
  rooms: Map<string, string[]>;
  /** Engine compartment id → plan room ids its studs fall in. */
  compartments: Map<string, Set<string>>;
  fuelStudIds: Set<string>;
  /** One row per sample time. */
  samples: Array<{ tSec: number; rooms: Record<string, RoomSample> }>;
  /** Room id → every stud that ever burned. */
  everBurned: Map<string, Set<string>>;
  ignitionSec: number;
}

/** `untilSec` 0 builds the scene and reads the compartments without stepping. */
export function runSmokeCorridor(untilSec: number, sampleEverySec = 10): SmokeCorridorRun {
  const scene = smokeCorridorSample.scene;
  const polygon = scene.buildingPolygon.map((pair) => [pair[0], pair[1]] as [number, number]);
  const studs = projectSceneStuds(polygon, generateSceneStuds(polygon, 0, ['G'])).map((stud) => ({
    id: stud.id,
    simPos: stud.simPos,
    spatialContext: stud.spatialContext,
    level: 'G',
  }));
  const verts: Vec2[] = polygon.map(([lat, lng]) => {
    const [p] = projectSceneStuds(polygon, [{ lat, lng }]);
    return p.simPos;
  });
  const walls: InteriorWall[] = scene.interiorWalls.map((wall) => ({ ...wall }));
  const exits = scene.exits as unknown as ExitDef[];
  const fuelObjects = smokeCorridorFuelObjects(studs, 'editor');
  const fuelCells = confirmedFuelCells(fuelObjects, studs);
  const fuelStudIds = new Set(fuelCells.keys());

  const engine = new SpatialEffectsEngine(DEFAULT_FIRE_PARAMS);
  engine.init(studs);
  engine.setStoreyHeights({ G: scene.levels[0].heightM });
  engine.setBuildingEnvelope(verts, exits);
  engine.setFuelCells(fuelCells);
  engine.setBlastCharge(defaultCharge());
  engine.setHoodFanWhen(scene.hoodFanWhen);

  const site = { x: scene.blastSite.x, y: scene.blastSite.y };
  const radius = scene.blastSite.manualRadiusM;
  const ignitionSec = blastEffectsTriggerSec(engine.timeScale);
  const event: HazardEvent = {
    triggerTimeSec: ignitionSec,
    eventType: 'explode',
    spreadType: 'fire',
    spreadRadius: radius,
    spreadRate: 10,
    description: 'Direct blast ignition',
    severity: 'critical',
    smokeGeneration: 'heavy',
    affectedStuds: blastSmokeStudIds(
      studs
        .filter((s) => Math.hypot(s.simPos.x - site.x, s.simPos.y - site.y) <= radius)
        .map((s) => s.id),
      fuelStudIds,
    ),
  };
  engine.registerHazard('blast-direct', [event], {
    initial: 'Pre-detonation',
    triggered: 'Blast wave',
    worsening: 'Fire spreading',
    critical: 'Engulfed',
  });
  const hazards: HazardZone[] = [
    {
      id: 'blast-direct',
      pos: site,
      radius,
      hazardType: 'ignitable',
      severity: 'high',
      label: 'Blast',
      description: 'Direct blast ignition',
      photos: [],
      level: 'G',
    },
  ];

  const rooms = new Map<string, string[]>();
  const roomOfStud = new Map<string, string>();
  for (const stud of studs) {
    if (stud.spatialContext !== 'inside_building') continue;
    const room = smokeCorridorRoomAt(smokeCorridorToPlan(stud.simPos, 'editor'));
    if (!room) continue;
    roomOfStud.set(stud.id, room);
    const list = rooms.get(room) ?? [];
    list.push(stud.id);
    rooms.set(room, list);
  }
  const compartments = new Map<string, Set<string>>();
  const fireSim = effectsView(engine).fireSim as unknown as {
    compartmentIds(walls: InteriorWall[]): Map<string, string>;
  };
  for (const [studId, comp] of fireSim.compartmentIds(walls)) {
    const room = roomOfStud.get(studId);
    if (!room) continue;
    const set = compartments.get(comp) ?? new Set<string>();
    set.add(room);
    compartments.set(comp, set);
  }

  const everBurned = new Map<string, Set<string>>();
  const samples: SmokeCorridorRun['samples'] = [];
  const steps = Math.round(untilSec / FX.EFFECTS_DT);
  const every = Math.round(sampleEverySec / FX.EFFECTS_DT);
  for (let i = 1; i <= steps; i++) {
    engine.step(FX.EFFECTS_DT, walls, hazards);
    for (const [id, state] of engine.studStates) {
      if (state.fire.state !== 'burning') continue;
      const room = roomOfStud.get(id) ?? 'outside';
      const set = everBurned.get(room) ?? new Set<string>();
      set.add(id);
      everBurned.set(room, set);
    }
    if (i % every !== 0) continue;
    const layerByStud = new Map<string, { k: number; interfaceM: number }>();
    for (const layer of engine.smokeLayers()) {
      for (const id of layer.members) {
        layerByStud.set(id, { k: layer.extinctionK, interfaceM: layer.interfaceM });
      }
    }
    const row: Record<string, RoomSample> = {};
    for (const [room, ids] of rooms) {
      let smoke = 0;
      let burning = 0;
      for (const id of ids) {
        const state = engine.studStates.get(id);
        smoke += state?.smoke ?? 0;
        if (state?.fire.state === 'burning') burning += 1;
      }
      const layer = layerByStud.get(ids[0]);
      row[room] = {
        smoke: smoke / ids.length,
        layerK: layer?.k ?? 0,
        interfaceM: layer?.interfaceM ?? scene.levels[0].heightM,
        burning,
      };
    }
    samples.push({ tSec: Math.round(i * FX.EFFECTS_DT), rooms: row });
  }
  return { rooms, compartments, fuelStudIds, samples, everBurned, ignitionSec };
}
