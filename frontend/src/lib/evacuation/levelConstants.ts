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
  GHOST_ALPHA: 0.15,
  MAX_LEVELS: 12,
} as const;

export const LEVEL_SOURCES: Record<keyof typeof LEVEL, { status: 'seed_pending' | 'assumed'; ref: string }> = {
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
  GHOST_ALPHA: { status: 'assumed', ref: 'assumed: UX' },
  MAX_LEVELS: { status: 'assumed', ref: 'PR #23 LAYOUT_LIMITS.maxStoreys' },
};
