import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import {
  AMBIENT_K,
  freshLayer,
  stepZone,
  type Boundary,
  type LayerSpec,
  type Lining,
  type Vent,
  type ZoneState,
} from '../../../src/lib/rts/twoZone.ts';

/**
 * Geometry, linings and fire curves are copied from the CFAST validation
 * inputs, firemodels/cfast at this commit. The measured layers are the
 * extracts beside this file, each with its own source header.
 */
export const CFAST_COMMIT = 'b86959775ec32c5f3d95580cc0e3da2135da20ee';
export const EXP_COMMIT = 'a9511fc4f56c3ae125d1d090e3be08e76959e856';

/** Known gaps are described here. Each expected failure links its section. */
export const KNOWN_GAPS_DOC = 'frontend/tests/fixtures/fireValidation/README.md';

/** Decision 5 (realistic-fire roadmap). */
export const TOLERANCE = {
  riseFraction: 0.2,
  doorFlowFraction: 0.25,
  flashoverTimeFraction: 0.2,
  interfaceM: (ceilingM: number) => Math.max(0.2, 0.15 * ceilingM),
} as const;

export interface LayerRow {
  t: number;
  interfaceM: number;
  lowerC: number;
  upperC: number;
}

export function readLayer(file: string): LayerRow[] {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  const rows: LayerRow[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('Time')) continue;
    const [t, z, lower, upper] = line.split(',').map(Number);
    if ([t, z, lower, upper].some((value) => !Number.isFinite(value))) continue;
    rows.push({ t: t!, interfaceM: z!, lowerC: lower!, upperC: upper! });
  }
  return rows;
}

/** CFAST MATL rows are W/m·K and kJ/kg·K; the layer takes kW/m·K. */
function matl(
  name: string,
  kWMK: number,
  rhoKgM3: number,
  cKjKgK: number,
  thicknessM: number,
): Lining {
  return { name, kKwMK: kWMK / 1000, rhoKgM3, cKjKgK, thicknessM };
}

export interface ValidationCase {
  id: string;
  title: string;
  cfastInput: string;
  extract: string;
  spec: Omit<LayerSpec, 'fires'>;
  /** Burner diameter from the CFAST fire AREA, as a circle. */
  diameterM: number;
  /** CFAST fire HEIGHT, metres above the floor. Absent means the fuel is on the floor. */
  baseM?: number;
  chi: number;
  /** CFAST TABL, time s and HRR kW, linear between points. */
  hrr: readonly (readonly [number, number])[];
  /** Mean over the extract rows in this window, seconds. */
  window: readonly [number, number];
}

const circle = (areaM2: number) => Math.sqrt((4 * areaM2) / Math.PI);

function box(
  widthM: number,
  depthM: number,
  heightM: number,
  floor: Lining,
  ceiling: Lining,
  walls: Lining,
  vents: Vent[],
): Omit<LayerSpec, 'fires'> {
  const area = widthM * depthM;
  let openings = 0;
  for (const vent of vents) openings += vent.widthM * (vent.soffitM - vent.sillM);
  const boundaries: Boundary[] = [
    { areaM2: area, lining: floor },
    { areaM2: area, lining: ceiling },
    { areaM2: 2 * (widthM + depthM) * heightM - openings, lining: walls },
  ];
  return { areaM2: area, ceilingM: heightM, vents, boundaries };
}

// NBS MV100A (Peacock et al., NBSIR 88-3752). The fire-room door opens into
// the entry. `runNbsFireRoom` puts that entry's layer on the far side of the
// opening below. The spec records the opening. The burner sits 0.1 m from
// the rear wall; the plume is entrained as if free-standing, as CFAST does.
const ceramicNbs = matl('Ceramic Fiber NBS', 0.09, 128, 1.04, 0.05);
const fireBrickNbs = matl('Fire Brick NBS', 0.36, 750, 1.04, 0.113);
const mariniteNbs = matl('Marinite NBS', 0.12, 720, 1.25, 0.0127);
const gypsumNbs = matl('Gypsum NBS', 0.17, 930, 1.09, 0.0127);
const nbsFire: ValidationCase['hrr'] = [
  [0, 0],
  [10, 110],
  [890, 110],
  [900, 0],
];

export const NBS_FIRE_ROOM: ValidationCase = {
  id: 'nbs-mv100a-fire-room',
  title: 'NBS multi-room MV100A, fire room',
  cfastInput: 'Validation/NBS/MV100A.in',
  extract: 'nbs-mv100a-fire-room.csv',
  spec: box(2.34, 2.34, 2.16, fireBrickNbs, ceramicNbs, ceramicNbs, [
    { widthM: 0.81, sillM: 0, soffitM: 1.6 },
  ]),
  diameterM: circle(0.1156),
  chi: 0.2,
  hrr: nbsFire,
  window: [300, 880],
};

const nbsDoor = { widthM: 0.81, sillM: 0, soffitM: 1.6 };

/**
 * Fire room and the entry it opens into (`Entry to Fire Room` in MV100A.in:
 * 1.02 m × 1.03 m × 2.00 m, Marinite walls and ceiling, gypsum floor, a
 * 0.81 m × 1.6 m door each way). The fire-room door sees that entry's layer
 * (CFAST Eq. 4.1 on both sides). The entry's other door opens to ambient.
 * Extending the chain so the corridor is on that door, with the jets lagged
 * one step, leaves this room at 0.86 m and 200 K. The corridor there is
 * 1.18 m and 33 K. Its rise is outside 20%, so that layer is not the far
 * side used here.
 */
export function runNbsFireRoom(endS: number): ZoneState[] {
  const entryArea = 1.02 * 1.03;
  const entryOpenings = 2 * nbsDoor.widthM * nbsDoor.soffitM;
  const entryWalls = 2 * (1.02 + 1.03) * 2 - entryOpenings;
  let fire = freshLayer(NBS_FIRE_ROOM.spec.ceilingM);
  let entry = freshLayer(2);
  let entryPressure = 0;
  const states: ZoneState[] = [fire];
  for (let t = 1; t <= endS; t++) {
    const q = hrrAt(NBS_FIRE_ROOM.hrr, t - 0.5);
    const fireStep = stepZone(
      fire,
      {
        ...NBS_FIRE_ROOM.spec,
        chi: NBS_FIRE_ROOM.chi,
        vents: [
          {
            ...nbsDoor,
            outside: {
              interfaceM: entry.interfaceM,
              upperK: entry.upperK,
              floorPressurePa: entryPressure,
            },
          },
        ],
        fires: q > 0 ? [{ heatKw: q, diameterM: NBS_FIRE_ROOM.diameterM }] : [],
      },
      1,
    );
    const left = fireStep.hotByVent[0];
    const jet =
      left && left.kg > 0
        ? {
            kgS: left.kg,
            tempK: left.tempK,
            oxygenY: left.oxygenY,
            fuelY: left.fuelY,
            widthM: nbsDoor.widthM,
            soffitM: nbsDoor.soffitM,
            lowEdgeM: 0,
          }
        : null;
    const entryStep = stepZone(
      entry,
      {
        areaM2: entryArea,
        ceilingM: 2,
        chi: NBS_FIRE_ROOM.chi,
        vents: [{ ...nbsDoor }],
        boundaries: [
          { areaM2: entryArea, lining: gypsumNbs },
          { areaM2: entryArea, lining: mariniteNbs },
          { areaM2: entryWalls, lining: mariniteNbs },
        ],
        fires: [],
      },
      1,
      0,
      jet,
    );
    fire = fireStep.state;
    entry = entryStep.state;
    entryPressure = entryStep.floorPressurePa;
    states.push(fire);
  }
  return states;
}

/** The corridor has no fire of its own. Its doors are the entry and the outside. */
// FV-4 runs the corridor through `nbsPlan.ts`; this case supplies its extract, window and ceiling.
export const NBS_CORRIDOR: ValidationCase = {
  id: 'nbs-mv100a-corridor',
  title: 'NBS multi-room MV100A, corridor',
  cfastInput: 'Validation/NBS/MV100A.in',
  extract: 'nbs-mv100a-corridor.csv',
  spec: box(12.19, 2.44, 2.44, gypsumNbs, mariniteNbs, mariniteNbs, [
    { widthM: 0.81, sillM: 0, soffitM: 1.6 },
    { widthM: 0.76, sillM: 0, soffitM: 2.03 },
  ]),
  diameterM: circle(0.1156),
  chi: 0.2,
  hrr: [[0, 0]],
  window: [300, 880],
};

// NIST/NRC ICFMP BE#3 Test 3 (NUREG-1824). Heptane spray, 2 m × 2 m door, no
// mechanical ventilation. Walls and ceiling Marinite, floor gypsum.
const mariniteBe3 = matl('Marinite ICFMP BE3', 0.12, 737, 1.25, 0.0254);
const gypsumBe3 = matl('Gypsum ICFMP BE3', 0.16, 790, 0.9, 0.0254);

export const BE3_TEST_3: ValidationCase = {
  id: 'nist-nrc-be3-test03',
  title: 'NIST/NRC BE#3 Test 3',
  cfastInput: 'Validation/NIST_NRC/NIST_NRC_T3.in',
  extract: 'nist-nrc-be3-test03.csv',
  spec: box(21.7, 7.04, 3.82, gypsumBe3, mariniteBe3, mariniteBe3, [
    { widthM: 2, sillM: 0, soffitM: 2 },
  ]),
  diameterM: circle(1),
  chi: 0.44,
  hrr: [
    [0, 0],
    [178, 1190],
    [1379, 1190],
    [1562, 0],
  ],
  window: [600, 1200],
};

// VTT large hall, ICFMP BE#2 (Hostikka et al., VTT 2001). 27 m × 13.8 m,
// 12 m eaves, a pitched roof to a 1.9 m wide monitor at 17.1–19 m. The steel
// is the hall's actual surface. The gas volume follows the cross-section in
// VTT_C1.in and VTT_C2.in (CFAST user's guide §4.4), not the floor carried
// up to the ridge. The pan stands 1 m above the floor (CFAST HEIGHT). Four
// 0.71 m leakage vents.
const steelBe2 = matl('Steel ICFMP BE2', 54, 7850, 0.425, 0.001);
const concreteBe2 = matl('Concrete ICFMP BE2', 2, 2300, 0.9, 0.15);
const vttVent = 0.71;
const vttSteelM2 =
  2 * (27 + 13.8) * 12 +
  2 * 27 * Math.hypot(5.1, (13.8 - 1.9) / 2) +
  (13.8 + 1.9) * 5.1 +
  2 * (27 + 1.9) * 1.9 +
  27 * 1.9 -
  4 * vttVent * vttVent;
const vttFloorM2 = 27 * 13.8;
const vttSpec: Omit<LayerSpec, 'fires'> = {
  areaM2: vttFloorM2,
  ceilingM: 19,
  // CROSS_SECT_HEIGHTS / CROSS_SECT_AREAS from both VTT inputs. The area
  // stays 372.6 m² up to the eaves, then a pyramid to the 51.3 m² monitor.
  crossSection: {
    heightsM: [0, 12, 17.1, 19],
    areasM2: [vttFloorM2, vttFloorM2, 51.3, 51.3],
  },
  vents: [
    { widthM: vttVent, sillM: 0, soffitM: vttVent },
    { widthM: vttVent, sillM: 0, soffitM: vttVent },
    { widthM: vttVent, sillM: 12, soffitM: 12 + vttVent },
    { widthM: vttVent, sillM: 12, soffitM: 12 + vttVent },
  ],
  boundaries: [
    { areaM2: vttFloorM2, lining: concreteBe2 },
    { id: 'vtt-steel', areaM2: vttSteelM2, lining: steelBe2 },
  ],
};

export const VTT_CASE_1: ValidationCase = {
  id: 'vtt-be2-case1',
  title: 'VTT large hall, BE#2 Case 1',
  cfastInput: 'Validation/VTT/VTT_C1.in',
  extract: 'vtt-be2-case1.csv',
  spec: vttSpec,
  diameterM: circle(1.08),
  baseM: 1,
  chi: 0.4,
  hrr: [
    [0, 0],
    [13, 1245],
    [90, 1709],
    [288, 1858],
    [327, 1783],
    [409, 1356],
    [438, 0],
  ],
  window: [180, 420],
};

export const VTT_CASE_2: ValidationCase = {
  id: 'vtt-be2-case2',
  title: 'VTT large hall, BE#2 Case 2',
  cfastInput: 'Validation/VTT/VTT_C2.in',
  extract: 'vtt-be2-case2.csv',
  spec: vttSpec,
  diameterM: circle(2.01),
  baseM: 1,
  chi: 0.4,
  hrr: [
    [0, 0],
    [14, 2151],
    [30, 2542],
    [91, 3063],
    [193, 3259],
    [282, 3129],
    [340, 2737],
    [372, 2275],
    [395, 0],
  ],
  window: [180, 360],
};

export function hrrAt(curve: ValidationCase['hrr'], tS: number): number {
  const first = curve[0];
  if (!first || tS <= first[0]) return first?.[1] ?? 0;
  for (let i = 1; i < curve.length; i++) {
    const [t1, q1] = curve[i]!;
    const [t0, q0] = curve[i - 1]!;
    if (tS <= t1) return q0 + ((q1 - q0) * (tS - t0)) / (t1 - t0);
  }
  return curve[curve.length - 1]![1];
}

/** One-second steps of the prescribed fire. `states[t]` is the layer at t seconds. */
export function runCase(c: ValidationCase, endS: number): ZoneState[] {
  let state = freshLayer(c.spec.ceilingM);
  const states: ZoneState[] = [state];
  for (let t = 1; t <= endS; t++) {
    const q = hrrAt(c.hrr, t - 0.5);
    const fires = q > 0 ? [{ heatKw: q, diameterM: c.diameterM, baseM: c.baseM }] : [];
    state = stepZone(state, { ...c.spec, chi: c.chi, fires }, 1).state;
    states.push(state);
  }
  return states;
}

export interface LayerComparison {
  modelInterfaceM: number;
  measuredInterfaceM: number;
  modelRiseK: number;
  measuredRiseK: number;
}

/**
 * Window means at the extract's own times. The measured rise is above the
 * first row's lower-layer temperature, the test's ambient. The model's
 * ambient is 293 K, so only rises are compared.
 */
export function compareLayer(c: ValidationCase, states: readonly ZoneState[]): LayerComparison {
  const rows = readLayer(c.extract);
  const ambientC = rows[0]!.lowerC;
  const inWindow = rows.filter((row) => row.t >= c.window[0] && row.t <= c.window[1]);
  assert.ok(inWindow.length >= 3, `${c.id}: ${inWindow.length} rows in the window`);
  let mz = 0;
  let mr = 0;
  let ez = 0;
  let er = 0;
  for (const row of inWindow) {
    const state = states[Math.round(row.t)];
    assert.ok(state, `${c.id}: no model state at ${row.t} s`);
    mz += state.interfaceM;
    mr += state.upperK - AMBIENT_K;
    ez += row.interfaceM;
    er += row.upperC - ambientC;
  }
  const n = inWindow.length;
  return {
    modelInterfaceM: mz / n,
    measuredInterfaceM: ez / n,
    modelRiseK: mr / n,
    measuredRiseK: er / n,
  };
}

export interface Check {
  case: string;
  metric: string;
  unit: string;
  model: number;
  target: number;
  /** Relative (a fraction of the target) or an absolute band. */
  tolerance: { relative: number } | { absolute: number } | { band: readonly [number, number] };
}

export function withinTolerance(check: Check): boolean {
  const tol = check.tolerance;
  if ('band' in tol) return check.model >= tol.band[0] && check.model <= tol.band[1];
  const diff = Math.abs(check.model - check.target);
  if ('relative' in tol) return diff <= tol.relative * Math.abs(check.target);
  return diff <= tol.absolute;
}

function describe(check: Check): string {
  const tol = check.tolerance;
  const fmt = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toPrecision(3));
  const band =
    'band' in tol
      ? `${fmt(tol.band[0])}–${fmt(tol.band[1])}`
      : 'relative' in tol
        ? `±${(tol.relative * 100).toFixed(0)}%`
        : `±${fmt(tol.absolute)} ${check.unit}`;
  const delta =
    check.target !== 0 ? ((check.model - check.target) / Math.abs(check.target)) * 100 : 0;
  return `${check.case} | ${check.metric} | model ${fmt(check.model)} ${check.unit} | target ${fmt(check.target)} ${check.unit} | ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% | tolerance ${band}`;
}

export function expectPass(t: TestContext, check: Check): void {
  const line = describe(check);
  t.diagnostic(`PASS | ${line}`);
  assert.ok(withinTolerance(check), `outside tolerance: ${line}`);
}

export interface KnownGap {
  /** Numbered entry in the known-gaps doc, e.g. FV-1. */
  id: string;
  /** The recorded model value. A fix or a regression both move it. */
  recorded: number;
  /** How far the model may drift from `recorded` before the record is stale. */
  pin: number;
  roadmap: string;
}

/**
 * An expected failure. It must still be outside the Decision 5 tolerance, and
 * the model must still sit at the recorded number. Fixing the gap fails the
 * first assertion; drifting fails the second. Either way, update the doc.
 */
export function expectKnownGap(t: TestContext, check: Check, gap: KnownGap): void {
  const line = describe(check);
  const link = `${KNOWN_GAPS_DOC}#${gap.id.toLowerCase()}; roadmap: ${gap.roadmap}`;
  t.diagnostic(`EXPECTED FAILURE ${gap.id} | ${line} | ${link}`);
  assert.ok(
    !withinTolerance(check),
    `${gap.id} now passes (${line}). Move it to a pass and close it in ${link}`,
  );
  assert.ok(
    Math.abs(check.model - gap.recorded) <= gap.pin,
    `${gap.id} moved from its recorded ${gap.recorded} ± ${gap.pin} (${line}). Update ${link}`,
  );
}
