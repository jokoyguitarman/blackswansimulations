import { useState, useCallback } from 'react';
import { api } from '../../lib/api';

interface CompileStepProps {
  wizardDraftId: string | null;
  onComplete: (scenarioId: string) => void;
}

export function CompileStep({ wizardDraftId, onComplete }: CompileStepProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const compile = useCallback(async () => {
    if (!wizardDraftId) {
      setError('No wizard draft available. Go back and complete previous steps.');
      return;
    }
    setLoading(true);
    setError(null);
    setElapsed(0);

    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);

    try {
      const { data } = await api.warroom.wizardDraftPersist(wizardDraftId);
      const id = (data as Record<string, unknown>).scenarioId as string;
      setScenarioId(id);
      onComplete(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scenario compilation failed');
    } finally {
      clearInterval(timer);
      setLoading(false);
    }
  }, [wizardDraftId, onComplete]);

  if (loading) {
    const phases = [
      { time: 0, label: 'Initializing scenario compilation...' },
      { time: 5, label: 'Loading scene config and research data...' },
      { time: 15, label: 'Generating layout and site knowledge...' },
      { time: 30, label: 'Creating victim profiles and casualties...' },
      { time: 60, label: 'Generating scenario pins and crowd dynamics...' },
      { time: 90, label: 'Building time-based injects and events...' },
      { time: 120, label: 'Processing secondary devices and adversary behavior...' },
      { time: 150, label: 'Persisting scenario to database...' },
    ];
    const currentPhase = [...phases].reverse().find((p) => elapsed >= p.time) ?? phases[0];

    return (
      <div className="flex flex-col items-center justify-center h-[400px]">
        <div className="text-lg terminal-text text-accent animate-pulse mb-4">
          Compiling scenario
        </div>
        <div className="text-xs terminal-text text-muted mb-2">{currentPhase.label}</div>
        <div className="text-[10px] terminal-text text-muted mb-6">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} elapsed
        </div>
        <div className="w-64 h-1.5 bg-surface-2 rounded overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-1000"
            style={{ width: `${Math.min((elapsed / 180) * 100, 95)}%` }}
          />
        </div>
        <div className="mt-8 text-[10px] terminal-text text-muted max-w-md text-center">
          This may take 2-5 minutes. The system is generating the full scenario including all pins,
          casualties, injects, crowd dynamics, and adversary behavior.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[300px]">
        <div className="text-lg terminal-text text-danger mb-4">Compilation failed</div>
        <div className="text-xs terminal-text text-danger max-w-md text-center mb-6">{error}</div>
        <button onClick={compile} className="military-button px-6 py-2 text-xs">
          Retry Compilation
        </button>
      </div>
    );
  }

  if (scenarioId) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px]">
        <div className="text-2xl terminal-text text-success mb-4">Scenario compiled</div>
        <div className="text-xs terminal-text text-muted mb-2">
          Your scenario has been created and saved.
        </div>
        <div className="text-[10px] terminal-text text-muted mb-8">Scenario ID: {scenarioId}</div>
        <div className="flex gap-4">
          <a href="/scenarios" className="military-button px-8 py-3 text-sm text-center">
            View scenarios
          </a>
          <a
            href="/warroom"
            className="px-8 py-3 text-sm terminal-text border border-border text-muted hover:border-border text-center"
          >
            Create another
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-[300px]">
      <div className="text-sm terminal-text text-muted mb-6 max-w-lg text-center">
        All research and analysis is complete. Click below to compile the full scenario. This will
        generate all scenario pins, casualties, injects, crowd dynamics, and adversary behavior. The
        process takes 2-5 minutes.
      </div>
      <button
        onClick={compile}
        disabled={!wizardDraftId}
        className="military-button px-10 py-4 text-sm disabled:opacity-30"
      >
        Compile scenario
      </button>
      {!wizardDraftId && (
        <div className="text-[10px] terminal-text text-danger mt-2">
          Draft not available -- complete previous steps first.
        </div>
      )}
    </div>
  );
}
