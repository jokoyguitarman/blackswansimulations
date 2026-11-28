import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { crisisElapsedMinutes } from '../../lib/sessionPhase.js';
import {
  isCrisisActivity,
  type PostKind,
  type TopicLabel,
  type TopicPhase,
} from './topicPromptCore.js';

type GradePlayerContent = typeof import('../contentGraderService.js').gradePlayerContent;
type GetPlayerTeamContext = typeof import('../teamCharterService.js').getPlayerTeamContext;
type GradeContext = Parameters<GradePlayerContent>[1];
type ContentGrade = Awaited<ReturnType<GradePlayerContent>>;
type FullTeam = NonNullable<Awaited<ReturnType<GetPlayerTeamContext>>>;
type TeamCharter = NonNullable<FullTeam['charter']>;
/** The fields this grader reads. The real team-context return is assignable to it. */
type TeamContext = {
  team_name: FullTeam['team_name'];
  charter: Pick<TeamCharter, 'mission' | 'scoring_rubric' | 'out_of_lane'> | null;
} | null;

export interface GradeActivityInput {
  sessionId: string;
  postId: string;
  userId: string;
  content: string;
  postFormat: string | undefined;
  imagePrompt: string | undefined;
  replyToPostId: string | undefined;
  postAsPage: boolean;
  /**
   * False keeps today's grading: every player post is graded, the label is ignored.
   * True grades only crisis activity. A missing migration forces the label to unclassified.
   */
  topicAware: boolean;
  label: TopicLabel;
  phase: TopicPhase;
  postKind: PostKind;
  columnsAvailable: boolean;
}

export interface GradeRuntime {
  loadSession(
    sessionId: string,
  ): Promise<{ scenario_id: string; start_time: string | null } | null>;
  loadScenario(
    scenarioId: string,
  ): Promise<{ description: string | null; initial_state: unknown } | null>;
  loadParentContent(postId: string): Promise<string | undefined>;
  getPlayerTeamContext(sessionId: string, userId: string): Promise<TeamContext>;
  gradePlayerContent(content: string, context: GradeContext): Promise<ContentGrade>;
  updateScore(postId: string, grade: ContentGrade): Promise<void>;
  /** Await the module import, then start the snapshot without waiting for it. */
  startSnapshot(sessionId: string): Promise<void>;
  /** Await the module import, then start the consequence without waiting for it. */
  startConsequence(
    sessionId: string,
    triggerId: string,
    description: string,
    sentiment: string,
    isPositive: boolean,
  ): Promise<void>;
}

/** The route grades when topic replies are off, or when AI is off (label stays unclassified). */
export function routeGradesPlayerPost(topicAware: boolean, aiEnabled: boolean): boolean {
  return !topicAware || !aiEnabled;
}

export function gradingLabel(
  input: Pick<GradeActivityInput, 'topicAware' | 'label' | 'columnsAvailable'>,
): TopicLabel {
  if (!input.topicAware) return input.label;
  if (!input.columnsAvailable) return 'unclassified';
  return input.label;
}

export function shouldSkipGrade(
  input:
    | GradeActivityInput
    | Pick<GradeActivityInput, 'topicAware' | 'label' | 'phase' | 'postKind' | 'columnsAvailable'>,
): boolean {
  if (input.phase === 'peace') return true;
  if (!input.topicAware) return false;
  return !isCrisisActivity({
    phase: input.phase,
    label: gradingLabel(input),
    postKind: input.postKind,
  });
}

const defaultRuntime: GradeRuntime = {
  async loadSession(sessionId) {
    const { data } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id, start_time')
      .eq('id', sessionId)
      .single();
    if (!data?.scenario_id) return null;
    return {
      scenario_id: String(data.scenario_id),
      start_time: data.start_time ? String(data.start_time) : null,
    };
  },
  async loadScenario(scenarioId) {
    const { data } = await supabaseAdmin
      .from('scenarios')
      .select('description, initial_state')
      .eq('id', scenarioId)
      .single();
    if (!data) return null;
    return {
      description: data.description == null ? null : String(data.description),
      initial_state: data.initial_state,
    };
  },
  async loadParentContent(postId) {
    const { data } = await supabaseAdmin
      .from('social_posts')
      .select('content')
      .eq('id', postId)
      .single();
    return data ? String(data.content || '') : undefined;
  },
  async getPlayerTeamContext(sessionId, userId) {
    const { getPlayerTeamContext } = await import('../teamCharterService.js');
    return getPlayerTeamContext(sessionId, userId);
  },
  async gradePlayerContent(content, context) {
    const { gradePlayerContent } = await import('../contentGraderService.js');
    return gradePlayerContent(content, context);
  },
  async updateScore(postId, grade) {
    await supabaseAdmin
      .from('social_posts')
      .update({ sop_compliance_score: grade })
      .eq('id', postId);
  },
  async startSnapshot(sessionId) {
    const { snapshotTeamScores } = await import('../teamScoreService.js');
    void snapshotTeamScores(sessionId);
  },
  async startConsequence(sessionId, triggerId, description, sentiment, isPositive) {
    const { generateConsequenceInject } = await import('../ambientContentService.js');
    void generateConsequenceInject(sessionId, triggerId, description, sentiment, isPositive);
  },
};

/**
 * Auto-grade a player post. The route fires this without awaiting, in the same
 * slot the inline block used, so the HTTP response is not held for the grade.
 * Errors are logged and swallowed.
 */
export async function gradeIfCrisisActivity(
  input: GradeActivityInput,
  runtime: GradeRuntime = defaultRuntime,
): Promise<void> {
  if (shouldSkipGrade(input)) return;

  try {
    const sessionData = await runtime.loadSession(input.sessionId);
    if (!sessionData) return;

    const scenario = await runtime.loadScenario(sessionData.scenario_id);
    if (!scenario) return;

    const is = (scenario.initial_state || {}) as Record<string, unknown>;
    const factSheet = (is.fact_sheet || {}) as Record<string, unknown>;
    const confirmedFacts = (factSheet.confirmed_facts || []) as string[];
    const researchGuidelines = ((is.research_guidelines as Record<string, unknown>)?.per_team ||
      []) as Array<{
      guidelines: Array<{ best_practice: string; source_basis: string }>;
    }>;
    const flatGuidelines = researchGuidelines.flatMap((t) => t.guidelines || []);

    let parentContent: string | undefined;
    if (input.replyToPostId) {
      parentContent = await runtime.loadParentContent(input.replyToPostId);
    }

    const elapsedMinutes = sessionData.start_time
      ? crisisElapsedMinutes(sessionData.start_time)
      : undefined;

    const teamCtx = await runtime.getPlayerTeamContext(input.sessionId, input.userId);
    const grade = await runtime.gradePlayerContent(input.content, {
      crisis_description: scenario.description || '',
      confirmed_facts: confirmedFacts,
      hateful_post_being_addressed: parentContent,
      research_guidelines: flatGuidelines.slice(0, 5),
      post_format: input.postFormat || 'text',
      is_official_page_post: input.postAsPage || false,
      elapsed_minutes: elapsedMinutes,
      image_prompt: input.imagePrompt || undefined,
      team_charter: teamCtx?.charter
        ? {
            team_name: teamCtx.team_name,
            mission: teamCtx.charter.mission,
            scoring_rubric: teamCtx.charter.scoring_rubric,
            out_of_lane: teamCtx.charter.out_of_lane,
          }
        : undefined,
    });

    await runtime.updateScore(input.postId, grade);

    // Refresh team scores now that a new grade landed (throttled inside).
    await runtime.startSnapshot(input.sessionId);

    const format = input.postFormat || 'text';
    if (grade.overall >= 70) {
      await runtime.startConsequence(
        input.sessionId,
        'player_good_response',
        `A player posted a high-quality ${format} response (scored ${grade.overall}/100). Generate a supportive reaction amplifying the good response.`,
        'supportive',
        true,
      );
    } else if (grade.overall < 40) {
      await runtime.startConsequence(
        input.sessionId,
        'player_poor_response',
        `A player posted a poor ${format} response (scored ${grade.overall}/100). Generate a skeptical reaction questioning the response quality.`,
        'negative',
        false,
      );
    }

    logger.info(
      { postId: input.postId, overall: grade.overall, format: input.postFormat },
      'Auto-graded player post',
    );
  } catch (gradeErr) {
    logger.warn({ err: gradeErr }, 'Auto-grade failed (non-critical)');
  }
}
