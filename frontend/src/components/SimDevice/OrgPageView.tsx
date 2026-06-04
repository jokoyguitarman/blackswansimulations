import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { usePageMode } from '../../contexts/PageModeContext';

const API_BASE = import.meta.env.VITE_API_URL || '';
function apiUrl(path: string) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return API_BASE ? `${API_BASE}${clean}` : clean;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await (await import('../../lib/supabase')).supabase.auth.getSession();
  const token = data.session?.access_token || '';
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

interface OrgPage {
  id: string;
  page_name: string;
  page_handle: string;
  page_bio: string;
  follower_count: number;
  page_logo_url?: string;
  verified: boolean;
  platform: string;
}

interface PagePost {
  id: string;
  content: string;
  created_at: string;
  like_count: number;
  reply_count: number;
  view_count: number;
  repost_count: number;
  post_format?: string;
  media_urls?: string[];
  posted_by_display_name?: string;
  is_branded_history?: boolean;
}

interface Comment {
  id: string;
  content: string;
  author_handle: string;
  author_display_name: string;
  author_type: string;
  created_at: string;
  like_count: number;
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 0) {
    const days = Math.abs(Math.floor(diff / (1000 * 60 * 60 * 24)));
    return `${days}d ago`;
  }
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getAvatarColor(name: string): string {
  const colors = [
    '#007AFF',
    '#34C759',
    '#FF9500',
    '#FF3B30',
    '#5856D6',
    '#AF52DE',
    '#FF2D55',
    '#5AC8FA',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function stripThreadTag(content: string): string {
  return content.replace(/^@[\w._-]+\[[^\]]*\]\s*/, '');
}

export default function OrgPageView({
  platform = 'facebook',
  onBack,
}: {
  platform?: 'facebook' | 'x_twitter';
  onBack?: () => void;
}) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { setIsPageMode } = usePageMode();
  const [pageInfo, setPageInfo] = useState<OrgPage | null>(null);
  const [posts, setPosts] = useState<PagePost[]>([]);
  const [loading, setLoading] = useState(true);
  const [composeText, setComposeText] = useState('');

  useEffect(() => {
    setIsPageMode(true);
    return () => setIsPageMode(false);
  }, [setIsPageMode]);

  const [selectedPost, setSelectedPost] = useState<PagePost | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [commentInput, setCommentInput] = useState('');
  const [likedCommentIds, setLikedCommentIds] = useState<Set<string>>(new Set());
  const [replyingToComment, setReplyingToComment] = useState<Comment | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);

  const loadPage = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const [pageRes, postsRes] = await Promise.all([
        fetch(apiUrl(`/api/social/org-page/session/${sessionId}`), { headers }),
        fetch(
          apiUrl(
            `/api/social/posts/session/${sessionId}?platform=${platform}&limit=500&sort=chronological&author_type=official_account&top_level_only=true`,
          ),
          { headers },
        ),
      ]);

      const pageJson = await pageRes.json();
      const targetPage = (pageJson.data || []).find(
        (p: Record<string, string>) => p.platform === platform,
      );
      if (targetPage) setPageInfo(targetPage);

      const postsJson = await postsRes.json();
      const officialPosts = (postsJson.data || []) as PagePost[];
      setPosts(
        officialPosts.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        ),
      );
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [sessionId, platform]);

  useEffect(() => {
    loadPage();
  }, [loadPage]);

  async function handlePagePost() {
    if (!composeText.trim() || !sessionId) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/posts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content: composeText,
          platform,
          post_as_page: true,
        }),
      });
      setComposeText('');
      setTimeout(loadPage, 1000);
    } catch {
      /* ignore */
    }
  }

  async function openComments(post: PagePost) {
    setSelectedPost(post);
    setComments([]);
    setLoadingComments(true);
    setCommentInput('');
    setReplyingToComment(null);
    setLikedCommentIds(new Set());
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/${post.id}`), { headers });
      const result = await res.json();
      setComments(result.data?.replies || []);
    } catch {
      /* ignore */
    }
    setLoadingComments(false);
  }

  async function handlePostComment() {
    if (!commentInput.trim() || !sessionId || !selectedPost) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/posts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content: commentInput,
          platform,
          post_as_page: true,
          reply_to_post_id: replyingToComment ? replyingToComment.id : selectedPost.id,
        }),
      });
      setCommentInput('');
      setReplyingToComment(null);
      setTimeout(() => openComments(selectedPost), 800);
    } catch {
      /* ignore */
    }
  }

  async function handleLikeComment(commentId: string) {
    if (!sessionId || likedCommentIds.has(commentId)) return;
    setLikedCommentIds((prev) => new Set([...prev, commentId]));
    setComments((prev) =>
      prev.map((c) => (c.id === commentId ? { ...c, like_count: c.like_count + 1 } : c)),
    );
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${commentId}/like`), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          reaction_type: 'like',
          post_as_page: true,
        }),
      });
    } catch {
      setLikedCommentIds((prev) => {
        const next = new Set(prev);
        next.delete(commentId);
        return next;
      });
      setComments((prev) =>
        prev.map((c) => (c.id === commentId ? { ...c, like_count: c.like_count - 1 } : c)),
      );
    }
  }

  function startReplyToComment(comment: Comment) {
    setReplyingToComment(comment);
    setCommentInput(`@${comment.author_handle} `);
    setTimeout(() => commentInputRef.current?.focus(), 50);
  }

  const isFacebook = platform === 'facebook';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!pageInfo) {
    return (
      <div className="p-4 text-center text-sm" style={{ color: '#65676B' }}>
        No organization page found for this session.
        {onBack && (
          <button onClick={onBack} className="block mx-auto mt-4 text-blue-500 text-sm">
            Go back
          </button>
        )}
      </div>
    );
  }

  // ─── Comments Thread Panel ───────────────────────────────────────────────────
  if (selectedPost) {
    return (
      <div
        className="h-full flex flex-col"
        style={{ backgroundColor: isFacebook ? '#F0F2F5' : '#000' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 flex-shrink-0"
          style={{
            height: 48,
            backgroundColor: isFacebook ? '#FFFFFF' : '#16181C',
            borderBottom: `1px solid ${isFacebook ? '#E4E6EB' : '#2F3336'}`,
          }}
        >
          <button
            onClick={() => setSelectedPost(null)}
            className="flex items-center gap-1 text-[15px] font-medium"
            style={{ color: isFacebook ? '#1877F2' : '#1D9BF0' }}
          >
            <span>&larr;</span> Back
          </button>
          <span className="text-[13px]" style={{ color: isFacebook ? '#65676B' : '#71767B' }}>
            {comments.length} comment{comments.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Original post */}
          <div
            className="p-4"
            style={{
              backgroundColor: isFacebook ? '#FFFFFF' : '#16181C',
              borderBottom: `1px solid ${isFacebook ? '#E4E6EB' : '#2F3336'}`,
            }}
          >
            <div className="flex items-center gap-2.5 mb-2">
              {pageInfo.page_logo_url ? (
                <img
                  src={pageInfo.page_logo_url}
                  alt={pageInfo.page_name}
                  className="w-10 h-10 rounded-lg object-cover"
                />
              ) : (
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
                  style={{ backgroundColor: isFacebook ? '#1877F2' : '#1D9BF0' }}
                >
                  {pageInfo.page_name.charAt(0)}
                </div>
              )}
              <div>
                <div className="flex items-center gap-1">
                  <span
                    className="font-semibold text-[14px]"
                    style={{ color: isFacebook ? '#050505' : '#E7E9EA' }}
                  >
                    {pageInfo.page_name}
                  </span>
                  <span style={{ color: isFacebook ? '#1877F2' : '#1D9BF0' }}>&#10003;</span>
                </div>
                <span className="text-[12px]" style={{ color: isFacebook ? '#65676B' : '#71767B' }}>
                  {timeAgo(selectedPost.created_at)}
                </span>
              </div>
            </div>
            <p
              className="text-[15px] leading-relaxed whitespace-pre-wrap"
              style={{ color: isFacebook ? '#050505' : '#E7E9EA' }}
            >
              {selectedPost.content}
            </p>
            {selectedPost.media_urls && selectedPost.media_urls.length > 0 && (
              <div className="mt-2">
                <img
                  src={selectedPost.media_urls[0]}
                  alt=""
                  className="w-full rounded-lg"
                  style={{ maxHeight: 200, objectFit: 'cover' }}
                />
              </div>
            )}
            <div
              className="flex items-center gap-4 mt-3 pt-2 text-[13px]"
              style={{
                borderTop: `1px solid ${isFacebook ? '#E4E6EB' : '#2F3336'}`,
                color: isFacebook ? '#65676B' : '#71767B',
              }}
            >
              <span>{formatCount(selectedPost.like_count)} likes</span>
              <span>{formatCount(selectedPost.reply_count)} comments</span>
              <span>{formatCount(selectedPost.view_count)} views</span>
            </div>
          </div>

          {/* Comments list */}
          {loadingComments ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
            </div>
          ) : comments.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-[14px]" style={{ color: isFacebook ? '#65676B' : '#71767B' }}>
                No comments yet. Be the first to comment.
              </p>
            </div>
          ) : (
            <div className="py-2">
              {comments.map((comment) => (
                <div
                  key={comment.id}
                  className="px-4 py-3 flex gap-3"
                  style={{ borderBottom: `0.5px solid ${isFacebook ? '#E4E6EB' : '#2F3336'}` }}
                >
                  <div
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-white font-semibold text-[12px]"
                    style={{ backgroundColor: getAvatarColor(comment.author_display_name) }}
                  >
                    {comment.author_display_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[13px] font-semibold"
                        style={{ color: isFacebook ? '#050505' : '#E7E9EA' }}
                      >
                        {comment.author_display_name}
                      </span>
                      <span
                        className="text-[11px]"
                        style={{ color: isFacebook ? '#65676B' : '#71767B' }}
                      >
                        {timeAgo(comment.created_at)}
                      </span>
                    </div>
                    <p
                      className="text-[14px] mt-0.5 whitespace-pre-wrap"
                      style={{ color: isFacebook ? '#050505' : '#E7E9EA' }}
                    >
                      {stripThreadTag(comment.content)}
                    </p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <button
                        onClick={() => handleLikeComment(comment.id)}
                        className="text-[12px] font-semibold"
                        style={{
                          color: likedCommentIds.has(comment.id)
                            ? isFacebook
                              ? '#1877F2'
                              : '#1D9BF0'
                            : isFacebook
                              ? '#65676B'
                              : '#71767B',
                        }}
                      >
                        Like
                      </button>
                      <button
                        onClick={() => startReplyToComment(comment)}
                        className="text-[12px] font-semibold"
                        style={{ color: isFacebook ? '#65676B' : '#71767B' }}
                      >
                        Reply
                      </button>
                      {comment.like_count > 0 && (
                        <span
                          className="text-[11px] ml-auto"
                          style={{ color: isFacebook ? '#65676B' : '#71767B' }}
                        >
                          {formatCount(comment.like_count)} likes
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Comment compose input */}
        <div
          className="flex-shrink-0"
          style={{
            backgroundColor: isFacebook ? '#FFFFFF' : '#16181C',
            borderTop: `1px solid ${isFacebook ? '#E4E6EB' : '#2F3336'}`,
          }}
        >
          {replyingToComment && (
            <div className="flex items-center justify-between px-4 pt-2 pb-1">
              <span className="text-[12px]" style={{ color: isFacebook ? '#65676B' : '#71767B' }}>
                Replying to {replyingToComment.author_display_name}
              </span>
              <button
                onClick={() => {
                  setReplyingToComment(null);
                  setCommentInput('');
                }}
                className="text-[12px] font-semibold"
                style={{ color: isFacebook ? '#1877F2' : '#1D9BF0' }}
              >
                Cancel
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 px-4 py-3">
            <input
              ref={commentInputRef}
              type="text"
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handlePostComment();
                }
              }}
              placeholder={
                replyingToComment
                  ? `Reply as ${pageInfo.page_name}...`
                  : `Comment as ${pageInfo.page_name}...`
              }
              className="flex-1 px-3 py-2 rounded-full text-[14px] outline-none"
              style={{
                backgroundColor: isFacebook ? '#F0F2F5' : '#2F3336',
                color: isFacebook ? '#050505' : '#E7E9EA',
              }}
            />
            <button
              onClick={handlePostComment}
              disabled={!commentInput.trim()}
              className="px-3 py-2 rounded-full text-[13px] font-semibold text-white disabled:opacity-40"
              style={{ backgroundColor: isFacebook ? '#1877F2' : '#1D9BF0' }}
            >
              Post
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Main Page View ──────────────────────────────────────────────────────────
  return (
    <div
      className="h-full overflow-y-auto"
      style={{ backgroundColor: isFacebook ? '#F0F2F5' : '#000' }}
    >
      {/* Page Header */}
      <div className="relative" style={{ backgroundColor: isFacebook ? '#FFFFFF' : '#16181C' }}>
        <div
          className="h-32"
          style={{
            background: isFacebook
              ? 'linear-gradient(135deg, #1877F2 0%, #42A5F5 100%)'
              : 'linear-gradient(135deg, #1D9BF0 0%, #0D47A1 100%)',
          }}
        />

        <div className="px-4 pb-4">
          <div className="flex items-end gap-3 -mt-8">
            {pageInfo.page_logo_url ? (
              <img
                src={pageInfo.page_logo_url}
                alt={pageInfo.page_name}
                className="w-20 h-20 rounded-lg object-cover border-4"
                style={{ borderColor: isFacebook ? '#FFFFFF' : '#16181C' }}
              />
            ) : (
              <div
                className="w-20 h-20 rounded-lg flex items-center justify-center text-white font-bold text-2xl border-4"
                style={{
                  backgroundColor: isFacebook ? '#1877F2' : '#1D9BF0',
                  borderColor: isFacebook ? '#FFFFFF' : '#16181C',
                }}
              >
                {pageInfo.page_name.charAt(0)}
              </div>
            )}
            <div className="flex-1 pb-1">
              <div className="flex items-center gap-1.5">
                <span
                  className="font-bold text-lg"
                  style={{ color: isFacebook ? '#050505' : '#E7E9EA' }}
                >
                  {pageInfo.page_name}
                </span>
                {pageInfo.verified && (
                  <span style={{ color: isFacebook ? '#1877F2' : '#1D9BF0' }}>&#10003;</span>
                )}
              </div>
              <div className="text-sm" style={{ color: isFacebook ? '#65676B' : '#71767B' }}>
                {pageInfo.page_handle}
              </div>
            </div>
          </div>

          {pageInfo.page_bio && (
            <p className="mt-3 text-sm" style={{ color: isFacebook ? '#050505' : '#E7E9EA' }}>
              {pageInfo.page_bio}
            </p>
          )}

          <div className="mt-2 text-sm" style={{ color: isFacebook ? '#65676B' : '#71767B' }}>
            {formatCount(pageInfo.follower_count)} followers
          </div>
        </div>

        {onBack && (
          <button
            onClick={onBack}
            className="absolute top-3 left-3 w-8 h-8 rounded-full flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.4)', color: '#fff' }}
          >
            &#8592;
          </button>
        )}
      </div>

      {/* Compose as page */}
      <div
        className="mx-4 mt-3 p-3 rounded-lg"
        style={{ backgroundColor: isFacebook ? '#FFFFFF' : '#16181C' }}
      >
        <textarea
          value={composeText}
          onChange={(e) => setComposeText(e.target.value)}
          placeholder={`Post as ${pageInfo.page_name}...`}
          className="w-full bg-transparent text-sm resize-none outline-none"
          style={{
            color: isFacebook ? '#050505' : '#E7E9EA',
            minHeight: 60,
          }}
          rows={2}
        />
        <div className="flex justify-end mt-2">
          <button
            onClick={handlePagePost}
            disabled={!composeText.trim()}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40"
            style={{ backgroundColor: isFacebook ? '#1877F2' : '#1D9BF0' }}
          >
            Post as {pageInfo.page_name}
          </button>
        </div>
      </div>

      {/* Posts timeline */}
      <div className="px-4 mt-3 pb-20 space-y-3">
        {posts.length === 0 ? (
          <div
            className="text-center py-8 text-sm"
            style={{ color: isFacebook ? '#65676B' : '#71767B' }}
          >
            No posts yet
          </div>
        ) : (
          posts.map((post) => (
            <div
              key={post.id}
              className="rounded-lg overflow-hidden"
              style={{ backgroundColor: isFacebook ? '#FFFFFF' : '#16181C' }}
            >
              <div className="p-3">
                <div className="flex items-center gap-2.5 mb-2">
                  {pageInfo.page_logo_url ? (
                    <img
                      src={pageInfo.page_logo_url}
                      alt={pageInfo.page_name}
                      className="w-10 h-10 rounded-lg object-cover"
                    />
                  ) : (
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
                      style={{ backgroundColor: isFacebook ? '#1877F2' : '#1D9BF0' }}
                    >
                      {pageInfo.page_name.charAt(0)}
                    </div>
                  )}
                  <div>
                    <div className="flex items-center gap-1">
                      <span
                        className="font-semibold text-[14px]"
                        style={{ color: isFacebook ? '#050505' : '#E7E9EA' }}
                      >
                        {pageInfo.page_name}
                      </span>
                      <span style={{ color: isFacebook ? '#1877F2' : '#1D9BF0' }}>&#10003;</span>
                    </div>
                    <div
                      className="flex items-center gap-1 text-[12px]"
                      style={{ color: isFacebook ? '#65676B' : '#71767B' }}
                    >
                      <span>{timeAgo(post.created_at)}</span>
                      {post.is_branded_history && (
                        <span
                          className="px-1 rounded text-[10px]"
                          style={{
                            backgroundColor: isFacebook ? '#F0F2F5' : '#2F3336',
                            color: isFacebook ? '#65676B' : '#71767B',
                          }}
                        >
                          Pre-crisis
                        </span>
                      )}
                      {post.posted_by_display_name && (
                        <span>&#183; by {post.posted_by_display_name}</span>
                      )}
                    </div>
                  </div>
                </div>

                <p
                  className="text-[15px] leading-relaxed whitespace-pre-wrap"
                  style={{ color: isFacebook ? '#050505' : '#E7E9EA' }}
                >
                  {post.content}
                </p>

                {post.media_urls && post.media_urls.length > 0 && (
                  <div className="mt-2">
                    <img
                      src={post.media_urls[0]}
                      alt=""
                      className="w-full rounded-lg"
                      style={{ maxHeight: 300, objectFit: 'cover' }}
                    />
                  </div>
                )}
              </div>

              <div
                className="flex items-center justify-between px-3 py-2 text-[13px]"
                style={{
                  borderTop: `1px solid ${isFacebook ? '#E4E6EB' : '#2F3336'}`,
                  color: isFacebook ? '#65676B' : '#71767B',
                }}
              >
                <span>{formatCount(post.like_count)} likes</span>
                <button
                  onClick={() => openComments(post)}
                  className="hover:underline"
                  style={{ color: isFacebook ? '#65676B' : '#71767B' }}
                >
                  {formatCount(post.reply_count)} comments
                </button>
                <span>{formatCount(post.view_count)} views</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
