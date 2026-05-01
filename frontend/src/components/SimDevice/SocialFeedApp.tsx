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

export default function SocialFeedApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [replyingTo, setReplyingTo] = useState<SocialPost | null>(null);

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

  function getSentimentColor(sentiment: string): string {
    switch (sentiment) {
      case 'hateful':
        return 'border-l-4 border-red-500 bg-red-950/30';
      case 'inflammatory':
        return 'border-l-4 border-orange-500 bg-orange-950/20';
      case 'negative':
        return 'border-l-4 border-yellow-500 bg-yellow-950/10';
      case 'supportive':
        return 'border-l-4 border-green-500 bg-green-950/10';
      case 'positive':
        return 'border-l-4 border-blue-500 bg-blue-950/10';
      default:
        return '';
    }
  }

  function getAuthorBadge(type: string): string | null {
    switch (type) {
      case 'npc_media':
        return '✓ Verified';
      case 'npc_politician':
        return '🏛️ Official';
      case 'npc_influencer':
        return '⭐ Influencer';
      case 'player':
        return '👤 You';
      case 'official_account':
        return '🛡️ Official';
      default:
        return null;
    }
  }

  return (
    <div className="h-full flex flex-col bg-black text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="text-blue-400 text-sm"
        >
          ← Home
        </button>
        <span className="font-bold text-lg">𝕏 Feed</span>
        <button
          onClick={() => setComposing(true)}
          className="bg-blue-500 text-white px-3 py-1 rounded-full text-sm font-medium"
        >
          Post
        </button>
      </div>

      {/* Compose Modal */}
      {composing && (
        <div className="absolute inset-0 bg-black/90 z-50 flex flex-col p-4">
          <div className="flex justify-between items-center mb-4">
            <button
              onClick={() => {
                setComposing(false);
                setReplyingTo(null);
              }}
              className="text-blue-400"
            >
              Cancel
            </button>
            <button
              onClick={handlePost}
              disabled={!composeText.trim()}
              className="bg-blue-500 text-white px-4 py-1.5 rounded-full text-sm font-bold disabled:opacity-50"
            >
              Post
            </button>
          </div>
          {replyingTo && (
            <div className="text-gray-500 text-sm mb-2 px-2">
              Replying to <span className="text-blue-400">{replyingTo.author_handle}</span>
            </div>
          )}
          <textarea
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            placeholder={replyingTo ? 'Post your reply...' : "What's happening?"}
            className="flex-1 bg-transparent text-white text-lg p-2 resize-none outline-none"
            maxLength={500}
            autoFocus
          />
          <div className="text-right text-gray-500 text-sm">{composeText.length}/500</div>
        </div>
      )}

      {/* Feed */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-500">Loading feed...</div>
        ) : posts.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-500">No posts yet</div>
        ) : (
          posts
            .filter((p) => !p.reply_to_post_id)
            .map((post) => (
              <div
                key={post.id}
                className={`px-4 py-3 border-b border-gray-800 ${getSentimentColor(post.sentiment)}`}
              >
                {/* Requires Response Badge */}
                {post.requires_response && !post.responded_at && (
                  <div className="flex items-center gap-1 text-amber-400 text-xs font-medium mb-2">
                    <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
                    REQUIRES RESPONSE
                  </div>
                )}

                {/* Author */}
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center text-lg flex-shrink-0">
                    {post.author_display_name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="font-bold text-sm truncate">{post.author_display_name}</span>
                      {getAuthorBadge(post.author_type) && (
                        <span className="text-[10px] text-blue-400">
                          {getAuthorBadge(post.author_type)}
                        </span>
                      )}
                      <span className="text-gray-500 text-sm">{post.author_handle}</span>
                      <span className="text-gray-600 text-sm">· {timeAgo(post.created_at)}</span>
                    </div>

                    {/* Content */}
                    <p className="text-sm mt-1 whitespace-pre-wrap break-words">
                      {String(post.content)
                        .split(/(#\w+)/g)
                        .map((part: string, i: number) => {
                          if (part.startsWith('#')) {
                            return (
                              <span key={i} className="text-blue-400">
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
                      <div className="flex gap-1 mt-2">
                        {!!post.content_flags.is_hate_speech && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-red-900 text-red-300 rounded">
                            Hate Speech
                          </span>
                        )}
                        {!!post.content_flags.is_misinformation && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-orange-900 text-orange-300 rounded">
                            Misinformation
                          </span>
                        )}
                        {!!post.content_flags.is_racist && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-red-900 text-red-300 rounded">
                            Racist
                          </span>
                        )}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-6 mt-3 text-gray-500">
                      <button
                        onClick={() => {
                          setReplyingTo(post);
                          setComposing(true);
                        }}
                        className="flex items-center gap-1 text-xs hover:text-blue-400 transition-colors"
                      >
                        💬 {post.reply_count}
                      </button>
                      <button className="flex items-center gap-1 text-xs hover:text-green-400 transition-colors">
                        🔁 {post.repost_count}
                      </button>
                      <button
                        onClick={() => handleLike(post.id)}
                        className="flex items-center gap-1 text-xs hover:text-red-400 transition-colors"
                      >
                        ❤️ {post.like_count}
                      </button>
                      <button
                        onClick={() => handleFlag(post.id)}
                        className={`flex items-center gap-1 text-xs transition-colors ${post.is_flagged_by_player ? 'text-amber-400' : 'hover:text-amber-400'}`}
                      >
                        {post.is_flagged_by_player ? '🚩' : '⚑'}
                      </button>
                      <span className="text-xs">{post.view_count.toLocaleString()} views</span>
                    </div>
                  </div>
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
