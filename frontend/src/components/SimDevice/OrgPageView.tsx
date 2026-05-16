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

interface OrgPage {
  id: string;
  page_name: string;
  page_handle: string;
  page_bio: string;
  follower_count: number;
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

export default function OrgPageView({
  platform = 'facebook',
  onBack,
}: {
  platform?: 'facebook' | 'x_twitter';
  onBack?: () => void;
}) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [pageInfo, setPageInfo] = useState<OrgPage | null>(null);
  const [posts, setPosts] = useState<PagePost[]>([]);
  const [loading, setLoading] = useState(true);
  const [composeText, setComposeText] = useState('');

  const loadPage = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const [pageRes, postsRes] = await Promise.all([
        fetch(apiUrl(`/api/social/org-page/session/${sessionId}`), { headers }),
        fetch(
          apiUrl(
            `/api/social/posts/session/${sessionId}?platform=${platform}&limit=100&sort=chronological`,
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
      const officialPosts = (
        (postsJson.data || []) as (PagePost & { author_type?: string })[]
      ).filter((p) => p.author_type === 'official_account') as PagePost[];
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

  return (
    <div
      className="h-full overflow-y-auto"
      style={{ backgroundColor: isFacebook ? '#F0F2F5' : '#000' }}
    >
      {/* Page Header */}
      <div className="relative" style={{ backgroundColor: isFacebook ? '#FFFFFF' : '#16181C' }}>
        {/* Cover area */}
        <div
          className="h-32"
          style={{
            background: isFacebook
              ? 'linear-gradient(135deg, #1877F2 0%, #42A5F5 100%)'
              : 'linear-gradient(135deg, #1D9BF0 0%, #0D47A1 100%)',
          }}
        />

        {/* Page info */}
        <div className="px-4 pb-4">
          <div className="flex items-end gap-3 -mt-8">
            <div
              className="w-20 h-20 rounded-lg flex items-center justify-center text-white font-bold text-2xl border-4"
              style={{
                backgroundColor: isFacebook ? '#1877F2' : '#1D9BF0',
                borderColor: isFacebook ? '#FFFFFF' : '#16181C',
              }}
            >
              {pageInfo.page_name.charAt(0)}
            </div>
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
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
                    style={{ backgroundColor: isFacebook ? '#1877F2' : '#1D9BF0' }}
                  >
                    {pageInfo.page_name.charAt(0)}
                  </div>
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
                <span>{formatCount(post.reply_count)} comments</span>
                <span>{formatCount(post.view_count)} views</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
