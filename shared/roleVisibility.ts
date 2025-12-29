import type { UserRole } from './types.js';

/**
 * Information types that can be visible or hidden based on role
 */
export type InformationType =
  | 'incidents' // All incidents and their details
  | 'incident_locations' // Geographic locations of incidents
  | 'casualties' // Casualty counts and medical data
  | 'resources' // Resource availability and allocations
  | 'intelligence' // Intelligence reports and classified intel
  | 'public_sentiment' // Public sentiment metrics
  | 'media_reports' // Media reports and social media
  | 'infrastructure_status' // Infrastructure and utility status
  | 'decisions' // Decisions made by other agencies
  | 'decision_rationale' // Why decisions were made
  | 'approval_chains' // Who approved what
  | 'financial_data' // Budget and financial information
  | 'political_pressure' // Political pressure indicators
  | 'weather_data' // Weather and environmental data
  | 'ngo_activities' // NGO activities and resources
  | 'defence_assets' // Defence/military asset positions
  | 'police_operations' // Police operation details
  | 'health_capacity' // Healthcare system capacity
  | 'utility_status' // Utility grid status
  | 'civil_government' // Civil government actions
  | 'full_timeline' // Complete timeline of events
  | 'scenario_objectives' // Overall scenario objectives
  | 'ai_injects' // AI-generated event injects
  | 'trainer_notes'; // Trainer notes and observations

/**
 * Role-based visibility configuration
 * Each role can see certain information types, creating blind spots
 * that require inter-agency communication
 */
export const roleVisibility: Record<
  UserRole,
  {
    visible: InformationType[];
    hidden: InformationType[];
    description: string;
  }
> = {
  // TRAINER: Full visibility (no blind spots)
  trainer: {
    visible: [
      'incidents',
      'incident_locations',
      'casualties',
      'resources',
      'intelligence',
      'public_sentiment',
      'media_reports',
      'infrastructure_status',
      'decisions',
      'decision_rationale',
      'approval_chains',
      'financial_data',
      'political_pressure',
      'weather_data',
      'ngo_activities',
      'defence_assets',
      'police_operations',
      'health_capacity',
      'utility_status',
      'civil_government',
      'full_timeline',
      'scenario_objectives',
      'ai_injects',
      'trainer_notes',
    ],
    hidden: [],
    description: 'Full system visibility for exercise oversight',
  },

  // ADMIN: Full visibility
  admin: {
    visible: [
      'incidents',
      'incident_locations',
      'casualties',
      'resources',
      'intelligence',
      'public_sentiment',
      'media_reports',
      'infrastructure_status',
      'decisions',
      'decision_rationale',
      'approval_chains',
      'financial_data',
      'political_pressure',
      'weather_data',
      'ngo_activities',
      'defence_assets',
      'police_operations',
      'health_capacity',
      'utility_status',
      'civil_government',
      'full_timeline',
      'scenario_objectives',
    ],
    hidden: ['ai_injects', 'trainer_notes'],
    description: 'Full system visibility (no trainer notes)',
  },

  // DEFENCE LIAISON: Military/defence perspective
  defence_liaison: {
    visible: [
      'incidents',
      'incident_locations',
      'defence_assets',
      'intelligence',
      'weather_data',
      'resources', // Only defence resources
      'decisions', // Only defence-related decisions
      'scenario_objectives',
      'media_reports', // Public media only
    ],
    hidden: [
      'casualties', // Must request from health
      'health_capacity', // Must request from health
      'police_operations', // Must request from police
      'utility_status', // Must request from utilities
      'public_sentiment', // Must request from PIO
      'financial_data', // Must request from civil government
      'political_pressure', // Must request from civil government
      'ngo_activities', // Must request from NGO liaison
      'decision_rationale', // Limited visibility
      'approval_chains', // Limited visibility
      'infrastructure_status', // Must request from utilities
    ],
    description:
      'Military/defence operations focus. Blind spots: health, police, utilities, public sentiment',
  },

  // POLICE COMMANDER: Law enforcement perspective
  police_commander: {
    visible: [
      'incidents',
      'incident_locations',
      'police_operations',
      'public_sentiment', // Public safety concerns
      'media_reports',
      'decisions', // Only police-related decisions
      'scenario_objectives',
      'weather_data',
    ],
    hidden: [
      'casualties', // Must request from health
      'health_capacity', // Must request from health
      'defence_assets', // Must request from defence
      'intelligence', // Must request from intelligence analyst
      'utility_status', // Must request from utilities
      'financial_data', // Must request from civil government
      'political_pressure', // Must request from civil government
      'ngo_activities', // Must request from NGO liaison
      'resources', // Limited visibility (only police resources)
      'decision_rationale', // Limited visibility
      'approval_chains', // Limited visibility
      'infrastructure_status', // Must request from utilities
    ],
    description: 'Law enforcement focus. Blind spots: health, defence, intelligence, utilities',
  },

  // PUBLIC INFORMATION OFFICER: Media and public communication
  public_information_officer: {
    visible: [
      'media_reports',
      'public_sentiment',
      'decisions', // Public-facing decisions only
      'scenario_objectives',
      'weather_data',
      'incidents', // Public incidents only
    ],
    hidden: [
      'incident_locations', // Exact locations classified
      'casualties', // Must request from health
      'health_capacity', // Must request from health
      'defence_assets', // Must request from defence
      'police_operations', // Must request from police
      'intelligence', // Must request from intelligence analyst
      'utility_status', // Must request from utilities
      'financial_data', // Must request from civil government
      'political_pressure', // Must request from civil government
      'ngo_activities', // Must request from NGO liaison
      'resources', // Limited visibility
      'decision_rationale', // Limited visibility
      'approval_chains', // Limited visibility
      'infrastructure_status', // Must request from utilities
    ],
    description:
      'Public communication focus. Blind spots: classified operations, health data, infrastructure',
  },

  // HEALTH DIRECTOR: Healthcare and medical perspective
  health_director: {
    visible: [
      'casualties',
      'health_capacity',
      'incidents', // Health-related incidents
      'weather_data', // Affects health planning
      'decisions', // Only health-related decisions
      'scenario_objectives',
      'media_reports', // Public health messaging
    ],
    hidden: [
      'incident_locations', // Exact locations must request
      'defence_assets', // Must request from defence
      'police_operations', // Must request from police
      'intelligence', // Must request from intelligence analyst
      'public_sentiment', // Must request from PIO
      'utility_status', // Must request from utilities
      'financial_data', // Must request from civil government
      'political_pressure', // Must request from civil government
      'ngo_activities', // Must request from NGO liaison
      'resources', // Limited visibility (only health resources)
      'decision_rationale', // Limited visibility
      'approval_chains', // Limited visibility
      'infrastructure_status', // Must request from utilities
    ],
    description:
      'Healthcare focus. Blind spots: defence, police, intelligence, utilities, public sentiment',
  },

  // CIVIL GOVERNMENT: Government administration
  civil_government: {
    visible: [
      'financial_data',
      'political_pressure',
      'public_sentiment',
      'decisions', // All government decisions
      'approval_chains', // Government approvals
      'scenario_objectives',
      'media_reports',
      'weather_data',
      'incidents', // Public incidents
    ],
    hidden: [
      'incident_locations', // Exact locations classified
      'casualties', // Must request from health
      'health_capacity', // Must request from health
      'defence_assets', // Must request from defence
      'police_operations', // Must request from police
      'intelligence', // Must request from intelligence analyst
      'utility_status', // Must request from utilities
      'ngo_activities', // Must request from NGO liaison
      'resources', // Limited visibility
      'decision_rationale', // Limited visibility
      'infrastructure_status', // Must request from utilities
    ],
    description:
      'Government administration focus. Blind spots: operational details, health, defence, police',
  },

  // UTILITY MANAGER: Infrastructure and utilities
  utility_manager: {
    visible: [
      'infrastructure_status',
      'utility_status',
      'weather_data',
      'incidents', // Infrastructure-related incidents
      'decisions', // Only utility-related decisions
      'scenario_objectives',
      'resources', // Only utility resources
    ],
    hidden: [
      'incident_locations', // Exact locations must request
      'casualties', // Must request from health
      'health_capacity', // Must request from health
      'defence_assets', // Must request from defence
      'police_operations', // Must request from police
      'intelligence', // Must request from intelligence analyst
      'public_sentiment', // Must request from PIO
      'financial_data', // Must request from civil government
      'political_pressure', // Must request from civil government
      'ngo_activities', // Must request from NGO liaison
      'decision_rationale', // Limited visibility
      'approval_chains', // Limited visibility
      'media_reports', // Limited visibility
    ],
    description:
      'Infrastructure focus. Blind spots: health, defence, police, intelligence, public sentiment',
  },

  // INTELLIGENCE ANALYST: Intelligence and analysis
  intelligence_analyst: {
    visible: [
      'intelligence',
      'incidents',
      'incident_locations',
      'public_sentiment', // For analysis
      'media_reports', // For analysis
      'decisions', // All decisions (for analysis)
      'scenario_objectives',
      'weather_data',
    ],
    hidden: [
      'casualties', // Must request from health
      'health_capacity', // Must request from health
      'defence_assets', // Must request from defence
      'police_operations', // Must request from police
      'utility_status', // Must request from utilities
      'financial_data', // Must request from civil government
      'political_pressure', // Must request from civil government
      'ngo_activities', // Must request from NGO liaison
      'resources', // Limited visibility
      'decision_rationale', // Limited visibility
      'approval_chains', // Limited visibility
      'infrastructure_status', // Must request from utilities
    ],
    description:
      'Intelligence analysis focus. Blind spots: operational details, health, utilities, financial',
  },

  // NGO LIAISON: Non-governmental organizations
  ngo_liaison: {
    visible: [
      'ngo_activities',
      'casualties', // For humanitarian aid
      'public_sentiment', // For community needs
      'media_reports',
      'decisions', // Only NGO-related decisions
      'scenario_objectives',
      'weather_data',
      'incidents', // Public incidents
    ],
    hidden: [
      'incident_locations', // Exact locations classified
      'health_capacity', // Must request from health
      'defence_assets', // Must request from defence
      'police_operations', // Must request from police
      'intelligence', // Must request from intelligence analyst
      'utility_status', // Must request from utilities
      'financial_data', // Must request from civil government
      'political_pressure', // Must request from civil government
      'resources', // Limited visibility (only NGO resources)
      'decision_rationale', // Limited visibility
      'approval_chains', // Limited visibility
      'infrastructure_status', // Must request from utilities
    ],
    description:
      'NGO/humanitarian focus. Blind spots: classified operations, infrastructure, financial, political',
  },
};

/**
 * Check if a role can see a specific information type
 */
export function canSee(role: UserRole, informationType: InformationType): boolean {
  return roleVisibility[role].visible.includes(informationType);
}

/**
 * Get all hidden information types for a role (blind spots)
 */
export function getBlindSpots(role: UserRole): InformationType[] {
  return roleVisibility[role].hidden;
}

/**
 * Get role description
 */
export function getRoleDescription(role: UserRole): string {
  return roleVisibility[role].description;
}
