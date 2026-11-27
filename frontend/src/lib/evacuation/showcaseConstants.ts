/** Evacuation showcase constants. Every value is pending review or labelled assumed. */
export const SHOWCASE = {
  BLAST_AT_GAME_S: 60,
  BANNER_S: 4,
  FX_FLASH_S: 0.25,
  FX_RING_S: 1.2,
  FX_FIREBALL_S: 3.0,
  FX_SHAKE_S: 0.6,
  FX_SHAKE_PX: 8,
  FREE_WALK_SPEED: 1.19,
  OUTDOOR_RUN_SPEED: 2.14,
  OUTDOOR_WALK_SPEED: 1.44,
  RUN_DISTANCE_M: 50,
  RUN_DENSITY_LIMIT: 1.65,
  STAFF_SHARE: 0.1,
  SHOWCASE_PANIC: 0.5,
  IDLE_WANDER_SPEED: 0.5,
  IDLE_WANDER_RADIUS_M: 4,
  CRAWL_SPEED: 0.71,
  SMOKE_SPEED_MIN: 0.2,
  JIN_A: 1.0573,
  JIN_B: 0.4326,
  VIS_K_REFLECTIVE: 3,
  VIS_K_LIT_SIGN: 8,
  D_TO_K_POINTS: [
    [0, 0],
    [0.05, 0.25],
    [0.2, 0.375],
    [0.4, 1.0],
    [0.6, 3.0],
    [0.8, 6.0],
    [1.0, 6.1],
  ],
  SMOKE_HEAD_ONSET: 0.2,
  CROUCH_EXTINCTION_VISITOR: 0.15,
  CROUCH_EXTINCTION_STAFF: 0.5,
  LAYER_STEP_D: 0.2,
  REROUTE_EXTINCTION: 1.5,
  /** An exit that has gone unusable is usable again only below this. */
  REROUTE_RECOVER: 1.3,
  REROUTE_COST_RATIO: 1.5,
  LOOKAHEAD_SAMPLES_M: [3, 6, 9],
  CROUCH_SPEED_FACTOR: 0.6,
  POSTURE_RELEASE: 0.8,
  TURN_BACK_PERMILLE: 300,
  /** How long a turn-back keeps that exit off the list. The roll itself is one-time. */
  TURN_BACK_HOLD_S: 30,
  /**
   * Share of evacuees, per thousand, who freeze the first time smoke or fire
   * reaches them. Only a marshal ends a freeze.
   */
  FREEZE_PERMILLE: 50,
  /** Extinction at the person's position, per metre, that counts as smoke reaching them. */
  FREEZE_TRIGGER_K: 1.0,
  /** A responder this close gets a frozen person moving again. */
  FREEZE_RELEASE_M: 1.5,
  FIRE_AVOID_RADIUS_M: 5.0,
  HEAT_AVOID_RADIUS_M: 2,
  SAMPLE_STEP_M: 1.5,
  SMOKE_COST_M_PER_K: 10,
  CONGESTED_PENALTY_M: 15,
  REROUTE_CHECK_S: 0.5,
  REROUTE_HYSTERESIS: 0.2,
  PREMOVE_MEDIAN_S: 30,
  PREMOVE_SIGMA_LN: 0.8144,
  PREMOVE_MIN_S: 12,
  PREMOVE_MAX_S: 150,
  ASSEMBLY_MIN_DISTANCE_M: 20,
  BUILDING_STOREY_HEIGHT_M: 4.0,
  LETHAL_RING_FRACTION: 0.293,
  SERIOUS_RING_FRACTION: 0.444,
  MINOR_RING_FRACTION: 1.0,
  DEFAULT_BLAST_RADIUS_M: 20,
  MINOR_INJURY_SPEED_FACTOR: 0.6,
  BLAST_PUSH_SPEED: 2,
  ZONE_UNSAFE_FACTOR: 3.0,
  DISPERSE_SHARE: 0.3,
  MAP_MARGIN_M: 40,
  LEAVE_OVERSHOOT_M: 10,
  AMBIENT_HEAT_S: 30,
  RNG_SEED: 1337,
  /** Persons per second per metre of effective width. Seed pending. */
  MAX_SPECIFIC_FLOW: 1.3,
  /** Boundary layer each side of a door or exit, metres. Seed pending. */
  BOUNDARY_LAYER_DOOR_M: 0.15,
} as const;

export type ShowcaseKey = keyof typeof SHOWCASE;
export type ShowcaseValueStatus = 'seed_pending' | 'assumed';

export interface ShowcaseValueSource {
  status: ShowcaseValueStatus;
  /** Seed file and key, or the knowledge-seeds folder expected to replace an assumed value. */
  ref: string;
}

export const SHOWCASE_SOURCES: Record<ShowcaseKey, ShowcaseValueSource> = {
  BLAST_AT_GAME_S: { status: 'assumed', ref: 'assumed: user requirement, no research needed' },
  BANNER_S: { status: 'assumed', ref: 'assumed: UX, no research needed' },
  FX_FLASH_S: { status: 'assumed', ref: 'assumed: visual, no research needed' },
  FX_RING_S: { status: 'assumed', ref: 'assumed: visual, no research needed' },
  FX_FIREBALL_S: { status: 'assumed', ref: 'assumed: visual, no research needed' },
  FX_SHAKE_S: { status: 'assumed', ref: 'assumed: visual, no research needed' },
  FX_SHAKE_PX: { status: 'assumed', ref: 'assumed: visual, no research needed' },
  FREE_WALK_SPEED: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#free_walk_speed',
  },
  OUTDOOR_RUN_SPEED: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/outdoor-evacuation.pending.json#running_crowd_speeds',
  },
  OUTDOOR_WALK_SPEED: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/outdoor-evacuation.pending.json#running_crowd_speeds',
  },
  RUN_DISTANCE_M: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/README.md#dispersal_beyond_50_m',
  },
  RUN_DENSITY_LIMIT: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/outdoor-evacuation.pending.json#running_crowd_speeds',
  },
  STAFF_SHARE: { status: 'assumed', ref: 'assumed: no research stream' },
  SHOWCASE_PANIC: { status: 'assumed', ref: 'assumed: no research stream' },
  IDLE_WANDER_SPEED: { status: 'assumed', ref: 'assumed: no research stream' },
  IDLE_WANDER_RADIUS_M: { status: 'assumed', ref: 'assumed: no research stream' },
  CRAWL_SPEED: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#crawl_speed',
  },
  SMOKE_SPEED_MIN: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#smoke_speed_min',
  },
  JIN_A: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/exposure-reference.pending.json#jin_speed_nonirritant_fit',
  },
  JIN_B: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/exposure-reference.pending.json#jin_speed_nonirritant_fit',
  },
  VIS_K_REFLECTIVE: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#visibility_k_reflective',
  },
  VIS_K_LIT_SIGN: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/smoke-movement.pending.json#visibility_constant_by_object',
  },
  D_TO_K_POINTS: {
    status: 'assumed',
    ref: 'assumed: mapping anchored at knowledge-seeds/fire-smoke-tenability/worked-examples.pending.json#soot_visibility',
  },
  SMOKE_HEAD_ONSET: {
    status: 'assumed',
    ref: 'assumed: display mapping; knowledge-seeds/fire-smoke-tenability/smoke-movement.pending.json#yamana_tanaka_layer_height is out of scope',
  },
  CROUCH_EXTINCTION_VISITOR: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/tenability-response.pending.json#jin_tenable_smoke_density',
  },
  CROUCH_EXTINCTION_STAFF: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/tenability-response.pending.json#jin_tenable_smoke_density',
  },
  LAYER_STEP_D: {
    status: 'assumed',
    ref: 'assumed: sandbox pseudo-layer offset (knowledge-seeds/fire-smoke-tenability/)',
  },
  REROUTE_EXTINCTION: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/tenability-response.pending.json#bryan_wood_smoke_movement',
  },
  REROUTE_RECOVER: { status: 'assumed', ref: 'assumed: numerical hysteresis' },
  REROUTE_COST_RATIO: { status: 'assumed', ref: 'assumed: PR #23 §6.30 main-game rule' },
  LOOKAHEAD_SAMPLES_M: { status: 'assumed', ref: 'assumed: PR #23 §6.30 next three route studs' },
  CROUCH_SPEED_FACTOR: {
    status: 'assumed',
    ref: 'assumed: gap (knowledge-seeds/fire-smoke-tenability/tenability-response.pending.json#crouch_speed_factor_gap)',
  },
  POSTURE_RELEASE: { status: 'assumed', ref: 'assumed: numerical hysteresis' },
  TURN_BACK_PERMILLE: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/tenability-response.pending.json#bryan_wood_smoke_movement',
  },
  TURN_BACK_HOLD_S: { status: 'assumed', ref: 'assumed: numerical' },
  FREEZE_PERMILLE: {
    status: 'assumed',
    ref: 'assumed: within Leach 2004 (Aviat Space Environ Med 75(6):539-542), 10-15% behave inappropriately incl. freezing, an observational heuristic; above Fahy, Proulx and Aiman 2012 (Fire and Materials 36(5-6):328-342), panic and nonadaptive behaviour rare in fires. A freeze lasts until a marshal arrives; nothing else ends it',
  },
  FREEZE_TRIGGER_K: { status: 'assumed', ref: 'assumed: smoke a person can see around them' },
  FREEZE_RELEASE_M: { status: 'assumed', ref: 'assumed: arm-reach plus a step' },
  FIRE_AVOID_RADIUS_M: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/fire-growth-spread.pending.json#point_source_radiation',
  },
  HEAT_AVOID_RADIUS_M: {
    status: 'assumed',
    ref: 'assumed: no seed applies (knowledge-seeds/fire-smoke-tenability/)',
  },
  SAMPLE_STEP_M: { status: 'assumed', ref: 'assumed: numerical' },
  SMOKE_COST_M_PER_K: { status: 'assumed', ref: 'assumed: no research stream' },
  CONGESTED_PENALTY_M: { status: 'assumed', ref: 'assumed: no research stream' },
  REROUTE_CHECK_S: { status: 'assumed', ref: 'assumed: numerical' },
  REROUTE_HYSTERESIS: { status: 'assumed', ref: 'assumed: numerical' },
  PREMOVE_MEDIAN_S: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/tenability-response.pending.json#pretravel_measured_store',
  },
  PREMOVE_SIGMA_LN: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/tenability-response.pending.json#pretravel_measured_store',
  },
  PREMOVE_MIN_S: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/tenability-response.pending.json#pretravel_measured_store',
  },
  PREMOVE_MAX_S: {
    status: 'assumed',
    ref: 'assumed: cap (knowledge-seeds/fire-smoke-tenability/tenability-response.pending.json#pretravel_measured_store)',
  },
  ASSEMBLY_MIN_DISTANCE_M: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/fire-smoke-tenability/outdoor-evacuation.pending.json#scdf_assembly_area_distance',
  },
  BUILDING_STOREY_HEIGHT_M: {
    status: 'assumed',
    ref: 'assumed: knowledge-seeds/building-hazards/README.md storey heights not found',
  },
  LETHAL_RING_FRACTION: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/blast-effects/worked-examples.pending.json#threshold_radii_10kg_tnt',
  },
  SERIOUS_RING_FRACTION: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/blast-effects/worked-examples.pending.json#threshold_radii_10kg_tnt',
  },
  MINOR_RING_FRACTION: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/blast-effects/injury-thresholds.pending.json#minor_injury_onset',
  },
  DEFAULT_BLAST_RADIUS_M: {
    status: 'assumed',
    ref: 'assumed: illustrative charge (knowledge-seeds/blast-effects/worked-examples.pending.json#threshold_radii_10kg_tnt)',
  },
  MINOR_INJURY_SPEED_FACTOR: {
    status: 'assumed',
    ref: 'assumed: gap in knowledge-seeds/blast-effects/',
  },
  BLAST_PUSH_SPEED: {
    status: 'assumed',
    ref: 'assumed: visual; knowledge-seeds/blast-effects/human-vulnerability.pending.json has no displacement speed',
  },
  ZONE_UNSAFE_FACTOR: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/blast-effects/worked-examples.pending.json#threshold_radii_10kg_tnt',
  },
  DISPERSE_SHARE: { status: 'assumed', ref: 'assumed: no research stream' },
  MAP_MARGIN_M: { status: 'assumed', ref: 'assumed: layout, no research needed' },
  LEAVE_OVERSHOOT_M: { status: 'assumed', ref: 'assumed: layout, no research needed' },
  AMBIENT_HEAT_S: {
    status: 'assumed',
    ref: 'assumed: gap (knowledge-seeds/fire-smoke-tenability/fire-growth-spread.pending.json#flame_spread_rates)',
  },
  RNG_SEED: { status: 'assumed', ref: 'assumed: replayability' },
  MAX_SPECIFIC_FLOW: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#max_specific_flow',
  },
  BOUNDARY_LAYER_DOOR_M: {
    status: 'seed_pending',
    ref: 'knowledge-seeds/physics-movement/movement-parameters.pending.json#boundary_layer_door',
  },
};
