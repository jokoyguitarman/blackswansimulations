import { logger } from '../../lib/logger.js';
import { ApiError, type BotApi } from './apiClient.js';
import {
  claim,
  extractCommitments,
  rememberAction,
  settleCommitments,
  type BotMemory,
  type TeamBoard,
} from './memory.js';
import { isHate, isMisinfo, type Situation } from './perception.js';
import type { BotAction, BotPersona } from './types.js';

/**
 * Executor: one BotAction â†’ one mutating API call (plus its preconditions), with
 * guards that keep bots inside the contract in docs/ai-teammate-bots-plan.md Â§8.
 *
 * Every write goes through the public routes with the bot's JWT. The executor
 * never touches Supabase directly.
 */

export interface ExecResult {
  ok: boolean;
  summary: string;
  /** player_actions.action_type the call is expected to have produced. */
  actionType: string | null;
  error?: string;
}

export interface ExecContext {
  api: BotApi;
  sit: Situation;
  mem: BotMemory;
  board: TeamBoard | null;
  /** Session-wide claims (emails / DMs addressed to the whole organisation). */
  sessionBoard?: TeamBoard | null;
  persona: BotPersona;
  userId: string;
}

/** Handles are stored with their leading '@'; normalise so summaries never read '@@'. */
const at = (handle: string): string => `@${String(handle ?? '').replace(/^@+/, '')}`;

const MAX_PUBLIC = 2000;

const SLURS = /\b(chink|paki|keling|bangla|nigg\w*|faggot|retard\w*)\b/i;

function guardText(text: string | null | undefined, max = MAX_PUBLIC): string | null {
  if (!text) return null;
  let t = text.replace(/\s+\n/g, '\n').trim();
  // Mentions that would not resolve open an autocomplete overlay in the UI and
  // read as spam in the feed; keep handles only when they already look like ones.
  t = t.replace(/@(\w{1,3})\b/g, '$1');
  if (SLURS.test(t)) return null;
  return t.slice(0, max);
}

export async function execute(action: BotAction, ctx: ExecContext): Promise<ExecResult> {
  const { api, sit, mem, board, userId } = ctx;
  const stamp = (id: string) => {
    mem.handled.add(id);
    const c = { by: userId, byName: ctx.persona.fullName, kind: action.kind, at: Date.now() };
    if (board) claim(board, id, c);
    if (ctx.sessionBoard) claim(ctx.sessionBoard, id, c);
  };
  const done = (summary: string, actionType: string | null): ExecResult => {
    if (actionType) mem.doneActionTypes.add(actionType);
    rememberAction(mem, action.kind, summary);
    return { ok: true, summary, actionType };
  };
  const skip = (why: string): ExecResult => ({
    ok: false,
    summary: why,
    actionType: null,
    error: why,
  });

  try {
    switch (action.kind) {
      case 'idle':
        return { ok: true, summary: 'monitoring', actionType: null };

      case 'read_news': {
        const article = sit.news.find((n) => n.id === action.targetId) ?? sit.news[0];
        if (!article) return skip('no unread news');
        await api.readNews(article.id);
        mem.readNews.add(article.id);
        return done(`read "${article.headline ?? article.title ?? 'article'}"`, 'news_read');
      }

      case 'email_read': {
        const email =
          sit.emails.all.find((e) => e.id === action.targetId) ?? sit.emails.unread[0] ?? null;
        if (!email) return skip('no unread email');
        await api.markEmailRead(email.id);
        mem.readEmails.add(email.id);
        return done(`read "${email.subject}"`, 'email_read');
      }

      case 'like':
      case 'repost': {
        const post = sit.feed.find((p) => p.id === action.targetId) ?? null;
        if (!post) return skip('post not visible');
        if (action.kind === 'like') await api.likePost(post.id);
        else await api.repost(post.id);
        stamp(post.id);
        return done(
          `${action.kind} ${at(post.author_handle)}`,
          action.kind === 'like' ? 'post_liked' : 'post_reposted',
        );
      }

      case 'flag': {
        const post = resolveHarmful(sit, action.targetId);
        if (!post) return skip('no harmful post to flag');
        await api.flagPost(post.id);
        stamp(post.id);
        return done(
          `flagged ${at(post.author_handle)}: ${post.content.slice(0, 60)}`,
          'post_flagged',
        );
      }

      case 'report': {
        const post = resolveHarmful(sit, action.targetId);
        if (!post) return skip('no harmful post to report');
        const flags = post.content_flags ?? {};
        const category = isHate(post)
          ? flags.incites_violence || flags.is_incitement
            ? 'incitement_to_violence'
            : 'hate_speech'
          : isMisinfo(post)
            ? 'misinformation'
            : flags.is_organized_pressure
              ? 'organized_harassment'
              : 'harmful_narrative';
        await api.reportPost(post.id, category, guardText(action.text, 900) ?? undefined);
        stamp(post.id);
        return done(`reported ${at(post.author_handle)} (${category})`, 'post_reported');
      }

      case 'dispute': {
        const post = resolveHarmful(sit, action.targetId);
        if (!post) return skip('no harmful post to dispute');
        const facts = guardText(action.text, 1900) ?? sit.facts.confirmed.slice(0, 2).join(' ');
        await api.fileDispute({
          target_type: 'post',
          target_id: post.id,
          claimed_falsehood: post.content.slice(0, 900),
          submitted_facts: facts,
        });
        stamp(post.id);
        return done(`disputed ${at(post.author_handle)}`, 'dispute_filed');
      }

      case 'reply': {
        const post = resolveHarmful(sit, action.targetId) ?? sit.needsResponse[0] ?? null;
        if (!post) return skip('no post to reply to');
        const text = guardText(action.text, 1200);
        if (!text) return skip('no reply text');
        await api.createPost({ content: text, platform: post.platform, reply_to_post_id: post.id });
        stamp(post.id);
        mem.lastPostAt = Date.now();
        return done(`replied to ${at(post.author_handle)}: ${text.slice(0, 80)}`, 'reply_posted');
      }

      case 'post': {
        const text = guardText(action.text, 1200);
        if (!text) return skip('no post text');
        await api.createPost({ content: text, platform: 'x_twitter' });
        mem.lastPostAt = Date.now();
        return done(`posted: ${text.slice(0, 80)}`, 'post_created');
      }

      case 'statement': {
        if (!sit.me.isPageHolder) return skip('not the page holder');
        const text = guardText(action.text, MAX_PUBLIC);
        if (!text) return skip('no statement text');
        await api.createPost({
          content: text,
          platform: 'x_twitter',
          post_format: 'official_statement',
          post_as_page: true,
        });
        const now = Date.now();
        settleCommitments(mem);
        mem.statements.push({ at: now, text });
        mem.commitments.push(...extractCommitments(text, now));
        mem.lastStatementAt = now;
        mem.lastPostAt = now;
        if (action.targetId) mem.handled.add(`published:${action.targetId}`);
        return done(`official statement: ${text.slice(0, 90)}`, 'post_created');
      }

      case 'email_reply': {
        const email =
          sit.emails.unanswered.find((e) => e.id === action.targetId) ?? sit.emails.unanswered[0];
        if (!email) return skip('no email to answer');
        const body = guardText(action.text, 6000);
        if (!body) return skip('no email body');
        if (!email.is_read && !mem.readEmails.has(email.id)) {
          await api.markEmailRead(email.id).catch(() => undefined);
          mem.readEmails.add(email.id);
        }
        const subject =
          (action.subject && action.subject.trim()) || `Re: ${email.subject}`.slice(0, 480);
        await api.sendEmail({
          to_addresses: action.to?.length ? action.to : [email.from_address],
          subject,
          body_text: body,
          replied_to_id: email.id,
        });
        mem.repliedEmails.add(email.id);
        stamp(email.id);
        return done(
          `replied to ${email.from_name ?? email.from_address}: ${email.subject}`,
          'email_sent',
        );
      }

      case 'email_forward': {
        const rel =
          sit.intelToRelay.find((r) => r.email.id === action.targetId) ?? sit.intelToRelay[0];
        if (!rel) return skip('nothing to relay');
        const to = action.to?.length ? action.to : rel.recipients.map((r) => r.address);
        const note = guardText(action.text, 2000) ?? 'Forwarding â€” this is in your lane.';
        await api.sendEmail({
          to_addresses: to,
          subject: (action.subject ?? `Fwd: ${rel.email.subject}`).slice(0, 480),
          body_text: `${note}\n\n---- Forwarded ----\nFrom: ${rel.email.from_name ?? rel.email.from_address}\nSubject: ${rel.email.subject}\n\n${rel.email.body_text ?? ''}`,
          forwarded_email_id: rel.email.id,
        });
        stamp(`fwd:${rel.email.id}`);
        mem.doneActionTypes.add('intel_shared');
        return done(
          `forwarded "${rel.email.subject}" to ${rel.entry.needed_by.join(', ')}`,
          'email_sent',
        );
      }

      case 'dm_reply': {
        const thread = sit.dms.find((t) => t.thread_id === action.targetId) ?? sit.dms[0];
        if (!thread) return skip('no DM to answer');
        const text = guardText(action.text, 1500);
        if (!text) return skip('no DM text');
        if (thread.latest_message && !thread.latest_message.is_read) {
          await api.markDmRead(thread.latest_message.id).catch(() => undefined);
        }
        await api.sendDm({
          recipient_handle: thread.other_participant.handle,
          content: text,
          send_as_page: thread.is_org_page_thread && sit.me.isPageHolder,
        });
        mem.repliedThreads.add(thread.thread_id);
        stamp(thread.thread_id);
        return done(
          `DM to ${thread.other_participant.display_name || thread.other_participant.handle}`,
          'dm_sent',
        );
      }

      case 'draft_create': {
        const text = guardText(action.text, 20_000);
        if (!text) return skip('no document text');
        const title = (action.subject ?? 'Statement draft').slice(0, 200);
        let draftId = action.targetId ?? null;
        const existing = draftId ? sit.drafts.mine.find((d) => d.id === draftId) : null;
        if (!existing) {
          const created = await api.createDraft(title);
          draftId = created.id;
        }
        const html = text
          .split(/\n{2,}/)
          .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
          .join('');
        await api.updateDraft(draftId!, html);
        await api.submitDraft(draftId!);
        mem.handled.add(draftId!);
        return done(`drafted "${title}" and sent it for review`, 'draft_submitted_for_approval');
      }

      case 'draft_review': {
        const draft =
          sit.drafts.toReview.find((d) => d.id === action.targetId) ?? sit.drafts.toReview[0];
        if (!draft) return skip('nothing to review');
        const verdict = action.verdict ?? 'approve';
        await api.reviewDraft(draft.id, verdict, guardText(action.text, 1900) ?? undefined);
        stamp(draft.id);
        return done(
          `${verdict === 'approve' ? 'approved' : 'sent back'} "${draft.title}"`,
          verdict === 'approve' ? 'draft_approved' : null,
        );
      }

      case 'chat': {
        const channelId = sit.chat.teamChannelId ?? sit.chat.allTeamsChannelId;
        if (!channelId) return skip('no team channel');
        const text = guardText(action.text, 1500);
        if (!text) return skip('no chat text');
        await api.sendChat(channelId, text);
        mem.lastChatAt = Date.now();
        if (action.targetId && action.targetId !== 'plan' && action.targetId !== 'status') {
          mem.seenChat.add(action.targetId);
        }
        if (action.targetId === 'plan' && board) {
          board.plan = text;
          board.planPostedAt = Date.now();
        }
        return done(`chat: ${text.slice(0, 80)}`, 'chat_message_sent');
      }

      case 'fact_check': {
        const target = action.targetId ?? sit.harmful[0]?.id;
        await api.recordAction(
          'fact_checked',
          target ?? undefined,
          guardText(action.text, 500) ?? undefined,
          'fact_check',
        );
        if (target) stamp(target);
        return done('fact-checked a claim against the fact sheet', 'fact_checked');
      }

      case 'escalate': {
        const target = action.targetId ?? sit.harmful[0]?.id;
        await api.recordAction(
          'escalated',
          target ?? undefined,
          guardText(action.text, 500) ?? undefined,
        );
        if (sit.chat.teamChannelId && action.text) {
          await api
            .sendChat(sit.chat.teamChannelId, guardText(action.text, 800)!)
            .catch(() => undefined);
        }
        if (target) stamp(target);
        return done('escalated a legal-risk item', 'escalated');
      }

      default:
        return skip(`unsupported action ${String((action as { kind: string }).kind)}`);
    }
  } catch (err) {
    const msg =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, kind: action.kind, userId }, 'teammates: action failed');
    return { ok: false, summary: `${action.kind} failed`, actionType: null, error: msg };
  }
}

function resolveHarmful(sit: Situation, targetId: string | null | undefined) {
  if (targetId) {
    const hit =
      sit.harmful.find((p) => p.id === targetId) ?? sit.feed.find((p) => p.id === targetId);
    if (hit) return hit;
  }
  return sit.harmful[0] ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
