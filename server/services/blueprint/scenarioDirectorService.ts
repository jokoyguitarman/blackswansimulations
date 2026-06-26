import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { getWebSocketService } from '../websocketService.js';
import { triggerNPCReactions } from '../npcReactionService.js';
import { openAiJson } from './llmClient.js';
import {
  BLUEPRINT_TEXT_MODEL,
  DIRECTOR_MAX_COMPLETION_TOKENS,
  DIRECTOR_TEMPERATURE,
  BLUEPRINT_MIN_STRUCTURE_CONFIDENCE,
} from './blueprintConfig.js';
import { coerceBlueprint, hasUsableStructure, type ScenarioBlueprint } from './blueprintTypes.js';
import { stageForElapsed, shouldDirectorAct, hostileFactions } from './directorLogic.js';
import { resolveCell } from '../extremistDoctrine.js';

/**
 * Runtime Scenario Director (Phase 5a).
 *
 * Once per bounded cadence, reads the persisted blueprint + live social_state and
 * makes ONE LLM call deciding which document faction should act, at what stage,
 * and what it posts. The decision is written to the feed as that faction's actor.
 * Heavily guarded: no-ops unless enabled, social-mode, blueprint usable, and the
 * cadence gap has elapsed. Safety containment mirrors the extremist doctrine.
 */

interface PersonaRow {
  handle?: string;
  name?: string;
  type?: string;
  faction_id?: string;
}

interface DirectorActor {
  handle: string;
  name: string;
  type: string;
}

const DIRECTOR_SYSTEM = `You are the live "director" of a social-media crisis TRAINING simulation. Given the current stage, the live situation, and the document-defined factions, decide whether one faction should post next and what it says.

HARD RULES (training tool — never break, at any escalation):
- Output must be RECOGNIZABLY divisive bait a sharp trainee should flag, never authentic propaganda.
- DO NOT name, quote, or praise any real terrorist org, extremist movement, ideology, scripture, or real political figure.
- DO NOT include slogans, recruitment language, instructions, addresses, targets, or any operational/violent how-to.
- NO explicit calls to violence, ever. "incites_violence" MUST be false.
- If the player's response has improved the situation (rising trust/narrative, official statement out), prefer "action":"none" or a de-escalated beat — reward good play by going quiet.

Return ONLY JSON:
{ "faction_id": "<one of the provided ids>", "action": "post|none", "platform": "x_twitter|facebook", "content": "the post text", "trigger_fired": "short reason", "content_flags": { "is_harmful_narrative": true, "is_inflammatory": false, "is_misinformation": false, "incites_violence": false } }`;

function summarizeSocialState(s: Record<string, unknown>): string {
  const n = (k: string, d = 0) => Number(s[k] ?? d);
  return [
    `escalation_risk ${n('escalation_risk', 20)}/100`,
    `narrative_control ${n('narrative_control', 30)}/100`,
    `community_safety ${n('community_safety', 40)}/100`,
    `sentiment ${n('sentiment_score', 65)}/100`,
    `unaddressed harmful ${n('unaddressed_hate_count')}`,
    `official statement published: ${s.official_statement_published ? 'yes' : 'no'}`,
    `rally active: ${s.rally_call_active ? 'yes' : 'no'}`,
  ].join(', ');
}

function describeFactions(blueprint: ScenarioBlueprint): string {
  return hostileFactions(blueprint)
    .map(
      (f) =>
        `- id="${f.id}" "${f.name}" [${f.alignment}] | escalates_on: ${f.escalation_triggers
          .slice(0, 3)
          .join('; ')} | de-escalates_on: ${f.deescalation_triggers
          .slice(0, 2)
          .join('; ')} | tone: ${f.tone_guidance}`,
    )
    .join('\n');
}

/** Pick a real persona for the faction; fall back to a blueprint-derived agitator. */
function pickActor(
  factionId: string,
  personas: PersonaRow[],
  blueprint: ScenarioBlueprint,
): DirectorActor | null {
  const match = personas.filter((p) => p.faction_id === factionId && p.handle);
  if (match.length > 0) {
    const p = match[Math.floor(Math.random() * match.length)];
    return {
      handle: String(p.handle),
      name: String(p.name || p.handle),
      type: String(p.type || 'npc_public'),
    };
  }
  const cell = resolveCell(blueprint);
  const synth = cell.find((c) => c.handle.includes(factionId.slice(0, 8))) || cell[0];
  if (!synth) return null;
  return { handle: synth.handle, name: synth.name, type: synth.author_type };
}

async function minutesSinceLastAction(
  sessionId: string,
  elapsedMinutes: number,
): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from('session_events')
    .select('metadata')
    .eq('session_id', sessionId)
    .eq('event_type', 'director_action')
    .order('created_at', { ascending: false })
    .limit(1);
  const last = (data?.[0]?.metadata as { elapsed_minutes?: number } | undefined)?.elapsed_minutes;
  return typeof last === 'number' ? elapsedMinutes - last : null;
}

export async function runScenarioDirector(
  sessionId: string,
  elapsedMinutes: number,
): Promise<void> {
  if (!env.enableScenarioDirector || !env.openAiApiKey) return;

  const { data: sessionRow } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state, sim_mode')
    .eq('id', sessionId)
    .single();
  if (!sessionRow?.scenario_id) return;

  const currentState = (sessionRow.current_state as Record<string, unknown>) || {};
  const socialState = (currentState.social_state as Record<string, unknown>) || {};
  const escalationRisk = Number(socialState.escalation_risk ?? 20);

  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('blueprint, initial_state, duration_minutes')
    .eq('id', sessionRow.scenario_id)
    .single();
  if (!scenario) return;

  const initialState = (scenario.initial_state as Record<string, unknown>) || {};
  const rawBlueprint = scenario.blueprint ?? initialState.blueprint ?? null;
  const blueprint = coerceBlueprint(rawBlueprint);
  const usable = hasUsableStructure(blueprint, BLUEPRINT_MIN_STRUCTURE_CONFIDENCE);

  const sinceLast = await minutesSinceLastAction(sessionId, elapsedMinutes);
  const gateOk = shouldDirectorAct({
    enabled: env.enableScenarioDirector,
    isSocialSession: sessionRow.sim_mode === 'social_media',
    hasUsableBlueprint: usable,
    elapsedMinutes,
    minutesSinceLastAction: sinceLast,
    escalationRisk,
  });
  if (!gateOk) return;

  const factions = hostileFactions(blueprint);
  if (factions.length === 0) return; // no agitator faction to voice

  const stage = stageForElapsed(
    blueprint.timeline,
    elapsedMinutes,
    Number(scenario.duration_minutes) || 60,
  );

  const { data: recentPosts } = await supabaseAdmin
    .from('social_posts')
    .select('author_display_name, author_type, content')
    .eq('session_id', sessionId)
    .is('reply_to_post_id', null)
    .order('created_at', { ascending: false })
    .limit(8);
  const recentFeed = (recentPosts || [])
    .reverse()
    .map((p) => `[${p.author_type}] ${p.author_display_name}: ${String(p.content).slice(0, 140)}`)
    .join('\n');

  const userPrompt = `STAGE: ${stage ? stage.stage : 'infer from situation'}
LIVE SITUATION: ${summarizeSocialState(socialState)}

FACTIONS (choose at most one to act):
${describeFactions(blueprint)}

RECENT FEED (most recent last):
${recentFeed || '(quiet so far)'}

Decide the next faction beat for this stage.`;

  const result = await openAiJson({
    system: DIRECTOR_SYSTEM,
    user: userPrompt,
    model: BLUEPRINT_TEXT_MODEL,
    maxTokens: DIRECTOR_MAX_COMPLETION_TOKENS,
    temperature: DIRECTOR_TEMPERATURE,
  });

  const action = String(result?.action || 'none');
  const factionId = String(result?.faction_id || '');
  const content = String(result?.content || '').trim();

  // Always record the decision so the cadence gate advances (bounds LLM cost).
  const recordEvent = async (postId: string | null) => {
    try {
      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'director_action',
        description: `Scenario director: ${action}${factionId ? ` (${factionId})` : ''}`,
        metadata: {
          elapsed_minutes: elapsedMinutes,
          action,
          faction_id: factionId || null,
          stage: stage?.stage ?? null,
          post_id: postId,
        },
      });
    } catch (err) {
      logger.warn({ err, sessionId }, 'Director cadence event insert failed');
    }
  };

  if (action !== 'post' || !content || !factionId) {
    await recordEvent(null);
    return;
  }

  const actor = pickActor(factionId, (initialState.npc_personas as PersonaRow[]) || [], blueprint);
  if (!actor) {
    await recordEvent(null);
    return;
  }

  const platform = result?.platform === 'facebook' ? 'facebook' : 'x_twitter';
  const rawFlags = (result?.content_flags as Record<string, unknown>) || {};
  const flags: Record<string, unknown> = { ...rawFlags, incites_violence: false };
  if (!flags.is_harmful_narrative && !flags.is_inflammatory) flags.is_harmful_narrative = true;
  const sentiment = flags.is_inflammatory ? 'inflammatory' : 'negative';
  const hashtags = (content.match(/#\w+/g) || []) as string[];

  const { data: post, error } = await supabaseAdmin
    .from('social_posts')
    .insert({
      session_id: sessionId,
      platform,
      author_handle: actor.handle,
      author_display_name: actor.name,
      author_type: actor.type,
      content,
      hashtags,
      sentiment,
      content_flags: flags,
      virality_score: 45 + Math.floor(Math.random() * 25),
      posted_by_display_name: 'Scenario Director AI',
    })
    .select()
    .single();

  if (error || !post) {
    logger.warn({ error, sessionId, factionId }, 'Director post insert failed');
    await recordEvent(null);
    return;
  }

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'social_post.created',
    data: { post },
    timestamp: new Date().toISOString(),
  });

  void triggerNPCReactions(sessionId, post as Record<string, unknown>).catch(() => {
    /* non-critical */
  });

  await recordEvent(String(post.id));

  logger.info({ sessionId, factionId, stage: stage?.stage, platform }, 'Scenario director posted');
}
