import { env } from '../../env.js';
import { PERSONA_PER_COUNTRY_CAP, PERSONA_PER_COUNTRY_FLOOR } from '../personaBudget.js';
import {
  estimateBuildCalls as estimateBuildCallsWith,
  explainBuildCalls as explainBuildCallsWith,
  type BuildEstimateInput,
  type BuildEstimateOptions,
} from '../../../shared/buildEstimate.js';

export type {
  BuildCallBreakdown,
  BuildEstimateInput,
  BuildEstimateOptions,
} from '../../../shared/buildEstimate.js';
export { stakeholderCallsFor } from '../../../shared/buildEstimate.js';

function envOptions(over?: Partial<BuildEstimateOptions>): BuildEstimateOptions {
  return {
    personasTotalMax: over?.personasTotalMax ?? env.socialPersonasTotalMax,
    pageBatch: over?.pageBatch ?? env.warroomOrgPageBatch,
    personaCap: over?.personaCap ?? PERSONA_PER_COUNTRY_CAP,
    personaFloor: over?.personaFloor ?? PERSONA_PER_COUNTRY_FLOOR,
    dependencyMapBatchTeams: over?.dependencyMapBatchTeams ?? env.warroomDependencyMapBatchTeams,
    dependencyUpstreamPerTeam: over?.dependencyUpstreamPerTeam ?? env.warroomDependencyUpstreamPerTeam,
    dependencyConsequenceBatch:
      over?.dependencyConsequenceBatch ?? env.warroomDependencyConsequenceBatch,
  };
}

/** Live budgets from `server/env.ts`. The pure count lives in `shared/buildEstimate.ts`. */
export function explainBuildCalls(input: BuildEstimateInput, over?: Partial<BuildEstimateOptions>) {
  return explainBuildCallsWith(input, envOptions(over));
}

export function estimateBuildCalls(
  input: BuildEstimateInput,
  over?: Partial<BuildEstimateOptions>,
): number {
  return estimateBuildCallsWith(input, envOptions(over));
}
