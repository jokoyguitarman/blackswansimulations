import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
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

type PostFormat =
  | 'text'
  | 'official_statement'
  | 'infographic'
  | 'humor_meme'
  | 'video_concept'
  | 'personal_story';

const POST_FORMATS: Array<{ value: PostFormat; label: string; icon: string }> = [
  { value: 'text', label: 'Post', icon: '✏️' },
  { value: 'official_statement', label: 'Statement', icon: '📋' },
  { value: 'infographic', label: 'Info', icon: '📊' },
  { value: 'humor_meme', label: 'Meme', icon: '😄' },
  { value: 'video_concept', label: 'Video', icon: '🎬' },
  { value: 'personal_story', label: 'Story', icon: '💬' },
];

const FORMAT_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  official_statement: { label: 'Official Statement', bg: '#E3F2FD', fg: '#1565C0' },
  infographic: { label: 'Infographic', bg: '#E8F5E9', fg: '#2E7D32' },
  humor_meme: { label: 'Meme/Humor', bg: '#FCE4EC', fg: '#C62828' },
  video_concept: { label: 'Video', bg: '#EDE7F6', fg: '#4527A0' },
  personal_story: { label: 'Personal Story', bg: '#FFF3E0', fg: '#E65100' },
};

const REACTIONS = [
  { type: 'like', emoji: '👍', bg: '#1877F2' },
  { type: 'love', emoji: '❤️', bg: '#F33E58' },
  { type: 'haha', emoji: '😂', bg: '#F7B928' },
  { type: 'wow', emoji: '😮', bg: '#F7B928' },
  { type: 'angry', emoji: '😡', bg: '#E9710F' },
  { type: 'sad', emoji: '😢', bg: '#F7B928' },
];

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
  liked_by_me?: boolean;
  my_reaction?: string | null;
  flagged_by_me?: boolean;
  post_format?: string;
  media_urls?: string[];
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function getAvatarColor(name: string): string {
  const colors = ['#1877F2', '#42B72A', '#F02849', '#FF6D00', '#8B5CF6', '#0EA5E9'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function getReactionEmojis(likeCount: number): string[] {
  if (likeCount === 0) return [];
  if (likeCount < 10) return ['👍'];
  if (likeCount < 50) return ['👍', '❤️'];
  return ['👍', '❤️', '😮'];
}

export default function FacebookFeedApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [postReplies, setPostReplies] = useState<Record<string, SocialPost[]>>({});
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [selectedFormat, setSelectedFormat] = useState<PostFormat>('text');
  const [showReactions, setShowReactions] = useState<string | null>(null);
  const [myReactions, setMyReactions] = useState<Record<string, string>>({});
  const [commentText, setCommentText] = useState<Record<string, string>>({});
  const [expandedPosts, setExpandedPosts] = useState<Set<string>>(new Set());
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set());
  const [knownHandles, setKnownHandles] = useState<Array<{ handle: string; display_name: string }>>(
    [],
  );
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const reactionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadPosts = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        apiUrl(`/api/social/posts/session/${sessionId}?platform=facebook&limit=1000`),
        {
          headers,
        },
      );
      const result = await res.json();
      if (result.data) {
        const topLevel = (result.data as SocialPost[]).filter((p) => !p.reply_to_post_id);
        const replies = (result.data as SocialPost[]).filter((p) => !!p.reply_to_post_id);
        setPosts(topLevel);
        const replyMap: Record<string, SocialPost[]> = {};
        for (const r of replies) {
          const pid = r.reply_to_post_id!;
          if (!replyMap[pid]) replyMap[pid] = [];
          replyMap[pid].push(r);
        }
        setPostReplies(replyMap);
        // Restore reactions from API data
        const rxMap: Record<string, string> = {};
        for (const p of result.data as SocialPost[]) {
          if (p.my_reaction) rxMap[p.id] = p.my_reaction;
        }
        setMyReactions(rxMap);
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    loadPosts();
    if (sessionId) {
      getAuthHeaders().then((h) =>
        fetch(apiUrl(`/api/social/handles/session/${sessionId}`), { headers: h })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (j?.data) setKnownHandles(j.data);
          })
          .catch(() => {}),
      );
    }
  }, [loadPosts, sessionId]);

  // Re-fetch when navigating back to this view
  useEffect(() => {
    if (location.pathname.includes('/facebook')) loadPosts();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: [
      'social_post.created',
      'social_posts.engagement_update',
      'social_post.media_updated',
    ],
    onEvent: (event) => {
      if (event.type === 'social_posts.engagement_update') {
        const updates = (
          event.data as {
            updates: Array<{
              id: string;
              like_count?: number;
              view_count?: number;
              repost_count?: number;
            }>;
          }
        ).updates;
        if (Array.isArray(updates)) {
          setPosts((prev) =>
            prev.map((p) => {
              const up = updates.find((u) => u.id === p.id);
              if (!up) return p;
              return {
                ...p,
                like_count: up.like_count ?? p.like_count,
                view_count: up.view_count ?? p.view_count,
                repost_count: up.repost_count ?? p.repost_count,
              };
            }),
          );
        }
      } else if (event.type === 'social_post.media_updated') {
        const { post_id, media_urls } = event.data as { post_id: string; media_urls: string[] };
        setPosts((prev) => prev.map((p) => (p.id === post_id ? { ...p, media_urls } : p)));
      } else if (event.type === 'social_post.created') {
        const newPost = (event.data as { post: SocialPost }).post;
        if (newPost.platform !== 'facebook') return;
        if (newPost.reply_to_post_id) {
          setPostReplies((prev) => {
            const pid = newPost.reply_to_post_id!;
            const existing = prev[pid] || [];
            if (existing.some((r) => r.id === newPost.id)) return prev;
            return { ...prev, [pid]: [...existing, newPost] };
          });
          setPosts((prev) =>
            prev.map((p) =>
              p.id === newPost.reply_to_post_id
                ? { ...p, reply_count: (p.reply_count || 0) + 1 }
                : p,
            ),
          );
        } else {
          setPosts((prev) => {
            if (prev.some((p) => p.id === newPost.id)) return prev;
            return [newPost, ...prev];
          });
        }
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
          platform: 'facebook',
          post_format: selectedFormat,
        }),
      });
      setComposeText('');
      setComposing(false);
      setSelectedFormat('text');
    } catch {
      /* ignore */
    }
  }

  async function handleReaction(postId: string, reactionType: string = 'like') {
    const post = posts.find((p) => p.id === postId);
    const alreadyLiked = post?.liked_by_me;
    if (!alreadyLiked) {
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId ? { ...p, like_count: p.like_count + 1, liked_by_me: true } : p,
        ),
      );
    }
    setMyReactions((prev) => ({ ...prev, [postId]: reactionType }));
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/like`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId, reaction_type: reactionType }),
      });
    } catch {
      if (!alreadyLiked) {
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId ? { ...p, like_count: p.like_count - 1, liked_by_me: false } : p,
          ),
        );
      }
    }
    setShowReactions(null);
  }

  async function handleShare(postId: string) {
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/repost`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch {
      /* ignore */
    }
  }

  async function handleComment(postId: string) {
    const text = commentText[postId]?.trim();
    if (!text || !sessionId) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/posts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content: text,
          reply_to_post_id: postId,
          platform: 'facebook',
        }),
      });
      setCommentText((prev) => ({ ...prev, [postId]: '' }));
    } catch {
      /* ignore */
    }
  }

  async function handleFlag(postId: string) {
    const post = posts.find((p) => p.id === postId);
    if (post?.flagged_by_me) return;
    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, flagged_by_me: true } : p)));
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/flag`), { method: 'POST', headers });
    } catch {
      setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, flagged_by_me: false } : p)));
    }
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function getBadge(type: string): string | null {
    if (type === 'npc_media' || type === 'official_account') return '✓';
    if (type === 'npc_politician') return '🏛️';
    if (type === 'npc_influencer') return '⭐';
    return null;
  }

  const maxChars = 2000;

  return (
    <div
      className="h-full flex flex-col"
      style={{ backgroundColor: '#F0F2F5', colorScheme: 'light' as const }}
    >
      {/* ── Facebook Header ── */}
      <div
        style={{ backgroundColor: '#FFFFFF', borderBottom: '1px solid #DADDE1' }}
        className="flex-shrink-0"
      >
        <div className="flex items-center justify-between px-3" style={{ height: 48 }}>
          <span
            className="text-[22px] font-bold"
            style={{ color: '#1877F2', fontFamily: 'Helvetica, Arial, sans-serif' }}
          >
            facebook
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => navigate(`/sim/${sessionId}/device/social`)}
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ backgroundColor: '#000' }}
              title="Switch to Z"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 4H20L4 20H20"
                  stroke="#FFF"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              onClick={() => navigate(`/sim/${sessionId}/device/home`)}
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ backgroundColor: '#E4E6EB' }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#050505"
                strokeWidth="2"
              >
                <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </button>
          </div>
        </div>

        {/* Nav Icons */}
        <div
          className="flex items-center justify-around px-2 pb-1"
          style={{ borderBottom: '2px solid transparent' }}
        >
          {[
            {
              label: 'Home',
              active: true,
              icon: (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#1877F2">
                  <path d="M3 9.5L12 2l9 7.5V22H15v-6H9v6H3V9.5z" />
                </svg>
              ),
            },
            {
              label: 'Friends',
              active: false,
              icon: (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#65676B"
                  strokeWidth="2"
                >
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                </svg>
              ),
            },
            {
              label: 'Watch',
              active: false,
              icon: (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#65676B"
                  strokeWidth="2"
                >
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                  <polyline points="17 2 12 7 7 2" />
                </svg>
              ),
            },
            {
              label: 'Notif',
              active: false,
              icon: (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#65676B"
                  strokeWidth="2"
                >
                  <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 01-3.46 0" />
                </svg>
              ),
            },
            {
              label: 'Menu',
              active: false,
              icon: (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#65676B"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              ),
            },
          ].map((tab) => (
            <div key={tab.label} className="flex flex-col items-center py-2 px-3 relative">
              {tab.icon}
              {tab.active && (
                <div
                  className="absolute bottom-0 left-0 right-0 h-[2px]"
                  style={{ backgroundColor: '#1877F2' }}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Create Post Bar ── */}
      <div
        className="mx-0 mt-2 px-3 py-2.5"
        style={{
          backgroundColor: '#FFFFFF',
          borderBottom: '1px solid #CED0D4',
          borderTop: '1px solid #CED0D4',
        }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[15px] flex-shrink-0"
            style={{ backgroundColor: '#1877F2' }}
          >
            Y
          </div>
          <button
            onClick={() => setComposing(true)}
            className="flex-1 text-left px-3.5 py-2 rounded-full text-[15px]"
            style={{ backgroundColor: '#F0F2F5', color: '#65676B' }}
          >
            What&apos;s on your mind?
          </button>
          <button onClick={() => setComposing(true)} className="px-2">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="18" height="18" rx="3" stroke="#45BD62" strokeWidth="2" />
              <circle cx="8.5" cy="8.5" r="1.5" fill="#45BD62" />
              <path
                d="M21 15l-5-5L5 21"
                stroke="#45BD62"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Feed ── */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div
              className="w-7 h-7 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#1877F2', borderTopColor: 'transparent' }}
            />
          </div>
        ) : posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2 px-8 text-center">
            <p className="text-[16px] font-bold" style={{ color: '#050505' }}>
              No posts yet
            </p>
            <p className="text-[14px]" style={{ color: '#65676B' }}>
              Posts will appear here as the simulation progresses.
            </p>
          </div>
        ) : (
          posts.map((post) => {
            const badge = getBadge(post.author_type);
            const reactionEmojis = getReactionEmojis(post.like_count);
            const replies = postReplies[post.id] || [];
            const isExpanded = expandedPosts.has(post.id);
            const isLong = post.content.length > 200;

            return (
              <div
                key={post.id}
                className="mt-2"
                style={{
                  backgroundColor: '#FFFFFF',
                  borderTop: '1px solid #CED0D4',
                  borderBottom: '1px solid #CED0D4',
                }}
              >
                {/* Author Row */}
                <div className="flex items-center gap-2.5 px-3 pt-3 pb-1.5">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[15px] flex-shrink-0"
                    style={{ backgroundColor: getAvatarColor(post.author_display_name) }}
                  >
                    {post.author_display_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="font-semibold text-[15px]" style={{ color: '#050505' }}>
                        {post.author_display_name}
                      </span>
                      {badge && (
                        <span className="text-[13px]" style={{ color: '#1877F2' }}>
                          {badge}
                        </span>
                      )}
                    </div>
                    <div
                      className="flex items-center gap-1 text-[13px]"
                      style={{ color: '#65676B' }}
                    >
                      <span>{timeAgo(post.created_at)}</span>
                      <span>·</span>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="#65676B">
                        <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 14.5a6.5 6.5 0 110-13 6.5 6.5 0 010 13z" />
                      </svg>
                    </div>
                  </div>
                  <button
                    onClick={() => handleFlag(post.id)}
                    className="p-1.5 rounded-full hover:bg-[#F2F3F5]"
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill={post.flagged_by_me ? '#F59E0B' : '#65676B'}
                    >
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </button>
                </div>

                {/* Content Flags */}
                {!!(
                  post.content_flags?.is_hate_speech || post.content_flags?.is_misinformation
                ) && (
                  <div className="px-3 pb-1 flex gap-1.5">
                    {!!post.content_flags.is_hate_speech && (
                      <span
                        className="text-[11px] px-2 py-0.5 rounded font-semibold"
                        style={{ backgroundColor: '#FDECEA', color: '#D32F2F' }}
                      >
                        Hate Speech
                      </span>
                    )}
                    {!!post.content_flags.is_misinformation && (
                      <span
                        className="text-[11px] px-2 py-0.5 rounded font-semibold"
                        style={{ backgroundColor: '#FFF3E0', color: '#E65100' }}
                      >
                        Misinformation
                      </span>
                    )}
                  </div>
                )}

                {post.requires_response && !post.responded_at && (
                  <div className="px-3 pb-1">
                    <span
                      className="text-[11px] font-bold px-2 py-0.5 rounded"
                      style={{ backgroundColor: '#FFF3CD', color: '#856404' }}
                    >
                      REQUIRES RESPONSE
                    </span>
                  </div>
                )}

                {post.post_format && FORMAT_BADGE[post.post_format] && (
                  <div className="px-3 pb-1">
                    <span
                      className="text-[11px] px-2 py-0.5 rounded font-semibold"
                      style={{
                        backgroundColor: FORMAT_BADGE[post.post_format].bg,
                        color: FORMAT_BADGE[post.post_format].fg,
                      }}
                    >
                      {FORMAT_BADGE[post.post_format].label}
                    </span>
                  </div>
                )}

                {/* Content Text */}
                <div className="px-3 pb-2">
                  <p
                    className="text-[15px] leading-[20px] whitespace-pre-wrap"
                    style={{ color: '#050505' }}
                  >
                    {isLong && !isExpanded ? (
                      <>
                        {post.content.substring(0, 200)}...
                        <button
                          onClick={() => setExpandedPosts((prev) => new Set([...prev, post.id]))}
                          className="font-semibold ml-1"
                          style={{ color: '#65676B' }}
                        >
                          See more
                        </button>
                      </>
                    ) : (
                      <>
                        {post.content}
                        {isLong && (
                          <button
                            onClick={() =>
                              setExpandedPosts((prev) => {
                                const n = new Set(prev);
                                n.delete(post.id);
                                return n;
                              })
                            }
                            className="font-semibold ml-1"
                            style={{ color: '#65676B' }}
                          >
                            See less
                          </button>
                        )}
                      </>
                    )}
                  </p>
                </div>

                {/* Media (full width, no padding) */}
                {Array.isArray(post.media_urls) && post.media_urls.length > 0 && (
                  <div className="relative">
                    {/\.(mp4|webm|mov)(\?|$)/i.test(post.media_urls[0]) ? (
                      <video
                        src={post.media_urls[0]}
                        controls
                        className="w-full"
                        style={{ maxHeight: 400, objectFit: 'contain', backgroundColor: '#000' }}
                      />
                    ) : (
                      <img
                        src={post.media_urls[0]}
                        alt=""
                        className="w-full"
                        style={{ maxHeight: 400, objectFit: 'cover' }}
                      />
                    )}
                    {post.post_format === 'video_concept' &&
                      !/\.(mp4|webm|mov)(\?|$)/i.test(post.media_urls[0] || '') && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div
                            className="w-16 h-16 rounded-full flex items-center justify-center"
                            style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
                          >
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                              <polygon points="8,5 19,12 8,19" />
                            </svg>
                          </div>
                        </div>
                      )}
                  </div>
                )}

                {/* Reaction + Comment Counts */}
                <div
                  className="flex items-center justify-between px-3 py-2"
                  style={{ borderBottom: '1px solid #CED0D4' }}
                >
                  <div className="flex items-center gap-1">
                    {reactionEmojis.length > 0 && (
                      <div className="flex -space-x-0.5">
                        {reactionEmojis.map((emoji, i) => (
                          <span key={i} className="text-[14px]">
                            {emoji}
                          </span>
                        ))}
                      </div>
                    )}
                    {post.like_count > 0 && (
                      <span className="text-[14px] ml-1" style={{ color: '#65676B' }}>
                        {formatCount(post.like_count)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[14px]" style={{ color: '#65676B' }}>
                    {post.reply_count > 0 && (
                      <button
                        onClick={() => setExpandedComments((prev) => new Set([...prev, post.id]))}
                        className="hover:underline"
                        style={{ color: '#65676B' }}
                      >
                        {formatCount(post.reply_count)} comments
                      </button>
                    )}
                    {post.repost_count > 0 && <span>{formatCount(post.repost_count)} shares</span>}
                  </div>
                </div>

                {/* Action Buttons */}
                <div
                  className="flex items-center justify-around px-1 py-0.5"
                  style={{ borderBottom: '1px solid #CED0D4', backgroundColor: '#FFFFFF' }}
                >
                  <div className="relative flex-1">
                    {(() => {
                      const myRx = myReactions[post.id];
                      const rxInfo = myRx ? REACTIONS.find((r) => r.type === myRx) : null;
                      const rxColor =
                        myRx === 'like'
                          ? '#1877F2'
                          : myRx === 'love'
                            ? '#F33E58'
                            : myRx === 'angry'
                              ? '#E9710F'
                              : myRx
                                ? '#F7B928'
                                : '#65676B';
                      return (
                        <button
                          onClick={() => handleReaction(post.id, 'like')}
                          onMouseEnter={() => {
                            if (reactionTimeoutRef.current)
                              clearTimeout(reactionTimeoutRef.current);
                            setShowReactions(post.id);
                          }}
                          onMouseLeave={() => {
                            reactionTimeoutRef.current = setTimeout(
                              () => setShowReactions(null),
                              600,
                            );
                          }}
                          className="flex items-center justify-center gap-1.5 w-full py-2 rounded-md hover:bg-[#F2F3F5] transition-colors"
                          style={{ color: post.liked_by_me ? rxColor : '#65676B' }}
                        >
                          {rxInfo ? (
                            <span className="text-[18px] leading-none">{rxInfo.emoji}</span>
                          ) : (
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
                            </svg>
                          )}
                          <span className="text-[14px] font-semibold">
                            {rxInfo
                              ? rxInfo.type.charAt(0).toUpperCase() + rxInfo.type.slice(1)
                              : 'Like'}
                          </span>
                        </button>
                      );
                    })()}
                    {showReactions === post.id && (
                      <div
                        className="absolute bottom-full left-0 mb-1 flex gap-1 px-2.5 py-2 rounded-full z-50"
                        style={{
                          backgroundColor: '#FFFFFF',
                          boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
                        }}
                        onMouseEnter={() => {
                          if (reactionTimeoutRef.current) clearTimeout(reactionTimeoutRef.current);
                          setShowReactions(post.id);
                        }}
                        onMouseLeave={() => {
                          reactionTimeoutRef.current = setTimeout(
                            () => setShowReactions(null),
                            300,
                          );
                        }}
                      >
                        {REACTIONS.map((r) => (
                          <button
                            key={r.type}
                            onClick={() => handleReaction(post.id, r.type)}
                            className="hover:scale-125 transition-transform leading-none bg-transparent border-0 p-0 cursor-pointer"
                            style={{ fontSize: 28, lineHeight: 1 }}
                            title={r.type}
                          >
                            {r.emoji}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setExpandedComments((prev) => new Set([...prev, post.id]));
                      setTimeout(() => commentInputRefs.current[post.id]?.focus(), 100);
                    }}
                    className="flex items-center justify-center gap-1.5 flex-1 py-2 rounded-md hover:bg-[#F2F3F5] transition-colors"
                    style={{ color: '#65676B' }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                    </svg>
                    <span className="text-[14px] font-semibold">Comment</span>
                  </button>
                  <button
                    onClick={() => handleShare(post.id)}
                    className="flex items-center justify-center gap-1.5 flex-1 py-2 rounded-md hover:bg-[#F2F3F5] transition-colors"
                    style={{ color: '#65676B' }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
                    </svg>
                    <span className="text-[14px] font-semibold">Share</span>
                  </button>
                </div>

                {/* Inline Comments */}
                {(() => {
                  const commentsExpanded = expandedComments.has(post.id);
                  const visibleReplies = commentsExpanded ? replies : replies.slice(-2);
                  return (
                    <>
                      {replies.length > 0 && (
                        <div className="px-3 pt-2 pb-1" style={{ backgroundColor: '#FFFFFF' }}>
                          {replies.length > 2 && !commentsExpanded && (
                            <button
                              onClick={() =>
                                setExpandedComments((prev) => new Set([...prev, post.id]))
                              }
                              className="text-[14px] font-semibold mb-2"
                              style={{ color: '#65676B' }}
                            >
                              View all {replies.length} comments
                            </button>
                          )}
                          {commentsExpanded && replies.length > 2 && (
                            <button
                              onClick={() =>
                                setExpandedComments((prev) => {
                                  const n = new Set(prev);
                                  n.delete(post.id);
                                  return n;
                                })
                              }
                              className="text-[14px] font-semibold mb-2"
                              style={{ color: '#65676B' }}
                            >
                              Hide comments
                            </button>
                          )}
                          {visibleReplies.map((reply) => (
                            <div key={reply.id} className="flex gap-2 mb-2.5">
                              <div
                                className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-[12px] flex-shrink-0"
                                style={{
                                  backgroundColor: getAvatarColor(reply.author_display_name),
                                }}
                              >
                                {reply.author_display_name.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <div
                                  className="rounded-2xl px-3 py-1.5"
                                  style={{ backgroundColor: '#F0F2F5' }}
                                >
                                  <span
                                    className="text-[13px] font-semibold"
                                    style={{ color: '#050505' }}
                                  >
                                    {reply.author_display_name}
                                  </span>
                                  <p className="text-[14px]" style={{ color: '#050505' }}>
                                    {reply.content}
                                  </p>
                                </div>
                                <div className="flex items-center gap-3 ml-3 mt-0.5">
                                  <button
                                    onClick={() => handleReaction(reply.id, 'like')}
                                    className="text-[12px] font-semibold hover:underline"
                                    style={{ color: reply.liked_by_me ? '#1877F2' : '#65676B' }}
                                  >
                                    Like
                                  </button>
                                  <button
                                    onClick={() => {
                                      setCommentText((prev) => ({
                                        ...prev,
                                        [post.id]: `${reply.author_handle} `,
                                      }));
                                      setExpandedComments((prev) => new Set([...prev, post.id]));
                                      setTimeout(
                                        () => commentInputRefs.current[post.id]?.focus(),
                                        100,
                                      );
                                    }}
                                    className="text-[12px] font-semibold hover:underline"
                                    style={{ color: '#65676B' }}
                                  >
                                    Reply
                                  </button>
                                  <span className="text-[12px]" style={{ color: '#65676B' }}>
                                    {timeAgo(reply.created_at)}
                                  </span>
                                  {reply.like_count > 0 && (
                                    <span className="text-[12px]" style={{ color: '#65676B' }}>
                                      👍 {reply.like_count}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Comment Input */}
                      <div
                        className="flex items-center gap-2 px-3 py-1.5 relative"
                        style={{ backgroundColor: '#FFFFFF' }}
                      >
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center text-white font-bold text-[10px] flex-shrink-0"
                          style={{ backgroundColor: '#1877F2' }}
                        >
                          Y
                        </div>
                        <div
                          className="flex-1 flex items-center rounded-full px-3 py-1 relative"
                          style={{ backgroundColor: '#F0F2F5' }}
                        >
                          <input
                            ref={(el) => {
                              commentInputRefs.current[post.id] = el;
                            }}
                            type="text"
                            value={commentText[post.id] || ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setCommentText((prev) => ({ ...prev, [post.id]: val }));
                              const match = val.match(/@(\w*)$/);
                              if (match) {
                                setMentionQuery(match[1].toLowerCase());
                                setShowMentions(true);
                              } else {
                                setShowMentions(false);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                handleComment(post.id);
                                setShowMentions(false);
                              }
                            }}
                            placeholder="Write a comment..."
                            className="flex-1 bg-transparent text-[13px] outline-none"
                            style={{ color: '#050505' }}
                          />
                          {commentText[post.id]?.trim() && (
                            <button
                              onClick={() => {
                                handleComment(post.id);
                                setShowMentions(false);
                              }}
                              className="ml-1"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="#1877F2">
                                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                              </svg>
                            </button>
                          )}
                          {showMentions &&
                            document.activeElement === commentInputRefs.current[post.id] && (
                              <div
                                className="absolute left-0 right-0 bottom-full mb-1 rounded-lg overflow-hidden z-50"
                                style={{
                                  backgroundColor: '#FFFFFF',
                                  boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                                  maxHeight: 120,
                                  overflowY: 'auto',
                                }}
                              >
                                {knownHandles
                                  .filter((h) => h.handle.toLowerCase().includes(mentionQuery))
                                  .slice(0, 5)
                                  .map((h) => (
                                    <button
                                      key={h.handle}
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        setCommentText((prev) => ({
                                          ...prev,
                                          [post.id]: (prev[post.id] || '').replace(
                                            /@\w*$/,
                                            h.handle + ' ',
                                          ),
                                        }));
                                        setShowMentions(false);
                                        commentInputRefs.current[post.id]?.focus();
                                      }}
                                      className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[#F2F3F5]"
                                      style={{ color: '#050505' }}
                                    >
                                      <span style={{ color: '#1877F2' }}>{h.handle}</span>
                                      <span
                                        className="ml-1 text-[11px]"
                                        style={{ color: '#65676B' }}
                                      >
                                        {h.display_name}
                                      </span>
                                    </button>
                                  ))}
                              </div>
                            )}
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            );
          })
        )}
        <div style={{ height: 16 }} />
      </div>

      {/* ── Compose Modal ── */}
      {composing && (
        <div className="absolute inset-0 flex flex-col" style={{ zIndex: 60 }}>
          <div
            className="flex-1"
            style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
            onClick={() => setComposing(false)}
          />
          <div
            className="flex flex-col"
            style={{
              backgroundColor: '#FFFFFF',
              borderRadius: '12px 12px 0 0',
              maxHeight: '80%',
              minHeight: 320,
            }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: '1px solid #DADDE1', backgroundColor: '#FFFFFF' }}
            >
              <button
                onClick={() => setComposing(false)}
                className="text-[15px] font-semibold"
                style={{ color: '#65676B' }}
              >
                Cancel
              </button>
              <span className="font-bold text-[17px]" style={{ color: '#050505' }}>
                Create post
              </span>
              <button
                onClick={handlePost}
                disabled={!composeText.trim()}
                className="px-4 py-1.5 rounded-md text-[14px] font-bold text-white disabled:opacity-40"
                style={{ backgroundColor: '#1877F2' }}
              >
                Post
              </button>
            </div>

            {/* Format Picker */}
            <div
              className="px-4 pt-3 pb-1 flex gap-1.5 flex-wrap"
              style={{ backgroundColor: '#FFFFFF' }}
            >
              {POST_FORMATS.map((fmt) => (
                <button
                  key={fmt.value}
                  onClick={() => setSelectedFormat(fmt.value)}
                  className="px-2.5 py-1 rounded-full text-[12px] font-semibold transition-colors"
                  style={{
                    backgroundColor: selectedFormat === fmt.value ? '#1877F2' : '#E4E6EB',
                    color: selectedFormat === fmt.value ? '#FFFFFF' : '#65676B',
                  }}
                >
                  {fmt.icon} {fmt.label}
                </button>
              ))}
            </div>

            {/* Compose Area */}
            <div
              className="flex-1 px-4 pb-2 overflow-y-auto"
              style={{ backgroundColor: '#FFFFFF' }}
            >
              <div className="flex gap-3 pt-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
                  style={{ backgroundColor: '#1877F2' }}
                >
                  Y
                </div>
                <div className="flex-1 relative">
                  <textarea
                    value={composeText}
                    onChange={(e) => {
                      const val = e.target.value;
                      setComposeText(val);
                      const match = val.match(/@(\w*)$/);
                      if (match) {
                        setMentionQuery(match[1].toLowerCase());
                        setShowMentions(true);
                      } else {
                        setShowMentions(false);
                      }
                    }}
                    placeholder="What's on your mind?"
                    className="w-full bg-transparent text-[16px] resize-none outline-none min-h-[140px]"
                    style={{ color: '#050505', lineHeight: '1.5' }}
                    maxLength={maxChars}
                    autoFocus
                  />
                  {showMentions && (
                    <div
                      className="absolute left-0 right-0 top-full mt-1 rounded-lg overflow-hidden z-50"
                      style={{
                        backgroundColor: '#FFFFFF',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                        maxHeight: 150,
                        overflowY: 'auto',
                      }}
                    >
                      {knownHandles
                        .filter((h) => h.handle.toLowerCase().includes(mentionQuery))
                        .slice(0, 6)
                        .map((h) => (
                          <button
                            key={h.handle}
                            onClick={() => {
                              setComposeText((prev) => prev.replace(/@\w*$/, h.handle + ' '));
                              setShowMentions(false);
                            }}
                            className="w-full text-left px-3 py-2 text-[14px] hover:bg-[#F2F3F5]"
                            style={{ color: '#050505' }}
                          >
                            <span style={{ color: '#1877F2' }}>{h.handle}</span>
                            <span className="ml-2 text-[12px]" style={{ color: '#65676B' }}>
                              {h.display_name}
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom toolbar */}
            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderTop: '1px solid #DADDE1', backgroundColor: '#FFFFFF' }}
            >
              <div className="flex items-center gap-4">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <rect
                    x="3"
                    y="3"
                    width="18"
                    height="18"
                    rx="3"
                    stroke="#45BD62"
                    strokeWidth="2"
                  />
                  <circle cx="8.5" cy="8.5" r="1.5" fill="#45BD62" />
                  <path
                    d="M21 15l-5-5L5 21"
                    stroke="#45BD62"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="9" stroke="#F7B928" strokeWidth="2" />
                  <path
                    d="M8 14s1.5 2 4 2 4-2 4-2"
                    stroke="#F7B928"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <circle cx="9" cy="9" r="1" fill="#F7B928" />
                  <circle cx="15" cy="9" r="1" fill="#F7B928" />
                </svg>
              </div>
              <span className="text-[13px]" style={{ color: '#65676B' }}>
                {composeText.length}/{maxChars}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
