import type { SurfaceCurve } from './blastDataset';

/** Copied from knowledge-seeds/blast-effects/blast-curves.pending.json rows. */
const INCIDENT_REF = 'knowledge-seeds/blast-effects/blast-curves.pending.json#kb_surface_incident_pressure_kpa';
const REFLECTED_REF = 'knowledge-seeds/blast-effects/blast-curves.pending.json#kb_surface_reflected_pressure_kpa';

export const KB_SURFACE_INCIDENT_PRESSURE_KPA: SurfaceCurve = {
  key: 'incident_kpa',
  ref: INCIDENT_REF,
  status: 'seed_pending',
  segments: [
    {
      zMin: 0.2,
      zMax: 2.9,
      A: 7.2106,
      B: -2.1069,
      C: -0.3229,
      D: 0.1117,
      E: 0.0685,
      F: 0,
      G: 0,
    },
    {
      zMin: 2.9,
      zMax: 23.8,
      A: 7.5938,
      B: -3.0523,
      C: 0.40977,
      D: 0.0261,
      E: -0.01267,
      F: 0,
      G: 0,
    },
    {
      zMin: 23.8,
      zMax: 198.5,
      A: 6.0536,
      B: -1.4066,
      C: 0,
      D: 0,
      E: 0,
      F: 0,
      G: 0,
    }
  ],
};

export const KB_SURFACE_REFLECTED_PRESSURE_KPA: SurfaceCurve = {
  key: 'reflected_kpa',
  ref: REFLECTED_REF,
  status: 'seed_pending',
  segments: [
    {
      zMin: 0.06,
      zMax: 2.0,
      A: 9.006,
      B: -2.6893,
      C: -0.6295,
      D: 0.1011,
      E: 0.29255,
      F: 0.13505,
      G: 0.019736,
    },
    {
      zMin: 2.0,
      zMax: 40.0,
      A: 8.8396,
      B: -1.733,
      C: -2.64,
      D: 2.293,
      E: -0.8232,
      F: 0.14247,
      G: -0.0099,
    }
  ],
};
