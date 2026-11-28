import { mergeSpokespersonLinks } from '../../../shared/pressureOrgLinks.js';
import { usablePeaceFeed } from '../generation/peaceFeedCore.js';
import type { CrisisContext } from '../multiOrgGenerationService.js';
import { crisisContextFrom, type DecisionContext } from '../multiOrgPipeline.js';
import type { NPCPersona, SocialInject } from '../socialCrisisGeneratorService.js';
import type {
  BuildRequest,
  BuildStage,
  CharactersOutput,
  ConvergenceOutput,
  PagesOutput,
  ReviewPayload,
  StageOutputs,
  StorylineOutput,
} from './buildTypes.js';

export const EMPTY_DECISION: DecisionContext = {
  leakiness: 0.5,
  labour_signal: false,
  product_safety_signal: false,
};

export interface CharactersStageInput {
  stage: 'characters';
  request: BuildRequest;
}

export interface StorylineStageInput {
  stage: 'storyline';
  request: BuildRequest;
  personas: NPCPersona[];
  fact_sheet: CharactersOutput['fact_sheet'];
  /** Present on a setup-edit build. The characters stage already paid for the diff. */
  brief_diff?: unknown;
  swap_premise?: string | null;
  prior_retired_keys?: string[];
}

export interface ConvergenceStageInput {
  stage: 'convergence';
  request: BuildRequest;
  crisisCtx: {
    crisisType: string;
    location: '';
    country: string;
    context: string;
    duration: number;
  };
  teamStorylines: Record<string, SocialInject[]>;
  personas: NPCPersona[];
  factSheet: CharactersOutput['fact_sheet'];
  stakeholders: StorylineOutput['stakeholders'];
  stakeholderInjects: SocialInject[];
  teamCharters?: StorylineOutput['team_charters'];
  brief_diff?: unknown;
  swap_premise?: string | null;
  prior_retired_keys?: string[];
}

export interface PagesStageInput {
  stage: 'pages';
  request: BuildRequest;
  pressure_organisations: BuildRequest['pressure_organisations'];
  stakeholders: StorylineOutput['stakeholders'];
  fact_sheet: CharactersOutput['fact_sheet'];
  crisis: CrisisContext;
  brief_diff?: unknown;
  swap_premise?: string | null;
  prior_retired_keys?: string[];
  /** Characters and storyline twins. The pages runner adds its own twins. */
  personas: NPCPersona[];
}

export type StageInput =
  CharactersStageInput | StorylineStageInput | ConvergenceStageInput | PagesStageInput;

function requireCharacters(outputs: StageOutputs): CharactersOutput {
  if (!outputs.characters) throw new Error('stage input requires characters output');
  return outputs.characters;
}

function requireStoryline(outputs: StageOutputs): StorylineOutput {
  if (!outputs.storyline) throw new Error('stage input requires storyline output');
  return outputs.storyline;
}

/** Characters, then storyline twins. First handle wins. Pages twins are not included. */
export function personasAfterStoryline(
  characters: CharactersOutput,
  storyline: Pick<StorylineOutput, 'persona_twins'>,
): NPCPersona[] {
  return dedupeByHandle([...(characters.personas ?? []), ...(storyline.persona_twins ?? [])]);
}

function dedupeByHandle(personas: NPCPersona[]): NPCPersona[] {
  const seen = new Set<string>();
  const out: NPCPersona[] = [];
  for (const persona of personas) {
    if (seen.has(persona.handle)) continue;
    seen.add(persona.handle);
    out.push(persona);
  }
  return out;
}

function pagesUsable(pages: PagesOutput | undefined): pages is PagesOutput {
  return !!pages && pages.skipped !== true;
}

/**
 * What a stage runner receives. Derived only from the frozen request and earlier outputs (§4.3).
 */
export function stageInput(
  stage: BuildStage,
  request: BuildRequest,
  outputs: StageOutputs,
): StageInput {
  if (stage === 'characters') return { stage, request };
  const characters = requireCharacters(outputs);
  const characterRow = characters as CharactersOutput & {
    brief_diff?: unknown;
    swap_premise?: string | null;
    revisions?: Array<{ decision?: string; inject_key?: string }>;
  };
  const editBase =
    request.mode === 'setup_edit'
      ? {
          brief_diff: characterRow.brief_diff ?? null,
          swap_premise: characterRow.swap_premise ?? null,
        }
      : null;
  const retiredSoFar = request.mode === 'setup_edit' ? retiredInjectKeys(characterRow) : [];
  if (stage === 'storyline') {
    return {
      stage,
      request,
      personas: characters.personas,
      fact_sheet: characters.fact_sheet,
      ...(editBase ? { ...editBase, prior_retired_keys: retiredSoFar } : {}),
    };
  }
  const storyline = requireStoryline(outputs);
  if (stage === 'convergence') {
    const injects = storyline.injects ?? [];
    return {
      stage,
      request,
      crisisCtx: {
        crisisType: request.crisis_type,
        location: '',
        country: request.country,
        context: request.context,
        duration: request.duration,
      },
      teamStorylines: {
        ...storyline.team_storylines,
        ...(injects.length > 0 ? { Shared: injects } : {}),
      },
      personas: personasAfterStoryline(characters, storyline),
      factSheet: characters.fact_sheet,
      stakeholders: storyline.stakeholders ?? [],
      stakeholderInjects: storyline.stakeholder_injects ?? [],
      teamCharters: storyline.team_charters ?? [],
      ...(editBase
        ? { ...editBase, prior_retired_keys: [...retiredSoFar, ...retiredInjectKeys(storyline)] }
        : {}),
    };
  }
  return {
    stage,
    request,
    pressure_organisations: mergeSpokespersonLinks(
      request.pressure_organisations,
      (storyline.pressure_organisations ?? []).map((org) => ({
        display_name: org.display_name,
        org_key: org.org_key,
        spokesperson_stakeholder_id: org.spokesperson_stakeholder_id,
      })),
    ),
    stakeholders: storyline.stakeholders ?? [],
    fact_sheet: characters.fact_sheet,
    crisis: crisisContextFrom({
      crisis_type: request.crisis_type,
      context: request.crisis_type,
      duration: 60,
      org_name: request.org_name,
    }),
    personas: personasAfterStoryline(characters, storyline),
    ...(editBase
      ? {
          ...editBase,
          prior_retired_keys: [
            ...retiredSoFar,
            ...retiredInjectKeys(storyline),
            ...retiredInjectKeys(outputs.convergence),
          ],
        }
      : {}),
  };
}

function retiredInjectKeys(output: { revisions?: Array<{ decision?: string; inject_key?: string }> } | undefined): string[] {
  return (output?.revisions ?? [])
    .filter((revision) => revision.decision === 'retire' && typeof revision.inject_key === 'string')
    .map((revision) => revision.inject_key as string);
}

function appendIntel(
  teamStorylines: Record<string, SocialInject[]>,
  intel: Record<string, SocialInject[]> | undefined,
): Record<string, SocialInject[]> {
  const next: Record<string, SocialInject[]> = {};
  for (const [team, injects] of Object.entries(teamStorylines)) {
    next[team] = [...injects];
  }
  for (const [team, injects] of Object.entries(intel ?? {})) {
    if (!Array.isArray(injects) || injects.length === 0) continue;
    next[team] = [...(next[team] ?? []), ...injects];
  }
  return next;
}

function stakeholderInjects(
  storyline: StorylineOutput | undefined,
  pages: PagesOutput | undefined,
): SocialInject[] {
  const base = [...(storyline?.stakeholder_injects ?? [])];
  const fresh = pagesUsable(pages) ? (pages.pressure_injects ?? []) : [];
  if (fresh.length === 0) return base;
  return [...base.filter((inject) => !inject.delivery_config?.page_org_key), ...fresh];
}

function firstList<T>(camel: T[] | undefined, snake: T[] | undefined): T[] {
  return camel ?? snake ?? [];
}

function dimensionLabels(
  convergence: ConvergenceOutput | undefined,
): Record<string, string> | null {
  return convergence?.dimensionLabels ?? convergence?.dimension_labels ?? null;
}

/** Review payload in the same shape the wizard stores on the draft (§4.4). */
export function assembleReview(request: BuildRequest, outputs: StageOutputs): ReviewPayload {
  // The review is assembled from stage outputs. `request` is part of the signature so every
  // caller passes the frozen build request alongside those outputs.
  void request;
  const characters = outputs.characters;
  const storyline = outputs.storyline;
  const convergence = outputs.convergence;
  const pages = pagesUsable(outputs.pages) ? outputs.pages : undefined;
  const pageOrgs = pages?.orgs ?? [];
  const peace = usablePeaceFeed(pages?.peace_period);

  return {
    personas: dedupeByHandle([
      ...(characters?.personas ?? []),
      ...(storyline?.persona_twins ?? []),
      ...(pages?.persona_twins ?? []),
    ]),
    fact_sheet: characters?.fact_sheet ?? { confirmed_facts: [], unconfirmed_claims: [] },
    communities: characters?.communities ?? [],
    ...(characters?.per_country_counts
      ? { per_country_counts: characters.per_country_counts }
      : {}),
    storyline_injects: storyline?.injects ?? [],
    team_storylines: appendIntel(storyline?.team_storylines ?? {}, convergence?.intel_injects),
    team_charters: storyline?.team_charters ?? [],
    stakeholders: storyline?.stakeholders ?? [],
    stakeholder_injects: stakeholderInjects(storyline, pages),
    org_registry: pageOrgs.length > 0 ? pageOrgs : (storyline?.orgs ?? []),
    sop_steps: storyline?.sop_steps ?? [],
    decision_context: storyline?.decision_context ?? EMPTY_DECISION,
    pressure_links: (storyline?.pressure_organisations ?? []).map((org) => ({
      display_name: org.display_name,
      org_key: org.org_key,
      ...(org.spokesperson_stakeholder_id
        ? { spokesperson_stakeholder_id: org.spokesperson_stakeholder_id }
        : {}),
    })),
    shared_injects: firstList(convergence?.sharedInjects, convergence?.shared_injects),
    convergence_gates: firstList(convergence?.convergenceGates, convergence?.convergence_gates),
    narrative: convergence?.narrative ?? null,
    objectives: convergence?.objectives ?? [],
    dimension_labels: dimensionLabels(convergence),
    org_page: pages?.org_page ?? null,
    ...(peace ? { peace_period: peace } : {}),
    ...(convergence?.team_dependencies
      ? { team_dependencies: convergence.team_dependencies }
      : {}),
  };
}
