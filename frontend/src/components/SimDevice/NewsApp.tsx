import { useState, useEffect } from 'react';
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

interface NewsArticle {
  id: string;
  outlet_name: string;
  headline: string;
  subheadline: string | null;
  body: string;
  category: string;
  is_factual: boolean;
  published_at: string;
}

function getOutletColor(name: string): string {
  const colors = [
    '#FF3B30',
    '#007AFF',
    '#FF9500',
    '#5856D6',
    '#34C759',
    '#FF2D55',
    '#AF52DE',
    '#5AC8FA',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function NewsApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<NewsArticle | null>(null);

  useEffect(() => {
    loadArticles();
  }, [sessionId]);

  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: ['news_article.published'],
    onEvent: (event) => {
      if (event.type === 'news_article.published') {
        const article = (event.data as { article: NewsArticle }).article;
        setArticles((prev) => [article, ...prev]);
      }
    },
  });

  async function loadArticles() {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/news/session/${sessionId}`), { headers });
      const result = await res.json();
      if (result.data) setArticles(result.data);
    } catch {
      /* ignore */
    }
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  }

  function getCategoryStyle(category: string): { bg: string; text: string } {
    switch (category) {
      case 'breaking':
        return { bg: '#FF3B30', text: '#FFFFFF' };
      case 'update':
        return { bg: '#FF9500', text: '#FFFFFF' };
      case 'opinion':
        return { bg: '#5856D6', text: '#FFFFFF' };
      default:
        return { bg: '#E5E5EA', text: '#8E8E93' };
    }
  }

  // Article Detail
  if (selectedArticle) {
    return (
      <div className="h-full flex flex-col" style={{ backgroundColor: '#FFFFFF' }}>
        {/* Nav */}
        <div
          className="flex items-center justify-between px-4 ios-blur-nav flex-shrink-0"
          style={{
            height: 44,
            backgroundColor: 'rgba(255,255,255,0.92)',
            borderBottom: '0.5px solid rgba(60,60,67,0.18)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <button
            onClick={() => setSelectedArticle(null)}
            className="flex items-center gap-0.5 ios-btn-bounce"
            style={{ color: '#FF2D55' }}
          >
            <svg width="12" height="20" viewBox="0 0 12 20" fill="none">
              <path
                d="M10 2L2 10l8 8"
                stroke="#FF2D55"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">News</span>
          </button>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#8E8E93"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="18" cy="5" r="3" />
            <path d="M18 8v13" />
            <path d="M6 12V5" />
            <circle cx="6" cy="15" r="3" />
          </svg>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Headline area */}
          <div className="px-5 pt-6 pb-4">
            <h1
              className="text-[26px] font-extrabold leading-tight"
              style={{ color: '#1C1C1E', letterSpacing: '-0.4px' }}
            >
              {selectedArticle.headline}
            </h1>
            {selectedArticle.subheadline && (
              <p className="text-[18px] mt-2 leading-snug" style={{ color: '#6C6C70' }}>
                {selectedArticle.subheadline}
              </p>
            )}
          </div>

          {/* Separator */}
          <div
            className="mx-5 mb-4"
            style={{ height: 1, backgroundColor: 'rgba(60,60,67,0.12)' }}
          />

          {/* Publisher attribution */}
          <div className="flex items-center gap-2.5 px-5 mb-5">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold"
              style={{ backgroundColor: getOutletColor(selectedArticle.outlet_name) }}
            >
              {selectedArticle.outlet_name.charAt(0)}
            </div>
            <div>
              <span className="text-[13px] font-semibold" style={{ color: '#1C1C1E' }}>
                {selectedArticle.outlet_name}
              </span>
              <span className="text-[13px] ml-2" style={{ color: '#8E8E93' }}>
                {timeAgo(selectedArticle.published_at)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 ml-auto">
              {(() => {
                const style = getCategoryStyle(selectedArticle.category);
                return (
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide"
                    style={{ backgroundColor: style.bg, color: style.text }}
                  >
                    {selectedArticle.category}
                  </span>
                );
              })()}
              {!selectedArticle.is_factual && (
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: '#FFF3CD', color: '#856404' }}
                >
                  UNVERIFIED
                </span>
              )}
            </div>
          </div>

          {/* Body */}
          <div className="px-5 pb-8">
            <p
              className="whitespace-pre-wrap"
              style={{
                color: '#1C1C1E',
                fontSize: '17px',
                lineHeight: '1.65',
                letterSpacing: '0.01em',
              }}
            >
              {selectedArticle.body}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Article List - Apple News style
  const heroArticle = articles[0];
  const restArticles = articles.slice(1);

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#F2F2F7' }}>
      {/* Nav */}
      <div
        className="ios-blur-nav flex-shrink-0"
        style={{
          backgroundColor: 'rgba(242,242,247,0.92)',
          borderBottom: '0.5px solid rgba(60,60,67,0.18)',
          backdropFilter: 'blur(20px)',
        }}
      >
        <div className="flex items-center justify-between px-4" style={{ height: 44 }}>
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/home`)}
            className="flex items-center gap-0.5 ios-btn-bounce"
            style={{ color: '#FF2D55' }}
          >
            <svg width="12" height="20" viewBox="0 0 12 20" fill="none">
              <path
                d="M10 2L2 10l8 8"
                stroke="#FF2D55"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Home</span>
          </button>
          <div style={{ width: 44 }} />
        </div>
        <div className="px-4 pb-1">
          <h1 className="text-[34px] font-bold tracking-tight" style={{ color: '#000000' }}>
            News
          </h1>
        </div>
      </div>

      {/* Articles */}
      <div className="flex-1 overflow-y-auto">
        {articles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2">
            <svg
              width="52"
              height="52"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C7C7CC"
              strokeWidth="0.8"
            >
              <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
              <line x1="6" y1="9" x2="18" y2="9" />
              <line x1="6" y1="13" x2="14" y2="13" />
              <line x1="6" y1="17" x2="10" y2="17" />
            </svg>
            <p className="text-[17px] font-semibold" style={{ color: '#3C3C43' }}>
              No News Yet
            </p>
            <p className="text-[14px]" style={{ color: '#8E8E93' }}>
              Articles will appear as the simulation progresses.
            </p>
          </div>
        ) : (
          <div className="pb-4">
            {/* Hero card for first article */}
            {heroArticle && (
              <button
                onClick={() => setSelectedArticle(heroArticle)}
                className="w-full text-left ios-btn-bounce"
              >
                <div
                  className="relative mx-4 mt-3 rounded-2xl overflow-hidden"
                  style={{
                    backgroundColor: '#1C1C1E',
                    minHeight: 220,
                  }}
                >
                  {/* Gradient overlay effect */}
                  <div
                    className="absolute inset-0"
                    style={{
                      background: `linear-gradient(135deg, ${getOutletColor(heroArticle.outlet_name)}33 0%, #1C1C1E 60%)`,
                    }}
                  />
                  <div
                    className="absolute inset-0"
                    style={{
                      background:
                        'linear-gradient(to bottom, transparent 30%, rgba(0,0,0,0.85) 100%)',
                    }}
                  />
                  {/* Content overlaid */}
                  <div
                    className="relative flex flex-col justify-between h-full p-4"
                    style={{ minHeight: 220 }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[11px] font-bold uppercase tracking-wide"
                        style={{ color: getOutletColor(heroArticle.outlet_name) }}
                      >
                        {heroArticle.outlet_name}
                      </span>
                      {heroArticle.category === 'breaking' && (
                        <span
                          className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                          style={{ backgroundColor: '#FF3B30', color: '#FFFFFF' }}
                        >
                          BREAKING
                        </span>
                      )}
                      {!heroArticle.is_factual && (
                        <span
                          className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                          style={{ backgroundColor: 'rgba(255,243,205,0.9)', color: '#856404' }}
                        >
                          UNVERIFIED
                        </span>
                      )}
                    </div>
                    <div>
                      <h2
                        className="text-[22px] font-extrabold leading-tight"
                        style={{ color: '#FFFFFF', letterSpacing: '-0.3px' }}
                      >
                        {heroArticle.headline}
                      </h2>
                      <p className="text-[13px] mt-2" style={{ color: 'rgba(255,255,255,0.6)' }}>
                        {timeAgo(heroArticle.published_at)}
                      </p>
                    </div>
                  </div>
                </div>
              </button>
            )}

            {/* Rest of articles */}
            {restArticles.length > 0 && (
              <div
                className="mx-4 mt-3 rounded-xl overflow-hidden"
                style={{ backgroundColor: '#FFFFFF' }}
              >
                {restArticles.map((article, idx) => {
                  const outletColor = getOutletColor(article.outlet_name);
                  return (
                    <button
                      key={article.id}
                      onClick={() => setSelectedArticle(article)}
                      className="w-full text-left px-4 py-3.5 ios-btn-bounce active:bg-gray-50"
                      style={{
                        borderBottom:
                          idx < restArticles.length - 1
                            ? '0.5px solid rgba(60,60,67,0.12)'
                            : 'none',
                      }}
                    >
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <div
                          className="w-[6px] h-[6px] rounded-full flex-shrink-0"
                          style={{ backgroundColor: outletColor }}
                        />
                        <span className="text-[12px] font-semibold" style={{ color: '#8E8E93' }}>
                          {article.outlet_name}
                        </span>
                        <span className="text-[12px]" style={{ color: '#AEAEB2' }}>
                          · {timeAgo(article.published_at)}
                        </span>
                        {article.category === 'breaking' && (
                          <span
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-auto"
                            style={{ backgroundColor: '#FF3B30', color: '#FFFFFF' }}
                          >
                            BREAKING
                          </span>
                        )}
                        {!article.is_factual && (
                          <span
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-auto"
                            style={{ backgroundColor: '#FFF3CD', color: '#856404' }}
                          >
                            UNVERIFIED
                          </span>
                        )}
                      </div>
                      <h3
                        className="text-[16px] font-bold leading-snug"
                        style={{ color: '#1C1C1E', letterSpacing: '-0.2px' }}
                      >
                        {article.headline}
                      </h3>
                      <p className="text-[13px] mt-1 line-clamp-2" style={{ color: '#8E8E93' }}>
                        {article.body.substring(0, 120)}...
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
