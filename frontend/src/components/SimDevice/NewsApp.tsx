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
        <div
          className="flex items-center gap-3 px-4 ios-blur-nav"
          style={{
            height: 44,
            backgroundColor: 'rgba(255,255,255,0.85)',
            borderBottom: '0.5px solid #C6C6C8',
          }}
        >
          <button
            onClick={() => setSelectedArticle(null)}
            className="flex items-center gap-1 ios-btn-bounce"
            style={{ color: '#FF3B30' }}
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
              <path
                d="M9 1L2 8l7 7"
                stroke="#FF3B30"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Back</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* Hero area */}
          <div className="px-4 pt-5 pb-4" style={{ borderBottom: '0.5px solid #E5E5EA' }}>
            <div className="flex items-center gap-2 mb-3">
              {(() => {
                const style = getCategoryStyle(selectedArticle.category);
                return (
                  <span
                    className="news-breaking-badge"
                    style={{ backgroundColor: style.bg, color: style.text }}
                  >
                    {selectedArticle.category.toUpperCase()}
                  </span>
                );
              })()}
              {!selectedArticle.is_factual && (
                <span
                  className="text-[11px] font-bold px-2 py-0.5 rounded-sm"
                  style={{ backgroundColor: '#FFF3CD', color: '#856404' }}
                >
                  UNVERIFIED
                </span>
              )}
            </div>
            <h1
              className="text-[24px] font-bold leading-tight"
              style={{ color: '#000000', letterSpacing: '-0.3px' }}
            >
              {selectedArticle.headline}
            </h1>
            {selectedArticle.subheadline && (
              <p className="text-[17px] mt-2 leading-snug" style={{ color: '#6C6C70' }}>
                {selectedArticle.subheadline}
              </p>
            )}
            <div className="flex items-center gap-2 mt-4">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
                style={{ backgroundColor: '#FF3B30' }}
              >
                {selectedArticle.outlet_name.charAt(0)}
              </div>
              <span className="text-[13px] font-semibold" style={{ color: '#000000' }}>
                {selectedArticle.outlet_name}
              </span>
              <span className="text-[13px]" style={{ color: '#8E8E93' }}>
                · {timeAgo(selectedArticle.published_at)}
              </span>
            </div>
          </div>

          {/* Body */}
          <div className="px-4 py-4">
            <p
              className="ios-body whitespace-pre-wrap"
              style={{ color: '#1C1C1E', lineHeight: 1.5 }}
            >
              {selectedArticle.body}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Article List
  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#F2F2F7' }}>
      {/* Nav */}
      <div
        className="ios-blur-nav"
        style={{ backgroundColor: 'rgba(242,242,247,0.85)', borderBottom: '0.5px solid #C6C6C8' }}
      >
        <div className="flex items-center justify-between px-4" style={{ height: 44 }}>
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/home`)}
            className="flex items-center gap-1 ios-btn-bounce"
            style={{ color: '#FF3B30' }}
          >
            <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
              <path
                d="M9 1L2 8l7 7"
                stroke="#FF3B30"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[17px]">Home</span>
          </button>
          <div style={{ width: 44 }} />
        </div>
        <div className="px-4 pb-2">
          <h1 className="ios-large-title" style={{ color: '#000000' }}>
            News
          </h1>
        </div>
      </div>

      {/* Articles */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-3">
        {articles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-1">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C7C7CC"
              strokeWidth="1"
            >
              <path d="M19 4H5a2 2 0 0 0-2 2v14l3.5-2 3.5 2 3.5-2 3.5 2V6a2 2 0 0 0-2-2z" />
            </svg>
            <p className="text-[15px]" style={{ color: '#8E8E93' }}>
              No news yet
            </p>
          </div>
        ) : (
          articles.map((article) => {
            const catStyle = getCategoryStyle(article.category);
            return (
              <button
                key={article.id}
                onClick={() => setSelectedArticle(article)}
                className="w-full text-left rounded-xl overflow-hidden ios-btn-bounce shadow-sm"
                style={{ backgroundColor: '#FFFFFF' }}
              >
                {/* Top accent strip for breaking */}
                {article.category === 'breaking' && (
                  <div style={{ height: 3, backgroundColor: '#FF3B30' }} />
                )}
                <div className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="news-breaking-badge"
                      style={{ backgroundColor: catStyle.bg, color: catStyle.text }}
                    >
                      {article.category.toUpperCase()}
                    </span>
                    <span className="text-[12px] font-medium" style={{ color: '#8E8E93' }}>
                      {article.outlet_name}
                    </span>
                    <span className="text-[12px]" style={{ color: '#AEAEB2' }}>
                      · {timeAgo(article.published_at)}
                    </span>
                    {!article.is_factual && (
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded-sm ml-auto"
                        style={{ backgroundColor: '#FFF3CD', color: '#856404' }}
                      >
                        UNVERIFIED
                      </span>
                    )}
                  </div>
                  <h3
                    className="text-[17px] font-bold leading-snug"
                    style={{ color: '#000000', letterSpacing: '-0.2px' }}
                  >
                    {article.headline}
                  </h3>
                  <p className="text-[13px] mt-1.5 line-clamp-2" style={{ color: '#6C6C70' }}>
                    {article.body.substring(0, 140)}...
                  </p>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
