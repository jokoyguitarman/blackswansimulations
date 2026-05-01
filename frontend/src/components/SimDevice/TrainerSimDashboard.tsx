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
    if (score >= 70) return 'text-green-400';
    if (score >= 40) return 'text-yellow-400';
    return 'text-red-400';
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Trainer Dashboard</h1>
            <p className="text-gray-500 text-sm">Social Media Crisis Simulation Control</p>
          </div>
          <button
            onClick={() => navigate(`/sessions/${sessionId}`)}
            className="text-blue-400 text-sm"
          >
            ← Back to Session
          </button>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-xs text-gray-500 uppercase">Sentiment</p>
            <p
              className={`text-3xl font-bold ${sentiment ? getSentimentColor(sentiment.overall) : 'text-gray-500'}`}
            >
              {sentiment?.overall ?? '--'}/100
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {sentiment?.trend === 'rising'
                ? '↑ Rising'
                : sentiment?.trend === 'falling'
                  ? '↓ Falling'
                  : '→ Stable'}
            </p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-xs text-gray-500 uppercase">Hate Posts</p>
            <p className="text-3xl font-bold text-red-400">{sentiment?.hate_speech_volume ?? 0}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-xs text-gray-500 uppercase">Total Posts</p>
            <p className="text-3xl font-bold text-blue-400">{postCount}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-xs text-gray-500 uppercase">Player Actions</p>
            <p className="text-3xl font-bold text-green-400">{actionCount}</p>
          </div>
        </div>

        {/* SOP Compliance */}
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
          <h2 className="text-lg font-bold mb-4">SOP Compliance Tracker</h2>
          {sopSteps.length === 0 ? (
            <p className="text-gray-500 text-sm">No SOP steps defined for this scenario</p>
          ) : (
            <div className="space-y-3">
              {sopSteps.map((step) => (
                <div key={step.step_id} className="flex items-center gap-3">
                  <div
                    className={`w-3 h-3 rounded-full flex-shrink-0 ${step.status === 'completed' ? 'bg-green-500' : step.status === 'overdue' ? 'bg-red-500 animate-pulse' : 'bg-gray-600'}`}
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{step.step_name}</p>
                    {step.time_limit_minutes && (
                      <p className="text-xs text-gray-500">
                        Deadline: {step.time_limit_minutes}min | Elapsed: {step.elapsed_minutes}min
                      </p>
                    )}
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${step.status === 'completed' ? 'bg-green-900 text-green-400' : step.status === 'overdue' ? 'bg-red-900 text-red-400' : 'bg-gray-800 text-gray-400'}`}
                  >
                    {step.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
