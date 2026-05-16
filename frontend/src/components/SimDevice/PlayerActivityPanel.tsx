import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';

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

interface ActivityPost {
  id: string;
  content: string;
  platform: string;
  author_type: string;
  author_handle: string;
  author_display_name: string;
  post_format?: string;
  created_at: string;
  like_count: number;
  reply_count: number;
  view_count: number;
  posted_by_display_name?: string;
}

interface ActivityAction {
  action_type: string;
  target_id: string;
  content: string | null;
  created_at: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const ACTION_LABELS: Record<string, string> = {
  post_liked: 'Liked a post',
  post_reposted: 'Reposted',
  reply_posted: 'Replied to a post',
  post_flagged: 'Flagged a post',
};

export default function PlayerActivityPanel({ onBack }: { onBack?: () => void }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [posts, setPosts] = useState<ActivityPost[]>([]);
  const [actions, setActions] = useState<ActivityAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'posts' | 'activity'>('posts');

  const loadActivity = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/my-activity/session/${sessionId}`), { headers });
      const json = await res.json();
      setPosts(json.posts || []);
      setActions(json.actions || []);
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    loadActivity();
  }, [loadActivity]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto" style={{ backgroundColor: '#000' }}>
      {/* Header */}
      <div
        className="sticky top-0 z-10 px-4 py-3 flex items-center gap-3"
        style={{ backgroundColor: '#000', borderBottom: '1px solid #2F3336' }}
      >
        {onBack && (
          <button onClick={onBack} className="text-lg" style={{ color: '#E7E9EA' }}>
            &#8592;
          </button>
        )}
        <span className="font-bold text-lg" style={{ color: '#E7E9EA' }}>
          My Activity
        </span>
      </div>

      {/* Tabs */}
      <div className="flex" style={{ borderBottom: '1px solid #2F3336' }}>
        {(['posts', 'activity'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 py-3 text-sm font-semibold text-center"
            style={{
              color: tab === t ? '#1D9BF0' : '#71767B',
              borderBottom: tab === t ? '2px solid #1D9BF0' : '2px solid transparent',
            }}
          >
            {t === 'posts' ? `My Posts (${posts.length})` : `Reactions (${actions.length})`}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="pb-20">
        {tab === 'posts' && (
          <div>
            {posts.length === 0 ? (
              <div className="text-center py-8 text-sm" style={{ color: '#71767B' }}>
                No posts yet
              </div>
            ) : (
              posts.map((post) => (
                <div
                  key={post.id}
                  className="px-4 py-3"
                  style={{ borderBottom: '1px solid #2F3336' }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[13px] font-semibold" style={{ color: '#E7E9EA' }}>
                      {post.author_display_name}
                    </span>
                    {post.author_type === 'official_account' && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                        style={{ backgroundColor: 'rgba(29,155,240,0.15)', color: '#1D9BF0' }}
                      >
                        Page
                      </span>
                    )}
                    <span className="text-[12px]" style={{ color: '#71767B' }}>
                      {post.platform === 'facebook' ? 'Facebook' : 'X'} &#183;{' '}
                      {timeAgo(post.created_at)}
                    </span>
                  </div>
                  <p className="text-[14px] leading-relaxed" style={{ color: '#E7E9EA' }}>
                    {post.content.length > 200 ? post.content.slice(0, 200) + '...' : post.content}
                  </p>
                  <div className="flex gap-4 mt-1.5 text-[12px]" style={{ color: '#71767B' }}>
                    <span>{post.like_count} likes</span>
                    <span>{post.reply_count} replies</span>
                    <span>{post.view_count} views</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'activity' && (
          <div>
            {actions.length === 0 ? (
              <div className="text-center py-8 text-sm" style={{ color: '#71767B' }}>
                No activity yet
              </div>
            ) : (
              actions.map((action, i) => (
                <div
                  key={`${action.target_id}-${i}`}
                  className="px-4 py-2.5 flex items-start gap-3"
                  style={{ borderBottom: '1px solid #2F3336' }}
                >
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0"
                    style={{
                      backgroundColor:
                        action.action_type === 'post_liked'
                          ? 'rgba(249,24,128,0.15)'
                          : action.action_type === 'post_flagged'
                            ? 'rgba(239,68,68,0.15)'
                            : 'rgba(29,155,240,0.15)',
                      color:
                        action.action_type === 'post_liked'
                          ? '#F91880'
                          : action.action_type === 'post_flagged'
                            ? '#ef4444'
                            : '#1D9BF0',
                    }}
                  >
                    {action.action_type === 'post_liked'
                      ? '&#9829;'
                      : action.action_type === 'post_flagged'
                        ? '&#9873;'
                        : action.action_type === 'post_reposted'
                          ? '&#8634;'
                          : '&#9998;'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold" style={{ color: '#E7E9EA' }}>
                      {ACTION_LABELS[action.action_type] || action.action_type}
                    </div>
                    {action.content && (
                      <p className="text-[12px] mt-0.5 truncate" style={{ color: '#71767B' }}>
                        {action.content}
                      </p>
                    )}
                    <span className="text-[11px]" style={{ color: '#71767B' }}>
                      {timeAgo(action.created_at)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
