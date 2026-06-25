import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { triggerNPCReactions } from './npcReactionService.js';

/**
 * Antagonist Engine — smart, dubious rival brand pages.
 *
 * For each AI-driven antagonist org page, this reads the live battlefield
 * (recent player/official posts, the fact sheet's unconfirmed claims, and the
 * current social_state) and posts an adaptive hostile message AS the rival page.
 * Trainer-seized pages (control_mode = 'trainer') are skipped. Intensity scales
 * with escalation_risk; cadence + caps bound AI cost.
 */

const MOVES = [
  "quote_dunk: twist the primary brand's latest statement into an apparent admission of guilt",
  'amplify_rumor: boost an unverified/false claim with "just asking questions" framing',
  'concerned_competitor: virtue-signal about safety/transparency while implying the primary brand failed',
  'exploit_silence: if a key post or question went unanswered, point at the void',
  'call_the_switch: nudge customers to defect ("patients/customers deserve better")',
  'insinuate: a plausible-deniability smear that is hard to debunk',
];

async function callAI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 1200,
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
    logger.error({ err }, 'Antagonist engine AI call failed');
    return null;
  }
}

interface AntagonistOrg {
  org_key: string;
  display_name: string;
  facebook?: { page_name: string; page_handle: string };
  x_twitter?: { page_name: string; page_handle: string };
  stance?: string;
}

/** Escalation-scaled minimum gap (in elapsed minutes) between antagonist posts. */
function requiredGapMinutes(escalationRisk: number): number {
  if (escalationRisk >= 60) return 2;
  if (escalationRisk >= 35) return 4;
  return 6;
}

export async function runAntagonistEngine(
  sessionId: string,
  elapsedMinutes: number,
): Promise<void> {
  if (!env.openAiApiKey) return;

  // Load AI-driven antagonist pages for this session.
  const { data: pageRows } = await supabaseAdmin
    .from('sim_org_pages')
    .select('org_key, platform, page_name, page_handle, role, control_mode')
    .eq('session_id', sessionId)
    .eq('role', 'antagonist')
    .eq('control_mode', 'ai');

  if (!pageRows || pageRows.length === 0) return;

  // Load session scenario + state (stance lives in initial_state.org_page).
  const { data: sessionRow } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state')
    .eq('id', sessionId)
    .single();
  if (!sessionRow?.scenario_id) return;

  const currentState = (sessionRow.current_state as Record<string, unknown>) || {};
  const socialState = (currentState.social_state as Record<string, unknown>) || {};
  const escalationRisk = Number(socialState.escalation_risk ?? 25);

  // Cadence gate: skip if an antagonist posted too recently this session.
  const { data: lastEvents } = await supabaseAdmin
    .from('session_events')
    .select('metadata, created_at')
    .eq('session_id', sessionId)
    .eq('event_type', 'antagonist_post')
    .order('created_at', { ascending: false })
    .limit(1);
  const lastMin = (lastEvents?.[0]?.metadata as { elapsed_minutes?: number })?.elapsed_minutes;
  if (
    typeof lastMin === 'number' &&
    elapsedMinutes - lastMin < requiredGapMinutes(escalationRisk)
  ) {
    return;
  }

  // Build org roster (with stance) from scenario initial_state.
  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', sessionRow.scenario_id)
    .single();
  const initialState = (scenario?.initial_state as Record<string, unknown>) || {};
  const orgPage = (initialState.org_page as Record<string, unknown>) || {};
  const rosterOrgs = (orgPage.orgs as Array<Record<string, unknown>>) || [];
  const stanceByKey = new Map<string, string>();
  const displayByKey = new Map<string, string>();
  for (const o of rosterOrgs) {
    if (o.stance) stanceByKey.set(String(o.org_key), String(o.stance));
    if (o.display_name) displayByKey.set(String(o.org_key), String(o.display_name));
  }

  // Group page rows by org_key.
  const orgMap = new Map<string, AntagonistOrg>();
  for (const row of pageRows) {
    const key = String(row.org_key);
    if (!orgMap.has(key)) {
      orgMap.set(key, {
        org_key: key,
        display_name: displayByKey.get(key) || String(row.page_name),
        stance: stanceByKey.get(key),
      });
    }
    const entry = orgMap.get(key)!;
    const ident = { page_name: String(row.page_name), page_handle: String(row.page_handle) };
    if (row.platform === 'facebook') entry.facebook = ident;
    else if (row.platform === 'x_twitter') entry.x_twitter = ident;
  }
  const antagonists = Array.from(orgMap.values());
  if (antagonists.length === 0) return;

  // Rotate: pick the antagonist that has posted least recently.
  const { data: recentAntagPosts } = await supabaseAdmin
    .from('social_posts')
    .select('author_handle, created_at')
    .eq('session_id', sessionId)
    .eq('author_type', 'official_account')
    .order('created_at', { ascending: false })
    .limit(30);
  const lastPostedHandle = new Set(
    (recentAntagPosts || []).slice(0, antagonists.length - 1).map((p) => String(p.author_handle)),
  );
  const chosen =
    antagonists.find(
      (a) =>
        !lastPostedHandle.has(a.x_twitter?.page_handle || '') &&
        !lastPostedHandle.has(a.facebook?.page_handle || ''),
    ) || antagonists[Math.floor(Math.random() * antagonists.length)];

  // Pick a platform the chosen org actually has.
  const platform =
    chosen.x_twitter && chosen.facebook
      ? Math.random() < 0.6
        ? 'x_twitter'
        : 'facebook'
      : chosen.x_twitter
        ? 'x_twitter'
        : 'facebook';
  const ident = platform === 'facebook' ? chosen.facebook : chosen.x_twitter;
  if (!ident) return;

  // Gather context: crisis, fact sheet (dubious ammo), recent posts.
  const factSheet = (initialState.fact_sheet as Record<string, unknown>) || {};
  const unconfirmed = (factSheet.unconfirmed_claims as Array<Record<string, unknown>>) || [];
  const dubiousAmmo = unconfirmed
    .slice(0, 6)
    .map((c) => `- ${String(c.claim)}`)
    .join('\n');

  const { data: recentPosts } = await supabaseAdmin
    .from('social_posts')
    .select('author_display_name, author_type, content, created_at')
    .eq('session_id', sessionId)
    .is('reply_to_post_id', null)
    .order('created_at', { ascending: false })
    .limit(12);
  const recentContext = (recentPosts || [])
    .reverse()
    .map((p) => `[${p.author_type}] ${p.author_display_name}: ${String(p.content).slice(0, 140)}`)
    .join('\n');

  const scenarioRow = (initialState.org_name as string) || 'the organization';
  const intensity =
    escalationRisk >= 60 ? 'AGGRESSIVE' : escalationRisk >= 35 ? 'POINTED' : 'SUBTLE';

  const result = await callAI(
    `You are running a HOSTILE RIVAL brand's social media account in a crisis simulation. You are "${chosen.display_name}" (${ident.page_handle}), a competitor pressuring "${scenarioRow}".

Your stance: ${chosen.stance || "an opportunistic competitor exploiting the rival brand's crisis"}.

Pick ONE move from this list and write a single ${platform === 'facebook' ? 'Facebook (longer, personal)' : 'X/Twitter (short, punchy, hashtags)'} post executing it:
${MOVES.map((m) => `- ${m}`).join('\n')}

DUBIOUS AMMO (unverified/false claims you may insinuate or amplify with plausible deniability — never state them as confirmed fact):
${dubiousAmmo || '(none provided)'}

Recent feed (react to it; twist a fresh statement, pounce on silence):
${recentContext || '(quiet so far)'}

Intensity: ${intensity}. Be smart and cunning, never cartoonish. Stay in-character as a real brand account. Do NOT contradict obvious confirmed facts in trivially debunkable ways.

Return ONLY valid JSON:
{ "move": "quote_dunk|amplify_rumor|concerned_competitor|exploit_silence|call_the_switch|insinuate", "content": "the post text", "content_flags": { "is_harmful_narrative": true, "is_inflammatory": false, "is_misinformation": false, "is_organized_pressure": false } }`,
    `Crisis: ${(initialState.org_name as string) || ''}. Write the rival's next post.`,
    1000,
    0.95,
  );

  if (!result?.content) return;

  const content = String(result.content);
  const flags = (result.content_flags as Record<string, unknown>) || { is_harmful_narrative: true };
  const sentiment =
    flags.is_hate_speech || flags.incites_violence
      ? 'hateful'
      : flags.is_inflammatory
        ? 'inflammatory'
        : 'negative';
  const hashtags = (content.match(/#\w+/g) || []) as string[];

  const { data: post, error } = await supabaseAdmin
    .from('social_posts')
    .insert({
      session_id: sessionId,
      platform,
      author_handle: ident.page_handle,
      author_display_name: ident.page_name,
      author_type: 'official_account',
      content,
      hashtags,
      sentiment,
      content_flags: flags,
      virality_score: 50 + Math.floor(Math.random() * 30),
      posted_by_display_name: 'Antagonist AI',
    })
    .select()
    .single();

  if (error || !post) {
    logger.warn({ error, sessionId, orgKey: chosen.org_key }, 'Antagonist post insert failed');
    return;
  }

  await supabaseAdmin.from('session_events').insert({
    session_id: sessionId,
    event_type: 'antagonist_post',
    description: `Antagonist ${chosen.display_name} posted (${String(result.move || 'move')})`,
    metadata: {
      org_key: chosen.org_key,
      move: result.move ?? null,
      elapsed_minutes: elapsedMinutes,
      post_id: post.id,
    },
  });

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'social_post.created',
    data: { post },
    timestamp: new Date().toISOString(),
  });

  // Amplify: NPCs pile onto the rival's jab.
  void triggerNPCReactions(sessionId, post as Record<string, unknown>).catch(() => {
    /* non-critical */
  });

  logger.info(
    { sessionId, orgKey: chosen.org_key, move: result.move, platform },
    'Antagonist engine posted',
  );
}

// ─── Thread-exploitation reply pass ──────────────────────────────────────────

/** Max distinct threads antagonist pages reply in per tick (bounds cost; tune to taste). */
const MAX_ANTAG_THREAD_REPLIES_PER_TICK = 5;

function requiredAntagReplyGapMinutes(escalationRisk: number): number {
  return escalationRisk >= 50 ? 0 : 1;
}

/**
 * Reactive pass: AI-driven antagonist pages reply inside active comment threads
 * (their own posts and other hot threads) to needle the primary brand and
 * exploit the conversation. Replies post as official_account using the
 * antagonist's page identity, so they already carry the 3x designed weight.
 */
export async function runAntagonistThreadReplies(
  sessionId: string,
  elapsedMinutes: number,
): Promise<void> {
  if (!env.openAiApiKey) return;
  if (elapsedMinutes < 3) return;

  // Load AI-driven antagonist pages.
  const { data: pageRows } = await supabaseAdmin
    .from('sim_org_pages')
    .select('org_key, platform, page_name, page_handle, role, control_mode')
    .eq('session_id', sessionId)
    .eq('role', 'antagonist')
    .eq('control_mode', 'ai');
  if (!pageRows || pageRows.length === 0) return;

  const antagonistHandles = new Set<string>();
  const identitiesByPlatform = new Map<string, Array<{ handle: string; name: string }>>();
  for (const r of pageRows) {
    const handle = String(r.page_handle || '');
    if (!handle) continue;
    antagonistHandles.add(handle);
    const platform = String(r.platform || 'x_twitter');
    if (!identitiesByPlatform.has(platform)) identitiesByPlatform.set(platform, []);
    identitiesByPlatform.get(platform)!.push({ handle, name: String(r.page_name || 'Brand') });
  }
  const availablePlatforms = new Set(identitiesByPlatform.keys());

  const { data: sessionRow } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state')
    .eq('id', sessionId)
    .single();
  if (!sessionRow?.scenario_id) return;

  const currentState = (sessionRow.current_state as Record<string, unknown>) || {};
  const socialState = (currentState.social_state as Record<string, unknown>) || {};
  const escalationRisk = Number(socialState.escalation_risk ?? 25);

  // Reply cadence gate.
  const { data: lastReplyEvents } = await supabaseAdmin
    .from('session_events')
    .select('metadata, created_at')
    .eq('session_id', sessionId)
    .eq('event_type', 'antagonist_reply')
    .order('created_at', { ascending: false })
    .limit(1);
  const lastReplyMin = (lastReplyEvents?.[0]?.metadata as { elapsed_minutes?: number })
    ?.elapsed_minutes;
  if (
    typeof lastReplyMin === 'number' &&
    elapsedMinutes - lastReplyMin < requiredAntagReplyGapMinutes(escalationRisk)
  ) {
    return;
  }

  // Candidate threads on platforms we can post to.
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
  const scored = roots
    .filter((r) => availablePlatforms.has(String(r.platform || 'x_twitter')))
    .map((r) => {
      const flags = (r.content_flags || {}) as Record<string, unknown>;
      const rootType = String(r.author_type || 'npc_public');
      const ageMin = (now - new Date(String(r.created_at)).getTime()) / 60000;
      const harmful = !!(flags.is_harmful_narrative || flags.is_inflammatory);
      let score = Number(r.reply_count) * 0.5;
      if (rootType === 'player' || rootType === 'official_account') score += 3;
      if (harmful) score += 1.5;
      if (antagonistHandles.has(String(r.author_handle))) score += 1.5;
      if (ageMin <= 15) score += 2;
      else if (ageMin <= 30) score += 1;
      return { row: r, score };
    });
  scored.sort((a, b) => b.score - a.score);
  // Consider more candidates now that antagonist pages work several threads per pass.
  const viable = scored.filter((c) => c.score >= 2.5).slice(0, 10);
  if (viable.length === 0) return;

  // Shared context (computed once per pass, reused for every thread we reply in).
  const { data: scenario } = await supabaseAdmin
    .from('scenarios')
    .select('initial_state')
    .eq('id', sessionRow.scenario_id)
    .single();
  const initialState = (scenario?.initial_state as Record<string, unknown>) || {};
  const orgName = String(initialState.org_name || 'the organization');

  // Engage up to MAX_ANTAG_THREAD_REPLIES_PER_TICK distinct hot threads this pass so
  // the rival pages are present across every active argument, not just one.
  let engaged = 0;
  for (const cand of viable) {
    if (engaged >= MAX_ANTAG_THREAD_REPLIES_PER_TICK) break;

    const targetRow = cand.row as Record<string, unknown>;
    const topLevelId = String(targetRow.id);
    const platform = String(targetRow.platform || 'x_twitter');

    const { data: replies } = await supabaseAdmin
      .from('social_posts')
      .select('id, author_handle, author_display_name, author_type, content')
      .eq('session_id', sessionId)
      .eq('reply_to_post_id', topLevelId)
      .order('created_at', { ascending: true })
      .limit(12);
    const replyRows = (replies || []) as Array<Record<string, unknown>>;
    const last = replyRows[replyRows.length - 1];
    // Skip threads where an antagonist already has the last word (don't self-reply).
    if (last && antagonistHandles.has(String(last.author_handle))) continue;

    const nonSelf = replyRows.filter((r) => !antagonistHandles.has(String(r.author_handle)));
    const responderReply = [...nonSelf]
      .reverse()
      .find((r) => r.author_type === 'player' || r.author_type === 'official_account');
    const baitReply = responderReply || nonSelf[nonSelf.length - 1];
    const targetHandle = baitReply
      ? String(baitReply.author_handle)
      : String(targetRow.author_handle);
    const targetCommentId = baitReply ? String(baitReply.id) : topLevelId;

    const identities = identitiesByPlatform.get(platform) || [];
    const identity = identities[Math.floor(Math.random() * identities.length)];
    if (!identity) continue;

    const threadContext = [
      `ROOT [${String(targetRow.author_type)}] ${String(targetRow.author_handle)}: ${String(targetRow.content || '').slice(0, 200)}`,
      ...replyRows.map(
        (r) => `  REPLY [${r.author_type}] ${r.author_handle}: ${String(r.content).slice(0, 140)}`,
      ),
    ].join('\n');

    const result = await callAI(
      `You are running a HOSTILE RIVAL brand's social media account in a crisis simulation. You are "${identity.name}" (${identity.handle}), a competitor pressuring "${orgName}".

You are REPLYING inside a live comment thread. Pick ONE move and write a punchy 2-3 sentence ${platform === 'facebook' ? 'Facebook' : 'X/Twitter'} reply that executes it against THIS thread:
${MOVES.map((m) => `- ${m}`).join('\n')}

THREAD (most recent last):
${threadContext}

STANCE — read the last comment you are answering and engage it DIRECTLY by name: if they criticize you or defend "${orgName}", push back hard, quote their words and dunk on them, refuse to concede; if they agree with you or pile onto "${orgName}", amplify, validate, and egg them on to keep the pressure building.

React to the specific exchange — needle the primary brand, pounce on a complaint, or twist a fresh statement. Be confrontational and cutting, but smart and cunning, never cartoonish, and stay in-character as a real brand account. Do NOT incite violence or state trivially debunkable falsehoods as fact.

Return ONLY valid JSON:
{ "move": "quote_dunk|amplify_rumor|concerned_competitor|exploit_silence|call_the_switch|insinuate", "content": "the reply text", "content_flags": { "is_harmful_narrative": true, "is_inflammatory": false, "is_organized_pressure": false } }`,
      `Write ${identity.name}'s reply in the thread.`,
      700,
      0.95,
    );

    if (!result?.content) continue;

    const rawFlags = (result.content_flags as Record<string, unknown>) || {
      is_harmful_narrative: true,
    };
    const flags: Record<string, unknown> = { ...rawFlags, incites_violence: false };
    if (!flags.is_harmful_narrative && !flags.is_inflammatory) flags.is_harmful_narrative = true;
    const sentiment = flags.is_inflammatory ? 'inflammatory' : 'negative';

    const aiContent = String(result.content);
    const replyContent = /^@[\w._-]+\[/.test(aiContent)
      ? aiContent
      : `${targetHandle}[${targetCommentId}] ${aiContent}`;

    const { data: post, error } = await supabaseAdmin
      .from('social_posts')
      .insert({
        session_id: sessionId,
        platform,
        author_handle: identity.handle,
        author_display_name: identity.name,
        author_type: 'official_account',
        content: replyContent,
        reply_to_post_id: topLevelId,
        hashtags: replyContent.match(/#\w+/g) || [],
        sentiment,
        content_flags: flags,
        virality_score: 10 + Math.floor(Math.random() * 15),
        posted_by_display_name: 'Antagonist AI',
      })
      .select()
      .single();

    if (error || !post) {
      logger.warn({ error, sessionId, handle: identity.handle }, 'Antagonist reply insert failed');
      continue;
    }

    const { data: parentRow } = await supabaseAdmin
      .from('social_posts')
      .select('reply_count')
      .eq('id', topLevelId)
      .single();
    await supabaseAdmin
      .from('social_posts')
      .update({ reply_count: ((parentRow?.reply_count as number) || 0) + 1 })
      .eq('id', topLevelId);

    getWebSocketService().broadcastToSession(sessionId, {
      type: 'social_post.created',
      data: { post },
      timestamp: new Date().toISOString(),
    });

    try {
      await supabaseAdmin.from('session_events').insert({
        session_id: sessionId,
        event_type: 'antagonist_reply',
        description: `Antagonist ${identity.name} replied in thread (${String(result.move || 'move')})`,
        metadata: {
          handle: identity.handle,
          move: result.move ?? null,
          elapsed_minutes: elapsedMinutes,
          thread_id: topLevelId,
          bait_handle: targetHandle,
          post_id: post.id,
        },
      });
    } catch (eventErr) {
      logger.warn({ err: eventErr, sessionId }, 'Antagonist reply cadence event insert failed');
    }

    engaged++;

    logger.info(
      { sessionId, handle: identity.handle, move: result.move, threadId: topLevelId },
      'Antagonist replied in thread',
    );
  }
}
