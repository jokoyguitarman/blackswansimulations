import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { crisisElapsedMinutes } from '../../lib/sessionPhase.js';
import type { TeamContext } from '../teamCharterService.js';
import { shouldSkipGrade } from './gradeIfCrisisActivity.js';
import type { PostKind, TopicLabel, TopicPhase } from './topicPromptCore.js';

type GradePlayerContent = typeof import('../contentGraderService.js').gradePlayerContent;
type ContentGrade = Awaited<ReturnType<GradePlayerContent>>;
type GradeContext = Parameters<GradePlayerContent>[1];

export interface OutboundEmailGradeInput {
  sessionId: string;
  emailId: string;
  userId: string;
  subject: string;
  bodyText: string;
  /**
   * False keeps today's grading: every outbound email is graded.
   * True grades only crisis activity. A missing migration forces the label to unclassified.
   */
  topicAware: boolean;
  label: TopicLabel;
  phase: TopicPhase;
  postKind: PostKind;
  columnsAvailable: boolean;
}

/** The calls the route's email grade made, in that order. Tests replace the whole set. */
export interface OutboundEmailGradeRuntime {
  loadSession(
    sessionId: string,
  ): Promise<{ scenario_id: string; start_time: string | null } | null>;
  loadScenario(
    scenarioId: string,
  ): Promise<{ description: string | null; initial_state: unknown } | null>;
  getPlayerTeamContext(sessionId: string, userId: string): Promise<TeamContext | null>;
  gradePlayerContent(content: string, context: GradeContext): Promise<ContentGrade>;
  updateScore(emailId: string, grade: ContentGrade): Promise<void>;
  /** Await the module import, then start the snapshot without waiting for it. */
  startSnapshot(sessionId: string): Promise<void>;
}

function emailGradeRequest(
  input: OutboundEmailGradeInput,
  scenario: { description: string | null; initial_state: unknown },
  elapsedMinutes: number,
  teamCtx: TeamContext | null,
): { content: string; context: GradeContext } {
  const is = (scenario.initial_state || {}) as Record<string, unknown>;
  const factSheet = (is.fact_sheet || {}) as Record<string, unknown>;
  const confirmedFacts = (factSheet.confirmed_facts || []) as string[];
  const emailFormat =
    teamCtx?.charter && !teamCtx.charter.can_post_publicly ? 'text' : 'official_statement';
  return {
    content: `${input.subject}\n\n${input.bodyText}`,
    context: {
      crisis_description: scenario.description || '',
      confirmed_facts: confirmedFacts,
      post_format: emailFormat,
      elapsed_minutes: elapsedMinutes,
      org_name: (is.org_name as string) || undefined,
      team_charter: teamCtx?.charter
        ? {
            team_name: teamCtx.team_name,
            mission: teamCtx.charter.mission,
            scoring_rubric: teamCtx.charter.scoring_rubric,
            out_of_lane: teamCtx.charter.out_of_lane,
          }
        : undefined,
    },
  };
}

const defaultRuntime: OutboundEmailGradeRuntime = {
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
  async getPlayerTeamContext(sessionId, userId) {
    const { getPlayerTeamContext } = await import('../teamCharterService.js');
    return getPlayerTeamContext(sessionId, userId);
  },
  async gradePlayerContent(content, context) {
    const { gradePlayerContent } = await import('../contentGraderService.js');
    return gradePlayerContent(content, context);
  },
  async updateScore(emailId, grade) {
    await supabaseAdmin
      .from('sim_emails')
      .update({ sop_compliance_score: grade })
      .eq('id', emailId);
  },
  async startSnapshot(sessionId) {
    const { snapshotTeamScores } = await import('../teamScoreService.js');
    void snapshotTeamScores(sessionId);
  },
};

/**
 * Grade one outbound player email. The route fires this without awaiting, in the
 * slot the inline block used. One runtime runs the sequence: session, scenario,
 * team context, grade, awaited score update, then an un-awaited snapshot.
 */
export async function gradeOutboundEmail(
  input: OutboundEmailGradeInput,
  runtime: OutboundEmailGradeRuntime = defaultRuntime,
): Promise<void> {
  if (shouldSkipGrade(input)) return;
  try {
    const sessionData = await runtime.loadSession(input.sessionId);
    if (!sessionData) return;
    const scenario = await runtime.loadScenario(sessionData.scenario_id);
    if (!scenario) return;
    const elapsedMinutes = crisisElapsedMinutes(sessionData.start_time ?? null);
    const teamCtx = await runtime.getPlayerTeamContext(input.sessionId, input.userId);
    const request = emailGradeRequest(input, scenario, elapsedMinutes, teamCtx);
    const grade = await runtime.gradePlayerContent(request.content, request.context);
    await runtime.updateScore(input.emailId, grade);
    await runtime.startSnapshot(input.sessionId);
  } catch (gradeErr) {
    logger.warn({ err: gradeErr, emailId: input.emailId }, 'Outbound email grading failed');
  }
}
