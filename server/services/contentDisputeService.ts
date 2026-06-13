import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import { recordPlayerAction } from './sopCheckerService.js';

interface FactSheet {
  confirmed_facts?: string[];
  unconfirmed_claims?: Array<{ claim: string; status?: string; truth?: string }>;
}

interface DisputeRecord {
  id: string;
  session_id: string;
  requested_by: string;
  target_type: 'article' | 'post';
  target_id: string;
  claimed_falsehood: string;
  submitted_facts: string;
}

interface JudgeVerdict {
  verdict: 'uphold' | 'correct' | 'reject';
  confidence: number;
  reason: string;
  correction_note: string;
}

const VERDICT_TO_STATUS: Record<JudgeVerdict['verdict'], string> = {
  uphold: 'upheld',
  correct: 'corrected',
  reject: 'rejected',
};

/**
 * Load the target content (article or post) being disputed.
 * Returns a normalized { headline, body, outlet, hasFactSheet } shape.
 */
async function loadTargetContent(
  targetType: 'article' | 'post',
  targetId: string,
): Promise<{ title: string; body: string; source: string } | null> {
  if (targetType === 'article') {
    const { data } = await supabaseAdmin
      .from('sim_news_articles')
      .select('headline, subheadline, body, outlet_name, status')
      .eq('id', targetId)
      .single();
    if (!data) return null;
    return {
      title: `${data.headline}${data.subheadline ? ` — ${data.subheadline}` : ''}`,
      body: data.body,
      source: data.outlet_name,
    };
  }

  const { data } = await supabaseAdmin
    .from('social_posts')
    .select('content, author_display_name, author_handle')
    .eq('id', targetId)
    .single();
  if (!data) return null;
  return {
    title: '',
    body: data.content,
    source: `${data.author_display_name} (${data.author_handle})`,
  };
}

/**
 * Ask the AI judge to rule on a dispute against the scenario fact sheet.
 */
async function callJudge(
  content: { title: string; body: string; source: string },
  dispute: DisputeRecord,
  factSheet: FactSheet | null,
  crisisDescription: string,
): Promise<JudgeVerdict | null> {
  const confirmed = (factSheet?.confirmed_facts || []).slice(0, 10).join('\n- ');
  const claims = (factSheet?.unconfirmed_claims || [])
    .slice(0, 8)
    .map((c) => `"${c.claim}" [${c.status || 'UNVERIFIED'}] truth: ${c.truth || 'unknown'}`)
    .join('\n- ');

  const hasFactSheet = !!(confirmed || claims);
  const factSheetBlock = hasFactSheet
    ? `GROUND TRUTH FACT SHEET (authoritative — this is what is actually true):
CONFIRMED FACTS:
- ${confirmed || '(none provided)'}

KNOWN FALSE / UNVERIFIED CLAIMS:
- ${claims || '(none provided)'}`
    : `NO FACT SHEET IS AVAILABLE for this scenario. You cannot verify ground truth. Be conservative: only uphold or correct if the disputed content is self-evidently fabricated or the player's evidence is overwhelmingly strong. Otherwise reject with low confidence.`;

  const systemPrompt = `You are an impartial editorial standards adjudicator for a crisis-communications training simulation. A player has filed a dispute claiming a piece of published content contains misinformation, and has submitted counter-facts. Your job is to rule on the dispute by comparing the content and the player's evidence against the ground-truth fact sheet.

${factSheetBlock}

VERDICT OPTIONS:
- "uphold": The content materially conflicts with the confirmed facts (or repeats a known-false claim) AND the player's submitted facts are substantially correct. The content should be retracted/removed.
- "correct": The content is partially inaccurate or misleading but not wholly false; a correction note should be appended rather than a full retraction.
- "reject": The content is consistent with the confirmed facts, OR the player's submitted "facts" are themselves wrong, unsupported, or irrelevant. No change is made.

RULES:
- Base your decision ONLY on the fact sheet and the evidence provided. Do not invent facts.
- Be skeptical of vague or unsupported player claims. Crying "fake news" without solid evidence should be rejected.
- confidence is 0.0-1.0 reflecting how certain you are.
- correction_note is a short factual clarification (only meaningful when verdict is "correct"; otherwise empty string).

Return ONLY valid JSON:
{ "verdict": "uphold|correct|reject", "confidence": 0.0, "reason": "1-2 sentence justification", "correction_note": "" }`;

  const userPrompt = `Crisis context: ${crisisDescription.substring(0, 400)}

DISPUTED CONTENT (from ${content.source}):
${content.title ? `Headline: ${content.title}\n` : ''}${content.body.substring(0, 1500)}

PLAYER'S CLAIM OF FALSEHOOD:
${dispute.claimed_falsehood}

PLAYER'S SUBMITTED FACTS / EVIDENCE:
${dispute.submitted_facts}`;

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
      temperature: 0.3,
      max_completion_tokens: 600,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    logger.warn({ status: response.status }, 'Dispute judge AI request failed');
    return null;
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<JudgeVerdict>;
    const verdict =
      parsed.verdict === 'uphold' || parsed.verdict === 'correct' ? parsed.verdict : 'reject';
    return {
      verdict,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reason: String(parsed.reason || ''),
      correction_note: String(parsed.correction_note || ''),
    };
  } catch {
    logger.warn({ raw: String(raw).substring(0, 200) }, 'Failed to parse dispute verdict JSON');
    return null;
  }
}

/**
 * Apply the verdict's consequence to the disputed content.
 */
async function applyOutcome(dispute: DisputeRecord, verdict: JudgeVerdict): Promise<void> {
  const { session_id: sessionId, target_type: targetType, target_id: targetId } = dispute;

  if (targetType === 'article') {
    if (verdict.verdict === 'uphold') {
      const { data: article } = await supabaseAdmin
        .from('sim_news_articles')
        .update({ status: 'retracted', correction_note: verdict.reason })
        .eq('id', targetId)
        .select()
        .single();

      // Also remove any social posts that shared this retracted article.
      await supabaseAdmin
        .from('social_posts')
        .update({ platform_removed: true, removal_reason: 'shared_article_retracted' })
        .eq('session_id', sessionId)
        .eq('shared_article_id', targetId);

      getWebSocketService().broadcastToSession(sessionId, {
        type: 'news_article.updated',
        data: { article },
        timestamp: new Date().toISOString(),
      });
    } else if (verdict.verdict === 'correct') {
      const { data: article } = await supabaseAdmin
        .from('sim_news_articles')
        .update({ status: 'corrected', correction_note: verdict.correction_note || verdict.reason })
        .eq('id', targetId)
        .select()
        .single();

      getWebSocketService().broadcastToSession(sessionId, {
        type: 'news_article.updated',
        data: { article },
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  // Social post
  if (verdict.verdict === 'uphold') {
    await supabaseAdmin
      .from('social_posts')
      .update({ platform_removed: true, removal_reason: 'misinformation_dispute_upheld' })
      .eq('id', targetId);

    getWebSocketService().broadcastToSession(sessionId, {
      type: 'social_post.removed',
      data: { post_id: targetId, reason: 'misinformation_dispute_upheld' },
      timestamp: new Date().toISOString(),
    });
  }
  // 'correct' and 'reject' leave the post in place.
}

/**
 * Notify the requesting player of the verdict.
 */
async function notifyRequester(dispute: DisputeRecord, verdict: JudgeVerdict): Promise<void> {
  const upheld = verdict.verdict === 'uphold';
  const corrected = verdict.verdict === 'correct';
  const title = upheld
    ? 'Your dispute was upheld'
    : corrected
      ? 'A correction was issued'
      : 'Your dispute was not upheld';
  const message = verdict.reason.substring(0, 200);

  const { error } = await supabaseAdmin.from('notifications').insert({
    session_id: dispute.session_id,
    user_id: dispute.requested_by,
    type: 'dispute_resolved',
    title,
    message,
    priority: upheld || corrected ? 'high' : 'medium',
    metadata: {
      dispute_id: dispute.id,
      target_type: dispute.target_type,
      target_id: dispute.target_id,
      verdict: verdict.verdict,
    },
  });

  if (error) {
    logger.warn({ error, disputeId: dispute.id }, 'Failed to create dispute notification');
    return;
  }

  getWebSocketService().broadcastToSession(dispute.session_id, {
    type: 'notification.created',
    data: {
      user_id: dispute.requested_by,
      notification_type: 'dispute_resolved',
      title,
      metadata: {
        dispute_id: dispute.id,
        target_type: dispute.target_type,
        target_id: dispute.target_id,
        verdict: verdict.verdict,
      },
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Adjudicate a dispute: AI judge vs the scenario fact sheet, then apply the
 * outcome (retract / correct / reject) after a realistic delay, notify the
 * requester, and score the player action.
 */
export async function adjudicateDispute(disputeId: string): Promise<void> {
  if (!env.openAiApiKey) return;

  try {
    const { data: dispute } = await supabaseAdmin
      .from('content_dispute_requests')
      .select('*')
      .eq('id', disputeId)
      .single();

    if (!dispute || dispute.status !== 'pending') return;
    const typed = dispute as DisputeRecord;

    const content = await loadTargetContent(typed.target_type, typed.target_id);
    if (!content) {
      logger.warn({ disputeId }, 'Dispute target content not found');
      return;
    }

    // Load scenario fact sheet (ground truth) for this session.
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', typed.session_id)
      .single();

    let factSheet: FactSheet | null = null;
    let crisisDescription = '';
    if (session?.scenario_id) {
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('description, initial_state')
        .eq('id', session.scenario_id)
        .single();
      const initialState = (scenario?.initial_state || {}) as Record<string, unknown>;
      factSheet = (initialState.fact_sheet as FactSheet) || null;
      crisisDescription = String(scenario?.description || '');
    }

    const verdict = await callJudge(content, typed, factSheet, crisisDescription);
    if (!verdict) return;

    // Realistic editorial review delay: 60-180s.
    const delayMs = (60 + Math.floor(Math.random() * 120)) * 1000;

    setTimeout(async () => {
      try {
        // Re-check the dispute is still pending (avoid double-resolution).
        const { data: current } = await supabaseAdmin
          .from('content_dispute_requests')
          .select('status')
          .eq('id', disputeId)
          .single();
        if (!current || current.status !== 'pending') return;

        await supabaseAdmin
          .from('content_dispute_requests')
          .update({
            status: VERDICT_TO_STATUS[verdict.verdict],
            verdict_reason: verdict.reason,
            ai_confidence: verdict.confidence,
            resolved_at: new Date().toISOString(),
          })
          .eq('id', disputeId);

        await applyOutcome(typed, verdict);
        await notifyRequester(typed, verdict);

        // Score the outcome.
        const success = verdict.verdict === 'uphold' || verdict.verdict === 'correct';
        await recordPlayerAction(
          typed.session_id,
          typed.requested_by,
          success ? 'dispute_upheld' : 'dispute_rejected',
          typed.target_id,
          verdict.reason,
          { verdict: verdict.verdict, confidence: verdict.confidence },
          'fact_check',
        );

        logger.info(
          { disputeId, verdict: verdict.verdict, confidence: verdict.confidence },
          'Dispute adjudicated',
        );
      } catch (applyErr) {
        logger.warn({ err: applyErr, disputeId }, 'Failed to apply dispute outcome');
      }
    }, delayMs);

    logger.info({ disputeId, verdict: verdict.verdict, delayMs }, 'Dispute verdict scheduled');
  } catch (err) {
    logger.error({ err, disputeId }, 'Dispute adjudication failed');
  }
}
