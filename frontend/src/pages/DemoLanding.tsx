import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: session ? `Bearer ${session.access_token}` : '',
  };
}

interface ScenarioSummary {
  id: string;
  title: string;
  description: string;
  scenario_type?: string;
}

type ViewMode = 'cinematic' | 'god' | 'spotlight';

export function DemoLanding() {
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<string>('');
  const [viewMode, setViewMode] = useState<ViewMode>('cinematic');
  const [speed, setSpeed] = useState(1);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.scenarios
      .list()
      .then((res) => {
        const list = (res.data ?? []) as ScenarioSummary[];
        setScenarios(list);
        if (list.length > 0) setSelectedScenario(list[0].id);
      })
      .catch(() => {});
  }, []);

  const handleLaunch = async () => {
    if (!selectedScenario) return;
    setLaunching(true);
    setError(null);

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl('/api/demo/start'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          scenarioId: selectedScenario,
          speedMultiplier: speed,
          mode: 'ai',
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Failed to start demo');
        return;
      }

      const sessionId = data.data?.sessionId;
      if (sessionId) {
        navigate(`/sessions/${sessionId}?spectator=true&mode=${viewMode}`);
      }
    } catch {
      setError('Network error');
    } finally {
      setLaunching(false);
    }
  };

  const modeDescriptions: Record<ViewMode, { label: string; sub: string }> = {
    cinematic: {
      label: 'Cinematic',
      sub: 'Full-screen map with floating action cards. Best for laptops & tablets.',
    },
    god: { label: 'God View', sub: 'Map + activity feed sidebar. Best for large screens.' },
    spotlight: {
      label: 'Team Spotlight',
      sub: 'Auto-rotating team focus. Best for showing player experience.',
    },
  };

  return (
    <div className="min-h-screen scanline flex items-center justify-center p-8">
      <div className="military-border bg-robotic-gray-300 p-8 max-w-2xl w-full">
        <div className="flex items-center gap-4 mb-8">
          <h1 className="text-2xl terminal-text uppercase tracking-wider">Demo Launcher</h1>
          <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest bg-robotic-red text-white rounded">
            DEMO
          </span>
        </div>

        {/* Scenario picker */}
        <div className="mb-6">
          <label className="block text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
            Scenario
          </label>
          <select
            value={selectedScenario}
            onChange={(e) => setSelectedScenario(e.target.value)}
            className="w-full px-4 py-3 bg-robotic-gray-400 border border-robotic-yellow/30 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow outline-none"
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>

        {/* View mode */}
        <div className="mb-6">
          <label className="block text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
            Viewing Mode
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(Object.entries(modeDescriptions) as [ViewMode, { label: string; sub: string }][]).map(
              ([mode, desc]) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`p-3 border text-left transition-colors ${
                    viewMode === mode
                      ? 'border-robotic-yellow bg-robotic-yellow/10'
                      : 'border-robotic-yellow/20 hover:border-robotic-yellow/40'
                  }`}
                >
                  <div className="text-sm terminal-text text-robotic-yellow font-bold">
                    {desc.label}
                  </div>
                  <div className="text-[10px] terminal-text text-robotic-yellow/50 mt-1">
                    {desc.sub}
                  </div>
                </button>
              ),
            )}
          </div>
        </div>

        {/* Speed */}
        <div className="mb-8">
          <label className="block text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
            Speed: {speed}x
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="flex-1 accent-yellow-500"
            />
            <div className="flex gap-1">
              {[1, 2, 5, 10].map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`px-2 py-1 text-xs terminal-text border ${
                    speed === s
                      ? 'border-robotic-yellow text-robotic-yellow'
                      : 'border-robotic-yellow/20 text-robotic-yellow/50 hover:text-robotic-yellow/80'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 border border-robotic-red bg-robotic-red/10 text-sm terminal-text text-robotic-red">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between">
          <button
            onClick={() => navigate('/sessions')}
            className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10"
          >
            Back
          </button>
          <button
            onClick={handleLaunch}
            disabled={launching || !selectedScenario}
            className="px-8 py-3 text-sm terminal-text uppercase font-bold bg-robotic-red text-white hover:bg-robotic-red/90 disabled:opacity-50 disabled:cursor-not-allowed tracking-wider"
          >
            {launching ? 'Launching...' : 'Launch Demo'}
          </button>
        </div>
      </div>
    </div>
  );
}
