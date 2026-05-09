import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import SocialFeedApp from './SocialFeedApp';

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

interface TrendingHashtag {
  tag: string;
  count: number;
}

interface TrendingTopic {
  label: string;
  count: number;
  trend: string;
  post_id?: string;
}

interface SuggestedNPC {
  handle: string;
  display_name: string;
  type: string;
  follower_count: number;
  personality: string;
}

function formatFollowers(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function getAvatarColor(name: string): string {
  const colors = ['#1D9BF0', '#00BA7C', '#F91880', '#7856FF', '#FF7A00', '#FFD400'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

const NAV_ITEMS = [
  {
    id: 'home',
    label: 'Home',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 1.696L.622 8.807l1.06 1.696L3 9.679V19.5A2.5 2.5 0 005.5 22h13a2.5 2.5 0 002.5-2.5V9.679l1.318.824 1.06-1.696L12 1.696zM12 16.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z" />
      </svg>
    ),
  },
  {
    id: 'explore',
    label: 'Explore',
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
      </svg>
    ),
  },
  {
    id: 'profile',
    label: 'Profile',
    icon: (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
];

export default function ZDesktopLayout() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [hashtags, setHashtags] = useState<TrendingHashtag[]>([]);
  const [topics, setTopics] = useState<TrendingTopic[]>([]);
  const [suggested, setSuggested] = useState<SuggestedNPC[]>([]);
  const [totalPosts, setTotalPosts] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeNav, setActiveNav] = useState('home');
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [feedFilter, setFeedFilter] = useState('');
  const [playerName, setPlayerName] = useState('Participant');
  const [playerHandle, setPlayerHandle] = useState('@player');
  const [openPostId, setOpenPostId] = useState<string | undefined>();
  const [composeCounter, setComposeCounter] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1100);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(containerRef.current);
    setContainerWidth(containerRef.current.offsetWidth);
    return () => observer.disconnect();
  }, []);

  const collapsed = containerWidth < 700;
  const showRight = containerWidth > 850;

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const u = session.user;
        const name = (u.user_metadata?.full_name as string) || u.email || 'Participant';
        const handle = `@${(name || u.email || u.id.slice(0, 8)).replace(/[@.\s+]/g, '_').toLowerCase()}`;
        setPlayerName(name);
        setPlayerHandle(handle);
      }
    });
  }, []);

  const loadTrending = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/trending/session/${sessionId}`), { headers });
      const json = await res.json();
      if (json.data) {
        setHashtags(json.data.hashtags || []);
        setTopics((json.data.topics || []).filter((t: TrendingTopic) => t.post_id));
        setTotalPosts(json.data.total_posts || 0);
      }
    } catch {
      /* retry */
    }
  }, [sessionId]);

  const loadSuggested = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/suggested/session/${sessionId}`), { headers });
      const json = await res.json();
      if (Array.isArray(json.data)) setSuggested(json.data);
    } catch {
      /* retry */
    }
  }, [sessionId]);

  useEffect(() => {
    loadTrending();
    loadSuggested();
    const id = setInterval(loadTrending, 15000);
    return () => clearInterval(id);
  }, [loadTrending, loadSuggested]);

  function toggleFollow(handle: string) {
    setFollowed((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full flex"
      style={{ backgroundColor: '#000', color: '#E7E9EA' }}
    >
      {/* ========== LEFT SIDEBAR ========== */}
      <div
        className="flex flex-col h-full flex-shrink-0 py-3 overflow-y-auto"
        style={{
          width: collapsed ? 60 : 200,
          borderRight: '1px solid #2F3336',
          paddingLeft: collapsed ? 6 : 8,
          paddingRight: collapsed ? 6 : 8,
          transition: 'width 0.2s',
        }}
      >
        {/* Z Logo */}
        <div className={collapsed ? 'flex justify-center mb-6' : 'px-3 mb-6'}>
          <span className="text-[24px] font-bold" style={{ color: '#E7E9EA' }}>
            Z
          </span>
        </div>

        {/* Nav Items */}
        <nav className="flex-1 space-y-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={`flex items-center gap-4 w-full py-3 rounded-full hover:bg-white/10 transition-colors outline-none focus:outline-none ${collapsed ? 'justify-center px-0' : 'px-3'}`}
              style={{ color: '#E7E9EA' }}
              title={collapsed ? item.label : undefined}
            >
              <span style={{ opacity: activeNav === item.id ? 1 : 0.7 }}>{item.icon}</span>
              {!collapsed && (
                <span
                  className="text-[15px]"
                  style={{ fontWeight: activeNav === item.id ? 700 : 400 }}
                >
                  {item.label}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Post Button */}
        <button
          onClick={() => setComposeCounter((c) => c + 1)}
          className={`py-3 rounded-full font-bold mt-4 hover:opacity-90 transition-opacity outline-none focus:outline-none ${collapsed ? 'w-10 h-10 flex items-center justify-center mx-auto text-[18px]' : 'w-full text-[16px]'}`}
          style={{ backgroundColor: '#1D9BF0', color: '#fff' }}
        >
          {collapsed ? '+' : 'Post'}
        </button>

        {/* User Info */}
        <div
          className={`flex items-center mt-4 py-2 rounded-full hover:bg-white/10 transition-colors cursor-pointer ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'}`}
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
            style={{ backgroundColor: '#1D9BF0' }}
          >
            {playerName.charAt(0).toUpperCase()}
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-bold truncate">{playerName}</div>
              <div className="text-[13px] truncate" style={{ color: '#71767B' }}>
                {playerHandle}
              </div>
            </div>
          )}
        </div>

        {/* Back to Phone / Desktop */}
        {!collapsed && (
          <div className="mt-3 space-y-1">
            <button
              onClick={() => navigate(`/sim/${sessionId}/device/home`)}
              className="w-full text-left px-3 py-2 rounded-lg text-[13px] hover:bg-white/10 transition-colors outline-none focus:outline-none"
              style={{ color: '#71767B' }}
            >
              Phone Mode
            </button>
            <button
              onClick={() => navigate(`/sim/${sessionId}/desktop`)}
              className="w-full text-left px-3 py-2 rounded-lg text-[13px] hover:bg-white/10 transition-colors outline-none focus:outline-none"
              style={{ color: '#71767B' }}
            >
              Desktop Mode
            </button>
          </div>
        )}
      </div>

      {/* ========== CENTER FEED ========== */}
      <div
        className="flex-1 h-full overflow-hidden"
        style={{ borderRight: showRight ? '1px solid #2F3336' : 'none' }}
      >
        <SocialFeedApp
          externalFilter={feedFilter}
          openPostId={openPostId}
          triggerCompose={composeCounter}
        />
      </div>

      {/* ========== RIGHT SIDEBAR ========== */}
      {showRight && (
        <div
          className="h-full overflow-y-auto px-4 py-3 flex-shrink-0"
          style={{ width: Math.min(320, Math.max(220, containerWidth - 700)), minWidth: 220 }}
        >
          {/* Search */}
          <div className="mb-5">
            <div
              className="flex items-center gap-3 rounded-full px-4 py-2.5"
              style={{ backgroundColor: '#16181C', border: '1px solid #2F3336' }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#71767B"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setFeedFilter(e.target.value);
                }}
                placeholder="Search"
                className="flex-1 bg-transparent outline-none text-[14px]"
                style={{ color: '#E7E9EA' }}
              />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    setFeedFilter('');
                  }}
                  className="text-[14px]"
                  style={{ color: '#71767B' }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* What's happening */}
          <div className="rounded-2xl mb-4 overflow-hidden" style={{ backgroundColor: '#16181C' }}>
            <h2 className="text-[20px] font-extrabold px-4 pt-3 pb-2">What's happening</h2>

            {/* Topics */}
            {topics.map((topic, i) => (
              <button
                key={i}
                onClick={() => {
                  if (topic.post_id) {
                    setOpenPostId(topic.post_id);
                  }
                }}
                className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors cursor-pointer"
              >
                <div className="text-[13px]" style={{ color: '#71767B' }}>
                  Trending in Crisis
                </div>
                <div className="text-[15px] font-bold mt-0.5 leading-snug">{topic.label}</div>
                <div className="text-[13px] mt-0.5" style={{ color: '#71767B' }}>
                  {topic.count > 0 ? `${formatFollowers(topic.count)} views` : ''}
                </div>
              </button>
            ))}

            {/* Hashtags */}
            {hashtags.length > 0 && (
              <>
                {hashtags.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => setFeedFilter(h.tag)}
                    className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors cursor-pointer"
                  >
                    <div className="text-[13px]" style={{ color: '#71767B' }}>
                      Trending
                    </div>
                    <div className="text-[15px] font-bold">{h.tag}</div>
                    <div className="text-[13px]" style={{ color: '#71767B' }}>
                      {h.count} posts
                    </div>
                  </button>
                ))}
              </>
            )}

            {topics.length === 0 && hashtags.length === 0 && (
              <div className="px-4 py-6 text-center">
                <p className="text-[14px]" style={{ color: '#71767B' }}>
                  Trends will appear as the simulation progresses
                </p>
              </div>
            )}

            {(topics.length > 0 || hashtags.length > 0) && (
              <div className="px-4 py-3 hover:bg-white/[0.03] transition-colors cursor-pointer">
                <span className="text-[15px]" style={{ color: '#1D9BF0' }}>
                  Show more
                </span>
              </div>
            )}
          </div>

          {/* Who to follow */}
          <div className="rounded-2xl mb-4 overflow-hidden" style={{ backgroundColor: '#16181C' }}>
            <h2 className="text-[20px] font-extrabold px-4 pt-3 pb-2">Who to follow</h2>

            {suggested.map((npc) => (
              <div
                key={npc.handle}
                className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors cursor-pointer"
              >
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[15px] flex-shrink-0"
                  style={{ backgroundColor: getAvatarColor(npc.display_name) }}
                >
                  {npc.display_name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] font-bold truncate">{npc.display_name}</div>
                  <div className="text-[13px] truncate" style={{ color: '#71767B' }}>
                    {npc.handle} · {formatFollowers(npc.follower_count)} followers
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFollow(npc.handle);
                  }}
                  className="px-4 py-1.5 rounded-full text-[13px] font-bold flex-shrink-0 outline-none focus:outline-none transition-colors"
                  style={{
                    backgroundColor: followed.has(npc.handle) ? 'transparent' : '#EFF3F4',
                    color: followed.has(npc.handle) ? '#EFF3F4' : '#0F1419',
                    border: followed.has(npc.handle) ? '1px solid #536471' : 'none',
                  }}
                >
                  {followed.has(npc.handle) ? 'Following' : 'Follow'}
                </button>
              </div>
            ))}

            {suggested.length === 0 && (
              <div className="px-4 py-6 text-center">
                <p className="text-[14px]" style={{ color: '#71767B' }}>
                  Suggested accounts will appear when the scenario loads
                </p>
              </div>
            )}

            {suggested.length > 0 && (
              <div className="px-4 py-3 hover:bg-white/[0.03] transition-colors cursor-pointer">
                <span className="text-[15px]" style={{ color: '#1D9BF0' }}>
                  Show more
                </span>
              </div>
            )}
          </div>

          {/* Stats */}
          <div className="px-4 py-3 text-[13px]" style={{ color: '#71767B' }}>
            <span>{totalPosts} posts in this simulation</span>
          </div>
        </div>
      )}
    </div>
  );
}
