/** Storey and stair constants. Every value is pending review or labelled assumed. */
export const LEVEL = {
  STAIR_SPEED_DOWN: 0.694,
  STAIR_SPEED_UP: 0.61,
  STAIR_SPECIFIC_FLOW: 1.01,
  STAIR_BOUNDARY_LAYER_M: 0.15,
  DEFAULT_STOREY_HEIGHT_M: 4.0,
  DEFAULT_BASEMENT_HEIGHT_M: 3.5,
  STAIR_TRAVEL_FACTOR: 2.0,
  DEFAULT_STAIR_WIDTH_M: 1.2,
  STAIR_CAPTURE_RADIUS_M: 1.5,
  STAIR_STUD_RADIUS_M: 2.5,
  ORIFICE_C: 0.7,
  RHO_AIR: 1.2,
  G: 9.81,
  SMOKE_TEMP_K: 400,
  STAIR_NEUTRAL_DEPTH_FRACTION: 0.5,
  CELL_AREA_M2: 9,
  LIFT_DOOR_WIDTH_M: 1.0,
  STAIR_FIRE_HEAT_S: 60,
  CROUCH_SPEED_FACTOR: 0.6,
  STAIR_CRAWL_FACTOR: 0.5,
  /**
   * Dead-end crawl down a stair: the most either FED may reach by the far
   * door, estimated on today's smoke and heat. Above it the person stays put.
   */
  DEAD_END_CRAWL_MAX_FED: 0.5,
  /** Seconds between the per-stud dose-rate samples the projection extrapolates from. */
  DOSE_TREND_S: 2,
  /** Samples in the trend window: the slope is fitted over (n − 1) × DOSE_TREND_S. */
  DOSE_TREND_SAMPLES: 4,
  /** Multiplier on the projected dose for what the linear trend misses. */
  DEAD_END_DOSE_MARGIN: 2,
  /**
   * Look-ahead, from each route check, over which staying put is tested for
   * incapacitation. It recedes with the check; it is not a rescue time.
   */
  DEFEND_HORIZON_S: 300,
  /** The most a crawl over DEAD_END_CRAWL_MAX_FED may project when it is started. */
  DEAD_END_OVER_LIMIT_CAP: 1.5,
  /**
   * Share of a landing's merged release that goes to the floor stream when
   * floor and stair streams are both waiting. The rest goes to the stair.
   */
  STAIR_MERGE_FLOOR_SHARE: 0.5,
  /** Width a minor reverse stream takes on a stair: one traffic lane. */
  STAIR_REVERSE_LANE_M: 0.76,
  /** Density at which stair movement stops, persons per m² of flight. */
  STAIR_JAM_DENSITY_PM2: 3.76,
  GHOST_ALPHA: 0.15,
  MAX_LEVELS: 12,
} as const;

export const LEVEL_SOURCES: Record<
  keyof typeof LEVEL,
  { status: 'seed_pending' | 'assumed'; ref: string }
> = {
  STAIR_SPEED_DOWN: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#stair_speed_down_free',
  },
  STAIR_SPEED_UP: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#stair_speed_up_free',
  },
  STAIR_SPECIFIC_FLOW: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#stair_max_specific_flow',
  },
  STAIR_BOUNDARY_LAYER_M: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#boundary_layer_stair',
  },
  DEFAULT_STOREY_HEIGHT_M: {
    status: 'assumed',
    ref: 'knowledge-seeds/building-hazards/README storey_height_m (not found)',
  },
  DEFAULT_BASEMENT_HEIGHT_M: {
    status: 'assumed',
    ref: 'knowledge-seeds/building-hazards/README storey_height_m (not found)',
  },
  STAIR_TRAVEL_FACTOR: {
    status: 'assumed',
    ref: 'knowledge-seeds/physics-movement/ (stair geometry and travel distance per storey; not seeded yet)',
  },
  DEFAULT_STAIR_WIDTH_M: {
    status: 'assumed',
    ref: 'Singapore Fire Code exit width rules (not seeded yet)',
  },
  STAIR_CAPTURE_RADIUS_M: { status: 'assumed', ref: 'assumed: numerical' },
  STAIR_STUD_RADIUS_M: { status: 'assumed', ref: 'assumed: numerical' },
  ORIFICE_C: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/smoke-movement.pending.json#vent_flow_orifice',
  },
  RHO_AIR: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/smoke-movement.pending.json#vent_flow_orifice',
  },
  G: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/smoke-movement.pending.json#vent_flow_orifice',
  },
  SMOKE_TEMP_K: {
    status: 'assumed',
    ref: 'knowledge-seeds/fire-smoke-tenability/worked-examples.pending.json#door_smoke_flow',
  },
  STAIR_NEUTRAL_DEPTH_FRACTION: {
    status: 'assumed',
    ref: 'knowledge-seeds/fire-smoke-tenability/smoke-movement.pending.json#stack_pressure',
  },
  CELL_AREA_M2: { status: 'assumed', ref: 'definition: one 3 × 3 m stud' },
  LIFT_DOOR_WIDTH_M: {
    status: 'assumed',
    ref: 'assumed: no seeded lift-door width',
  },
  STAIR_FIRE_HEAT_S: {
    status: 'assumed',
    ref: 'knowledge-seeds/fire-smoke-tenability/fire-growth-spread.pending.json#compartment_to_compartment',
  },
  CROUCH_SPEED_FACTOR: {
    status: 'assumed',
    ref: 'knowledge-seeds/fire-smoke-tenability/#crouch_speed_factor_gap',
  },
  STAIR_CRAWL_FACTOR: { status: 'assumed', ref: 'assumed: no stair crawl speed in any seed' },
  DOSE_TREND_S: { status: 'assumed', ref: 'assumed: four route checks' },
  DOSE_TREND_SAMPLES: {
    status: 'assumed',
    ref: 'assumed: a 6 s least-squares window, long enough to ride out one spiky sample, short against a 30 s crawl',
  },
  DEAD_END_DOSE_MARGIN: {
    status: 'assumed',
    ref: 'calibrated: stair shaft test, blasts at the centre, (4, 1.5), (-3, 0) and (-3, -2), and shafts open with the upper floor alarmed at T+240. The flight is breathed as a blend of its two landings by progress, and projected at crawl pace on the worse storey. With the trend and no margin, realised/projected FED for crawlers carrying 0.005 or more is 0.93 to 1.39 at the four blast sites and 1.16 to 1.58 for survivors of the T+240 scene. Two leaves headroom over 1.58. (Before PR 131, a present-state-only projection gave 2.7 to 4.3; not re-measured.)',
  },
  DEFEND_HORIZON_S: {
    status: 'assumed',
    ref: 'assumed: a receding five-minute look-ahead. The engine has no rescue to wait for, so the question each check asks is whether staying here would incapacitate within the next five minutes, not whether help arrives in time. The linear trend held for 300 s is uncalibrated as a dose; it is read only as at or over 1',
  },
  DEAD_END_OVER_LIMIT_CAP: {
    status: 'assumed',
    ref: 'calibrated: stair shaft test, shafts open, upper floor alarmed at T+240. Crawls started at 0.59-1.29 got out (1.29 realised 0.91); every crawl started at 2.1 or more went down 30-31 s later on the ground floor, or on L1. The cap sits in that gap. At the worst realised/projected ratio (0.80), a crawl started at 1.5 could realise about 1.2: the cap trades a small incapacitation risk for crawls that save people. Applied only when a crawl starts',
  },
  DEAD_END_CRAWL_MAX_FED: {
    status: 'assumed',
    ref: 'assumed: half the ISO 13571 incapacitating dose, applied to the trend projection after DEAD_END_DOSE_MARGIN, so a crawl is refused once about a quarter of the dose is projected unscaled',
  },
  STAIR_MERGE_FLOOR_SHARE: {
    status: 'assumed',
    ref: 'Galea, Sharp & Lawrence (2008), J. Fire Prot. Eng. 18(4) 291-316: merging at the floor-stair interface in high-rise drills runs close to 50:50, with door placement shifting the bias either way. SFPE Handbook 5th ed. ch. 59 (Gwynne & Rosenbaum, Employing the Hydraulic Model in Assessing Emergency Movement) caps the merged flow at the downstream flight. 0.5 is the even case',
  },
  STAIR_REVERSE_LANE_M: {
    status: 'assumed',
    ref: 'Fruin (1971) Pedestrian Planning and Design, and HCM 2000 ch. 18 stairways: a minor reverse flow takes one 30 in (0.76 m) lane. NIST NCSTAR 1-7 (Averill et al. 2005): firefighters ascending 1.1 m WTC stairs put descending occupants into single file. The engine caps the lane at half the effective width',
  },
  STAIR_JAM_DENSITY_PM2: {
    status: 'assumed',
    ref: 'SFPE Handbook 5th ed. ch. 59 (Gwynne & Rosenbaum, after Nelson & Mowrer): S = k(1 - 0.266 D) reaches zero at D = 1/0.266 = 3.76 p/m². Used as the most a flight can hold standing',
  },
  GHOST_ALPHA: { status: 'assumed', ref: 'assumed: UX' },
  MAX_LEVELS: { status: 'assumed', ref: 'PR #23 LAYOUT_LIMITS.maxStoreys' },
};
