import { env } from '../../env.js';
import { withAiCallCount } from '../../lib/aiCallScope.js';
import { withConcurrencyLimit } from '../../lib/limitConcurrency.js';
import { logger } from '../../lib/logger.js';
import { coerceBlueprint } from '../blueprint/blueprintTypes.js';
import {
  crisisContextFrom,
  resolveOrganisations,
  runConvergencePipeline,
  runNpcsPipeline,
  runOrgPagePipeline,
  runStorylinePipeline,
} from '../multiOrgPipeline.js';
import type { OrganisationsValidation } from '../scenarioOrgModel.js';
import type { StageInput } from './assemble.js';
import { charactersReadyLine, formatProgress, stakeholdersReadyLine } from './buildCore.js';
import type { BuildRequest, LogKind } from './buildTypes.js';
import { loadDeltaBuildContext } from '../setupEdits/deltaBuildContext.js';
import { runDeltaStage, type DeltaCarry } from '../setupEdits/deltaBuildRun.js';
import type { BriefDiff } from '../setupEdits/affectedLayers.js';
import type { DeltaBuildContext, DeltaGenerators } from '../setupEdits/deltaBuildTypes.js';
import { createDeltaGenerators } from '../setupEdits/deltaGenerators.js';

export interface StageContext {
  log(kind: LogKind, message: string): void;
  signal: AbortSignal;
}

export type StageRunner = (input: StageInput, ctx: StageContext) => Promise<unknown>;

export interface StageRunnerDeps {
  loadDeltaContext?: (request: BuildRequest) => Promise<DeltaBuildContext>;
  deltaGenerators?: DeltaGenerators;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error('aborted');
}

function assertOrgs(
  request: BuildRequest,
  pressure: BuildRequest['pressure_organisations'] = request.pressure_organisations,
): Extract<OrganisationsValidation, { ok: true }> {
  const orgs = resolveOrganisations(request.organisations, request.competitors, pressure);
  if (!orgs || !orgs.ok) {
    throw new Error(orgs && !orgs.ok ? orgs.message : 'invalid organisations');
  }
  return orgs;
}

function blueprintFor(request: BuildRequest) {
  return env.enableDocumentBlueprint && request.blueprint
    ? coerceBlueprint(request.blueprint)
    : null;
}

async function runStage<T>(stage: string, ctx: StageContext, fn: () => Promise<T>): Promise<T> {
  const { result, calls } = await withAiCallCount(fn);
  const line = `${stage}: ${calls} AI calls`;
  logger.info(line);
  ctx.log('progress', line);
  return result;
}

/** One runner per stage. Each wraps the existing pipeline and stops if the caller aborted. */
export function createStageRunners(
  deps: StageRunnerDeps = {},
): Record<StageInput['stage'], StageRunner> {
  const loadDeltaContext = deps.loadDeltaContext ?? loadDeltaBuildContext;
  const generators = deps.deltaGenerators ?? createDeltaGenerators();

  async function runEdit(input: StageInput, ctx: StageContext): Promise<unknown> {
    const loaded = await loadDeltaContext(input.request);
    const carry = carryFrom(input);
    return runStage(input.stage, ctx, () =>
      withConcurrencyLimit(env.warroomGenConcurrency, () =>
        runDeltaStage(input.stage, loaded, generators, carry),
      ),
    );
  }

  return {
    characters: async (input, ctx) => {
      if (input.stage !== 'characters')
        throw new Error('characters runner expected characters input');
      if (input.request.mode === 'setup_edit') {
        const result = await runEdit(input, ctx);
        throwIfAborted(ctx.signal);
        return result;
      }
      const request = input.request;
      const orgs = assertOrgs(request);
      const crisis = crisisContextFrom({
        crisis_type: request.crisis_type,
        context: request.context,
        duration: request.duration,
        org_name: request.org_name,
      });
      const result = await runStage('characters', ctx, () => runNpcsPipeline(orgs, crisis));
      throwIfAborted(ctx.signal);
      ctx.log('progress', charactersReadyLine(result.personas.length));
      return {
        personas: result.personas,
        fact_sheet: result.factSheet,
        communities: result.communities,
        countries: result.countries,
        per_country_counts: result.per_country_counts,
        footprint: result.footprint,
      };
    },
    storyline: async (input, ctx) => {
      if (input.stage !== 'storyline') throw new Error('storyline runner expected storyline input');
      if (input.request.mode === 'setup_edit') {
        const result = await runEdit(input, ctx);
        throwIfAborted(ctx.signal);
        return result;
      }
      const request = input.request;
      const orgs = assertOrgs(request);
      const crisis = crisisContextFrom({
        crisis_type: request.crisis_type,
        context: request.context,
        duration: request.duration,
        org_name: request.org_name,
      });
      const result = await runStage('storyline', ctx, () =>
        runStorylinePipeline(
          orgs,
          crisis,
          input.personas,
          input.fact_sheet,
          blueprintFor(request),
          (msg) => {
            const line = formatProgress(msg);
            if (line) ctx.log('progress', line);
          },
        ),
      );
      throwIfAborted(ctx.signal);
      if (result.stakeholders.length > 0) {
        const withConcern = result.stakeholders.filter(
          (stakeholder) => stakeholder.grievance,
        ).length;
        ctx.log('progress', stakeholdersReadyLine(result.stakeholders.length, withConcern));
      }
      return result;
    },
    convergence: async (input, ctx) => {
      if (input.stage !== 'convergence')
        throw new Error('convergence runner expected convergence input');
      if (input.request.mode === 'setup_edit') {
        const result = await runEdit(input, ctx);
        throwIfAborted(ctx.signal);
        return result;
      }
      const orgs = assertOrgs(input.request);
      const result = await runStage('convergence', ctx, () =>
        runConvergencePipeline(
          orgs,
          input.crisisCtx,
          input.teamStorylines,
          input.personas,
          input.factSheet,
          blueprintFor(input.request),
          undefined,
          {
            stakeholders: input.stakeholders,
            stakeholderInjects: input.stakeholderInjects,
          },
        ),
      );
      throwIfAborted(ctx.signal);
      return result;
    },
    pages: async (input, ctx) => {
      if (input.stage !== 'pages') throw new Error('pages runner expected pages input');
      if (input.request.mode === 'setup_edit') {
        const result = await runEdit(input, ctx);
        throwIfAborted(ctx.signal);
        return result;
      }
      const request = input.request;
      const orgs = assertOrgs(request, input.pressure_organisations);
      const result = await runStage('pages', ctx, () =>
        runOrgPagePipeline(
          orgs,
          request.crisis_type,
          request.brand_logo_url,
          request.auto_antagonist !== false,
          (msg) => ctx.log('progress', msg),
          {
            stakeholders: input.stakeholders,
            factSheet: input.fact_sheet,
            crisis: input.crisis,
          },
        ),
      );
      throwIfAborted(ctx.signal);
      return {
        org_page: result.orgPage as unknown as Record<string, unknown>,
        orgs: result.orgs,
        countries: result.countries,
        pressure_injects: result.pressure_injects,
        persona_twins: result.persona_twins,
      };
    },
  };
}

function carryFrom(input: StageInput): DeltaCarry | undefined {
  if (input.stage === 'characters' || !('brief_diff' in input)) return undefined;
  const brief = input.brief_diff;
  return {
    briefDiff: brief && typeof brief === 'object' ? (brief as BriefDiff) : null,
    swapPremise: input.swap_premise ?? null,
  };
}
