import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

interface ScenarioSummary {
  id: string;
  title: string;
  description: string;
  scenario_type?: string;
}

interface DemoScriptSummary {
  id: string;
  name: string;
  scenarioType: string;
  durationMinutes: number;
  eventCount: number;
}

type ViewMode = 'cinematic' | 'god' | 'spotlight';
type DemoMode = 'scripted' | 'ai' | 'hybrid';

function getAuthToken(): string {
  return (
    localStorage.getItem('supabase.auth.token') ??
    (JSON.parse(localStorage.getItem('sb-auth-token') ?? '{}') as { access_token?: string })
      ?.access_token ??
    ''
  );
}

export function DemoLanding() {
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [scripts, setScripts] = useState<DemoScriptSummary[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<string>('');
  const [selectedScript, setSelectedScript] = useState<string>('');
  const [viewMode, setViewMode] = useState<ViewMode>('cinematic');
  const [demoMode, setDemoMode] = useState<DemoMode>('scripted');
  const [speed, setSpeed] = useState(1);
  const [launching, setLaunching] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    api.scenarios
      .list()
      .then((res) => {
        const list = (res.data ?? []) as ScenarioSummary[];
        setScenarios(list);
        if (list.length > 0) setSelectedScenario(list[0].id);
      })
      .catch(() => {});

    fetchScripts();
  }, []);

  const fetchScripts = () => {
    fetch(apiUrl('/api/demo/scripts'), {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    })
      .then((r) => r.json())
      .then((r) => {
        const list = (r.data ?? []) as DemoScriptSummary[];
        setScripts(list);
        if (list.length > 0 && !selectedScript) setSelectedScript(list[0].id);
      })
      .catch(() => {});
  };

  const handleLaunch = async () => {
    if (!selectedScenario) return;
    setLaunching(true);
    setError(null);

    try {
      const res = await fetch(apiUrl('/api/demo/start'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: JSON.stringify({
          scenarioId: selectedScenario,
          scriptId: demoMode !== 'ai' ? selectedScript || undefined : undefined,
          speedMultiplier: speed,
          mode: demoMode,
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

  const handleGenerateScript = async () => {
    if (!selectedScenario) return;
    setGenerating(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(apiUrl('/api/demo/generate-script'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: JSON.stringify({
          scenarioId: selectedScenario,
          durationMinutes: 14,
          eventDensity: 'normal',
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Failed to generate script');
        return;
      }

      const result = data.data;
      setSuccessMsg(
        `Generated "${result.name}" — ${result.eventCount} events, ~${result.durationMinutes} min`,
      );

      fetchScripts();
      if (result.scriptId) setSelectedScript(result.scriptId);
    } catch {
      setError('Network error during generation');
    } finally {
      setGenerating(false);
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

  const demoModeDescriptions: Record<DemoMode, { label: string; sub: string; color: string }> = {
    scripted: {
      label: 'Scripted',
      sub: 'Pre-authored script playback. Predictable, polished sequence.',
      color: 'robotic-yellow',
    },
    ai: {
      label: 'AI Agents',
      sub: 'Fully autonomous AI agents react to live injects in real time.',
      color: 'robotic-cyan',
    },
    hybrid: {
      label: 'Hybrid',
      sub: 'Script drives main beats, AI agents fill gaps and react to dynamic events.',
      color: 'robotic-green',
    },
  };

  const needsScript = demoMode === 'scripted' || demoMode === 'hybrid';

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

        {/* Demo mode */}
        <div className="mb-6">
          <label className="block text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
            Demo Mode
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(
              Object.entries(demoModeDescriptions) as [
                DemoMode,
                { label: string; sub: string; color: string },
              ][]
            ).map(([mode, desc]) => (
              <button
                key={mode}
                onClick={() => setDemoMode(mode)}
                className={`p-3 border text-left transition-colors ${
                  demoMode === mode
                    ? `border-${desc.color} bg-${desc.color}/10`
                    : 'border-robotic-yellow/20 hover:border-robotic-yellow/40'
                }`}
                style={
                  demoMode === mode
                    ? {
                        borderColor: 'var(--color-robotic-yellow)',
                        backgroundColor: 'rgba(255,200,0,0.08)',
                      }
                    : {}
                }
              >
                <div className="text-sm terminal-text text-robotic-yellow font-bold">
                  {desc.label}
                </div>
                <div className="text-[10px] terminal-text text-robotic-yellow/50 mt-1">
                  {desc.sub}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Script picker (only for scripted / hybrid modes) */}
        {needsScript && (
          <div className="mb-6">
            <label className="block text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
              Demo Script
            </label>
            <div className="flex gap-2">
              <select
                value={selectedScript}
                onChange={(e) => setSelectedScript(e.target.value)}
                className="flex-1 px-4 py-3 bg-robotic-gray-400 border border-robotic-yellow/30 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow outline-none"
              >
                <option value="">Auto-detect</option>
                {scripts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.eventCount} events, ~{s.durationMinutes}min)
                  </option>
                ))}
              </select>
              <button
                onClick={handleGenerateScript}
                disabled={generating || !selectedScenario}
                className="px-4 py-3 text-xs terminal-text uppercase font-bold border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {generating ? 'Generating...' : 'Generate Script'}
              </button>
            </div>
            {successMsg && (
              <div className="mt-2 p-2 border border-green-500/40 bg-green-500/10 text-xs terminal-text text-green-400">
                {successMsg}
              </div>
            )}
          </div>
        )}

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
            className="px-8 py-3 text-sm terminal-text uppercase font-bold bg-robotic-yellow text-robotic-gray-400 hover:bg-robotic-yellow/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {launching ? 'Launching...' : 'Launch Demo'}
          </button>
        </div>
      </div>
    </div>
  );
}
