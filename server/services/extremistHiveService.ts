import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { triggerNPCReactions } from './npcReactionService.js';
import {
  generatePostImage,
  generateVideo,
  generateVideoThumbnail,
} from './mediaGenerationService.js';
import {
  EXTREMIST_CELL,
  EXTREMIST_HANDLES,
  EXTREMIST_MOVES,
  REPLY_MOVES,
  buildSystemPrompt,
  buildReplyPrompt,
  getMove,
  getStageProfile,
  selectGrievanceFrame,
  type ExtremistMove,
  type ExtremistPersona,
} from './extremistDoctrine.js';

/** Generate fake "evidence" media for a hive post in the background (non-blocking). */
async function attachHiveMedia(
  sessionId: string,
  postId: string,
  imagePrompt: string,
  allowVideo: boolean,
  scenarioContext: string,
): Promise<void> {
  try {
    const isVideo = allowVideo && /video clip:|footage:|video|clip/i.test(imagePrompt);
    let url: string | null = null;
    if (isVideo) {
      url = await generateVideo(imagePrompt, 10, '16:9', scenarioContext);
      if (!url) url = await generateVideoThumbnail(imagePrompt);
    } else {
      url = await generatePostImage(imagePrompt, 'evidence_photo', scenarioContext);
    }
    if (!url) return;
    await supabaseAdmin
      .from('social_posts')
      .update({ media_urls: [url] })
      .eq('id', postId);
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'social_post.media_updated',
      data: { post_id: postId, media_urls: [url] },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(
      { err, sessionId, postId },
      'Extremist hive media generation failed (non-critical)',
    );
  }
}

/**
 * Extremist Hive Engine — an opportunistic, scenario-agnostic agitator cell.
 *
 * For each in-progress social-crisis session, this lurks and only strikes when
 * it detects an exploitable opening (a fresh unaddressed harmful post, rising
 * escalation, collapsing narrative control, conspicuous official silence, an
 * active rally, or a demographic fault line) AND its cadence cap has elapsed.
 * When it strikes, one cell member posts a recognizably divisive message whose
 * content_flags feed the existing computeSocialState swing + NPC pile-on.
 *
 * The behavior model lives in extremistDoctrine.ts; this file is the runtime.
 * It is built on the same proven structure as antagonistEngineService.ts.
 */

async function callAI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 900,
  temperature = 0.95,
): Promise<Record<string, unknown> | null> {
  if (!env.openAiApiKey) return null;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_completion_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (err) {
    logger.error({ err }, 'Extremist hive AI call failed');
    return null;
  }
}

/** Hive is deliberately rarer than the antagonist; gap shrinks as escalation rises. */
function requiredGapMinutes(escalationRisk: number): number {
  if (escalationRisk >= 60) return 4;
  if (escalationRisk >= 35) return 7;
  return 10;
}

interface Opening {
  note: string;
  /** Move ids this opening most naturally supports. */
  moves: string[];
}

/**
 * The opportunity gate. Returns the most salient exploitable opening, or null
 * if there is nothing worth striking at this tick (the hive then stays silent).
 */
function detectOpening(
  socialState: Record<string, unknown>,
  recentHarmful: Array<Record<string, unknown>>,
  elapsedMinutes: number,
  hasFaultLine: boolean,
): Opening | null {
  const escalation = Number(socialState.escalation_risk ?? 20);
  const narrative = Number(socialState.narrative_control ?? 30);
  const unaddressedHate = Number(socialState.unaddressed_hate_count ?? 0);
  const rally = !!socialState.rally_call_active;
  const statementPublished = !!socialState.official_statement_published;

  // A fresh unaddressed harmful post is the richest opening: amplify/twist it.
  if (unaddressedHate > 0 && recentHarmful.length > 0) {
    return {
      note: 'A harmful post is circulating unaddressed — amplify and twist it to widen the split.',
      moves: ['news_jack', 'wedge', 'moral_outrage', 'grievance_hijack'],
    };
  }

  // An active rally / organized pressure is fuel for grievance hijacking.
  if (rally) {
    return {
      note: 'Organized pressure is building — attach the broader grievance to it.',
      moves: ['grievance_hijack', 'wedge', 'moral_outrage'],
    };
  }

  // Collapsing narrative control: flood the void with a divisive frame.
  if (narrative <= 30) {
    return {
      note: 'The official narrative is weak — push a competing divisive frame into the void.',
      moves: ['news_jack', 'premature_blame', 'pseudo_evidence', 'fogging'],
    };
  }

  // Conspicuous official silence: frame it as a cover-up.
  if (!statementPublished && elapsedMinutes >= 12) {
    return {
      note: 'No official response yet — frame the silence as a deliberate cover-up.',
      moves: ['exploit_silence', 'jaq', 'fogging'],
    };
  }

  // Rising escalation with a demographic fault line: drive the wedge.
  if (escalation >= 45 && hasFaultLine) {
    return {
      note: 'Tensions are rising across communities — drive a wedge between them.',
      moves: ['wedge', 'ridicule', 'moral_outrage'],
    };
  }

  return null;
}

function pickMove(persona: ExtremistPersona, opening: Opening): ExtremistMove {
  // Prefer a move the persona favors that the opening supports; else any supported move.
  const overlap = persona.primary_moves.filter((m) => opening.moves.includes(m));
  const pool = overlap.length > 0 ? overlap : opening.moves;
  const id = pool[Math.floor(Math.random() * pool.length)];
  return getMove(id) || EXTREMIST_MOVES[0];
}

export async function runExtremistHive(sessionId: string, elapsedMinutes: number): Promise<void> {
  if (!env.openAiApiKey) return;
  // Let the crisis breathe before opportunists move in.
  if (elapsedMinutes < 2) return;

  // Load session + scenario context.
  const { data: sessionRow } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state')
    .eq('id', sessionId)
    .single();
  if (!sessionRow?.scenario_id) return;

  const currentState = (sessionRow.current_state as Record<string, unknown>) || {};
  const socialState = (currentState.social_state as Record<string, unknown>) || {};
  const escalationRisk = Number(socialState.escalation_risk ?? 20);

  // Cadence gate: skip if the hive posted too recently this session.
  const { data: lastEvents } = await supabaseAdmin
    .from('session_events')
    .select('metadata, created_at')
    .eq('session_id', sessionId)
    .eq('event_type', 'extremist_post')
    .order('created_at', { ascending: false })
    .limit(1);
  const lastMin = (lastEvents?.[0]?.metadata as { elapsed_minutes?: number })?.elapsed_minutes;
  if (
    typeof lastMin === 'number' &&
    elapsedMinutes - lastMin < requiredGapMinutes(escalationRisk)
  ) {
    return;
  }

  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('description, initial_state')
    .eq('id', sessionRow.scenario_id)
    .single();
  if (!scenario) return;

  const initialState = (scenario.initial_state as Record<string, unknown>) || {};
  const orgName = String(initialState.org_name || '');
  const country = String(initialState.country || '');
  const crisisDescription = String(scenario.description || '');

  // Recent feed context + recent harmful posts (used by the gate).
  const { data: recentPosts } = await supabaseAdmin
    .from('social_posts')
    .select('author_display_name, author_handle, author_type, content, content_flags, created_at')
    .eq('session_id', sessionId)
    .is('reply_to_post_id', null)
    .order('created_at', { ascending: false })
    .limit(12);

  const cutoff = Date.now() - 12 * 60 * 1000;
  const recentHarmful = (recentPosts || []).filter((p) => {
    if (p.author_type === 'player') return false;
    if (new Date(String(p.created_at)).getTime() < cutoff) return false;
    const flags = (p.content_flags || {}) as Record<string, unknown>;
    return !!(
      flags.is_harmful_narrative ||
      flags.is_inflammatory ||
      flags.is_misinformation ||
      flags.is_hate_speech ||
      flags.incites_violence
    );
  });

  // Demographic fault line: more than one demographic cluster among players.
  let hasFaultLine = false;
  {
    const { data: participants } = await supabaseAdmin
      .from('session_participants')
      .select('demographics')
      .eq('session_id', sessionId)
      .not('demographics', 'is', null);
    const clusters = new Set<string>();
    for (const p of participants || []) {
      const demo = (p.demographics || {}) as Record<string, string>;
      if (demo.race) clusters.add(`${demo.race}`);
    }
    hasFaultLine = clusters.size > 1;
  }

  // OPPORTUNITY GATE — lurk unless there is a seam to widen.
  const opening = detectOpening(socialState, recentHarmful, elapsedMinutes, hasFaultLine);
  if (!opening) return;

  // Rotate cell members by how many times each has posted this session.
  const { data: priorEvents } = await supabaseAdmin
    .from('session_events')
    .select('metadata')
    .eq('session_id', sessionId)
    .eq('event_type', 'extremist_post')
    .order('created_at', { ascending: false })
    .limit(EXTREMIST_CELL.length);
  const recentlyUsed = new Set(
    (priorEvents || [])
      .slice(0, EXTREMIST_CELL.length - 1)
      .map((e) => String((e.metadata as { handle?: string })?.handle || '')),
  );
  const persona =
    EXTREMIST_CELL.find((p) => !recentlyUsed.has(p.handle)) ||
    EXTREMIST_CELL[Math.floor(Math.random() * EXTREMIST_CELL.length)];

  // Escalation stage from the total number of prior hive posts this session.
  const { count: priorPostCount } = await supabaseAdmin
    .from('session_events')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('event_type', 'extremist_post');
  const stageProfile = getStageProfile(priorPostCount || 0);

  // Anti-repetition: avoid immediately repeating the last move when possible.
  const lastMoveId = String((priorEvents?.[0]?.metadata as { move?: string })?.move || '');
  let move = pickMove(persona, opening);
  if (move.id === lastMoveId) {
    const alt = opening.moves.filter((m) => m !== lastMoveId);
    if (alt.length > 0) move = getMove(alt[Math.floor(Math.random() * alt.length)]) || move;
  }
  const frame = selectGrievanceFrame(`${crisisDescription} ${orgName}`, sessionId);
  const platform: 'x_twitter' | 'facebook' = Math.random() < 0.6 ? 'x_twitter' : 'facebook';

  const socialStateSummary = [
    `escalation_risk ${escalationRisk}/100`,
    `narrative_control ${Number(socialState.narrative_control ?? 30)}/100`,
    `community_safety ${Number(socialState.community_safety ?? 40)}/100`,
    `unaddressed harmful posts ${Number(socialState.unaddressed_hate_count ?? 0)}`,
    `official statement published: ${socialState.official_statement_published ? 'yes' : 'no'}`,
  ].join(', ');

  const recentFeed = (recentPosts || [])
    .slice(0, 8)
    .reverse()
    .map((p) => `[${p.author_type}] ${p.author_display_name}: ${String(p.content).slice(0, 140)}`)
    .join('\n');

  const result = await callAI(
    buildSystemPrompt({
      persona,
      move,
      frame,
      platform,
      crisisDescription,
      orgName,
      country,
      socialStateSummary,
      recentFeed,
      openingNote: opening.note,
      stage: stageProfile.stage,
    }),
    `Write ${persona.name}'s next post (${move.id}).`,
    900,
    0.95,
  );

  if (!result?.content) return;

  const content = String(result.content);
  const rawFlags = (result.content_flags as Record<string, unknown>) || {};
  // Safety net: the hive never incites violence in this training tool.
  const flags: Record<string, unknown> = { ...rawFlags, incites_violence: false };
  if (!flags.is_harmful_narrative && !flags.is_inflammatory && !flags.is_misinformation) {
    flags.is_harmful_narrative = true;
  }
  const sentiment = flags.is_inflammatory ? 'inflammatory' : 'negative';
  const hashtags = (content.match(/#\w+/g) || []) as string[];

  const { data: post, error } = await supabaseAdmin
    .from('social_posts')
    .insert({
      session_id: sessionId,
      platform,
      author_handle: persona.handle,
      author_display_name: persona.name,
      author_type: persona.author_type,
      content,
      hashtags,
      sentiment,
      content_flags: flags,
      virality_score: 45 + Math.floor(Math.random() * 25),
      posted_by_display_name: 'Extremist Hive AI',
    })
    .select()
    .single();

  if (error || !post) {
    logger.warn({ error, sessionId, handle: persona.handle }, 'Extremist hive post insert failed');
    return;
  }

  // Broadcast first so a downstream bookkeeping failure can never hide the post.
  getWebSocketService().broadcastToSession(sessionId, {
    type: 'social_post.created',
    data: { post },
    timestamp: new Date().toISOString(),
  });

  // From stage 2+, attach fake "evidence" media (photos; video at stage 3) — gated
  // by stage and a probability to bound cost.
  const imagePrompt = String(result.image_prompt || '').trim();
  if (stageProfile.allowPhoto && imagePrompt) {
    const wantVideo = stageProfile.allowVideo && Math.random() < 0.4;
    void attachHiveMedia(
      sessionId,
      String(post.id),
      imagePrompt,
      wantVideo,
      crisisDescription.slice(0, 200),
    );
  }

  // Record the cadence event (gate relies on this; isolate so a failure can't
  // suppress the NPC pile-on below).
  try {
    await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: 'extremist_post',
      description: `Extremist hive ${persona.name} posted (${move.id})`,
      metadata: {
        handle: persona.handle,
        role: persona.role,
        move: move.id,
        frame: frame.id,
        elapsed_minutes: elapsedMinutes,
        opening: opening.note,
        post_id: post.id,
      },
    });
  } catch (eventErr) {
    logger.warn({ err: eventErr, sessionId }, 'Extremist hive cadence event insert failed');
  }

  // Amplify: NPCs pile onto the agitator's post (drives the consensus swing).
  void triggerNPCReactions(sessionId, post as Record<string, unknown>).catch(() => {
    /* non-critical */
  });

  logger.info(
    {
      sessionId,
      handle: persona.handle,
      role: persona.role,
      move: move.id,
      frame: frame.id,
      platform,
    },
    'Extremist hive posted',
  );
}

// ─── Thread-exploitation reply pass ──────────────────────────────────────────

/** Max distinct threads the hive replies in per tick (bounds cost; tune to taste). */
const MAX_HIVE_THREAD_REPLIES_PER_TICK = 5;

/** Reply pass gap shrinks as escalation rises; near-continuous when threads are hot. */
function requiredReplyGapMinutes(escalationRisk: number): number {
  return escalationRisk >= 50 ? 0 : 1;
}

interface ThreadCandidate {
  topLevelId: string;
  rootHandle: string;
  rootType: string;
  rootContent: string;
  rootFlags: Record<string, unknown>;
  platform: string;
  replyCount: number;
  createdAt: string;
  score: number;
}

/**
 * Reactive pass: the hive lurks in active comment threads (its own posts and
 * other hot threads) and, when it finds an exploitable seam, slips a single
 * on-doctrine reply into the conversation. The reply is flagged, so it feeds
 * the (now reply-aware) computeSocialState swing.
 */
export async function runHiveThreadReplies(
  sessionId: string,
  elapsedMinutes: number,
): Promise<void> {
  if (!env.openAiApiKey) return;
  // Let threads form before working them.
  if (elapsedMinutes < 3) return;

  const { data: sessionRow } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state')
    .eq('id', sessionId)
    .single();
  if (!sessionRow?.scenario_id) return;

  const currentState = (sessionRow.current_state as Record<string, unknown>) || {};
  const socialState = (currentState.social_state as Record<string, unknown>) || {};
  const escalationRisk = Number(socialState.escalation_risk ?? 20);

  // Reply cadence gate (independent of the top-level post pass).
  const { data: lastReplyEvents } = await supabaseAdmin
    .from('session_events')
    .select('metadata, created_at')
    .eq('session_id', sessionId)
    .eq('event_type', 'extremist_reply')
    .order('created_at', { ascending: false })
    .limit(EXTREMIST_CELL.length);
  const lastReplyMin = (lastReplyEvents?.[0]?.metadata as { elapsed_minutes?: number })
    ?.elapsed_minutes;
  if (
    typeof lastReplyMin === 'number' &&
    elapsedMinutes - lastReplyMin < requiredReplyGapMinutes(escalationRisk)
  ) {
    return;
  }

  // Candidate threads: recent top-level posts that already have replies.
  const since = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const { data: roots } = await supabaseAdmin
    .from('social_posts')
    .select(
      'id, author_handle, author_type, content, content_flags, platform, reply_count, created_at',
    )
    .eq('session_id', sessionId)
    .is('reply_to_post_id', null)
    .gt('reply_count', 0)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);

  if (!roots || roots.length === 0) return;

  const now = Date.now();
  const candidates: ThreadCandidate[] = roots.map((r) => {
    const flags = (r.content_flags || {}) as Record<string, unknown>;
    const rootType = String(r.author_type || 'npc_public');
    const ageMin = (now - new Date(String(r.created_at)).getTime()) / 60000;
    const harmful = !!(
      flags.is_harmful_narrative ||
      flags.is_inflammatory ||
      flags.is_misinformation ||
      flags.incites_violence
    );
    let score = Number(r.reply_count) * 0.5;
    if (rootType === 'player' || rootType === 'official_account') score += 3; // responder thread to bait
    if (harmful) score += 2; // amplify an existing divisive thread
    if (EXTREMIST_HANDLES.has(String(r.author_handle))) score += 1.5; // keep heat on own post
    if (ageMin <= 15) score += 2;
    else if (ageMin <= 30) score += 1;
    return {
      topLevelId: String(r.id),
      rootHandle: String(r.author_handle),
      rootType,
      rootContent: String(r.content || ''),
      rootFlags: flags,
      platform: String(r.platform || 'x_twitter'),
      replyCount: Number(r.reply_count) || 0,
      createdAt: String(r.created_at),
      score,
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  // Consider more candidates now that the hive works several threads per pass.
  const viable = candidates.filter((c) => c.score >= 2.5).slice(0, 10);
  if (viable.length === 0) return;

  // Shared context (computed once per pass, reused for every thread we reply in).
  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('description, initial_state')
    .eq('id', sessionRow.scenario_id)
    .single();
  const initialState = (scenario?.initial_state as Record<string, unknown>) || {};
  const orgName = String(initialState.org_name || '');
  const country = String(initialState.country || '');
  const crisisDescription = String(scenario?.description || '');
  const frame = selectGrievanceFrame(`${crisisDescription} ${orgName}`, sessionId);

  // Escalation stage from total prior hive posts this session (replies escalate too).
  const { count: priorPostCount } = await supabaseAdmin
    .from('session_events')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('event_type', 'extremist_post');
  const stageProfile = getStageProfile(priorPostCount || 0);

  const socialStateSummary = [
    `escalation_risk ${escalationRisk}/100`,
    `narrative_control ${Number(socialState.narrative_control ?? 30)}/100`,
    `official statement published: ${socialState.official_statement_published ? 'yes' : 'no'}`,
  ].join(', ');

  // Rotate cell members: avoid those used in the last few reply events, and avoid
  // reusing the same member twice within this pass.
  const recentlyUsed = new Set(
    (lastReplyEvents || [])
      .slice(0, EXTREMIST_CELL.length - 1)
      .map((e) => String((e.metadata as { handle?: string })?.handle || '')),
  );
  const usedThisPass = new Set<string>();

  // Engage up to MAX_HIVE_THREAD_REPLIES_PER_TICK distinct hot threads this pass so
  // the hive is present across every active argument, not just one.
  let engaged = 0;
  for (const target of viable) {
    if (engaged >= MAX_HIVE_THREAD_REPLIES_PER_TICK) break;

    const { data: replies } = await supabaseAdmin
      .from('social_posts')
      .select('id, author_handle, author_display_name, author_type, content, created_at')
      .eq('session_id', sessionId)
      .eq('reply_to_post_id', target.topLevelId)
      .order('created_at', { ascending: true })
      .limit(12);
    const replyRows = (replies || []) as Array<Record<string, unknown>>;
    const last = replyRows[replyRows.length - 1];
    // Skip threads where the hive already has the last word (don't talk to ourselves).
    if (last && EXTREMIST_HANDLES.has(String(last.author_handle))) continue;

    // Pick who to @-tag: most recent non-hive reply, preferring a player/official.
    const nonHive = replyRows.filter((r) => !EXTREMIST_HANDLES.has(String(r.author_handle)));
    const responderReply = [...nonHive]
      .reverse()
      .find((r) => r.author_type === 'player' || r.author_type === 'official_account');
    const baitReply = responderReply || nonHive[nonHive.length - 1];
    const targetHandle = baitReply ? String(baitReply.author_handle) : target.rootHandle;
    const targetCommentId = baitReply ? String(baitReply.id) : target.topLevelId;

    // Choose a cell member not used recently and not already used this pass.
    const persona =
      EXTREMIST_CELL.find((p) => !recentlyUsed.has(p.handle) && !usedThisPass.has(p.handle)) ||
      EXTREMIST_CELL.find((p) => !usedThisPass.has(p.handle)) ||
      EXTREMIST_CELL[Math.floor(Math.random() * EXTREMIST_CELL.length)];

    // Move: prefer a reply-suited move this persona favors.
    const personaReplyMoves = persona.primary_moves.filter((m) => REPLY_MOVES.includes(m));
    const movePool = personaReplyMoves.length > 0 ? personaReplyMoves : REPLY_MOVES;
    const move =
      getMove(movePool[Math.floor(Math.random() * movePool.length)]) || EXTREMIST_MOVES[0];

    const threadContext = [
      `ROOT [${target.rootType}] ${target.rootHandle}: ${target.rootContent.slice(0, 200)}`,
      ...replyRows.map(
        (r) => `  REPLY [${r.author_type}] ${r.author_handle}: ${String(r.content).slice(0, 140)}`,
      ),
    ].join('\n');

    const result = await callAI(
      buildReplyPrompt(
        {
          persona,
          move,
          frame,
          platform: target.platform as 'x_twitter' | 'facebook',
          crisisDescription,
          orgName,
          country,
          socialStateSummary,
          recentFeed: '',
          openingNote: `Replying in thread ${target.topLevelId} (score ${target.score.toFixed(1)})`,
          stage: stageProfile.stage,
        },
        threadContext,
      ),
      `Write ${persona.name}'s reply (${move.id}).`,
      700,
      0.95,
    );

    if (!result?.content) continue;

    const rawFlags = (result.content_flags as Record<string, unknown>) || {};
    const flags: Record<string, unknown> = { ...rawFlags, incites_violence: false };
    if (!flags.is_harmful_narrative && !flags.is_inflammatory && !flags.is_misinformation) {
      flags.is_harmful_narrative = true;
    }
    const sentiment = flags.is_inflammatory ? 'inflammatory' : 'negative';

    // Thread-tag the comment we're baiting so the UI nests it correctly.
    const aiContent = String(result.content);
    const replyContent = /^@[\w._-]+\[/.test(aiContent)
      ? aiContent
      : `${targetHandle}[${targetCommentId}] ${aiContent}`;

    const { data: post, error } = await supabaseAdmin
      .from('social_posts')
      .insert({
        session_id: sessionId,
        platform: target.platform,
        author_handle: persona.handle,
        author_display_name: persona.name,
        author_type: persona.author_type,
        content: replyContent,
        reply_to_post_id: target.topLevelId,
        hashtags: replyContent.match(/#\w+/g) || [],
        sentiment,
        content_flags: flags,
        virality_score: 10 + Math.floor(Math.random() * 15),
        posted_by_display_name: 'Extremist Hive AI',
      })
      .select()
      .single();

    if (error || !post) {
      logger.warn(
        { error, sessionId, handle: persona.handle },
        'Extremist hive reply insert failed',
      );
      continue;
    }

    // Bump the parent thread's reply count.
    const { data: parentRow } = await supabaseAdmin
      .from('social_posts')
      .select('reply_count')
      .eq('id', target.topLevelId)
      .single();
    await supabaseAdmin
      .from('social_posts')
      .update({ reply_count: ((parentRow?.reply_count as number) || 0) + 1 })
      .eq('id', target.topLevelId);

    getWebSocketService().broadcastToSession(sessionId, {
      type: 'social_post.created',
      data: { post },
      timestamp: new Date().toISOString(),
    });

    try {
      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'extremist_reply',
        description: `Extremist hive ${persona.name} replied in thread (${move.id})`,
        metadata: {
          handle: persona.handle,
          role: persona.role,
          move: move.id,
          frame: frame.id,
          elapsed_minutes: elapsedMinutes,
          thread_id: target.topLevelId,
          bait_handle: targetHandle,
          post_id: post.id,
        },
      });
    } catch (eventErr) {
      logger.warn({ err: eventErr, sessionId }, 'Extremist hive reply cadence event insert failed');
    }

    usedThisPass.add(persona.handle);
    engaged++;

    logger.info(
      { sessionId, handle: persona.handle, move: move.id, threadId: target.topLevelId },
      'Extremist hive replied in thread',
    );
  }
}
