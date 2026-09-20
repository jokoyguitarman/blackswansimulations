import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { getBotToken } from './accounts.js';

/**
 * Loopback REST client for one bot (docs/ai-teammate-bots-plan.md D1).
 *
 * Every read and every action goes through the public routes with the bot's own
 * JWT, so visibility filtering, grading, NPC reactions, watchdog, team scores and
 * notifications behave exactly as they do for a human. The base URL defaults to
 * this process's own listening port.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    body: string,
  ) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

export function apiBase(): string {
  return (env.teammateBotsApiBase ?? `http://127.0.0.1:${env.port}`).replace(/\/$/, '');
}

export class BotApi {
  constructor(
    readonly userId: string,
    readonly sessionId: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    allowRetry = true,
  ): Promise<T> {
    const token = await getBotToken(this.userId);
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status === 401 && allowRetry) {
      await getBotToken(this.userId, true);
      return this.request<T>(method, path, body, false);
    }
    if (!res.ok) throw new ApiError(res.status, method, path, text);
    if (!text) return {} as T;
    const parsed = JSON.parse(text) as { data?: T } & T;
    return (parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  /** Read helper that never throws: returns the fallback on any error. */
  async safeGet<T>(path: string, fallback: T): Promise<T> {
    try {
      return await this.get<T>(path);
    } catch (err) {
      logger.debug({ err, path, userId: this.userId }, 'teammates: read failed');
      return fallback;
    }
  }

  // ─── Perception ─────────────────────────────────────────────────────────

  posts() {
    return this.safeGet<FeedPost[]>(`/api/social/posts/session/${this.sessionId}`, []);
  }
  emails() {
    return this.safeGet<SimEmail[]>(`/api/social/emails/session/${this.sessionId}`, []);
  }
  dmThreads() {
    return this.safeGet<DmThread[]>(
      `/api/social/messenger/threads/${this.sessionId}?platform=facebook`,
      [],
    );
  }
  dmThread(threadId: string) {
    return this.safeGet<DirectMessage[]>(`/api/social/messenger/thread/${threadId}`, []);
  }
  channels() {
    return this.safeGet<Channel[]>(`/api/channels/session/${this.sessionId}`, []);
  }
  channelMessages(channelId: string, limit = 30) {
    return this.safeGet<ChatMessage[]>(
      `/api/channels/${channelId}/messages?page=1&limit=${limit}`,
      [],
    );
  }
  drafts() {
    return this.safeGet<Draft[]>(`/api/drafts/session/${this.sessionId}`, []);
  }
  myTeam() {
    return this.safeGet<MyTeam | null>(`/api/social/my-team/session/${this.sessionId}`, null);
  }
  socialState() {
    return this.safeGet<Record<string, unknown>>(`/api/social/state/session/${this.sessionId}`, {});
  }
  news() {
    return this.safeGet<NewsArticle[]>(`/api/social/news/session/${this.sessionId}`, []);
  }
  pages() {
    return this.safeGet<OrgPage[]>(`/api/social/pages/session/${this.sessionId}`, []);
  }
  myActivity() {
    return this.safeGet<{ posts: MyPost[]; actions: MyActionRow[] }>(
      `/api/social/my-activity/session/${this.sessionId}`,
      { posts: [], actions: [] },
    );
  }
  emailContacts() {
    return this.safeGet<EmailContact[]>(
      `/api/social/emails/contacts/session/${this.sessionId}`,
      [],
    );
  }
  sop() {
    return this.safeGet<Record<string, unknown> | null>(
      `/api/social/sop/session/${this.sessionId}`,
      null,
    );
  }
  teamAssignments() {
    return this.safeGet<TeamAssignment[]>(`/api/teams/session/${this.sessionId}`, []);
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  createPost(body: {
    content: string;
    platform?: string;
    reply_to_post_id?: string;
    post_format?: string;
    post_as_page?: boolean;
  }) {
    return this.post<FeedPost>('/api/social/posts', { session_id: this.sessionId, ...body });
  }
  likePost(postId: string) {
    return this.post(`/api/social/posts/${postId}/like`);
  }
  repost(postId: string) {
    return this.post(`/api/social/posts/${postId}/repost`);
  }
  flagPost(postId: string) {
    return this.post(`/api/social/posts/${postId}/flag`);
  }
  reportPost(postId: string, violation_category: string, reason_text?: string) {
    return this.post(`/api/social/posts/${postId}/report`, { violation_category, reason_text });
  }
  fileDispute(body: {
    target_type: 'post' | 'article';
    target_id: string;
    claimed_falsehood: string;
    submitted_facts: string;
  }) {
    return this.post('/api/social/disputes', { session_id: this.sessionId, ...body });
  }
  markEmailRead(emailId: string) {
    return this.post(`/api/social/emails/${emailId}/read`);
  }
  sendEmail(body: {
    to_addresses: string[];
    cc_addresses?: string[];
    subject: string;
    body_text: string;
    replied_to_id?: string;
    forwarded_email_id?: string;
  }) {
    return this.post<SimEmail>('/api/social/emails', { session_id: this.sessionId, ...body });
  }
  sendDm(body: {
    recipient_handle: string;
    content: string;
    platform?: string;
    send_as_page?: boolean;
  }) {
    return this.post('/api/social/messenger/send', {
      session_id: this.sessionId,
      platform: 'facebook',
      ...body,
    });
  }
  markDmRead(messageId: string) {
    return this.post(`/api/social/messenger/${messageId}/read`);
  }
  createDraft(title: string) {
    return this.post<Draft>('/api/drafts', { session_id: this.sessionId, title });
  }
  updateDraft(id: string, content_html: string) {
    return this.patch<Draft>(`/api/drafts/${id}`, { content_html });
  }
  submitDraft(id: string) {
    return this.post<Draft>(`/api/drafts/${id}/submit`);
  }
  reviewDraft(id: string, verdict: 'approve' | 'request_changes', note?: string) {
    return this.post<Draft>(`/api/drafts/${id}/review`, { verdict, note });
  }
  sendChat(channelId: string, content: string) {
    return this.post(`/api/channels/${channelId}/messages`, { content, message_type: 'text' });
  }
  recordAction(action_type: string, target_id?: string, content?: string, sop_step?: string) {
    return this.post('/api/social/action', {
      session_id: this.sessionId,
      action_type,
      target_id,
      content,
      sop_step,
    });
  }
  readNews(articleId: string) {
    return this.post(`/api/social/news/${articleId}/read`);
  }
  setDemographics(demographics: Record<string, string>) {
    return this.post('/api/social/demographics', { session_id: this.sessionId, demographics });
  }
  markReady() {
    return this.post(`/api/sessions/${this.sessionId}/ready`, { is_ready: true });
  }
  gradeContent(content: string, hateful_post_content?: string) {
    return this.post<Record<string, unknown>>('/api/social/grade', {
      session_id: this.sessionId,
      content,
      hateful_post_content,
    });
  }
}

// ─── Row shapes (subset of what the routes return) ──────────────────────────

export interface FeedPost {
  id: string;
  platform: string;
  user_id: string | null;
  author_handle: string;
  author_display_name: string;
  author_type: string;
  content: string;
  reply_to_post_id: string | null;
  content_flags: Record<string, unknown> | null;
  virality_score: number | null;
  requires_response: boolean | null;
  responded_at: string | null;
  reply_count: number | null;
  like_count?: number | null;
  created_at: string;
  post_format?: string | null;
  posted_by_user_id?: string | null;
  target_player_ids?: string[] | null;
  is_surfaced_to_session?: boolean | null;
  sop_compliance_score?: Record<string, unknown> | null;
}

export interface SimEmail {
  id: string;
  direction: 'inbound' | 'outbound';
  from_address: string;
  from_name: string | null;
  to_addresses: string[] | null;
  cc_addresses?: string[] | null;
  subject: string;
  body_text: string | null;
  replied_to_id: string | null;
  thread_id: string | null;
  sent_by_player_id: string | null;
  recipient_user_ids: string[] | null;
  is_read?: boolean | null;
  priority?: string | null;
  email_category?: string | null;
  inject_id?: string | null;
  target_teams?: string[] | null;
  created_at: string;
}

export interface DirectMessage {
  id: string;
  thread_id: string;
  sender_handle: string;
  sender_display_name: string | null;
  sender_type?: string | null;
  recipient_handle: string;
  content: string;
  is_read: boolean | null;
  created_at: string;
}

export interface DmThread {
  thread_id: string;
  latest_message: DirectMessage;
  unread_count: number;
  other_participant: { handle: string; display_name: string };
  is_org_page_thread: boolean;
}

export interface Channel {
  id: string;
  name: string;
  type: string;
  team_name: string | null;
  unread_count?: number;
}

export interface ChatMessage {
  id: string;
  sender_id: string | null;
  content: string;
  type?: string;
  created_at: string;
  sender?: { id: string; full_name: string; role: string; team_name?: string } | null;
}

export interface Draft {
  id: string;
  author_id: string;
  author_name?: string;
  team_name: string | null;
  title: string;
  content_text: string;
  content_html: string;
  status: 'draft' | 'in_review' | 'approved' | 'changes_requested';
  submitted_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  updated_at: string;
}

export interface MyTeam {
  team_name: string;
  function_key: string | null;
  org_key: string | null;
  country: string | null;
  mission: string | null;
  responsibilities: string[];
  out_of_lane: string[];
  tasks: string[];
}

export interface NewsArticle {
  id: string;
  headline?: string;
  title?: string;
  summary?: string | null;
  body?: string | null;
  outlet?: string | null;
  published_at?: string;
  is_disputed?: boolean | null;
}

export interface OrgPage {
  org_key: string;
  display_name: string;
  role?: string;
  is_primary?: boolean;
  control_mode?: string;
  controllers?: string[];
  facebook?: { page_handle?: string } | null;
  x_twitter?: { page_handle?: string } | null;
}

export interface MyPost {
  id: string;
  content: string;
  platform: string;
  author_type: string;
  post_format: string | null;
  created_at: string;
}

export interface MyActionRow {
  action_type: string;
  target_id: string | null;
  content: string | null;
  created_at: string;
}

export interface EmailContact {
  address: string;
  name: string;
  source: 'player' | 'previous' | 'stakeholder' | 'npc' | string;
  team_name?: string | null;
  kind?: 'group';
  tier?: 'roster';
}

export interface TeamAssignment {
  user_id: string;
  team_name: string;
  team_role?: string | null;
  user?: { id: string; full_name: string; role: string } | null;
}
