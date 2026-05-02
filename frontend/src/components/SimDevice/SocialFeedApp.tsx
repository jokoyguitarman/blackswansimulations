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
  const [selectedPost, setSelectedPost] = useState<SocialPost | null>(null);
  const [threadReplies, setThreadReplies] = useState<SocialPost[]>([]);

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

  async function openThread(post: SocialPost) {
    setSelectedPost(post);
    setThreadReplies([]);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/${post.id}`), { headers });
      const result = await res.json();
      if (result.data?.replies) {
        setThreadReplies(result.data.replies);
      }
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

  if (selectedPost) {
    const badge = getAuthorBadge(selectedPost.author_type);
    return (
      <div
        className="h-full flex flex-col"
        style={{ backgroundColor: '#000000', color: '#E7E9EA' }}
      >
        {/* Thread Header */}
        <div
          className="flex items-center gap-3 px-4 flex-shrink-0"
          style={{ height: 53, borderBottom: '1px solid #2F3336' }}
        >
          <button
            onClick={() => {
              setSelectedPost(null);
              setThreadReplies([]);
            }}
            className="ios-btn-bounce"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#E7E9EA">
              <path d="M7.414 13l5.293 5.293a1 1 0 0 1-1.414 1.414l-7-7a1 1 0 0 1 0-1.414l7-7a1 1 0 1 1 1.414 1.414L7.414 11H20a1 1 0 1 1 0 2H7.414z" />
            </svg>
          </button>
          <span className="text-[17px] font-bold">Post</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Original Post (expanded) */}
          <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid #2F3336' }}>
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-[18px]"
                style={{ backgroundColor: getAvatarColor(selectedPost.author_display_name) }}
              >
                {selectedPost.author_display_name.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="flex items-center gap-1">
                  <span className="font-bold text-[15px]">{selectedPost.author_display_name}</span>
                  {badge && (
                    <span className="text-[14px]" style={{ color: badge.color }}>
                      {badge.label}
                    </span>
                  )}
                </div>
                <span className="text-[13px]" style={{ color: '#71767B' }}>
                  {selectedPost.author_handle}
                </span>
              </div>
            </div>
            <p className="text-[17px] leading-relaxed mb-3 whitespace-pre-wrap">
              {selectedPost.content}
            </p>
            <div className="text-[13px] mb-3" style={{ color: '#71767B' }}>
              {new Date(selectedPost.created_at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              {' · '}
              {new Date(selectedPost.created_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </div>
            <div
              className="flex items-center gap-5 py-2 text-[13px]"
              style={{ borderTop: '1px solid #2F3336', color: '#71767B' }}
            >
              <span>
                <strong style={{ color: '#E7E9EA' }}>
                  {formatCount(selectedPost.reply_count)}
                </strong>{' '}
                Replies
              </span>
              <span>
                <strong style={{ color: '#E7E9EA' }}>
                  {formatCount(selectedPost.repost_count)}
                </strong>{' '}
                Reposts
              </span>
              <span>
                <strong style={{ color: '#E7E9EA' }}>{formatCount(selectedPost.like_count)}</strong>{' '}
                Likes
              </span>
            </div>
            <div
              className="flex items-center justify-around py-2"
              style={{ borderTop: '1px solid #2F3336' }}
            >
              <button
                onClick={() => {
                  setReplyingTo(selectedPost);
                  setComposing(true);
                }}
                className="ios-btn-bounce p-2"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#71767B"
                  strokeWidth="1.5"
                >
                  <path
                    d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button onClick={() => handleLike(selectedPost.id)} className="ios-btn-bounce p-2">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#71767B"
                  strokeWidth="1.5"
                >
                  <path
                    d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button onClick={() => handleFlag(selectedPost.id)} className="ios-btn-bounce p-2">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill={selectedPost.is_flagged_by_player ? '#F59E0B' : 'none'}
                  stroke={selectedPost.is_flagged_by_player ? '#F59E0B' : '#71767B'}
                  strokeWidth="1.5"
                >
                  <path
                    d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <line x1="4" y1="22" x2="4" y2="15" />
                </svg>
              </button>
            </div>
          </div>

          {/* Replies */}
          {threadReplies.length === 0 ? (
            <div className="flex items-center justify-center h-24">
              <p className="text-[13px]" style={{ color: '#71767B' }}>
                No replies yet
              </p>
            </div>
          ) : (
            threadReplies.map((reply) => {
              const replyBadge = getAuthorBadge(reply.author_type);
              return (
                <div
                  key={reply.id}
                  className="px-4 py-3"
                  style={{ borderBottom: '1px solid #2F3336' }}
                >
                  <div className="flex gap-3">
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-[14px] flex-shrink-0"
                      style={{ backgroundColor: getAvatarColor(reply.author_display_name) }}
                    >
                      {reply.author_display_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className="font-bold text-[14px]">{reply.author_display_name}</span>
                        {replyBadge && (
                          <span className="text-[12px]" style={{ color: replyBadge.color }}>
                            {replyBadge.label}
                          </span>
                        )}
                        <span className="text-[13px]" style={{ color: '#71767B' }}>
                          {reply.author_handle}
                        </span>
                        <span className="text-[13px]" style={{ color: '#71767B' }}>
                          · {timeAgo(reply.created_at)}
                        </span>
                      </div>
                      <p className="text-[14px] mt-1 whitespace-pre-wrap">{reply.content}</p>
                      <div className="flex items-center gap-5 mt-2">
                        <button
                          onClick={() => handleLike(reply.id)}
                          className="ios-btn-bounce flex items-center gap-1"
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#71767B"
                            strokeWidth="1.5"
                          >
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                          </svg>
                          <span className="text-[12px]" style={{ color: '#71767B' }}>
                            {formatCount(reply.like_count)}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#000000', color: '#E7E9EA' }}>
      {/* Header */}
      <div className="flex-shrink-0" style={{ borderBottom: '1px solid #2F3336' }}>
        <div className="flex items-center justify-between px-4" style={{ height: 53 }}>
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/home`)}
            className="ios-btn-bounce w-8 h-8 flex items-center justify-center"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#E7E9EA">
              <path d="M7.414 13l5.293 5.293a1 1 0 0 1-1.414 1.414l-7-7a1 1 0 0 1 0-1.414l7-7a1 1 0 1 1 1.414 1.414L7.414 11H20a1 1 0 1 1 0 2H7.414z" />
            </svg>
          </button>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="#E7E9EA">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          <button className="ios-btn-bounce w-8 h-8 flex items-center justify-center">
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
            className="flex-1 py-3 text-center text-[15px] font-bold relative transition-colors"
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
            className="flex-1 py-3 text-center text-[15px] font-bold relative transition-colors"
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
          <div className="flex items-center justify-center h-32">
            <div
              className="w-7 h-7 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#1D9BF0', borderTopColor: 'transparent' }}
            />
          </div>
        ) : posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3 px-8 text-center">
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#333639"
              strokeWidth="1.5"
            >
              <path
                d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p className="text-[15px] font-bold" style={{ color: '#E7E9EA' }}>
              Welcome to X
            </p>
            <p className="text-[13px]" style={{ color: '#71767B' }}>
              Posts will appear here as the simulation progresses.
            </p>
          </div>
        ) : (
          posts
            .filter((p) => !p.reply_to_post_id)
            .map((post) => {
              const badge = getAuthorBadge(post.author_type);
              return (
                <div
                  key={post.id}
                  className="px-4 py-3 transition-colors cursor-pointer hover:bg-white/[0.03]"
                  style={{
                    borderBottom: '1px solid #2F3336',
                    borderLeft: getSentimentBorder(post.sentiment),
                  }}
                  onClick={() => openThread(post)}
                >
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
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[16px] flex-shrink-0"
                      style={{ backgroundColor: getAvatarColor(post.author_display_name) }}
                    >
                      {post.author_display_name.charAt(0).toUpperCase()}
                    </div>

                    <div className="flex-1 min-w-0">
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

                      {post.is_repost && (
                        <div
                          className="flex items-center gap-1 mt-0.5"
                          style={{ color: '#71767B' }}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M17 1l4 4-4 4" />
                            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                            <path d="M7 23l-4-4 4-4" />
                            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                          </svg>
                          <span className="text-[12px]">Reposted</span>
                        </div>
                      )}

                      <p
                        className="text-[15px] mt-1 whitespace-pre-wrap break-words"
                        style={{ color: '#E7E9EA', lineHeight: '1.4' }}
                      >
                        {String(post.content)
                          .split(/(#\w+)/g)
                          .map((part: string, i: number) =>
                            part.startsWith('#') ? (
                              <span key={i} style={{ color: '#1D9BF0' }}>
                                {part}
                              </span>
                            ) : (
                              <span key={i}>{part}</span>
                            ),
                          )}
                      </p>

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

                      {/* Engagement bar */}
                      <div
                        className="flex items-center justify-between mt-3 max-w-[340px]"
                        style={{ color: '#71767B' }}
                      >
                        {/* Reply */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
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
                        {/* Repost */}
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1.5 group transition-colors hover:text-[#00BA7C]"
                        >
                          <div className="p-1.5 rounded-full group-hover:bg-[#00BA7C]/10 transition-colors">
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
                              <path d="M17 1l4 4-4 4" />
                              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                              <path d="M7 23l-4-4 4-4" />
                              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                            </svg>
                          </div>
                          <span className="text-[13px]">
                            {post.repost_count > 0 ? formatCount(post.repost_count) : ''}
                          </span>
                        </button>
                        {/* Like */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleLike(post.id);
                          }}
                          className="flex items-center gap-1.5 group transition-colors hover:text-[#F91880]"
                        >
                          <div className="p-1.5 rounded-full group-hover:bg-[#F91880]/10 transition-colors">
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
                              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                            </svg>
                          </div>
                          <span className="text-[13px]">
                            {post.like_count > 0 ? formatCount(post.like_count) : ''}
                          </span>
                        </button>
                        {/* Views */}
                        <div className="flex items-center gap-1.5">
                          <div className="p-1.5">
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
                              <path d="M18 20V10M12 20V4M6 20v-6" />
                            </svg>
                          </div>
                          <span className="text-[13px]">
                            {post.view_count > 0 ? formatCount(post.view_count) : ''}
                          </span>
                        </div>
                        {/* Flag */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleFlag(post.id);
                          }}
                          className="flex items-center group transition-colors hover:text-[#F59E0B]"
                        >
                          <div className="p-1.5 rounded-full group-hover:bg-[#F59E0B]/10 transition-colors">
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill={post.is_flagged_by_player ? '#F59E0B' : 'none'}
                              stroke={post.is_flagged_by_player ? '#F59E0B' : 'currentColor'}
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                              <line x1="4" y1="22" x2="4" y2="15" />
                            </svg>
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

      {/* Compose FAB */}
      {!composing && (
        <button
          onClick={() => setComposing(true)}
          className="absolute ios-btn-bounce flex items-center justify-center"
          style={{
            bottom: 24,
            right: 20,
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: '#1D9BF0',
            boxShadow: '0 4px 12px rgba(29,155,240,0.4)',
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}

      {/* Compose Modal */}
      {composing && (
        <div className="absolute inset-0 flex flex-col" style={{ zIndex: 60 }}>
          <div
            className="flex-1"
            style={{ backgroundColor: 'rgba(91, 112, 131, 0.4)' }}
            onClick={() => {
              setComposing(false);
              setReplyingTo(null);
            }}
          />
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
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: '1px solid #2F3336' }}
            >
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

            {replyingTo && (
              <div className="px-4 pb-2 pt-3">
                <span className="text-[14px]" style={{ color: '#71767B' }}>
                  Replying to <span style={{ color: '#1D9BF0' }}>{replyingTo.author_handle}</span>
                </span>
              </div>
            )}

            <div className="flex-1 px-4 pb-2 overflow-y-auto">
              <div className="flex gap-3 pt-3">
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
                  className="flex-1 bg-transparent text-[18px] resize-none outline-none min-h-[120px] placeholder:text-[#71767B]"
                  style={{ color: '#E7E9EA', lineHeight: '1.4' }}
                  maxLength={500}
                  autoFocus
                />
              </div>
            </div>

            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderTop: '1px solid #2F3336' }}
            >
              <div className="flex items-center gap-4" style={{ color: '#1D9BF0' }}>
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  <line x1="9" y1="9" x2="9.01" y2="9" />
                  <line x1="15" y1="9" x2="15.01" y2="9" />
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
