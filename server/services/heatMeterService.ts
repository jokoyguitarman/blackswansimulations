/**
 * Heat Meter Service
 *
 * Ratio-based decision quality scoring. Each team starts at 0% heat.
 * Mistakes add weighted points; good decisions earn small cooldown credits.
 * Heat = max(0, (mistake_points - cooldown_points) / total_decisions) * 100, capped at 100.
 *
 * Stored in session.current_state.heat_meter[teamName] and broadcast via state.updated.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import { publishInjectToSession } from '../routes/injects.js';
import { shouldCancelScheduledInject } from './aiService.js';
import { env } from '../env.js';
import type { Server as IoServer } from 'socket.io';
// PathwayOutcome type import removed — pathway system replaced by dynamic consequences

export type MistakeType = 'vague' | 'contradiction' | 'prereq' | 'no_intel' | 'rejected' | 'good';

const MISTAKE_WEIGHTS: Record<MistakeType, number> = {
  vague: 1,
  contradiction: 2,
  prereq: 1,
  no_intel: 0.5,
  rejected: 3,
  good: 0,
};

const GOOD_DECISION_COOLDOWN = 0.3;

export interface TeamHeatState {
  mistake_points: number;
  cooldown_points: number;
  total_decisions: number;
  heat_percentage: number;
}

function computeHeatPercentage(state: TeamHeatState): number {
  if (state.total_decisions === 0) return 0;
  const raw = ((state.mistake_points - state.cooldown_points) / state.total_decisions) * 100;
  return Math.min(100, Math.max(0, Math.round(raw * 10) / 10));
}

/**
 * Update a team's heat meter after a decision is evaluated.
 * Reads current heat_meter from session.current_state, applies the change,
 * writes back to the DB and broadcasts via WebSocket.
 */
export async function updateTeamHeatMeter(
  sessionId: string,
  teamName: string,
  mistakeType: MistakeType,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _io?: IoServer | null,
): Promise<{ heat_percentage: number }> {
  const { data: session, error: sessErr } = await supabaseAdmin
    .from('sessions')
    .select('current_state')
    .eq('id', sessionId)
    .single();

  if (sessErr || !session) {
    logger.warn({ sessionId, error: sessErr }, 'Heat meter: session not found');
    return { heat_percentage: 0 };
  }

  const currentState = ((session as { current_state?: Record<string, unknown> }).current_state ??
    {}) as Record<string, unknown>;
  const heatMeterAll = (currentState.heat_meter ?? {}) as Record<string, TeamHeatState>;

  const teamState: TeamHeatState = heatMeterAll[teamName] ?? {
    mistake_points: 0,
    cooldown_points: 0,
    total_decisions: 0,
    heat_percentage: 0,
  };

  teamState.total_decisions += 1;

  if (mistakeType === 'good') {
    teamState.cooldown_points += GOOD_DECISION_COOLDOWN;
  } else {
    teamState.mistake_points += MISTAKE_WEIGHTS[mistakeType];
  }

  teamState.heat_percentage = computeHeatPercentage(teamState);
  heatMeterAll[teamName] = teamState;

  const nextState = { ...currentState, heat_meter: heatMeterAll };

  await supabaseAdmin.from('sessions').update({ current_state: nextState }).eq('id', sessionId);

  try {
    getWebSocketService().stateUpdated?.(sessionId, {
      state: nextState,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // WebSocket broadcast is non-critical
  }

  logger.info(
    {
      sessionId,
      team: teamName,
      mistakeType,
      heat: teamState.heat_percentage,
      decisions: teamState.total_decisions,
    },
    'Heat meter updated',
  );

  return { heat_percentage: teamState.heat_percentage };
}

// ---------------------------------------------------------------------------
// Heat-to-Robustness Band Mapping
// ---------------------------------------------------------------------------

export function heatPercentageToRobustnessBand(heat: number): 'low' | 'medium' | 'high' {
  if (heat >= 60) return 'low';
  if (heat >= 30) return 'medium';
  return 'high';
}

// ---------------------------------------------------------------------------
// Dynamic Decision Consequence Generator
// Replaces pre-generated pathway outcomes with on-the-fly consequence generation.
// Uses the team's actual decision + robustness band + escalation factors to produce
// a contextually accurate consequence inject every time.
// ---------------------------------------------------------------------------

/**
 * Generate a consequence inject based on the team's actual decision and their
 * current robustness (heat) band. Loads recent escalation factors for context
 * and uses the LLM to produce a consequence that logically follows from what
 * the team actually did (or failed to do).
 */
export async function generateDecisionConsequence(
  sessionId: string,
  teamName: string,
  heatPercentage: number,
  scenarioId: string,
  trainerId: string,
  io: IoServer,
  decisionText?: string,
): Promise<void> {
  const apiKey = env.openAiApiKey;
  if (!apiKey || !decisionText) return;

  try {
    const band = heatPercentageToRobustnessBand(heatPercentage);

    // Load recent escalation factors for situational context
    const { data: factorRows } = await supabaseAdmin
      .from('session_escalation_factors')
      .select('factors, de_escalation_factors, target_team, trigger_inject_id')
      .eq('session_id', sessionId)
      .order('evaluated_at', { ascending: false })
      .limit(3);

    const relevantFactors = (factorRows ?? [])
      .filter(
        (r) =>
          !(r as Record<string, unknown>).target_team ||
          (r as Record<string, unknown>).target_team === teamName,
      )
      .slice(0, 2);

    const factorSummary = relevantFactors
      .flatMap((r) => {
        const esc = (r.factors as Array<{ name?: string; description?: string }>) ?? [];
        const deEsc =
          (r.de_escalation_factors as Array<{ name?: string; description?: string }>) ?? [];
        return [
          ...esc.map((f) => `⬆ ${f.name}: ${f.description}`),
          ...deEsc.map((f) => `⬇ ${f.name}: ${f.description}`),
        ];
      })
      .slice(0, 8)
      .join('\n');

    // Load the most recent trigger inject for context
    let triggerInjectContext = '';
    const latestTriggerInjectId =
      relevantFactors[0] && (relevantFactors[0] as Record<string, unknown>).trigger_inject_id;
    if (latestTriggerInjectId) {
      const { data: trigInject } = await supabaseAdmin
        .from('scenario_injects')
        .select('title, content')
        .eq('id', latestTriggerInjectId as string)
        .maybeSingle();
      if (trigInject) {
        triggerInjectContext = `\nTRIGGER INJECT: ${(trigInject.title as string) ?? ''}\n${((trigInject.content as string) ?? '').slice(0, 300)}`;
      }
    }

    const toneGuide =
      band === 'high'
        ? 'POSITIVE — the team performed well. Describe a favourable in-world outcome that logically follows from their specific action. Acknowledge what they did right. The consequence should feel like a reward — reduced panic, improved coordination, lives saved, public confidence boosted.'
        : band === 'medium'
          ? 'MIXED — the team made a reasonable effort but with gaps. Describe a partial improvement with lingering challenges. Acknowledge the effort but highlight what was missed or incomplete. The situation improves somewhat but problems persist.'
          : 'NEGATIVE — the team responded inadequately or missed the point. Describe a worsening in-world situation that flows directly from their poor decision. Be specific about what went wrong as a consequence. Panic increases, conditions deteriorate, coordination breaks down.';

    const systemPrompt = `You are a crisis simulation consequence engine. Given a team's decision and the current situational context, generate a realistic in-world consequence inject.

RULES:
1. The consequence MUST logically follow from the team's ACTUAL decision — never invent actions they didn't take.
2. Tone: ${toneGuide}
3. Length: 2-4 sentences, present tense, describing what is NOW happening as a direct result.
4. The consequence should feel like a natural development in the crisis, not an artificial game mechanic.
5. Reference specific details from the decision (locations, personnel, equipment mentioned).
6. The title should be 3-8 words summarising the consequence.
7. Set severity: "low" for positive outcomes, "medium" for mixed, "high" for negative.
8. Return ONLY valid JSON: { "title": "...", "content": "...", "severity": "low|medium|high" }`;

    const userPrompt = `TEAM: ${teamName}
ROBUSTNESS BAND: ${band} (heat: ${Math.round(heatPercentage)}%)
${triggerInjectContext}

TEAM'S ACTUAL DECISION:
${decisionText.slice(0, 600)}

${factorSummary ? `CURRENT ESCALATION/DE-ESCALATION FACTORS:\n${factorSummary}` : ''}

Generate a consequence inject that describes what happens IN THE WORLD as a result of this team's decision. Return JSON only.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 350,
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Decision consequence: OpenAI API error');
      return;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
    const cleaned = raw
      .replace(/```json\s*/g, '')
      .replace(/```/g, '')
      .trim();

    let parsed: { title?: string; content?: string; severity?: string };
    try {
      parsed = JSON.parse(cleaned) as { title?: string; content?: string; severity?: string };
    } catch {
      logger.warn({ raw: cleaned.slice(0, 200) }, 'Decision consequence: failed to parse JSON');
      return;
    }

    if (!parsed.title || !parsed.content) return;

    const requiresResponse = band !== 'high';
    const severity =
      parsed.severity || (band === 'high' ? 'low' : band === 'medium' ? 'medium' : 'high');

    const { data: createdInject, error: createError } = await supabaseAdmin
      .from('scenario_injects')
      .insert({
        scenario_id: scenarioId,
        session_id: sessionId,
        trigger_time_minutes: null,
        trigger_condition: null,
        type: band === 'high' ? 'pathway' : 'warroom',
        title: parsed.title,
        content: parsed.content,
        severity,
        affected_roles: [],
        inject_scope: 'team_specific',
        target_teams: [teamName],
        requires_response: requiresResponse,
        requires_coordination: false,
        ai_generated: true,
        triggered_by_user_id: null,
        generation_source: 'decision_consequence',
      })
      .select()
      .single();

    if (createError || !createdInject) {
      logger.warn(
        { error: createError, sessionId, team: teamName },
        'Decision consequence inject insert failed',
      );
      return;
    }

    // AI cancellation gate: check whether team's recent actions already address this consequence
    try {
      const { data: recentDecisions } = await supabaseAdmin
        .from('decisions')
        .select('title, description, type')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(15);

      const decisionsForAi = (recentDecisions ?? []).map((d) => ({
        title: (d.title as string) || '',
        description: (d.description as string) || '',
        type: (d.type as string) || null,
      }));

      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'ai_step_start',
        description: `AI: Evaluating whether to cancel consequence inject: ${parsed.title}`,
        actor_id: null,
        metadata: {
          step: 'evaluating_consequence_cancellation',
          inject_title: parsed.title,
          team: teamName,
          robustness_band: band,
        },
      });

      const cancelResult = await shouldCancelScheduledInject(
        { title: parsed.title, content: parsed.content },
        decisionsForAi,
        apiKey,
      );

      if (cancelResult.cancel) {
        await supabaseAdmin.from('session_events').insert({
          session_id: sessionId,
          event_type: 'inject_cancelled',
          description: `Consequence inject cancelled: ${parsed.title} — ${cancelResult.cancel_reason ?? 'Team actions addressed the concern'}`,
          actor_id: null,
          metadata: {
            inject_id: createdInject.id,
            cancel_reason: cancelResult.cancel_reason ?? null,
            team: teamName,
            robustness_band: band,
          },
        });

        logger.info(
          {
            sessionId,
            team: teamName,
            injectId: createdInject.id,
            reason: cancelResult.cancel_reason,
          },
          'Decision consequence inject cancelled by AI gate',
        );

        // If the adversary adapted the inject, create and publish the adapted version
        if (cancelResult.adversary_inject?.title && cancelResult.adversary_inject?.content) {
          const { data: adaptedInject } = await supabaseAdmin
            .from('scenario_injects')
            .insert({
              scenario_id: scenarioId,
              session_id: sessionId,
              trigger_time_minutes: null,
              trigger_condition: null,
              type: band === 'high' ? 'pathway' : 'warroom',
              title: cancelResult.adversary_inject.title,
              content: cancelResult.adversary_inject.content,
              severity,
              affected_roles: [],
              inject_scope: 'team_specific',
              target_teams: [teamName],
              requires_response: requiresResponse,
              requires_coordination: false,
              ai_generated: true,
              triggered_by_user_id: null,
              generation_source: 'adversary_adaptation',
            })
            .select()
            .single();

          if (adaptedInject) {
            await publishInjectToSession(adaptedInject.id, sessionId, trainerId, io);
            logger.info(
              {
                sessionId,
                team: teamName,
                injectId: adaptedInject.id,
                title: cancelResult.adversary_inject.title,
              },
              'Adversary-adapted consequence inject published',
            );
          }
        }
        return;
      }
    } catch (gateErr) {
      logger.warn(
        { error: gateErr, sessionId, team: teamName },
        'Consequence cancellation gate failed, publishing inject anyway',
      );
    }

    await publishInjectToSession(createdInject.id, sessionId, trainerId, io);

    logger.info(
      {
        sessionId,
        team: teamName,
        injectId: createdInject.id,
        robustnessBand: band,
        heatPercentage,
        title: parsed.title,
      },
      'Decision consequence inject published',
    );
  } catch (err) {
    logger.warn({ err, sessionId, team: teamName }, 'generateDecisionConsequence failed');
  }
}

// ---------------------------------------------------------------------------
// Senior Editor AI — Media Script Evaluator
// ---------------------------------------------------------------------------

export interface EditorialReview {
  verdict: 'approved' | 'revision_requested' | 'rejected';
  score: number;
  dimensions: {
    spokesperson_identity: number;
    factual_precision: number;
    verified_vs_unverified: number;
    public_guidance: number;
    victim_dignity: number;
    empathy_tone: number;
    rumor_management: number;
    consistency: number;
    next_update_commitment: number;
  };
  feedback: string;
  editor_name: string;
  platform_notes?: string;
}

export async function evaluateMediaScript(
  scriptContent: string,
  injectContext: string | null,
  groundTruth: {
    totalCasualties: number;
    totalCrowdSize: number;
    hazardCount: number;
    deathsOnSite: number;
    activeInjects: string[];
  },
  previousStatements: string[],
  mediaStateFlags: Record<string, unknown>,
  revisionCount: number,
): Promise<EditorialReview> {
  const fallback: EditorialReview = {
    verdict: 'approved',
    score: 7,
    dimensions: {
      spokesperson_identity: 3,
      factual_precision: 3,
      verified_vs_unverified: 3,
      public_guidance: 3,
      victim_dignity: 4,
      empathy_tone: 3,
      rumor_management: 3,
      consistency: 4,
      next_update_commitment: 3,
    },
    feedback: 'Statement meets basic standards.',
    editor_name: 'Chief Editor M. Torres',
  };

  const apiKey = env.openAiApiKey;
  if (!apiKey) return fallback;

  try {
    const previousBlock =
      previousStatements.length > 0
        ? `\nPREVIOUS STATEMENTS ISSUED:\n${previousStatements.map((s, i) => `${i + 1}. ${s.slice(0, 200)}`).join('\n')}`
        : '\nNo previous statements have been issued.';

    const injectBlock = injectContext
      ? `\nINJECT BEING RESPONDED TO:\n${injectContext}`
      : '\nThis is a proactive statement (no specific inject triggered it).';

    const mediaFlagsBlock = [
      `Spokesperson designated: ${mediaStateFlags.spokesperson_designated === true ? 'yes' : 'no'}`,
      `Press conference held: ${mediaStateFlags.press_conference_held === true ? 'yes' : 'no'}`,
      `Camera placement decided: ${mediaStateFlags.camera_placement_decided === true ? 'yes' : 'no'}`,
      `Statements issued so far: ${Number(mediaStateFlags.statements_issued) || 0}`,
    ].join(', ');

    const systemPrompt = [
      'You are Chief Editor M. Torres, a veteran crisis communications editor with 25 years of experience covering bombings, mass casualties, chemical attacks, hostage situations, and natural disasters.',
      'You are reviewing a draft public statement BEFORE it goes to air. You are tough but fair.',
      'Your job is to protect the public AND the organization issuing the statement.',
      '',
      'Score each dimension 1-5:',
      '1. SPOKESPERSON IDENTITY: Did they identify who is speaking and their authority?',
      '2. FACTUAL PRECISION: Specific numbers, locations, times — not vague hand-waving?',
      '3. VERIFIED VS UNVERIFIED: Did they distinguish confirmed facts from preliminary info?',
      '4. PUBLIC GUIDANCE: Clear instructions (evacuate, avoid area, shelter, hotline)?',
      '5. VICTIM DIGNITY: No names before family notification, no graphic descriptions?',
      '6. EMPATHY & TONE: Compassionate but controlled, not robotic or panicky?',
      '7. RUMOR MANAGEMENT: Did they address known misinformation or leave a vacuum?',
      '8. CONSISTENCY: Does this contradict any previous statement?',
      '9. NEXT UPDATE: Did they commit to a follow-up timeline?',
      '',
      `GROUND TRUTH (actual situation — use to verify factual accuracy):`,
      `- Total casualties: ${groundTruth.totalCasualties}`,
      `- Crowd size: ${groundTruth.totalCrowdSize}`,
      `- Active hazards: ${groundTruth.hazardCount}`,
      `- Deaths on site: ${groundTruth.deathsOnSite}`,
      `- Active injects/situations: ${groundTruth.activeInjects.slice(0, 5).join('; ') || 'none'}`,
      `- Media state: ${mediaFlagsBlock}`,
      previousBlock,
      injectBlock,
      '',
      revisionCount > 0
        ? `This is revision #${revisionCount + 1}. The player has already been asked to revise ${revisionCount} time(s). Be stricter — they should be improving.`
        : 'This is the first submission.',
      '',
      'Compute an overall score (1-10) as the average of dimensions, weighted:',
      '- Factual precision and public guidance are double-weighted.',
      '- If casualty numbers are wrong by more than 30%, cap overall score at 5.',
      '',
      'VERDICT:',
      '- Score 7+: "approved" — statement goes live. Include minor notes if any.',
      '- Score 4-6: "revision_requested" — statement NOT published. Give specific, actionable feedback in-character.',
      '- Score below 4: "rejected" — harsh feedback, this would damage credibility if aired.',
      '',
      'Write feedback IN CHARACTER as Chief Editor Torres. Be direct, specific, cite exact problems.',
      '',
      'Return ONLY valid JSON:',
      '{ "spokesperson_identity": n, "factual_precision": n, "verified_vs_unverified": n, "public_guidance": n, "victim_dignity": n, "empathy_tone": n, "rumor_management": n, "consistency": n, "next_update_commitment": n, "score": n, "verdict": "approved|revision_requested|rejected", "feedback": "string", "platform_notes": "string or null" }',
    ].join('\n');

    const userPrompt = `Review this draft public statement:\n\n${scriptContent.slice(0, 1500)}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a crisis communications editorial reviewer. Return valid JSON only.',
          },
          { role: 'user', content: systemPrompt + '\n\n' + userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'evaluateMediaScript: OpenAI API error');
      return fallback;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return fallback;

    const parsed = JSON.parse(content) as Record<string, unknown>;

    const score =
      typeof parsed.score === 'number' ? Math.min(10, Math.max(1, Math.round(parsed.score))) : 7;

    let verdict: EditorialReview['verdict'] = 'approved';
    if (typeof parsed.verdict === 'string') {
      if (parsed.verdict === 'revision_requested' || parsed.verdict === 'rejected') {
        verdict = parsed.verdict;
      }
    } else {
      verdict = score >= 7 ? 'approved' : score >= 4 ? 'revision_requested' : 'rejected';
    }

    const dim = (key: string) =>
      typeof parsed[key] === 'number'
        ? Math.min(5, Math.max(1, Math.round(parsed[key] as number)))
        : 3;

    return {
      verdict,
      score,
      dimensions: {
        spokesperson_identity: dim('spokesperson_identity'),
        factual_precision: dim('factual_precision'),
        verified_vs_unverified: dim('verified_vs_unverified'),
        public_guidance: dim('public_guidance'),
        victim_dignity: dim('victim_dignity'),
        empathy_tone: dim('empathy_tone'),
        rumor_management: dim('rumor_management'),
        consistency: dim('consistency'),
        next_update_commitment: dim('next_update_commitment'),
      },
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : fallback.feedback,
      editor_name: 'Chief Editor M. Torres',
      platform_notes: typeof parsed.platform_notes === 'string' ? parsed.platform_notes : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'evaluateMediaScript AI call failed, using fallback');
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Public Sentiment Nudge (media team only)
// ---------------------------------------------------------------------------

const SENTIMENT_DELTAS: Record<MistakeType, number> = {
  good: 0.5,
  vague: -0.5,
  contradiction: -1.0,
  prereq: -0.5,
  no_intel: -0.3,
  rejected: -2.0,
};

interface MediaToneScore {
  delta: number;
  label: string;
  reason: string;
}

/**
 * AI-based tone & reassurance evaluation for media decisions.
 * Scores how calming, factual, empathetic, and confidence-building the
 * media content is, and returns a sentiment delta (−2 to +2).
 */
async function evaluateMediaTone(
  decisionTitle: string,
  decisionDescription: string,
  currentSentiment: number,
  mistakeType: MistakeType,
): Promise<MediaToneScore> {
  const fallbackDelta = SENTIMENT_DELTAS[mistakeType];
  const fallback: MediaToneScore = {
    delta: fallbackDelta,
    label: mistakeType === 'good' ? 'Adequate' : 'Issues detected',
    reason:
      mistakeType === 'good' ? 'Statement meets basic standards' : `Evaluation: ${mistakeType}`,
  };

  try {
    const prompt = [
      'You are a crisis communications evaluator for an emergency response simulation.',
      'Evaluate the media decision below on how well it serves the public during a crisis.',
      '',
      'Score the following dimensions (each 1-5):',
      '1. REASSURANCE: Does it calm the public? Does it project competence and control?',
      '2. FACTUAL ACCURACY: Does it cite specific numbers, locations, actions, timelines?',
      '3. EMPATHY: Does it acknowledge victims, express concern, show human compassion?',
      '4. ACTIONABLE GUIDANCE: Does it tell the public what to do (stay away, evacuate, shelter)?',
      '5. TRANSPARENCY: Is it honest about unknowns without creating panic?',
      '',
      `Current public sentiment: ${currentSentiment}/10`,
      `Evaluator assessment: ${mistakeType === 'good' ? 'passes basic quality checks' : `flagged as "${mistakeType}"`}`,
      '',
      `Decision title: ${decisionTitle}`,
      `Decision content: ${decisionDescription}`,
      '',
      'Based on the scores, compute a sentiment delta between -2.0 and +2.0:',
      '- Excellent across all dimensions (avg 4+): +1.0 to +2.0',
      '- Good content but missing some dimensions (avg 3-4): +0.3 to +1.0',
      '- Adequate but generic/vague (avg 2-3): -0.3 to +0.3',
      '- Poor — panicky, contradictory, or dismissive (avg 1-2): -0.5 to -1.5',
      '- Actively harmful — spreading fear, blaming victims, lying (avg <2): -1.5 to -2.0',
      '',
      'A decision that is NOT a public-facing statement (e.g. internal coordination, setting up media area) should get delta 0 to +0.3.',
      '',
      'Return ONLY valid JSON:',
      '{ "reassurance": number, "factual": number, "empathy": number, "guidance": number, "transparency": number, "delta": number, "label": "1-3 word summary", "reason": "1 sentence explanation" }',
    ].join('\n');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You evaluate crisis communications quality. Return valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) return fallback;

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return fallback;

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const delta =
      typeof parsed.delta === 'number' ? Math.min(2, Math.max(-2, parsed.delta)) : fallbackDelta;
    const label = typeof parsed.label === 'string' ? parsed.label : fallback.label;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : fallback.reason;

    return { delta, label, reason };
  } catch (err) {
    logger.warn({ err }, 'evaluateMediaTone AI call failed, using fallback');
    return fallback;
  }
}

export async function nudgePublicSentiment(
  sessionId: string,
  mistakeType: MistakeType,
  decisionTitle?: string,
  decisionDescription?: string,
): Promise<void> {
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state, scenario_id')
      .eq('id', sessionId)
      .single();
    if (!session) return;

    const currentState = ((session as { current_state?: Record<string, unknown> }).current_state ??
      {}) as Record<string, unknown>;
    const mediaState = (currentState.media_state ?? {}) as Record<string, unknown>;
    const current =
      typeof mediaState.public_sentiment === 'number' ? mediaState.public_sentiment : 5;

    let delta: number;
    let sentimentLabel: string | undefined;
    let sentimentReason: string | undefined;

    if (decisionTitle && decisionDescription) {
      const toneScore = await evaluateMediaTone(
        decisionTitle,
        decisionDescription,
        current,
        mistakeType,
      );
      delta = toneScore.delta;
      sentimentLabel = toneScore.label;
      sentimentReason = toneScore.reason;
    } else {
      delta = SENTIMENT_DELTAS[mistakeType];
    }

    const nudged = Math.min(10, Math.max(1, Math.round((current + delta) * 10) / 10));

    const nextState = {
      ...currentState,
      media_state: {
        ...mediaState,
        public_sentiment: nudged,
        ...(sentimentLabel && { sentiment_label: sentimentLabel }),
        ...(sentimentReason && { sentiment_reason: sentimentReason }),
      },
    };

    await supabaseAdmin.from('sessions').update({ current_state: nextState }).eq('id', sessionId);

    try {
      getWebSocketService().stateUpdated?.(sessionId, {
        state: nextState,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // non-critical
    }

    // Positive inject when sentiment crosses thresholds upward
    if (delta > 0 && nudged > current) {
      const scenarioId = (session as { scenario_id?: string }).scenario_id;
      const thresholds = [6, 8];
      for (const t of thresholds) {
        if (current < t && nudged >= t && scenarioId) {
          await supabaseAdmin.from('scenario_injects').insert({
            scenario_id: scenarioId,
            session_id: sessionId,
            title: t >= 8 ? 'Positive public response' : 'Public sentiment stabilising',
            body:
              t >= 8
                ? 'Your communications strategy is working well. Public confidence in the response effort has improved significantly. Media coverage is largely positive.'
                : 'Your latest press statement has been received positively. Public sentiment is showing early signs of recovery. Maintain the current communications tempo.',
            inject_type: 'field_update',
            trigger_type: 'time_based',
            trigger_minutes: 0,
            target_team: 'media',
            generation_source: 'sentiment_positive',
          });
          logger.info({ sessionId, threshold: t, nudged }, 'Positive sentiment inject created');
          break;
        }
      }
    }

    // Negative inject when sentiment drops below thresholds
    if (delta < 0 && nudged < current) {
      const scenarioId = (session as { scenario_id?: string }).scenario_id;
      const thresholds = [4, 2];
      for (const t of thresholds) {
        if (current > t && nudged <= t && scenarioId) {
          await supabaseAdmin.from('scenario_injects').insert({
            scenario_id: scenarioId,
            session_id: sessionId,
            title: t <= 2 ? 'Public confidence crisis' : 'Growing public unease',
            body:
              t <= 2
                ? `Public confidence has collapsed. ${sentimentReason || 'Communications have failed to reassure the public.'} Social media is flooded with criticism and panic is spreading. Immediate corrective action is needed.`
                : `Public sentiment is declining. ${sentimentReason || 'Recent communications have not adequately addressed public concerns.'} Media outlets are beginning to question the response effort. Consider issuing a more reassuring and factual update.`,
            inject_type: 'field_update',
            trigger_type: 'time_based',
            trigger_minutes: 0,
            target_team: 'media',
            generation_source: 'sentiment_negative',
          });
          logger.info({ sessionId, threshold: t, nudged }, 'Negative sentiment inject created');
          break;
        }
      }
    }

    logger.info(
      { sessionId, mistakeType, previous: current, nudged, delta, sentimentLabel },
      'Public sentiment nudged (media decision)',
    );
  } catch (err) {
    logger.warn({ err, sessionId }, 'nudgePublicSentiment failed');
  }
}

/**
 * Compute unanswered media challenges and apply sentiment pressure.
 * Called from the AI inject scheduler on each cycle.
 */
export async function applyMediaChallengePressure(sessionId: string): Promise<void> {
  try {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('current_state, scenario_id')
      .eq('id', sessionId)
      .single();
    if (!session) return;

    const scenarioId = (session as { scenario_id?: string }).scenario_id;
    if (!scenarioId) return;

    // Find injects targeting media team
    const { data: mediaInjects } = await supabaseAdmin
      .from('session_published_injects')
      .select('inject_id')
      .eq('session_id', sessionId);

    if (!mediaInjects?.length) return;

    const publishedIds = mediaInjects.map((i) => (i as { inject_id: string }).inject_id);

    const { data: mediaTargetedInjects } = await supabaseAdmin
      .from('scenario_injects')
      .select('id')
      .eq('scenario_id', scenarioId)
      .in('id', publishedIds)
      .eq('requires_response', true)
      .or('target_team.eq.media,target_teams.cs.{media}');

    if (!mediaTargetedInjects?.length) return;

    const challengeIds = new Set(mediaTargetedInjects.map((i) => (i as { id: string }).id));

    // Find which challenges have been answered with an executed decision
    const { data: answeredDecisions } = await supabaseAdmin
      .from('decisions')
      .select('response_to_incident_id')
      .eq('session_id', sessionId)
      .eq('status', 'executed')
      .not('response_to_incident_id', 'is', null);

    const answeredIds = new Set(
      (answeredDecisions ?? []).map(
        (d) => (d as { response_to_incident_id: string }).response_to_incident_id,
      ),
    );

    // Count unanswered
    let unansweredCount = 0;
    for (const id of challengeIds) {
      if (!answeredIds.has(id)) unansweredCount++;
    }

    const currentState = ((session as { current_state?: Record<string, unknown> }).current_state ??
      {}) as Record<string, unknown>;
    const mediaState = (currentState.media_state ?? {}) as Record<string, unknown>;
    const currentSentiment =
      typeof mediaState.public_sentiment === 'number' ? mediaState.public_sentiment : 5;

    // Apply pressure: -0.3 per unanswered challenge, capped at -1.5 total
    const pressure = Math.min(1.5, unansweredCount * 0.3);
    const nudged =
      unansweredCount > 0
        ? Math.max(1, Math.round((currentSentiment - pressure) * 10) / 10)
        : currentSentiment;

    const nextState = {
      ...currentState,
      media_state: {
        ...mediaState,
        public_sentiment: nudged,
        unanswered_challenges: unansweredCount,
      },
    };

    await supabaseAdmin.from('sessions').update({ current_state: nextState }).eq('id', sessionId);

    try {
      getWebSocketService().stateUpdated?.(sessionId, {
        state: nextState,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // non-critical
    }

    if (unansweredCount > 0) {
      logger.info(
        { sessionId, unansweredCount, pressure, from: currentSentiment, to: nudged },
        'Media challenge pressure applied',
      );
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'applyMediaChallengePressure failed');
  }
}
