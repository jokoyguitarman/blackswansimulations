import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';

const SCENARIO_TYPES = [
  { id: 'open_field_shooting', label: 'Open-field shooting' },
  { id: 'knife_attack', label: 'Knife attack' },
  { id: 'gas_attack', label: 'Gas attack' },
  { id: 'kidnapping', label: 'Kidnapping' },
  { id: 'car_bomb', label: 'Car bomb / suicide bomber' },
  { id: 'bombing_mall', label: 'Mall bombing' },
];

const SETTINGS = [
  { id: 'beach', label: 'Beach' },
  { id: 'subway', label: 'Subway / Metro' },
  { id: 'mall', label: 'Mall' },
  { id: 'resort', label: 'Resort' },
  { id: 'hotel', label: 'Hotel' },
  { id: 'train', label: 'Train' },
  { id: 'open_field', label: 'Open field' },
];

const TERRAINS = [
  { id: 'jungle', label: 'Jungle' },
  { id: 'mountain', label: 'Mountain' },
  { id: 'coastal', label: 'Coastal' },
  { id: 'desert', label: 'Desert' },
  { id: 'urban', label: 'Urban' },
  { id: 'rural', label: 'Rural' },
  { id: 'swamp', label: 'Swamp' },
  { id: 'island', label: 'Island' },
];

const COMPLEXITY_TIERS = [
  { id: 'minimal', label: 'Minimal', desc: '4 injects, no decision branches' },
  { id: 'standard', label: 'Standard', desc: '8 injects, 2 decision branches' },
  { id: 'full', label: 'Full', desc: '12 injects, 4 decision branches, locations, env seeds' },
  { id: 'rich', label: 'Rich', desc: '18 injects, 6 decision branches, full content' },
];

export const WarRoom = () => {
  const { isTrainer } = useRoleVisibility();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [scenarioType, setScenarioType] = useState('');
  const [setting, setSetting] = useState('');
  const [terrain, setTerrain] = useState('');
  const [location, setLocation] = useState('');
  const [complexityTier, setComplexityTier] = useState<'minimal' | 'standard' | 'full' | 'rich'>(
    'full',
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useStructured, setUseStructured] = useState(false);

  if (!isTrainer) {
    return (
      <div className="min-h-screen scanline flex items-center justify-center">
        <div className="military-border p-8 text-center">
          <h1 className="text-xl terminal-text uppercase mb-4">[ACCESS DENIED]</h1>
          <p className="text-sm terminal-text text-robotic-yellow/70">
            War Room is available to trainers only.
          </p>
        </div>
      </div>
    );
  }

  const handleGenerate = async () => {
    setError(null);
    setLoading(true);
    try {
      const options: Parameters<typeof api.warroom.generate>[0] = {
        complexity_tier: complexityTier,
      };
      if (useStructured && scenarioType) {
        options.scenario_type = scenarioType;
        options.setting = setting || undefined;
        options.terrain = terrain || undefined;
        options.location = location || undefined;
      } else if (prompt.trim()) {
        options.prompt = prompt.trim();
      } else {
        setError('Provide a prompt or select scenario type, setting, and terrain.');
        setLoading(false);
        return;
      }

      const result = await api.warroom.generate(options);
      const scenarioId = result.data?.scenarioId;
      if (scenarioId) {
        navigate(`/scenarios`);
      } else {
        setError('No scenario ID returned');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate scenario');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen scanline">
      <div className="max-w-4xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-4 mb-4">
          <Link
            to="/scenarios"
            className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow"
          >
            ← [SCENARIOS]
          </Link>
        </div>
        <div className="military-border p-6 mb-6">
          <h1 className="text-2xl terminal-text uppercase tracking-wider mb-2">
            [WAR_ROOM] Scenario Generator
          </h1>
          <p className="text-xs terminal-text text-robotic-yellow/70">
            Enter a prompt or select parameters. AI will generate a complete, playable scenario.
          </p>
        </div>

        <div className="military-border p-6 mb-6">
          <div className="flex gap-4 mb-4">
            <button
              onClick={() => setUseStructured(false)}
              className={`px-4 py-2 text-xs terminal-text uppercase border ${
                !useStructured
                  ? 'border-robotic-yellow bg-robotic-yellow/10 text-robotic-yellow'
                  : 'border-robotic-gray-200 text-robotic-yellow/70'
              }`}
            >
              Free-text prompt
            </button>
            <button
              onClick={() => setUseStructured(true)}
              className={`px-4 py-2 text-xs terminal-text uppercase border ${
                useStructured
                  ? 'border-robotic-yellow bg-robotic-yellow/10 text-robotic-yellow'
                  : 'border-robotic-gray-200 text-robotic-yellow/70'
              }`}
            >
              Structured
            </button>
          </div>

          {!useStructured ? (
            <div className="mb-4">
              <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                [PROMPT] Describe your scenario (e.g. "Kidnapping at jungle resort in Bali")
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Kidnapping at a jungle resort in Bali with ocean and jungle access"
                className="w-full min-h-[120px] px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow placeholder-robotic-yellow/30 terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                disabled={loading}
              />
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                  [SCENARIO_TYPE]
                </label>
                <select
                  value={scenarioType}
                  onChange={(e) => setScenarioType(e.target.value)}
                  className="w-full px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                  disabled={loading}
                >
                  <option value="">Select...</option>
                  {SCENARIO_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                    [SETTING]
                  </label>
                  <select
                    value={setting}
                    onChange={(e) => setSetting(e.target.value)}
                    className="w-full px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                    disabled={loading}
                  >
                    <option value="">Select...</option>
                    {SETTINGS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                    [TERRAIN]
                  </label>
                  <select
                    value={terrain}
                    onChange={(e) => setTerrain(e.target.value)}
                    className="w-full px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                    disabled={loading}
                  >
                    <option value="">Select...</option>
                    {TERRAINS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                  [LOCATION] Real place (optional, e.g. "Bondi Beach, Sydney")
                </label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Bali, Indonesia"
                  className="w-full px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow placeholder-robotic-yellow/30 terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                  disabled={loading}
                />
              </div>
            </div>
          )}

          <div className="mt-6">
            <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
              [COMPLEXITY]
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {COMPLEXITY_TIERS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setComplexityTier(t.id as typeof complexityTier)}
                  className={`p-3 text-left border transition-all ${
                    complexityTier === t.id
                      ? 'border-robotic-yellow bg-robotic-yellow/10'
                      : 'border-robotic-gray-200 hover:border-robotic-yellow/50'
                  }`}
                  disabled={loading}
                >
                  <span className="text-sm terminal-text text-robotic-yellow">{t.label}</span>
                  <span className="block text-xs terminal-text text-robotic-yellow/60 mt-1">
                    {t.desc}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="military-border p-4 mb-6 border-robotic-orange">
            <p className="text-sm terminal-text text-robotic-orange">{error}</p>
          </div>
        )}

        <div className="flex gap-4">
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? '[GENERATING...] (30–60s)' : '[GENERATE]'}
          </button>
          <a
            href="/scenarios"
            className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50 transition-all"
          >
            [CANCEL]
          </a>
        </div>
      </div>
    </div>
  );
};
