/**
 * Scenario Condition Config Service
 * Returns condition_keys and keyword_patterns for a scenario based on its type (from initial_state or inferred from teams).
 * Used by TrainerEnvironmentalTruths and scenarioStateService.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ConditionKeyDef {
  key: string;
  meaning: string;
  team?: string;
  /** Dot-separated path into currentState, e.g. "police_state.perimeter_established" */
  state_path?: string;
  /** When true, invert the resolved value (e.g. "not established" = !value) */
  negate?: boolean;
}

export interface KeywordPatternDef {
  category: string;
  keywords: string[];
  state_key?: string;
}

export interface ScenarioConditionConfig {
  condition_keys: ConditionKeyDef[];
  keyword_patterns: KeywordPatternDef[];
  scenario_type?: string;
}

const MCI_CONDITION_KEYS: ConditionKeyDef[] = [
  {
    key: 'evacuation_no_flow_control_decision',
    meaning: 'No decision matches flow/bottleneck/exit capacity keywords',
    team: 'evacuation',
  },
  {
    key: 'evacuation_flow_control_decided',
    meaning: 'evacuation_state.flow_control_decided === true',
    team: 'evacuation',
  },
  {
    key: 'evacuation_exit_bottleneck_active',
    meaning: 'exits_congested non-empty (unmanaged)',
    team: 'evacuation',
  },
  {
    key: 'evacuation_coordination_established',
    meaning: 'evacuation_state.coordination_with_triage === true',
    team: 'evacuation',
  },
  {
    key: 'triage_zone_established_as_incident_location',
    meaning: 'Decision mentions triage zone',
    team: 'triage',
  },
  {
    key: 'triage_supply_critical',
    meaning: 'triage_state.supply_level === critical',
    team: 'triage',
  },
  { key: 'triage_surge_active', meaning: 'triage_state.surge_active === true', team: 'triage' },
  {
    key: 'triage_no_prioritisation_decision',
    meaning: 'No decision matches prioritisation keywords',
    team: 'triage',
  },
  {
    key: 'triage_prioritisation_decided',
    meaning: 'triage_state.prioritisation_decided === true',
    team: 'triage',
  },
  {
    key: 'media_statement_issued',
    meaning: 'media_state.first_statement_issued === true',
    team: 'media',
  },
  {
    key: 'media_no_statement_by_T12',
    meaning: 'elapsedMinutes >= 12 and no statement',
    team: 'media',
  },
  {
    key: 'media_misinformation_addressed',
    meaning: 'media_state.misinformation_addressed === true',
    team: 'media',
  },
];

const MCI_KEYWORD_PATTERNS: KeywordPatternDef[] = [
  {
    category: 'Flow control (evac)',
    keywords: ['flow', 'bottleneck', 'stagger', 'congestion', 'egress', 'exit capacity'],
    state_key: 'evacuation_state.flow_control_decided',
  },
  {
    category: 'Supply/equipment (triage)',
    keywords: ['supply', 'request', 'tourniquet', 'stretcher', 'shortage'],
    state_key: 'triage_state.supply_request_made',
  },
  {
    category: 'Prioritisation (triage)',
    keywords: ['prioritise', 'critical first', 'severity', 'triage protocol'],
    state_key: 'triage_state.prioritisation_decided',
  },
  {
    category: 'Statement (media)',
    keywords: ['statement', 'press', 'announce', 'release'],
    state_key: 'media_state.first_statement_issued',
  },
  {
    category: 'Misinformation (media)',
    keywords: ['debunk', 'counter', 'correct', 'misinformation', 'rumour'],
    state_key: 'media_state.misinformation_addressed',
  },
];

function getTemplatesDir(): string {
  const candidates = [
    path.join(__dirname, '../../scenario_templates'),
    path.join(process.cwd(), 'scenario_templates'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(process.cwd(), 'scenario_templates');
}

function loadTemplate(scenarioType: string): Record<string, unknown> | null {
  try {
    const filePath = path.join(getTemplatesDir(), 'scenario_types', `${scenarioType}.json`);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isMCITeams(teamNames: string[]): boolean {
  const lower = teamNames.map((t) => (t || '').toLowerCase());
  return (
    lower.some((t) => /evacuation|evac/.test(t)) &&
    lower.some((t) => /triage/.test(t)) &&
    lower.some((t) => /media/.test(t))
  );
}

/**
 * Get condition_keys and keyword_patterns for a scenario.
 * Uses scenario_type from initial_state if present; otherwise infers from scenario_teams.
 * Falls back to MCI defaults when teams match Evac/Triage/Media.
 */
export async function getConditionConfigForScenario(
  scenarioId: string,
): Promise<ScenarioConditionConfig> {
  const { data: scenario, error: scenarioError } = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', scenarioId)
    .single();

  if (scenarioError || !scenario) {
    return { condition_keys: MCI_CONDITION_KEYS, keyword_patterns: MCI_KEYWORD_PATTERNS };
  }

  const initialState = (scenario.initial_state as Record<string, unknown>) || {};
  const scenarioType = initialState.scenario_type as string | undefined;

  if (scenarioType) {
    const template = loadTemplate(scenarioType);
    if (template) {
      const conditionKeys = (template.condition_keys as ConditionKeyDef[] | undefined) ?? [];
      const keywordPatterns = (template.keyword_patterns as KeywordPatternDef[] | undefined) ?? [];
      if (conditionKeys.length > 0 || keywordPatterns.length > 0) {
        return {
          condition_keys: conditionKeys.length > 0 ? conditionKeys : MCI_CONDITION_KEYS,
          keyword_patterns: keywordPatterns.length > 0 ? keywordPatterns : MCI_KEYWORD_PATTERNS,
          scenario_type: scenarioType,
        };
      }
    }
  }

  const { data: teams } = await supabaseAdmin
    .from('scenario_teams')
    .select('team_name')
    .eq('scenario_id', scenarioId);

  const teamNames = (teams ?? []).map((t) => (t as { team_name: string }).team_name);

  if (isMCITeams(teamNames)) {
    return {
      condition_keys: MCI_CONDITION_KEYS,
      keyword_patterns: MCI_KEYWORD_PATTERNS,
      scenario_type: scenarioType ?? 'car_bomb',
    };
  }

  const lower = teamNames.map((t) => (t || '').toLowerCase());
  const hasPolice = lower.some((t) => /police|negotiation|intelligence/.test(t));
  const hasCloseProtection = lower.some((t) => /close_protection|protection|vip/.test(t));
  const hasCrowdMgmt = lower.some((t) => /crowd_management|crowd/.test(t));
  const hasEventSecurity = lower.some((t) => /event_security|venue/.test(t));
  const hasTransit = lower.some((t) => /transit_security|transit|platform/.test(t));
  const hasBombSquad = lower.some((t) => /bomb_squad|bomb|eod/.test(t));
  const hasMallSecurity = lower.some((t) => /mall_security|mall/.test(t));
  const hasResort = lower.some((t) => /resort_security|resort/.test(t));
  const hasFireHazmat = lower.some((t) => /fire_hazmat|hazmat/.test(t));
  const hasPublicHealth = lower.some((t) => /public_health/.test(t));
  const hasNegotiation = lower.some((t) => /negotiation/.test(t));

  let inferredType: string;
  if (hasCloseProtection && hasPolice) {
    inferredType = 'assassination';
  } else if (hasNegotiation && hasResort) {
    inferredType = 'kidnapping';
  } else if (hasNegotiation && hasPolice) {
    inferredType = 'hostage_siege';
  } else if (hasBombSquad && hasMallSecurity) {
    inferredType = 'bombing_mall';
  } else if (hasBombSquad) {
    inferredType = 'bombing';
  } else if (hasMallSecurity) {
    inferredType = 'active_shooter';
  } else if (hasPublicHealth || (hasFireHazmat && !hasBombSquad)) {
    inferredType = 'poisoning';
  } else if (hasFireHazmat) {
    inferredType = 'gas_attack';
  } else if (hasCrowdMgmt || (hasEventSecurity && !hasPolice)) {
    inferredType = 'stampede_crush';
  } else if (hasTransit) {
    inferredType = 'knife_attack';
  } else if (hasResort) {
    inferredType = 'kidnapping';
  } else if (hasPolice) {
    inferredType = 'car_bomb';
  } else {
    inferredType = 'car_bomb';
  }
  const template = loadTemplate(inferredType);
  if (template) {
    const conditionKeys = (template.condition_keys as ConditionKeyDef[] | undefined) ?? [];
    const keywordPatterns = (template.keyword_patterns as KeywordPatternDef[] | undefined) ?? [];
    return {
      condition_keys: conditionKeys.length > 0 ? conditionKeys : MCI_CONDITION_KEYS,
      keyword_patterns: keywordPatterns.length > 0 ? keywordPatterns : MCI_KEYWORD_PATTERNS,
      scenario_type: inferredType,
    };
  }

  return {
    condition_keys: MCI_CONDITION_KEYS,
    keyword_patterns: MCI_KEYWORD_PATTERNS,
  };
}
