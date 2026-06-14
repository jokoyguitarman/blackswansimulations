import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';
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
  status?: string;
  correction_note?: string | null;
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
  const [searchParams] = useSearchParams();
  const { isTrainer } = useRoleVisibility();
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<NewsArticle | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [shareModal, setShareModal] = useState<{
    article: NewsArticle;
    platform: 'x_twitter' | 'facebook';
  } | null>(null);
  const [stanceText, setStanceText] = useState('');
  const [selectedStance, setSelectedStance] = useState<
    'support' | 'neutral' | 'criticize' | 'fake_news'
  >('neutral');
  const [posting, setPosting] = useState(false);
  const [disputeModal, setDisputeModal] = useState<NewsArticle | null>(null);
  const [disputeNote, setDisputeNote] = useState('');
  const [disputing, setDisputing] = useState(false);

  useEffect(() => {
    loadArticles();
  }, [sessionId]);

  useEffect(() => {
    const articleIdParam = searchParams.get('article');
    if (articleIdParam && articles.length > 0) {
      const target = articles.find((a) => a.id === articleIdParam);
      if (target) openArticle(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, articles]);

  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: ['news_article.published', 'news_article.updated'],
    onEvent: (event) => {
      if (event.type === 'news_article.published') {
        const article = (event.data as { article: NewsArticle }).article;
        setArticles((prev) => [article, ...prev]);
      } else if (event.type === 'news_article.updated') {
        const updated = (event.data as { article: NewsArticle }).article;
        if (!updated) return;
        setArticles((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
        setSelectedArticle((prev) => (prev && prev.id === updated.id ? updated : prev));
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

  function openShareModal(article: NewsArticle, platform: 'x_twitter' | 'facebook') {
    setShareModal({ article, platform });
    setStanceText('');
    setSelectedStance('neutral');
  }

  async function submitShare() {
    if (!shareModal || !sessionId) return;
    setPosting(true);
    const { article, platform } = shareModal;
    try {
      const headers = await getAuthHeaders();
      const linkSuffix = `news.sim/${article.id.slice(0, 8)}`;
      const commentary = stanceText.trim();
      const content =
        platform === 'x_twitter'
          ? `${commentary || article.headline}\n\n${linkSuffix}`
          : `${commentary || `📰 ${article.headline}`}\n\n— ${article.outlet_name}`;

      await fetch(apiUrl('/api/social/posts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content,
          platform,
          shared_article_id: article.id,
          share_stance: selectedStance,
          content_flags: {
            shared_article: {
              id: article.id,
              headline: article.headline,
              outlet_name: article.outlet_name,
              snippet: article.body.substring(0, 150),
              category: article.category,
            },
          },
        }),
      });
      setShareModal(null);
      setShareStatus(`Shared to ${platform === 'x_twitter' ? 'Z' : 'Fakebook'}!`);
      setTimeout(() => setShareStatus(null), 3000);
    } catch {
      setShareStatus('Failed to share');
    } finally {
      setPosting(false);
    }
  }

  async function shareToChat(article: NewsArticle) {
    if (!sessionId) return;
    setShareStatus(null);
    try {
      const headers = await getAuthHeaders();
      const channelsRes = await fetch(apiUrl(`/api/channels?session_id=${sessionId}`), { headers });
      const channelsJson = await channelsRes.json();
      const channels = channelsJson.data || [];
      const generalChannel =
        channels.find((c: Record<string, string>) => c.type === 'public') || channels[0];
      if (!generalChannel) {
        setShareStatus('No chat channel found');
        return;
      }
      const messageContent = `📰 ${article.headline}\n— ${article.outlet_name}\n\n[article:${article.id}]`;
      await fetch(apiUrl(`/api/channels/${generalChannel.id}/messages`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: messageContent, message_type: 'text' }),
      });
      setShareStatus('Shared to TeamChat!');
      setTimeout(() => setShareStatus(null), 3000);
    } catch {
      setShareStatus('Failed to share');
    }
  }

  function openArticle(article: NewsArticle) {
    setSelectedArticle(article);
    getAuthHeaders().then((headers) =>
      fetch(apiUrl(`/api/social/news/${article.id}/read`), {
        method: 'POST',
        headers,
      }).catch(() => {}),
    );
  }

  function openDisputeModal(article: NewsArticle) {
    setDisputeModal(article);
    setDisputeNote('');
  }

  async function submitDispute() {
    if (!disputeModal || !sessionId) return;
    setDisputing(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl('/api/social/disputes'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          target_type: 'article',
          target_id: disputeModal.id,
          claimed_falsehood: disputeNote.trim(),
          submitted_facts: '',
        }),
      });
      if (res.ok) {
        setDisputeModal(null);
        setShareStatus('Dispute filed — under review');
      } else {
        const err = await res.json().catch(() => ({}));
        setShareStatus(err.error || 'Failed to file dispute');
      }
      setTimeout(() => setShareStatus(null), 4000);
    } catch {
      setShareStatus('Failed to file dispute');
      setTimeout(() => setShareStatus(null), 3000);
    } finally {
      setDisputing(false);
    }
  }

  function copyArticleLink(article: NewsArticle) {
    const slug = article.outlet_name.toLowerCase().replace(/\s+/g, '-');
    const url = `https://news.sim/${slug}/${article.id.slice(0, 8)}`;
    navigator.clipboard.writeText(url).then(() => {
      setShareStatus('Link copied!');
      setTimeout(() => setShareStatus(null), 3000);
    });
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
      <div className="h-full flex flex-col relative" style={{ backgroundColor: '#FFFFFF' }}>
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

          {/* Moderation banner */}
          {selectedArticle.status === 'retracted' && (
            <div
              className="mx-5 mb-4 p-3 rounded-lg"
              style={{ backgroundColor: '#FDECEA', border: '1px solid #F0556A' }}
            >
              <p className="text-[13px] font-bold" style={{ color: '#C62828' }}>
                This article has been retracted
              </p>
              {selectedArticle.correction_note && (
                <p className="text-[12px] mt-1" style={{ color: '#8E6B6B' }}>
                  {selectedArticle.correction_note}
                </p>
              )}
            </div>
          )}
          {selectedArticle.status === 'corrected' && (
            <div
              className="mx-5 mb-4 p-3 rounded-lg"
              style={{ backgroundColor: '#FFF8E1', border: '1px solid #F7B928' }}
            >
              <p className="text-[13px] font-bold" style={{ color: '#8A6D1F' }}>
                Correction appended
              </p>
              {selectedArticle.correction_note && (
                <p className="text-[12px] mt-1" style={{ color: '#8A7A4F' }}>
                  {selectedArticle.correction_note}
                </p>
              )}
            </div>
          )}

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
              {isTrainer && !selectedArticle.is_factual && (
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
          <div className="px-5 pb-4">
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

          {/* Share buttons */}
          <div className="mx-5 mb-8 pt-4" style={{ borderTop: '1px solid rgba(60,60,67,0.12)' }}>
            <p className="text-[13px] font-medium mb-3" style={{ color: '#8E8E93' }}>
              Share this article
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => openShareModal(selectedArticle, 'x_twitter')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[12px] font-semibold"
                style={{ backgroundColor: '#16181C', color: '#E7E9EA' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#E7E9EA">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                Post to Z
              </button>
              <button
                onClick={() => openShareModal(selectedArticle, 'facebook')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[12px] font-semibold text-white"
                style={{ backgroundColor: '#1877F2' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                </svg>
                Post to FB
              </button>
              <button
                onClick={() => shareToChat(selectedArticle)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[12px] font-semibold"
                style={{ backgroundColor: '#007AFF', color: '#FFFFFF' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                </svg>
                Chat
              </button>
              <button
                onClick={() => copyArticleLink(selectedArticle)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[12px] font-semibold"
                style={{ backgroundColor: '#E5E5EA', color: '#1C1C1E' }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#1C1C1E"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                Link
              </button>
            </div>
            {selectedArticle.status !== 'retracted' && (
              <button
                onClick={() => openDisputeModal(selectedArticle)}
                className="flex items-center gap-1.5 mt-3 px-3 py-2 rounded-full text-[12px] font-semibold"
                style={{ backgroundColor: '#FCE4EC', color: '#C62828' }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#C62828"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                  <line x1="4" y1="22" x2="4" y2="15" />
                </svg>
                Dispute / Request Correction
              </button>
            )}
            {shareStatus && (
              <p className="text-[12px] mt-2 font-medium" style={{ color: '#34C759' }}>
                {shareStatus}
              </p>
            )}
          </div>
        </div>

        {shareModal && (
          <div
            className="absolute inset-0 flex items-end justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 60 }}
            onClick={() => setShareModal(null)}
          >
            <div
              className="w-full rounded-t-2xl"
              style={{ backgroundColor: '#FFFFFF', maxHeight: '75%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 pt-4 pb-2">
                <h3 className="text-[17px] font-bold" style={{ color: '#1C1C1E' }}>
                  Share to {shareModal.platform === 'x_twitter' ? 'Z' : 'Fakebook'}
                </h3>
                <button
                  onClick={() => setShareModal(null)}
                  className="text-[15px] font-medium"
                  style={{ color: '#8E8E93' }}
                >
                  Cancel
                </button>
              </div>

              <div className="mx-5 mb-3 p-3 rounded-lg" style={{ backgroundColor: '#F2F2F7' }}>
                <p
                  className="text-[10px] font-bold uppercase tracking-wide mb-1"
                  style={{ color: '#8E8E93' }}
                >
                  {shareModal.article.outlet_name}
                </p>
                <p className="text-[13px] font-semibold" style={{ color: '#1C1C1E' }}>
                  {shareModal.article.headline}
                </p>
              </div>

              <div className="px-5 mb-3">
                <textarea
                  value={stanceText}
                  onChange={(e) => setStanceText(e.target.value)}
                  placeholder="Add your commentary..."
                  rows={3}
                  className="w-full rounded-lg p-3 text-[14px] resize-none outline-none"
                  style={{
                    backgroundColor: '#F2F2F7',
                    color: '#1C1C1E',
                    border: '1px solid rgba(60,60,67,0.18)',
                  }}
                />
              </div>

              <div className="px-5 mb-4">
                <p className="text-[12px] font-semibold mb-2" style={{ color: '#8E8E93' }}>
                  Your stance on this article:
                </p>
                <div className="flex gap-2 flex-wrap">
                  {(
                    [
                      { value: 'support', label: 'Support', bg: '#E8F5E9', fg: '#2E7D32' },
                      { value: 'neutral', label: 'Neutral', bg: '#F5F5F5', fg: '#616161' },
                      { value: 'criticize', label: 'Criticize', bg: '#FCE4EC', fg: '#C62828' },
                      { value: 'fake_news', label: 'Fake News', bg: '#F3E5F5', fg: '#7B1FA2' },
                    ] as const
                  ).map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setSelectedStance(s.value)}
                      className="px-3 py-1.5 rounded-full text-[12px] font-semibold transition-all"
                      style={{
                        backgroundColor: selectedStance === s.value ? s.fg : s.bg,
                        color: selectedStance === s.value ? '#FFFFFF' : s.fg,
                        boxShadow: selectedStance === s.value ? `0 0 0 2px ${s.fg}` : 'none',
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="px-5 pb-6">
                <button
                  onClick={submitShare}
                  disabled={posting}
                  className="w-full py-3 rounded-xl text-[15px] font-semibold text-white"
                  style={{
                    backgroundColor: shareModal.platform === 'x_twitter' ? '#16181C' : '#1877F2',
                    opacity: posting ? 0.6 : 1,
                  }}
                >
                  {posting
                    ? 'Posting...'
                    : `Post to ${shareModal.platform === 'x_twitter' ? 'Z' : 'Fakebook'}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {disputeModal && (
          <div
            className="absolute inset-0 flex items-end justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 60 }}
            onClick={() => setDisputeModal(null)}
          >
            <div
              className="w-full rounded-t-2xl"
              style={{ backgroundColor: '#FFFFFF', maxHeight: '85%', overflowY: 'auto' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 pt-4 pb-2">
                <h3 className="text-[17px] font-bold" style={{ color: '#1C1C1E' }}>
                  Request Correction / Takedown
                </h3>
                <button
                  onClick={() => setDisputeModal(null)}
                  className="text-[15px] font-medium"
                  style={{ color: '#8E8E93' }}
                >
                  Cancel
                </button>
              </div>

              <div className="mx-5 mb-3 p-3 rounded-lg" style={{ backgroundColor: '#F2F2F7' }}>
                <p
                  className="text-[10px] font-bold uppercase tracking-wide mb-1"
                  style={{ color: '#8E8E93' }}
                >
                  {disputeModal.outlet_name}
                </p>
                <p className="text-[13px] font-semibold" style={{ color: '#1C1C1E' }}>
                  {disputeModal.headline}
                </p>
              </div>

              <div className="px-5 mb-4">
                <p className="text-[12px] font-semibold mb-1.5" style={{ color: '#8E8E93' }}>
                  What's wrong with this? Add any facts you have (optional)
                </p>
                <textarea
                  value={disputeNote}
                  onChange={(e) => setDisputeNote(e.target.value)}
                  placeholder="Identify the false claim and cite any verified facts that counter it..."
                  rows={4}
                  className="w-full rounded-lg p-3 text-[14px] resize-none outline-none"
                  style={{
                    backgroundColor: '#F2F2F7',
                    color: '#1C1C1E',
                    border: '1px solid rgba(60,60,67,0.18)',
                  }}
                />
              </div>

              <div className="px-5 pb-6">
                <button
                  onClick={submitDispute}
                  disabled={disputing}
                  className="w-full py-3 rounded-xl text-[15px] font-semibold text-white"
                  style={{ backgroundColor: '#C62828', opacity: disputing ? 0.6 : 1 }}
                >
                  {disputing ? 'Submitting...' : 'Submit report'}
                </button>
                <p className="text-[11px] mt-2 text-center" style={{ color: '#8E8E93' }}>
                  Editorial review takes a few minutes. Reports with no supporting facts are likely
                  to be rejected and may affect your credibility.
                </p>
              </div>
            </div>
          </div>
        )}
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
                onClick={() => openArticle(heroArticle)}
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
                      {isTrainer && !heroArticle.is_factual && (
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
                      onClick={() => openArticle(article)}
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
                        {isTrainer && !article.is_factual && (
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
