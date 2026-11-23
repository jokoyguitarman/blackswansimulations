// ref: knowledge-seeds/blast-effects/worked-examples.pending.json
// ref: knowledge-seeds/blast-effects/blast-curves.pending.json#lookup_tables.hemispherical_surface

export interface Tnt10kgCase {
  caseId: string;
  burst: 'surface' | 'free_air';
  rangeM: number;
  zOracle: number;
  psKpa: number;
  qKpa: number;
  standingKpa: number;
  reflectedKpa: number;
}

export const TNT_10KG_CASES: Tnt10kgCase[] = [
  {
    caseId: 'tnt10kg_hemispherical_surface_5m',
    burst: 'surface',
    rangeM: 5,
    zOracle: 2.321,
    psKpa: 202.1,
    qKpa: 112.1,
    standingKpa: 314.2,
    reflectedKpa: 679.1,
  },
  {
    caseId: 'tnt10kg_hemispherical_surface_10m',
    burst: 'surface',
    rangeM: 10,
    zOracle: 4.642,
    psKpa: 49.3,
    qKpa: 8.011,
    standingKpa: 57.31,
    reflectedKpa: 117.5,
  },
  {
    caseId: 'tnt10kg_hemispherical_surface_20m',
    burst: 'surface',
    rangeM: 20,
    zOracle: 9.283,
    psKpa: 16.5,
    qKpa: 0.9381,
    standingKpa: 17.44,
    reflectedKpa: 35.14,
  },
  {
    caseId: 'tnt10kg_hemispherical_surface_50m',
    burst: 'surface',
    rangeM: 50,
    zOracle: 23.21,
    psKpa: 5.055,
    qKpa: 0.08943,
    standingKpa: 5.144,
    reflectedKpa: 10.24,
  },
  {
    caseId: 'tnt10kg_spherical_free_air_5m',
    burst: 'free_air',
    rangeM: 5,
    zOracle: 2.321,
    psKpa: 131.7,
    qKpa: 51.56,
    standingKpa: 183.3,
    reflectedKpa: 389.5,
  },
  {
    caseId: 'tnt10kg_spherical_free_air_10m',
    burst: 'free_air',
    rangeM: 10,
    zOracle: 4.642,
    psKpa: 35.15,
    qKpa: 4.15,
    standingKpa: 39.3,
    reflectedKpa: 79.8,
  },
  {
    caseId: 'tnt10kg_spherical_free_air_20m',
    burst: 'free_air',
    rangeM: 20,
    zOracle: 9.283,
    psKpa: 12.64,
    qKpa: 0.5533,
    standingKpa: 13.19,
    reflectedKpa: 26.56,
  },
  {
    caseId: 'tnt10kg_spherical_free_air_50m',
    burst: 'free_air',
    rangeM: 50,
    zOracle: 23.21,
    psKpa: 3.877,
    qKpa: 0.05268,
    standingKpa: 3.929,
    reflectedKpa: 7.891,
  },
];

export const THRESHOLD_RADII_10KG = {
  surface: {
    lethalM: 3.836,
    seriousM: 5.809,
    minorM: 13.08,
    glassInjuryM: 39.07,
    glassBreakageM: 97.36,
  },
  free_air: {
    lethalM: 3.153,
    seriousM: 4.775,
    minorM: 10.75,
    glassInjuryM: 32.12,
    glassBreakageM: 80.04,
  },
};

export const CUBE_ROOT_GLASS = [
  { k: 0.5, radius10kgM: 39.07, ratio: 0.49987 },
  { k: 2, radius10kgM: 39.07, ratio: 2 },
  { k: 3, radius10kgM: 39.07, ratio: 2.9997 },
];

/** Ten rows of lookup_tables.hemispherical_surface (z, incident pressure kPa). */
export const SURFACE_LOOKUP_SAMPLES: Array<{ z: number; incidentKpa: number }> = [
  { z: 0.2, incidentKpa: 17310 },
  { z: 0.34, incidentKpa: 8607 },
  { z: 0.577, incidentKpa: 3863 },
  { z: 0.98, incidentKpa: 1412 },
  { z: 1.67, incidentKpa: 430.5 },
  { z: 2.83, incidentKpa: 131 },
  { z: 4.8, incidentKpa: 46.44 },
  { z: 8.16, incidentKpa: 19.84 },
  { z: 16.5, incidentKpa: 7.767 },
  { z: 40, incidentKpa: 2.375 },
];
