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

  function getCategoryColor(category: string): string {
    switch (category) {
      case 'breaking':
        return 'bg-red-600';
      case 'update':
        return 'bg-orange-600';
      default:
        return 'bg-gray-600';
    }
  }

  if (selectedArticle) {
    return (
      <div className="h-full flex flex-col bg-white text-gray-900">
        <div className="flex items-center gap-3 px-4 py-3 border-b bg-gray-50">
          <button onClick={() => setSelectedArticle(null)} className="text-blue-600 text-sm">
            ← Back
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <span
            className={`text-[10px] text-white px-2 py-0.5 rounded ${getCategoryColor(selectedArticle.category)}`}
          >
            {selectedArticle.category.toUpperCase()}
          </span>
          <h1 className="text-xl font-bold mt-2 leading-tight">{selectedArticle.headline}</h1>
          {selectedArticle.subheadline && (
            <p className="text-sm text-gray-500 mt-1">{selectedArticle.subheadline}</p>
          )}
          <div className="flex items-center gap-2 mt-3 text-xs text-gray-500">
            <span className="font-medium text-gray-700">{selectedArticle.outlet_name}</span>
            <span>·</span>
            <span>{timeAgo(selectedArticle.published_at)}</span>
          </div>
          <hr className="my-4" />
          <div className="text-sm leading-relaxed whitespace-pre-wrap">{selectedArticle.body}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white text-gray-900">
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="text-blue-600 text-sm"
        >
          ← Home
        </button>
        <span className="font-bold text-lg">News</span>
        <div />
      </div>
      <div className="flex-1 overflow-y-auto">
        {articles.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            No news yet
          </div>
        ) : (
          articles.map((article) => (
            <button
              key={article.id}
              onClick={() => setSelectedArticle(article)}
              className="w-full text-left px-4 py-4 border-b hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-[10px] text-white px-1.5 py-0.5 rounded ${getCategoryColor(article.category)}`}
                >
                  {article.category.toUpperCase()}
                </span>
                <span className="text-xs text-gray-500">{article.outlet_name}</span>
                <span className="text-xs text-gray-400">· {timeAgo(article.published_at)}</span>
              </div>
              <h3 className="font-bold text-sm leading-snug">{article.headline}</h3>
              <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                {article.body.substring(0, 120)}...
              </p>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
