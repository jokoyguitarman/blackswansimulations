/**
 * CounterDefinition — shared type for scenario-driven team counters.
 *
 * Stored as JSONB array on scenario_teams.counter_definitions.
 * The game engine uses the `behavior` + `config` fields to know how each
 * counter should change during play (time ticks, player decisions, etc.).
 */

export type CounterBehavior =
  | 'time_rate'
  | 'decision_toggle'
  | 'decision_increment'
  | 'derived'
  | 'state_effect'
  | 'static';

export interface CounterDefinition {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'enum';
  initial_value: number | boolean | string;
  behavior: CounterBehavior;
  visible_to?: 'all' | 'trainer_only';
  config?: CounterConfig;
}

export interface CounterConfig {
  // time_rate
  base_rate_per_min?: number;
  cap_key?: string;
  requires_flag?: string;
  robustness_affects?: boolean;
  robustness_low_mult?: number;
  robustness_high_mult?: number;
  congestion_halves?: boolean;
  impact_sensitive?: boolean;
  rate_modifier_key?: string;
  marshal_boost_key?: string;
  marshal_boost_mult?: number;

  // decision_toggle / decision_increment
  keywords?: string[];
  categories?: string[];

  // derived — robustness-driven split fractions
  source_pool_key?: string;
  pool_fraction?: number;
  rate_key?: string;
  split_fractions?: Record<string, number>;
  split_fractions_low?: Record<string, number>;
  split_fractions_high?: Record<string, number>;

  // enum
  values?: string[];
}
