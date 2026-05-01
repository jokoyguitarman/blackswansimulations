import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWebSocket } from '../../hooks/useWebSocket';
import { supabase } from '../../lib/supabase';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}`;
  return cleanPath;
}

async function getAuthHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  };
}

interface SocialPost {
  id: string;
  author_handle: string;
  author_display_name: string;
  author_type: string;
  content: string;
  hashtags: string[];
  like_count: number;
  repost_count: number;
  reply_count: number;
  view_count: number;
  sentiment: string;
  content_flags: Record<string, unknown>;
  is_flagged_by_player: boolean;
  requires_response: boolean;
  responded_at: string | null;
  is_repost: boolean;
  created_at: string;
  platform: string;
  virality_score: number;
  reply_to_post_id: string | null;
}

function ReplyIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="M1.751 10c.08-.544.234-1.073.456-1.573a8.014 8.014 0 0 1 7.532-5.424c2.048 0 3.91.768 5.325 2.032l2.185-2.185A1 1 0 0 1 19 3.55V9a1 1 0 0 1-1 1h-5.45a1 1 0 0 1-.707-1.707l1.953-1.953A4.98 4.98 0 0 0 9.74 5.003a4.98 4.98 0 0 0-4.688 3.384A5.01 5.01 0 0 0 4.999 12a5.006 5.006 0 0 0 4.688 3.613 4.98 4.98 0 0 0 3.555-1.487l1.414 1.414A6.985 6.985 0 0 1 9.74 18.003 7.013 7.013 0 0 1 2.727 12c0-.68.098-1.363.283-2.012Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

function RepostIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function HeartIcon({ filled }: { filled?: boolean }) {
  if (filled) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="#F91880">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    );
  }
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function ViewsIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M18 20V10M12 20V4M6 20v-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FlagIcon({ flagged }: { flagged?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={flagged ? '#F59E0B' : 'none'}
      stroke={flagged ? '#F59E0B' : 'currentColor'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export default function SocialFeedApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [replyingTo, setReplyingTo] = useState<SocialPost | null>(null);
  const [activeTab, setActiveTab] = useState<'foryou' | 'following'>('foryou');

  const loadPosts = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/session/${sessionId}`), { headers });
      const result = await res.json();
      if (result.data) setPosts(result.data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadPosts();
  }, [loadPosts]);

  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: ['social_post.created', 'social_post.flagged'],
    onEvent: (event) => {
      if (event.type === 'social_post.created') {
        const newPost = (event.data as { post: SocialPost }).post;
        setPosts((prev) => [newPost, ...prev]);
      }
    },
  });

  async function handlePost() {
    if (!composeText.trim() || !sessionId) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/posts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content: composeText,
          reply_to_post_id: replyingTo?.id,
        }),
      });
      setComposeText('');
      setComposing(false);
      setReplyingTo(null);
    } catch {
      /* ignore */
    }
  }

  async function handleLike(postId: string) {
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/like`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId }),
      });
      setPosts((prev) =>
        prev.map((p) => (p.id === postId ? { ...p, like_count: p.like_count + 1 } : p)),
      );
    } catch {
      /* ignore */
    }
  }

  async function handleFlag(postId: string) {
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/flag`), {
        method: 'POST',
        headers,
      });
      setPosts((prev) =>
        prev.map((p) => (p.id === postId ? { ...p, is_flagged_by_player: true } : p)),
      );
    } catch {
      /* ignore */
    }
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function getSentimentBorder(sentiment: string): string {
    switch (sentiment) {
      case 'hateful':
        return '3px solid #EF4444';
      case 'inflammatory':
        return '3px solid #F97316';
      case 'negative':
        return '3px solid #EAB308';
      case 'supportive':
        return '3px solid #22C55E';
      case 'positive':
        return '3px solid #3B82F6';
      default:
        return 'none';
    }
  }

  function getAuthorBadge(type: string): { label: string; color: string } | null {
    switch (type) {
      case 'npc_media':
        return { label: '✓', color: '#1D9BF0' };
      case 'npc_politician':
        return { label: '🏛️', color: '#7C3AED' };
      case 'npc_influencer':
        return { label: '⭐', color: '#F59E0B' };
      case 'player':
        return { label: '👤', color: '#22C55E' };
      case 'official_account':
        return { label: '✓', color: '#FFD700' };
      default:
        return null;
    }
  }

  function getAvatarColor(name: string): string {
    const colors = ['#1D9BF0', '#7856FF', '#F91880', '#FF7A00', '#00BA7C', '#FFD400'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#000000', color: '#E7E9EA' }}>
      {/* Header */}
      <div className="flex-shrink-0" style={{ borderBottom: '1px solid #2F3336' }}>
        {/* Top row */}
        <div className="flex items-center justify-between px-4" style={{ height: 44 }}>
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/home`)}
            className="ios-btn-bounce"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#E7E9EA">
              <path d="M7.414 13l5.293 5.293a1 1 0 0 1-1.414 1.414l-7-7a1 1 0 0 1 0-1.414l7-7a1 1 0 1 1 1.414 1.414L7.414 11H20a1 1 0 1 1 0 2H7.414z" />
            </svg>
          </button>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="#E7E9EA">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          <button onClick={() => {}} className="ios-btn-bounce">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#E7E9EA"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex">
          <button
            onClick={() => setActiveTab('foryou')}
            className="flex-1 py-3 text-center text-[15px] font-bold relative"
            style={{ color: activeTab === 'foryou' ? '#E7E9EA' : '#71767B' }}
          >
            For You
            {activeTab === 'foryou' && (
              <div
                className="absolute bottom-0 left-1/2 -translate-x-1/2 h-1 w-14 rounded-full"
                style={{ backgroundColor: '#1D9BF0' }}
              />
            )}
          </button>
          <button
            onClick={() => setActiveTab('following')}
            className="flex-1 py-3 text-center text-[15px] font-bold relative"
            style={{ color: activeTab === 'following' ? '#E7E9EA' : '#71767B' }}
          >
            Following
            {activeTab === 'following' && (
              <div
                className="absolute bottom-0 left-1/2 -translate-x-1/2 h-1 w-14 rounded-full"
                style={{ backgroundColor: '#1D9BF0' }}
              />
            )}
          </button>
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32" style={{ color: '#71767B' }}>
            <div
              className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#1D9BF0', borderTopColor: 'transparent' }}
            />
          </div>
        ) : posts.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-40 gap-2"
            style={{ color: '#71767B' }}
          >
            <p className="text-[15px]">No posts yet</p>
            <p className="text-[13px]">Posts will appear here as the simulation progresses.</p>
          </div>
        ) : (
          posts
            .filter((p) => !p.reply_to_post_id)
            .map((post) => {
              const badge = getAuthorBadge(post.author_type);
              return (
                <div
                  key={post.id}
                  className="x-feed-post px-4 py-3"
                  style={{ borderLeft: getSentimentBorder(post.sentiment) }}
                >
                  {/* Requires Response */}
                  {post.requires_response && !post.responded_at && (
                    <div className="flex items-center gap-1.5 mb-2 ml-[52px]">
                      <span className="relative flex h-2 w-2">
                        <span
                          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                          style={{ backgroundColor: '#F59E0B' }}
                        />
                        <span
                          className="relative inline-flex rounded-full h-2 w-2"
                          style={{ backgroundColor: '#F59E0B' }}
                        />
                      </span>
                      <span
                        className="text-[12px] font-bold tracking-wide"
                        style={{ color: '#F59E0B' }}
                      >
                        REQUIRES RESPONSE
                      </span>
                    </div>
                  )}

                  <div className="flex gap-3">
                    {/* Avatar */}
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[16px] flex-shrink-0"
                      style={{ backgroundColor: getAvatarColor(post.author_display_name) }}
                    >
                      {post.author_display_name.charAt(0).toUpperCase()}
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Author line */}
                      <div className="flex items-center gap-1 flex-wrap">
                        <span
                          className="font-bold text-[15px] truncate"
                          style={{ color: '#E7E9EA' }}
                        >
                          {post.author_display_name}
                        </span>
                        {badge && (
                          <span
                            className="text-[12px] flex-shrink-0"
                            style={{ color: badge.color }}
                          >
                            {badge.label}
                          </span>
                        )}
                        <span className="text-[15px] truncate" style={{ color: '#71767B' }}>
                          {post.author_handle}
                        </span>
                        <span style={{ color: '#71767B' }}>·</span>
                        <span className="text-[14px] flex-shrink-0" style={{ color: '#71767B' }}>
                          {timeAgo(post.created_at)}
                        </span>
                      </div>

                      {/* Content */}
                      <p
                        className="text-[15px] mt-0.5 whitespace-pre-wrap break-words leading-[1.35]"
                        style={{ color: '#E7E9EA' }}
                      >
                        {String(post.content)
                          .split(/(#\w+)/g)
                          .map((part: string, i: number) => {
                            if (part.startsWith('#')) {
                              return (
                                <span key={i} style={{ color: '#1D9BF0' }}>
                                  {part}
                                </span>
                              );
                            }
                            return <span key={i}>{part}</span>;
                          })}
                      </p>

                      {/* Content Flags */}
                      {!!(
                        post.content_flags &&
                        (post.content_flags.is_hate_speech || post.content_flags.is_misinformation)
                      ) && (
                        <div className="flex gap-1.5 mt-2 flex-wrap">
                          {!!post.content_flags.is_hate_speech && (
                            <span
                              className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                              style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: '#F87171' }}
                            >
                              Hate Speech
                            </span>
                          )}
                          {!!post.content_flags.is_misinformation && (
                            <span
                              className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                              style={{ backgroundColor: 'rgba(249,115,22,0.15)', color: '#FB923C' }}
                            >
                              Misinformation
                            </span>
                          )}
                          {!!post.content_flags.is_racist && (
                            <span
                              className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                              style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: '#F87171' }}
                            >
                              Racist Content
                            </span>
                          )}
                        </div>
                      )}

                      {/* Engagement Bar */}
                      <div
                        className="flex items-center justify-between mt-3 max-w-[340px]"
                        style={{ color: '#71767B' }}
                      >
                        <button
                          onClick={() => {
                            setReplyingTo(post);
                            setComposing(true);
                          }}
                          className="flex items-center gap-1.5 group transition-colors hover:text-[#1D9BF0]"
                        >
                          <div className="p-1.5 rounded-full group-hover:bg-[#1D9BF0]/10 transition-colors">
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                            </svg>
                          </div>
                          <span className="text-[13px]">
                            {post.reply_count > 0 ? formatCount(post.reply_count) : ''}
                          </span>
                        </button>

                        <button className="flex items-center gap-1.5 group transition-colors hover:text-[#00BA7C]">
                          <div className="p-1.5 rounded-full group-hover:bg-[#00BA7C]/10 transition-colors">
                            <RepostIcon />
                          </div>
                          <span className="text-[13px]">
                            {post.repost_count > 0 ? formatCount(post.repost_count) : ''}
                          </span>
                        </button>

                        <button
                          onClick={() => handleLike(post.id)}
                          className="flex items-center gap-1.5 group transition-colors hover:text-[#F91880]"
                        >
                          <div className="p-1.5 rounded-full group-hover:bg-[#F91880]/10 transition-colors">
                            <HeartIcon />
                          </div>
                          <span className="text-[13px]">
                            {post.like_count > 0 ? formatCount(post.like_count) : ''}
                          </span>
                        </button>

                        <div className="flex items-center gap-1.5">
                          <div className="p-1.5">
                            <ViewsIcon />
                          </div>
                          <span className="text-[13px]">
                            {post.view_count > 0 ? formatCount(post.view_count) : ''}
                          </span>
                        </div>

                        <button
                          onClick={() => handleFlag(post.id)}
                          className="flex items-center group transition-colors hover:text-[#F59E0B]"
                        >
                          <div className="p-1.5 rounded-full group-hover:bg-[#F59E0B]/10 transition-colors">
                            <FlagIcon flagged={post.is_flagged_by_player} />
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
        )}
      </div>

      {/* Floating Compose Button (FAB) */}
      {!composing && (
        <button
          onClick={() => setComposing(true)}
          className="absolute ios-btn-bounce shadow-lg flex items-center justify-center"
          style={{
            bottom: 24,
            right: 20,
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: '#1D9BF0',
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
            <path
              d="M23 3c-6.62-.1-10.38 2.421-13.424 6.614C7.26 13.026 5.518 16.42 3.48 19.14c-.296.4.022.86.504.86h2.18c.403 0 .758-.247.918-.618C9.004 14.498 12.27 10.926 19.07 10.204V14a.5.5 0 0 0 .86.354l3.5-3.5a.5.5 0 0 0 0-.708l-3.5-3.5A.5.5 0 0 0 19.07 7V3z"
              fill="none"
              stroke="white"
              strokeWidth="1.5"
            />
            <path d="M22.5 3.5L3 20.5" stroke="white" strokeWidth="0" fill="none" />
            <path d="M23 3a1 1 0 0 0-1-1H12a1 1 0 0 0 0 2h10a1 1 0 0 0 1-1z" fill="none" />
          </svg>
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="white"
            style={{ position: 'absolute' }}
          >
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
          </svg>
        </button>
      )}

      {/* Compose Modal (slide up) */}
      {composing && (
        <div className="absolute inset-0 flex flex-col" style={{ zIndex: 60 }}>
          {/* Backdrop */}
          <div
            className="flex-1"
            style={{ backgroundColor: 'rgba(91, 112, 131, 0.4)' }}
            onClick={() => {
              setComposing(false);
              setReplyingTo(null);
            }}
          />
          {/* Sheet */}
          <div
            className="flex flex-col"
            style={{
              backgroundColor: '#000000',
              borderTop: '1px solid #2F3336',
              borderRadius: '16px 16px 0 0',
              maxHeight: '70%',
              minHeight: 280,
            }}
          >
            {/* Sheet header */}
            <div className="flex items-center justify-between px-4 py-3">
              <button
                onClick={() => {
                  setComposing(false);
                  setReplyingTo(null);
                }}
                className="text-[15px]"
                style={{ color: '#E7E9EA' }}
              >
                Cancel
              </button>
              <button
                onClick={handlePost}
                disabled={!composeText.trim()}
                className="px-4 py-1.5 rounded-full text-[15px] font-bold text-white disabled:opacity-40"
                style={{ backgroundColor: '#1D9BF0' }}
              >
                Post
              </button>
            </div>

            {/* Reply context */}
            {replyingTo && (
              <div className="px-4 pb-2">
                <span className="text-[14px]" style={{ color: '#71767B' }}>
                  Replying to <span style={{ color: '#1D9BF0' }}>{replyingTo.author_handle}</span>
                </span>
              </div>
            )}

            {/* Compose area */}
            <div className="flex-1 px-4 pb-2 overflow-y-auto">
              <div className="flex gap-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[16px] flex-shrink-0"
                  style={{ backgroundColor: '#1D9BF0' }}
                >
                  Y
                </div>
                <textarea
                  value={composeText}
                  onChange={(e) => setComposeText(e.target.value)}
                  placeholder={replyingTo ? 'Post your reply...' : "What's happening?"}
                  className="flex-1 bg-transparent text-[17px] resize-none outline-none min-h-[120px] placeholder:text-[#71767B]"
                  style={{ color: '#E7E9EA' }}
                  maxLength={500}
                  autoFocus
                />
              </div>
            </div>

            {/* Bottom toolbar */}
            <div
              className="flex items-center justify-between px-4 py-2"
              style={{ borderTop: '1px solid #2F3336' }}
            >
              <div className="flex items-center gap-4" style={{ color: '#1D9BF0' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path
                    d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 14.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z"
                    opacity="0.3"
                  />
                </svg>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path
                    d="M3 5.5C3 4.119 4.12 3 5.5 3h13C19.88 3 21 4.119 21 5.5v13c0 1.381-1.12 2.5-2.5 2.5h-13C4.12 21 3 19.881 3 18.5v-13z"
                    opacity="0"
                  />
                  <path d="M15.712 11.823a.75.75 0 0 1 0 1.354l-5.474 2.953a.75.75 0 0 1-1.113-.677V9.547a.75.75 0 0 1 1.113-.676l5.474 2.952z" />
                </svg>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[13px]" style={{ color: '#71767B' }}>
                  {composeText.length}/500
                </span>
                {composeText.length > 0 && (
                  <svg width="20" height="20" viewBox="0 0 20 20">
                    <circle cx="10" cy="10" r="9" fill="none" stroke="#2F3336" strokeWidth="2" />
                    <circle
                      cx="10"
                      cy="10"
                      r="9"
                      fill="none"
                      strokeWidth="2"
                      stroke={composeText.length > 450 ? '#F4212E' : '#1D9BF0'}
                      strokeDasharray={`${(composeText.length / 500) * 56.5} 56.5`}
                      strokeLinecap="round"
                      transform="rotate(-90 10 10)"
                    />
                  </svg>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
