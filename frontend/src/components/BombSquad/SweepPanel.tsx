import { useState, useCallback } from 'react';
import { api } from '../../lib/api';

interface SweepPanelProps {
  sessionId: string;
  assetId: string;
  assetName: string;
  onClose: () => void;
}

export const SweepPanel = ({ sessionId, assetId, assetName, onClose }: SweepPanelProps) => {
  const [k9, setK9] = useState(false);
  const [robot, setRobot] = useState(false);
  const [personnel, setPersonnel] = useState(2);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    found: boolean;
    message?: string;
    device_description?: string;
    is_live?: boolean;
    container_type?: string;
    detonation_deadline?: string;
  } | null>(null);

  const initiateSweep = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.bombSquad.sweep(sessionId, assetId, { personnel, k9, robot });
      setResult(res);
    } catch {
      setResult({ found: false, message: 'Sweep request failed' });
    } finally {
      setLoading(false);
    }
  }, [sessionId, assetId, personnel, k9, robot]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-ink/40">
      <div className="bg-surface border border-border p-6 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm terminal-text text-ink">Deploy sweep resources</h3>
          <button onClick={onClose} className="text-muted hover:text-ink text-xs">
            Close
          </button>
        </div>
        <p className="text-xs terminal-text text-muted mb-4">
          Target: <span className="text-ink">{assetName}</span>
        </p>

        {!result ? (
          <>
            <div className="space-y-3 mb-5">
              <label className="flex items-center gap-3 text-xs terminal-text text-ink">
                <input
                  type="checkbox"
                  checked={k9}
                  onChange={(e) => setK9(e.target.checked)}
                  className="accent-accent"
                />
                K9 Explosive Detection Unit
              </label>
              <label className="flex items-center gap-3 text-xs terminal-text text-ink">
                <input
                  type="checkbox"
                  checked={robot}
                  onChange={(e) => setRobot(e.target.checked)}
                  className="accent-accent"
                />
                EOD Robot (ROV)
              </label>
              <label className="flex items-center gap-3 text-xs terminal-text text-ink">
                Personnel:
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={personnel}
                  onChange={(e) => setPersonnel(parseInt(e.target.value, 10) || 1)}
                  className="w-16 px-2 py-1 bg-surface-2 border border-border text-ink text-sm"
                />
              </label>
            </div>
            <button
              onClick={initiateSweep}
              disabled={loading}
              className="w-full py-2 text-sm terminal-text border border-accent bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Sweeping…' : 'Initiate sweep'}
            </button>
          </>
        ) : result.found ? (
          <div className="text-center space-y-3">
            <div className="text-danger font-bold text-lg terminal-text animate-pulse">
              Suspicious device found
            </div>
            <p className="text-xs terminal-text text-ink">{result.device_description}</p>
            {result.is_live && result.detonation_deadline && (
              <div className="text-danger text-xs terminal-text mt-2">
                Live device — detonation timer active
              </div>
            )}
            <p className="text-[10px] terminal-text text-muted">
              Container: {result.container_type?.replace(/_/g, ' ')}
            </p>
            <button
              onClick={onClose}
              className="mt-3 px-4 py-1 text-xs terminal-text border border-border text-ink hover:bg-accent/10"
            >
              Acknowledge
            </button>
          </div>
        ) : (
          <div className="text-center space-y-3">
            <div className="text-success font-bold text-lg terminal-text">Area clear</div>
            <p className="text-xs terminal-text text-muted">
              {result.message || 'No suspicious items found in this area.'}
            </p>
            <button
              onClick={onClose}
              className="mt-3 px-4 py-1 text-xs terminal-text border border-border text-ink hover:bg-accent/10"
            >
              Acknowledge
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
