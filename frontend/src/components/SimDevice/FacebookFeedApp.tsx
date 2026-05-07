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

type Reaction = 'like' | 'love' | 'haha' | 'wow' | 'angry' | 'sad';

const REACTIONS: Array<{ type: Reaction; emoji: string; label: string }> = [
  { type: 'like', emoji: '👍', label: 'Like' },
  { type: 'love', emoji: '❤️', label: 'Love' },
  { type: 'haha', emoji: '😂', label: 'Haha' },
  { type: 'wow', emoji: '😮', label: 'Wow' },
  { type: 'angry', emoji: '😡', label: 'Angry' },
  { type: 'sad', emoji: '😢', label: 'Sad' },
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
  flagged_by_me?: boolean;
  post_format?: string;
  media_urls?: string[];
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export default function FacebookFeedApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [selectedFormat, setSelectedFormat] = useState<PostFormat>('text');
  const [showReactions, setShowReactions] = useState<string | null>(null);

  const loadPosts = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/session/${sessionId}?platform=facebook`), {
        headers,
      });
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
        if (!newPost.reply_to_post_id) {
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

  async function handleLike(postId: string) {
    const post = posts.find((p) => p.id === postId);
    if (post?.liked_by_me) return;
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId ? { ...p, like_count: p.like_count + 1, liked_by_me: true } : p,
      ),
    );
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/like`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch {
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId ? { ...p, like_count: p.like_count - 1, liked_by_me: false } : p,
        ),
      );
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

  async function handleFlag(postId: string) {
    const post = posts.find((p) => p.id === postId);
    if (post?.flagged_by_me) return;
    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, flagged_by_me: true } : p)));
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/flag`), {
        method: 'POST',
        headers,
      });
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

  function getAvatarColor(name: string): string {
    const colors = ['#1877F2', '#42B72A', '#F02849', '#FF6D00', '#8B5CF6', '#0EA5E9'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  function getAuthorBadge(type: string): string | null {
    switch (type) {
      case 'npc_media':
      case 'official_account':
        return '✓';
      case 'npc_politician':
        return '🏛️';
      case 'npc_influencer':
        return '⭐';
      default:
        return null;
    }
  }

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#F0F2F5', color: '#050505' }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 flex-shrink-0"
        style={{ height: 50, backgroundColor: '#FFFFFF', borderBottom: '1px solid #DADDE1' }}
      >
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="w-8 h-8 flex items-center justify-center"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#65676B">
            <path d="M7.414 13l5.293 5.293a1 1 0 0 1-1.414 1.414l-7-7a1 1 0 0 1 0-1.414l7-7a1 1 0 1 1 1.414 1.414L7.414 11H20a1 1 0 1 1 0 2H7.414z" />
          </svg>
        </button>
        <span className="text-[20px] font-bold" style={{ color: '#1877F2' }}>
          facebook
        </span>
        <button
          className="w-8 h-8 flex items-center justify-center rounded-full"
          style={{ backgroundColor: '#E4E6EB' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="#050505">
            <circle cx="11" cy="11" r="8" fill="none" stroke="#050505" strokeWidth="2" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" stroke="#050505" strokeWidth="2" />
          </svg>
        </button>
      </div>

      {/* Create Post Card */}
      <div
        className="mx-3 mt-3 px-4 py-3 rounded-lg"
        style={{ backgroundColor: '#FFFFFF', boxShadow: '0 1px 2px rgba(0,0,0,0.1)' }}
      >
        <button onClick={() => setComposing(true)} className="w-full flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold"
            style={{ backgroundColor: '#1877F2' }}
          >
            Y
          </div>
          <div
            className="flex-1 text-left px-3 py-2 rounded-full text-[15px]"
            style={{ backgroundColor: '#F0F2F5', color: '#65676B' }}
          >
            What&apos;s on your mind?
          </div>
        </button>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto pb-4">
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
          posts
            .filter((p) => !p.reply_to_post_id)
            .map((post) => {
              const badge = getAuthorBadge(post.author_type);
              return (
                <div
                  key={post.id}
                  className="mx-3 mt-3 rounded-lg overflow-hidden"
                  style={{ backgroundColor: '#FFFFFF', boxShadow: '0 1px 2px rgba(0,0,0,0.1)' }}
                >
                  {/* Post Header */}
                  <div className="flex items-center gap-3 px-4 pt-3 pb-2">
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[16px]"
                      style={{ backgroundColor: getAvatarColor(post.author_display_name) }}
                    >
                      {post.author_display_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-1">
                        <span className="font-semibold text-[15px]" style={{ color: '#050505' }}>
                          {post.author_display_name}
                        </span>
                        {badge && (
                          <span className="text-[12px]" style={{ color: '#1877F2' }}>
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
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="#65676B">
                          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8z" />
                        </svg>
                      </div>
                    </div>
                    <button onClick={() => handleFlag(post.id)} className="p-1">
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill={post.flagged_by_me ? '#F59E0B' : '#65676B'}
                      >
                        <circle cx="12" cy="6" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="12" cy="18" r="1.5" />
                      </svg>
                    </button>
                  </div>

                  {post.requires_response && !post.responded_at && (
                    <div className="px-4 pb-2">
                      <span
                        className="text-[12px] font-bold px-2 py-0.5 rounded"
                        style={{ backgroundColor: '#FFF3CD', color: '#856404' }}
                      >
                        REQUIRES RESPONSE
                      </span>
                    </div>
                  )}

                  {post.post_format && FORMAT_BADGE[post.post_format] && (
                    <div className="px-4 pb-1">
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

                  {/* Content */}
                  <div className="px-4 pb-3">
                    <p className="text-[15px] leading-relaxed" style={{ color: '#050505' }}>
                      {post.content}
                    </p>
                  </div>

                  {/* Media */}
                  {Array.isArray(post.media_urls) && post.media_urls.length > 0 && (
                    <div className="relative">
                      <img
                        src={post.media_urls[0]}
                        alt=""
                        className="w-full max-h-[350px] object-cover"
                      />
                      {post.post_format === 'video_concept' && (
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

                  {/* Content Flags */}
                  {!!(
                    post.content_flags?.is_hate_speech || post.content_flags?.is_misinformation
                  ) && (
                    <div className="px-4 pb-2 flex gap-1.5">
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

                  {/* Engagement Stats */}
                  <div
                    className="flex items-center justify-between px-4 py-2 text-[13px]"
                    style={{ color: '#65676B', borderTop: '1px solid #DADDE1' }}
                  >
                    <span>👍 {formatCount(post.like_count)}</span>
                    <div className="flex gap-3">
                      <span>{formatCount(post.reply_count)} comments</span>
                      <span>{formatCount(post.repost_count)} shares</span>
                    </div>
                  </div>

                  {/* Action Bar */}
                  <div
                    className="flex items-center justify-around px-2 py-1"
                    style={{ borderTop: '1px solid #DADDE1' }}
                  >
                    <div className="relative">
                      <button
                        onClick={() => handleLike(post.id)}
                        onMouseEnter={() => setShowReactions(post.id)}
                        onMouseLeave={() => setTimeout(() => setShowReactions(null), 500)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-md transition-colors hover:bg-gray-100"
                        style={{ color: post.liked_by_me ? '#1877F2' : '#65676B' }}
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                        </svg>
                        <span className="text-[14px] font-semibold">Like</span>
                      </button>
                      {showReactions === post.id && (
                        <div
                          className="absolute bottom-full left-0 mb-1 flex gap-1 p-1.5 rounded-full"
                          style={{
                            backgroundColor: '#FFFFFF',
                            boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
                          }}
                          onMouseEnter={() => setShowReactions(post.id)}
                          onMouseLeave={() => setShowReactions(null)}
                        >
                          {REACTIONS.map((r) => (
                            <button
                              key={r.type}
                              onClick={() => handleLike(post.id)}
                              className="text-[24px] hover:scale-125 transition-transform p-0.5"
                              title={r.label}
                            >
                              {r.emoji}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      className="flex items-center gap-1.5 px-4 py-2 rounded-md transition-colors hover:bg-gray-100"
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
                        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                      </svg>
                      <span className="text-[14px] font-semibold">Comment</span>
                    </button>
                    <button
                      onClick={() => handleShare(post.id)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-md transition-colors hover:bg-gray-100"
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
                        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" />
                      </svg>
                      <span className="text-[14px] font-semibold">Share</span>
                    </button>
                  </div>
                </div>
              );
            })
        )}
      </div>

      {/* Compose Modal */}
      {composing && (
        <div className="absolute inset-0 flex flex-col" style={{ zIndex: 60 }}>
          <div
            className="flex-1"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)' }}
            onClick={() => setComposing(false)}
          />
          <div
            className="flex flex-col"
            style={{
              backgroundColor: '#FFFFFF',
              borderRadius: '12px 12px 0 0',
              maxHeight: '75%',
              minHeight: 300,
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: '1px solid #DADDE1' }}
            >
              <button
                onClick={() => setComposing(false)}
                className="text-[15px]"
                style={{ color: '#65676B' }}
              >
                Cancel
              </button>
              <span className="font-bold text-[16px]" style={{ color: '#050505' }}>
                Create Post
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

            <div className="px-4 pt-3 pb-1 flex gap-1.5 flex-wrap">
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

            <div className="flex-1 px-4 pb-2 overflow-y-auto">
              <div className="flex gap-3 pt-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
                  style={{ backgroundColor: '#1877F2' }}
                >
                  Y
                </div>
                <textarea
                  value={composeText}
                  onChange={(e) => setComposeText(e.target.value)}
                  placeholder="What's on your mind?"
                  className="flex-1 bg-transparent text-[16px] resize-none outline-none min-h-[120px]"
                  style={{ color: '#050505', lineHeight: '1.5' }}
                  maxLength={500}
                  autoFocus
                />
              </div>
            </div>

            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderTop: '1px solid #DADDE1' }}
            >
              <div className="flex items-center gap-4" style={{ color: '#65676B' }}>
                <span className="text-[13px]">Add to your post</span>
              </div>
              <span className="text-[13px]" style={{ color: '#65676B' }}>
                {composeText.length}/500
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
