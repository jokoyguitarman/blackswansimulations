/**
 * Consequence triggers are level checks that fire once per session.
 * narrative_recovering and narrative_collapsing re-arm when narrative_control
 * crosses back through 35, so a later collapse or recovery can fire again.
 */

export interface ConsequenceTriggerState {
  oldest_unaddressed_hate_minutes: number;
  oldest_unaddressed_misinfo_minutes: number;
  official_statement_published: boolean;
  strategic_ratio: number;
  tier1_reactive_actions: number;
  rally_call_active: boolean;
  community_leader_contacted: boolean;
  narrative_control: number;
}

export interface ConsequenceTriggerPlan {
  fire: string[];
  fired: string[];
}

const NARRATIVE_REARM = 35;

export function planConsequenceTriggers(
  state: ConsequenceTriggerState,
  elapsedMinutes: number,
  firedList: readonly string[],
): ConsequenceTriggerPlan {
  const fired = new Set(firedList);
  if (state.narrative_control > NARRATIVE_REARM) fired.delete('narrative_collapsing');
  if (state.narrative_control < NARRATIVE_REARM) fired.delete('narrative_recovering');

  const candidates: Array<[string, boolean]> = [
    ['hate_unaddressed_10min', state.oldest_unaddressed_hate_minutes > 10],
    ['misinfo_unaddressed_10min', state.oldest_unaddressed_misinfo_minutes > 10],
    ['no_statement_20min', elapsedMinutes > 20 && !state.official_statement_published],
    ['no_statement_35min', elapsedMinutes > 35 && !state.official_statement_published],
    ['trench_warfare', state.strategic_ratio < 0.2 && state.tier1_reactive_actions > 6],
    ['rally_gaining_traction', state.rally_call_active],
    ['leader_contacted', state.community_leader_contacted],
    ['statement_published', state.official_statement_published],
    ['narrative_recovering', state.narrative_control > 50],
    ['narrative_collapsing', state.narrative_control < 20],
  ];

  const fire: string[] = [];
  for (const [id, active] of candidates) {
    if (!active || fired.has(id)) continue;
    fire.push(id);
    fired.add(id);
  }
  return { fire, fired: [...fired] };
}
