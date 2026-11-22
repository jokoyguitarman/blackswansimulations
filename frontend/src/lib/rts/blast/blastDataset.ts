import {
  KB_SURFACE_INCIDENT_PRESSURE_KPA,
  KB_SURFACE_REFLECTED_PRESSURE_KPA,
} from './kbSurfaceCoefficients';

export type DataStatus = 'seed_pending' | 'assumed';
export type Confidence = 'high' | 'medium' | 'low';

export interface SourcedValue<T> {
  value: T;
  status: DataStatus;
  confidence: Confidence;
  ref: string;
}

export interface ExplosivePreset {
  key: string;
  label: string;
  tntEqPressure: SourcedValue<number>;
  tntEqImpulse: SourcedValue<number>;
}

export interface PolySegment {
  zMin: number;
  zMax: number;
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
  F: number;
  G: number;
}

export interface SurfaceCurve {
  key: 'incident_kpa' | 'reflected_kpa';
  segments: PolySegment[];
  ref: string;
  status: DataStatus;
}

export type CriterionKey =
  | 'lethal_onset'
  | 'serious_injury_onset'
  | 'minor_injury_onset'
  | 'glass_injury'
  | 'glass_breakage';

export interface Criterion {
  key: CriterionKey;
  thresholdKpa: SourcedValue<number>;
  metric: 'standing_effective' | 'incident';
}

export interface BlastDataset {
  version: string;
  presets: ExplosivePreset[];
  curves: SurfaceCurve[];
  criteria: Criterion[];
  freeAirFromSurfaceFactor: SourcedValue<number>;
}

const MATERIALS = 'knowledge-seeds/blast-effects/explosive-materials.pending.json';
const CURVES = 'knowledge-seeds/blast-effects/blast-curves.pending.json';
const INJURY = 'knowledge-seeds/blast-effects/injury-thresholds.pending.json';

function factor(
  fileKey: string,
  value: number,
  status: DataStatus,
  confidence: Confidence,
): SourcedValue<number> {
  return { value, status, confidence, ref: `${MATERIALS}#${fileKey}` };
}

export const BLAST_DATASET: BlastDataset = {
  version: 'blast-effects-2026-11-22-pending',
  presets: [
    {
      key: 'unknown',
      label: 'Other / unknown (TNT-equivalent)',
      tntEqPressure: factor('unknown', 1, 'seed_pending', 'high'),
      tntEqImpulse: factor('unknown', 1, 'seed_pending', 'high'),
    },
    {
      key: 'tnt',
      label: 'TNT',
      tntEqPressure: factor('tnt', 1, 'seed_pending', 'high'),
      tntEqImpulse: factor('tnt', 1, 'seed_pending', 'high'),
    },
    {
      key: 'anfo',
      label: 'ANFO',
      tntEqPressure: factor('anfo', 0.82, 'seed_pending', 'medium'),
      tntEqImpulse: factor('anfo', 0.82, 'seed_pending', 'medium'),
    },
    {
      key: 'rdx',
      label: 'RDX',
      tntEqPressure: factor('rdx_c4', 1.14, 'seed_pending', 'medium'),
      tntEqImpulse: factor('rdx_c4', 1.09, 'seed_pending', 'medium'),
    },
    {
      key: 'c4',
      label: 'C-4',
      tntEqPressure: factor('rdx_c4', 1.37, 'seed_pending', 'medium'),
      tntEqImpulse: factor('rdx_c4', 1.19, 'seed_pending', 'medium'),
    },
    {
      key: 'petn',
      label: 'PETN',
      tntEqPressure: factor('petn_semtex', 1.27, 'seed_pending', 'medium'),
      tntEqImpulse: factor('petn_semtex', 1.11, 'seed_pending', 'medium'),
    },
    {
      key: 'semtex',
      label: 'Semtex',
      tntEqPressure: factor('petn_semtex', 1.27, 'assumed', 'low'),
      tntEqImpulse: factor('petn_semtex', 1.11, 'assumed', 'low'),
    },
    {
      key: 'dynamite',
      label: 'Dynamite',
      tntEqPressure: factor('dynamite', 1.25, 'assumed', 'low'),
      tntEqImpulse: factor('dynamite', 1.25, 'assumed', 'low'),
    },
    {
      key: 'tatp',
      label: 'TATP',
      tntEqPressure: factor('tatp', 0.8, 'assumed', 'low'),
      tntEqImpulse: factor('tatp', 0.8, 'assumed', 'low'),
    },
    {
      key: 'black_powder',
      label: 'Black powder',
      tntEqPressure: factor('black_powder', 0.55, 'assumed', 'low'),
      tntEqImpulse: factor('black_powder', 0.55, 'assumed', 'low'),
    },
  ],
  curves: [KB_SURFACE_INCIDENT_PRESSURE_KPA, KB_SURFACE_REFLECTED_PRESSURE_KPA],
  criteria: [
    {
      key: 'lethal_onset',
      thresholdKpa: {
        value: 690,
        status: 'seed_pending',
        confidence: 'high',
        ref: `${INJURY}#lethal_onset`,
      },
      metric: 'standing_effective',
    },
    {
      key: 'serious_injury_onset',
      thresholdKpa: {
        value: 207,
        status: 'seed_pending',
        confidence: 'high',
        ref: `${INJURY}#serious_injury_onset`,
      },
      metric: 'standing_effective',
    },
    {
      key: 'minor_injury_onset',
      thresholdKpa: {
        value: 34.5,
        status: 'seed_pending',
        confidence: 'high',
        ref: `${INJURY}#minor_injury_onset`,
      },
      metric: 'standing_effective',
    },
    {
      key: 'glass_injury',
      thresholdKpa: {
        value: 6.9,
        status: 'seed_pending',
        confidence: 'high',
        ref: `${INJURY}#glass_injury`,
      },
      metric: 'incident',
    },
    {
      key: 'glass_breakage',
      thresholdKpa: {
        value: 2,
        status: 'seed_pending',
        confidence: 'high',
        ref: `${INJURY}#glass_breakage`,
      },
      metric: 'incident',
    },
  ],
  freeAirFromSurfaceFactor: {
    value: 1.8,
    status: 'seed_pending',
    confidence: 'medium',
    ref: `${CURVES}#free_air_from_surface_factor`,
  },
};
