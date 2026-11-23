import {
  BLAST_DATASET,
  type CriterionKey,
  type DataStatus,
  type ExplosivePreset,
  type PolySegment,
} from './blastDataset';

export interface ChargeSpec {
  presetKey: string;
  amountKg: number;
  burst: 'surface' | 'free_air';
  heightM: number;
}

export interface BlastRings {
  lethalM: number;
  seriousM: number;
  minorM: number;
  glassInjuryM: number;
  glassBreakageM: number;
  ignitionM: number;
  tntKg: number;
  tntImpulseKg: number;
  notes: string[];
  dataStatus: 'seed_pending' | 'mixed';
}

export interface BlastPressure {
  z: number;
  psKpa: number;
  qKpa: number;
  prKpa: number;
  effectiveKpa: number;
  notes: string[];
}

export type InjuryBandP = 'lethal' | 'serious' | 'minor' | 'none';

const BLAST_CONSTANTS = {
  P0_KPA: 101.325,
  FREE_AIR_FROM_SURFACE_FACTOR: 1.8,
  Z_MIN: 0.2,
  Z_MAX: 198.5,
  NEAR_WALL_M: 1.8,
  FIRE_IGNITION_FACTOR: 1,
};

const BLAST_CONSTANT_SOURCES: Record<keyof typeof BLAST_CONSTANTS | 'WALL_ATTENUATION', { status: DataStatus; ref: string }> = {
  P0_KPA: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/blast-effects/blast-curves.pending.json#units_and_conventions',
  },
  FREE_AIR_FROM_SURFACE_FACTOR: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/blast-effects/blast-curves.pending.json#free_air_from_surface_factor',
  },
  Z_MIN: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/blast-effects/blast-curves.pending.json#kb_surface_incident_pressure_kpa',
  },
  Z_MAX: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/blast-effects/blast-curves.pending.json#kb_surface_incident_pressure_kpa',
  },
  NEAR_WALL_M: {
    status: 'assumed',
    ref: 'assumed: body length; knowledge-seeds/blast-effects/human-vulnerability.pending.json',
  },
  FIRE_IGNITION_FACTOR: {
    status: 'assumed',
    ref: 'assumed: gap (knowledge-seeds/blast-effects/vapour-cloud-and-fireball.pending.json)',
  },
  WALL_ATTENUATION: {
    status: 'assumed',
    ref: 'assumed: gap (knowledge-seeds/blast-effects/README.md)',
  },
};

const INCIDENT = BLAST_DATASET.curves.find((c) => c.key === 'incident_kpa')!;
const REFLECTED = BLAST_DATASET.curves.find((c) => c.key === 'reflected_kpa')!;

function presetFor(key: string): ExplosivePreset {
  return BLAST_DATASET.presets.find((p) => p.key === key) ?? BLAST_DATASET.presets[0]!;
}

function criterionKpa(key: CriterionKey): number {
  return BLAST_DATASET.criteria.find((c) => c.key === key)!.thresholdKpa.value;
}

function finiteAmount(amountKg: number): number {
  if (!Number.isFinite(amountKg) || amountKg < 0) return 0;
  return amountKg;
}

function evalSegment(z: number, seg: PolySegment): number {
  const x = Math.log(z);
  const x2 = x * x;
  const x3 = x2 * x;
  const x4 = x3 * x;
  const x5 = x4 * x;
  const x6 = x5 * x;
  return Math.exp(seg.A + seg.B * x + seg.C * x2 + seg.D * x3 + seg.E * x4 + seg.F * x5 + seg.G * x6);
}

function pickSegment(segments: PolySegment[], z: number): PolySegment {
  for (const seg of segments) {
    if (z >= seg.zMin && z < seg.zMax) return seg;
  }
  const last = segments[segments.length - 1]!;
  if (z <= last.zMax) return z < segments[0]!.zMin ? segments[0]! : last;
  return last;
}

function clampZ(z: number): number {
  if (!Number.isFinite(z) || z < BLAST_CONSTANTS.Z_MIN) return BLAST_CONSTANTS.Z_MIN;
  if (z > BLAST_CONSTANTS.Z_MAX) return BLAST_CONSTANTS.Z_MAX;
  return z;
}

function scaledMassKg(spec: ChargeSpec): number {
  const pressure = finiteAmount(spec.amountKg) * presetFor(spec.presetKey).tntEqPressure.value;
  if (spec.burst === 'free_air') return pressure / BLAST_CONSTANTS.FREE_AIR_FROM_SURFACE_FACTOR;
  return pressure;
}

function standingKpa(z: number): number {
  const ps = surfacePsKpa(z);
  return ps + dynamicPressureKpa(ps);
}

function solveZ(threshold: number, metric: 'standing' | 'incident', notes: string[]): number {
  const f = metric === 'incident' ? surfacePsKpa : standingKpa;
  const atMin = f(BLAST_CONSTANTS.Z_MIN);
  const atMax = f(BLAST_CONSTANTS.Z_MAX);
  if (threshold > atMin) {
    notes.push('inside_curve_min');
    return BLAST_CONSTANTS.Z_MIN;
  }
  if (threshold < atMax) {
    notes.push('outside_curve_range');
    return BLAST_CONSTANTS.Z_MAX;
  }
  let lo = Math.log(BLAST_CONSTANTS.Z_MIN);
  let hi = Math.log(BLAST_CONSTANTS.Z_MAX);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(Math.exp(mid)) > threshold) lo = mid;
    else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
}

function groundRadius(r3d: number, spec: ChargeSpec): number {
  if (spec.burst !== 'free_air') return Math.max(0, r3d);
  const h = Number.isFinite(spec.heightM) ? spec.heightM : 0;
  return Math.sqrt(Math.max(0, r3d * r3d - h * h));
}

function datasetStatus(preset: ExplosivePreset): 'seed_pending' | 'mixed' {
  if (preset.tntEqPressure.status === 'assumed' || preset.tntEqImpulse.status === 'assumed') return 'mixed';
  for (const source of Object.values(BLAST_CONSTANT_SOURCES)) {
    if (source.status === 'assumed') return 'mixed';
  }
  return 'seed_pending';
}

function clampCharge(spec: ChargeSpec): { spec: ChargeSpec; notes: string[] } {
  const notes: string[] = [];
  let presetKey = spec.presetKey;
  if (!BLAST_DATASET.presets.some((p) => p.key === presetKey)) {
    presetKey = 'unknown';
    notes.push('Unknown explosive; using the TNT-equivalent preset');
  }
  let amountKg = spec.amountKg;
  if (!Number.isFinite(amountKg) || amountKg < 0.1) {
    amountKg = 0.1;
    notes.push('Clamped to 0.1 kg');
  } else if (amountKg > 2000) {
    amountKg = 2000;
    notes.push('Clamped to 2,000 kg');
  }
  let heightM = spec.heightM;
  if (!Number.isFinite(heightM) || heightM < 0.5) {
    heightM = 0.5;
    notes.push('Clamped to 0.5 m');
  } else if (heightM > 30) {
    heightM = 30;
    notes.push('Clamped to 30 m');
  }
  const burst = spec.burst === 'free_air' ? 'free_air' : 'surface';
  return { spec: { presetKey, amountKg, burst, heightM }, notes };
}

function tntEquivalentKg(spec: ChargeSpec): { pressure: number; impulse: number } {
  const preset = presetFor(spec.presetKey);
  const amount = Number.isFinite(spec.amountKg) ? spec.amountKg : 0;
  return {
    pressure: amount * preset.tntEqPressure.value,
    impulse: amount * preset.tntEqImpulse.value,
  };
}

function surfacePsKpa(z: number): number {
  const zc = clampZ(z);
  return evalSegment(zc, pickSegment(INCIDENT.segments, zc));
}

function surfacePrKpa(z: number): number {
  const zc = clampZ(z);
  if (zc > 40) {
    const ps = surfacePsKpa(zc);
    const p0 = BLAST_CONSTANTS.P0_KPA;
    return (8 * ps * ps + 14 * ps * p0) / (ps + 7 * p0);
  }
  return evalSegment(zc, pickSegment(REFLECTED.segments, zc));
}

function dynamicPressureKpa(psKpa: number): number {
  const p0 = BLAST_CONSTANTS.P0_KPA;
  return (2.5 * psKpa * psKpa) / (7 * p0 + psKpa);
}

function blastPressureAt(spec: ChargeSpec, range3dM: number, nearWall: boolean): BlastPressure {
  const ws = scaledMassKg(spec);
  const cube = Math.cbrt(ws);
  const range = Number.isFinite(range3dM) ? Math.max(0, range3dM) : 0;
  const rawZ = cube > 0 ? range / cube : range > 0 ? Number.POSITIVE_INFINITY : 0;
  const notes: string[] = [];
  let z = rawZ;
  if (!(rawZ >= BLAST_CONSTANTS.Z_MIN && rawZ <= BLAST_CONSTANTS.Z_MAX)) {
    z = clampZ(rawZ);
    notes.push('outside_curve_range');
  }
  const psKpa = surfacePsKpa(z);
  const qKpa = dynamicPressureKpa(psKpa);
  const prKpa = surfacePrKpa(z);
  return {
    z,
    psKpa,
    qKpa,
    prKpa,
    effectiveKpa: nearWall ? prKpa : psKpa + qKpa,
    notes,
  };
}

function bandForEffectiveKpa(effectiveKpa: number): InjuryBandP {
  if (!Number.isFinite(effectiveKpa)) return 'none';
  if (effectiveKpa >= criterionKpa('lethal_onset')) return 'lethal';
  if (effectiveKpa >= criterionKpa('serious_injury_onset')) return 'serious';
  if (effectiveKpa >= criterionKpa('minor_injury_onset')) return 'minor';
  return 'none';
}

function computeBlastRings(spec: ChargeSpec): BlastRings {
  const eq = tntEquivalentKg(spec);
  const ws = scaledMassKg(spec);
  const cube = Math.cbrt(ws);
  const notes: string[] = [];
  const radiusFor = (key: CriterionKey, metric: 'standing' | 'incident') => {
    const z = solveZ(criterionKpa(key), metric, notes);
    return groundRadius(z * cube, spec);
  };
  let lethalM = radiusFor('lethal_onset', 'standing');
  let seriousM = radiusFor('serious_injury_onset', 'standing');
  let minorM = radiusFor('minor_injury_onset', 'standing');
  seriousM = Math.max(seriousM, lethalM);
  minorM = Math.max(minorM, seriousM);
  const glassInjuryM = radiusFor('glass_injury', 'incident');
  const glassBreakageM = radiusFor('glass_breakage', 'incident');
  const finite = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return {
    lethalM: finite(lethalM),
    seriousM: finite(seriousM),
    minorM: finite(minorM),
    glassInjuryM: finite(glassInjuryM),
    glassBreakageM: finite(glassBreakageM),
    ignitionM: finite(lethalM * BLAST_CONSTANTS.FIRE_IGNITION_FACTOR),
    tntKg: finite(eq.pressure),
    tntImpulseKg: finite(eq.impulse),
    notes: [...new Set(notes)],
    dataStatus: datasetStatus(presetFor(spec.presetKey)),
  };
}

function defaultCharge(): ChargeSpec {
  return { presetKey: 'unknown', amountKg: 10, burst: 'surface', heightM: 1.5 };
}

export {
  BLAST_CONSTANTS,
  BLAST_CONSTANT_SOURCES,
  clampCharge,
  tntEquivalentKg,
  surfacePsKpa,
  surfacePrKpa,
  dynamicPressureKpa,
  blastPressureAt,
  bandForEffectiveKpa,
  computeBlastRings,
  defaultCharge,
};
