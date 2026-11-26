/**
 * Holland Village bomb session, offline.
 *
 * The footprint is the saved way/152752628 ring. The stall counts are the NEA
 * sentence the layout tests already use (21 cooked, 48 market). Nothing is
 * fetched. The step loop matches the review session: crowd at 1/60 s, effects
 * in 0.1 s slices, blast at one minute, setters applied on every frame.
 */
import { projectPolygon } from '../../src/lib/evacuation/geometry.ts';
import { PolygonEvacuationEngine } from '../../src/lib/evacuation/engine.ts';
import { DEFAULT_POLYGON_CONFIG } from '../../src/lib/evacuation/types.ts';
import { HazardField } from '../../src/lib/evacuation/hazardSensing.ts';
import { blastEffectsTriggerSec } from '../../src/lib/evacuation/showcase.ts';
import { SHOWCASE } from '../../src/lib/evacuation/showcaseConstants.ts';
import { FX } from '../../src/lib/rts/fx/fxConstants.ts';
import { createAccumulator, stepEffectsFixed } from '../../src/lib/rts/fx/simClock.ts';
import { SpatialEffectsEngine, blastSmokeStudIds } from '../../src/lib/rts/spatialEffects.ts';
import { DEFAULT_FIRE_PARAMS } from '../../src/lib/rts/fireSimulation.ts';
import {
  confirmedElectricalSources,
  confirmedFuelCells,
  confirmedGasLines,
  confirmedSuppression,
  snapObjectsToStuds,
} from '../../src/lib/rts/materialLibrary.ts';
import { HOLLAND_BOMB, layoutHawkerCentre } from '../../src/lib/rts/hawkerLayout.ts';
import { defaultCharge } from '../../src/lib/rts/blast/blastModel.ts';
import { generateSceneStuds, projectSceneStuds } from '../../src/lib/rts/sceneStuds.ts';
import { extractHawkerFacts } from '../../../shared/hawkerFacts.ts';
import type { HazardZone } from '../../src/lib/rts/types.ts';

/** Open ring of OSM way/152752628, the same nodes the lookup test freezes. */
const HOLLAND_RING: [number, number][] = [
  [1.3109098, 103.794894],
  [1.3108498, 103.7947684],
  [1.3109805, 103.7947079],
  [1.3111669, 103.7946216],
  [1.3111884, 103.7946664],
  [1.3112402, 103.7947744],
  [1.3112871, 103.7948339],
  [1.3113087, 103.7949064],
  [1.3113019, 103.7949818],
  [1.3112678, 103.7950494],
  [1.3112112, 103.7950996],
  [1.31114, 103.7951254],
  [1.3110644, 103.795123],
  [1.3109949, 103.7950929],
  [1.3109416, 103.7950392],
  [1.3109118, 103.7949696],
];

const BUILDING = 'Holland Village Market and Food Centre';

function hollandFacts() {
  return extractHawkerFacts(
    [
      {
        url: 'https://example.test/centre',
        title: 'Centre page',
        text: `${BUILDING}. Comprises 21 cooked food stalls and 48 market stalls. National Environment Agency.`,
      },
      {
        url: 'https://example.test/stalls',
        title: 'Stall notes',
        text: 'Holland Village Market. Notes 01-33 and 01-37. Cooked food stalls are about 10.75 m².',
      },
    ],
    BUILDING,
  );
}

export interface HollandMark {
  tSec: number;
  states: Record<string, number>;
  out: number;
  lethal: number;
  serious: number;
  minor: number;
  crawling: number;
  fumeDown: number;
  heatDown: number;
  burning: number;
  smoky: number;
  jets: number;
  sprays: number;
  arcs: number;
}

export interface HollandResult {
  bomb: { x: number; y: number };
  walls: number;
  exits: number;
  fuelStuds: number;
  marks: HollandMark[];
}

interface CrowdBody {
  __ped: { state?: string };
}

export function runHolland(): HollandResult {
  const verts = projectPolygon(HOLLAND_RING);
  const projected = projectSceneStuds(HOLLAND_RING, generateSceneStuds(HOLLAND_RING, 0, ['G']));
  const indoor = projected
    .filter((stud) => stud.spatialContext === 'inside_building' && stud.floor === 'G')
    .map((stud) => ({ id: stud.id, x: stud.simPos.x, y: stud.simPos.y }));
  const layout = layoutHawkerCentre({ verts, studs: indoor, facts: hollandFacts() });
  if (!layout.bomb) throw new Error('Holland layout has no bomb');
  const objects = snapObjectsToStuds(
    layout.objects,
    projected.map((stud) => ({ id: stud.id, simPos: stud.simPos, level: 'G' })),
  );
  const fireStuds = projected.map((stud) => ({
    id: stud.id,
    simPos: stud.simPos,
    spatialContext: stud.spatialContext,
    level: 'G',
  }));
  const site = layout.bomb;
  const radius = HOLLAND_BOMB.fireballM;
  const charge = defaultCharge();
  const exits = layout.exits;
  const walls = layout.walls;
  const evac = new PolygonEvacuationEngine(
    {
      ...DEFAULT_POLYGON_CONFIG,
      vertices: verts,
      pedestrianCount: HOLLAND_BOMB.crowd,
      dt: FX.FIXED_DT,
    },
    exits,
    walls.map((wall) => ({
      startX: wall.start.x,
      startY: wall.start.y,
      endX: wall.end.x,
      endY: wall.end.y,
      hasDoor: wall.hasDoor,
      doorWidth: wall.doorWidth,
      doorPosition: wall.doorPosition,
    })),
    [],
    { afterExit: 'zone', zones: [], seed: SHOWCASE.RNG_SEED },
  );
  const effects = new SpatialEffectsEngine(DEFAULT_FIRE_PARAMS);
  effects.init(fireStuds);
  const cells = confirmedFuelCells(objects, fireStuds);
  const gasLines = confirmedGasLines(objects);
  const electrical = confirmedElectricalSources(objects, []);
  const heads = confirmedSuppression(objects, { G: 4 });
  effects.setFuelCells(cells);
  effects.setStoreyHeights({ G: 4 });
  effects.setBuildingEnvelope(verts, exits);
  const trigger = blastEffectsTriggerSec(effects.timeScale);
  const affected = blastSmokeStudIds(
    fireStuds
      .filter((stud) => Math.hypot(stud.simPos.x - site.x, stud.simPos.y - site.y) <= radius)
      .map((stud) => stud.id),
    new Set(cells.keys()),
  );
  effects.registerHazard(
    'blast-direct',
    [
      {
        triggerTimeSec: trigger,
        eventType: 'explode',
        spreadType: 'fire',
        spreadRadius: radius,
        spreadRate: 10,
        description: 'Direct blast ignition',
        severity: 'critical',
        smokeGeneration: 'heavy',
        affectedStuds: affected,
      },
    ],
    { initial: 'a', triggered: 'b', worsening: 'c', critical: 'd' },
  );
  const zone: HazardZone = {
    id: 'blast-direct',
    pos: site,
    radius,
    hazardType: 'ignitable',
    severity: 'high',
    label: 'Blast',
    description: '',
    photos: [],
  };
  const field = new HazardField(
    fireStuds.map((stud) => ({
      id: stud.id,
      simPos: stud.simPos,
      indoor: stud.spatialContext === 'inside_building',
    })),
    3,
  );
  evac.setHazardField(field);
  const acc = createAccumulator();
  const fps = 60;
  const blastStep = Math.round(SHOWCASE.BLAST_AT_GAME_S / FX.FIXED_DT);
  const marks: HollandMark[] = [];
  const bodies = (evac as unknown as { pedestrians: CrowdBody[] }).pedestrians;
  for (let step = 1; step <= 300 * fps; step += 1) {
    field.setStates(effects.studStates);
    evac.syncExits(exits);
    if (step === blastStep) evac.triggerBlast(site, radius);
    evac.step();
    effects.setFuelCells(cells);
    effects.setStoreyHeights({ G: 4 });
    effects.setBuildingEnvelope(verts, exits);
    effects.setBlastCharge(charge);
    effects.setGasLines(gasLines);
    effects.setElectricalSources(electrical);
    effects.setSuppression(heads);
    stepEffectsFixed(effects, acc, FX.FIXED_DT, 1, walls, [zone]);
    if (step % (30 * fps) !== 0) continue;
    const states: Record<string, number> = {};
    for (const body of bodies) {
      const state = body.__ped.state ?? 'unknown';
      states[state] = (states[state] ?? 0) + 1;
    }
    const showcase = evac.getMetrics().showcase;
    const stats = effects.getStats();
    const ordered: Record<string, number> = {};
    for (const key of Object.keys(states).sort()) ordered[key] = states[key];
    marks.push({
      tSec: step / fps,
      states: ordered,
      out: (states.outside ?? 0) + (states.left_map ?? 0) + (states.arrived ?? 0),
      lethal: showcase?.down.lethal ?? 0,
      serious: showcase?.down.serious ?? 0,
      minor: showcase?.minorInjured ?? 0,
      crawling: showcase?.crawling ?? 0,
      fumeDown: showcase?.fumeDown ?? 0,
      heatDown: showcase?.heatDown ?? 0,
      burning: stats.fire.burning,
      smoky: stats.smokeAffected,
      jets: effects.gasJets().length,
      sprays: effects.sprays().length,
      arcs: effects.electricalArcs().length,
    });
  }
  return {
    bomb: { x: site.x, y: site.y },
    walls: walls.length,
    exits: exits.length,
    fuelStuds: cells.size,
    marks,
  };
}
