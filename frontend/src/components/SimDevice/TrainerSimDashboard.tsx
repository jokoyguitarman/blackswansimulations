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

interface SentimentData {
  overall: number;
  hate_speech_volume: number;
  misinformation_volume: number;
  supportive_volume: number;
  trend: string;
}

interface SOPStep {
  step_id: string;
  step_name: string;
  status: string;
  elapsed_minutes: number;
  time_limit_minutes?: number;
}

export default function TrainerSimDashboard() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [sentiment, setSentiment] = useState<SentimentData | null>(null);
  const [sopSteps, setSopSteps] = useState<SOPStep[]>([]);
  const [postCount, setPostCount] = useState(0);
  const [actionCount, setActionCount] = useState(0);

  const loadData = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();

      const [sentRes, sopRes, postsRes, actionsRes] = await Promise.all([
        fetch(apiUrl(`/api/social/sentiment/session/${sessionId}`), { headers }),
        fetch(apiUrl(`/api/social/sop/session/${sessionId}`), { headers }),
        fetch(apiUrl(`/api/social/posts/session/${sessionId}?limit=1`), { headers }),
        fetch(apiUrl(`/api/social/actions/session/${sessionId}`), { headers }),
      ]);

      const sentData = await sentRes.json();
      if (sentData.data) setSentiment(sentData.data);

      const sopData = await sopRes.json();
      if (sopData.data) setSopSteps(sopData.data);

      const postsData = await postsRes.json();
      setPostCount(postsData.count || 0);

      const actionsData = await actionsRes.json();
      setActionCount((actionsData.data || []).length);
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: ['social_post.created', 'sentiment.updated', 'social_post.flagged'],
    onEvent: () => {
      loadData();
    },
  });

  function getSentimentColor(score: number): string {
    if (score >= 70) return '#34C759';
    if (score >= 40) return '#FFD60A';
    return '#FF453A';
  }

  function getTrendIcon(trend: string): { icon: string; color: string } {
    switch (trend) {
      case 'rising':
        return { icon: '↑', color: '#34C759' };
      case 'falling':
        return { icon: '↓', color: '#FF453A' };
      default:
        return { icon: '→', color: '#8E8E93' };
    }
  }

  function getStepStatusStyle(status: string): { bg: string; text: string; dot: string } {
    switch (status) {
      case 'completed':
        return { bg: 'rgba(52,199,89,0.12)', text: '#34C759', dot: '#34C759' };
      case 'overdue':
        return { bg: 'rgba(255,69,58,0.12)', text: '#FF453A', dot: '#FF453A' };
      case 'in_progress':
        return { bg: 'rgba(0,122,255,0.12)', text: '#0A84FF', dot: '#0A84FF' };
      default:
        return { bg: 'rgba(142,142,147,0.12)', text: '#8E8E93', dot: '#48484A' };
    }
  }

  return (
    <div className="min-h-screen p-6" style={{ backgroundColor: '#1C1C1E', color: '#E5E5EA' }}>
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight" style={{ color: '#FFFFFF' }}>
              Dashboard
            </h1>
            <p className="text-[15px] mt-0.5" style={{ color: '#8E8E93' }}>
              Crisis Simulation Control Center
            </p>
          </div>
          <button
            onClick={() => navigate(`/sessions/${sessionId}`)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl ios-btn-bounce"
            style={{ backgroundColor: '#2C2C2E', color: '#0A84FF' }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            <span className="text-[14px] font-medium">Back to Session</span>
          </button>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {/* Sentiment Card */}
          <div className="rounded-2xl p-5" style={{ backgroundColor: '#2C2C2E' }}>
            <div className="flex items-center justify-between mb-3">
              <p
                className="text-[12px] font-semibold tracking-wider uppercase"
                style={{ color: '#8E8E93' }}
              >
                Sentiment
              </p>
              {sentiment && (
                <span
                  className="text-[12px] font-semibold"
                  style={{ color: getTrendIcon(sentiment.trend).color }}
                >
                  {getTrendIcon(sentiment.trend).icon} {sentiment.trend}
                </span>
              )}
            </div>
            <p
              className="text-[36px] font-bold tracking-tight"
              style={{ color: sentiment ? getSentimentColor(sentiment.overall) : '#48484A' }}
            >
              {sentiment?.overall ?? '--'}
            </p>
            <p className="text-[12px] mt-1" style={{ color: '#8E8E93' }}>
              out of 100
            </p>
            {sentiment && (
              <div
                className="mt-3 h-1.5 rounded-full overflow-hidden"
                style={{ backgroundColor: '#3A3A3C' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${sentiment.overall}%`,
                    backgroundColor: getSentimentColor(sentiment.overall),
                  }}
                />
              </div>
            )}
          </div>

          {/* Hate Posts Card */}
          <div className="rounded-2xl p-5" style={{ backgroundColor: '#2C2C2E' }}>
            <p
              className="text-[12px] font-semibold tracking-wider uppercase mb-3"
              style={{ color: '#8E8E93' }}
            >
              Hate Posts
            </p>
            <p className="text-[36px] font-bold tracking-tight" style={{ color: '#FF453A' }}>
              {sentiment?.hate_speech_volume ?? 0}
            </p>
            <p className="text-[12px] mt-1" style={{ color: '#8E8E93' }}>
              flagged content
            </p>
            <div className="mt-3 flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#FF453A' }} />
              <span className="text-[11px]" style={{ color: '#FF453A' }}>
                Requires attention
              </span>
            </div>
          </div>

          {/* Total Posts Card */}
          <div className="rounded-2xl p-5" style={{ backgroundColor: '#2C2C2E' }}>
            <p
              className="text-[12px] font-semibold tracking-wider uppercase mb-3"
              style={{ color: '#8E8E93' }}
            >
              Total Posts
            </p>
            <p className="text-[36px] font-bold tracking-tight" style={{ color: '#0A84FF' }}>
              {postCount}
            </p>
            <p className="text-[12px] mt-1" style={{ color: '#8E8E93' }}>
              in simulation
            </p>
          </div>

          {/* Player Actions Card */}
          <div className="rounded-2xl p-5" style={{ backgroundColor: '#2C2C2E' }}>
            <p
              className="text-[12px] font-semibold tracking-wider uppercase mb-3"
              style={{ color: '#8E8E93' }}
            >
              Actions
            </p>
            <p className="text-[36px] font-bold tracking-tight" style={{ color: '#34C759' }}>
              {actionCount}
            </p>
            <p className="text-[12px] mt-1" style={{ color: '#8E8E93' }}>
              player responses
            </p>
          </div>
        </div>

        {/* SOP Compliance */}
        <div className="rounded-2xl p-6" style={{ backgroundColor: '#2C2C2E' }}>
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: 'rgba(0,122,255,0.15)' }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#0A84FF"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </div>
              <h2 className="text-[20px] font-bold" style={{ color: '#FFFFFF' }}>
                SOP Compliance
              </h2>
            </div>
            {sopSteps.length > 0 && (
              <span className="text-[13px] font-medium" style={{ color: '#8E8E93' }}>
                {sopSteps.filter((s) => s.status === 'completed').length}/{sopSteps.length}{' '}
                completed
              </span>
            )}
          </div>
          {sopSteps.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-[15px]" style={{ color: '#48484A' }}>
                No SOP steps defined for this scenario
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {sopSteps.map((step) => {
                const style = getStepStatusStyle(step.status);
                const isOverdue = step.status === 'overdue';
                return (
                  <div
                    key={step.step_id}
                    className="flex items-center gap-4 p-3 rounded-xl"
                    style={{ backgroundColor: '#3A3A3C' }}
                  >
                    <div
                      className={`w-3 h-3 rounded-full flex-shrink-0 ${isOverdue ? 'animate-pulse' : ''}`}
                      style={{ backgroundColor: style.dot }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-medium" style={{ color: '#E5E5EA' }}>
                        {step.step_name}
                      </p>
                      {step.time_limit_minutes && (
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[12px]" style={{ color: '#8E8E93' }}>
                            {step.elapsed_minutes}m / {step.time_limit_minutes}m
                          </span>
                          <div
                            className="flex-1 h-1 rounded-full overflow-hidden"
                            style={{ backgroundColor: '#48484A', maxWidth: 120 }}
                          >
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${Math.min(100, (step.elapsed_minutes / step.time_limit_minutes) * 100)}%`,
                                backgroundColor: style.dot,
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                    <span
                      className="text-[12px] font-semibold px-2.5 py-1 rounded-lg"
                      style={{ backgroundColor: style.bg, color: style.text }}
                    >
                      {step.status}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
