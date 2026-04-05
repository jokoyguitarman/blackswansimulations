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
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-robotic-yellow/50 p-6 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm terminal-text uppercase text-robotic-yellow tracking-wider">
            [DEPLOY SWEEP RESOURCES]
          </h3>
          <button
            onClick={onClose}
            className="text-robotic-yellow/60 hover:text-robotic-yellow text-xs"
          >
            [CLOSE]
          </button>
        </div>
        <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
          Target: <span className="text-robotic-yellow">{assetName}</span>
        </p>

        {!result ? (
          <>
            <div className="space-y-3 mb-5">
              <label className="flex items-center gap-3 text-xs terminal-text text-robotic-yellow/80">
                <input
                  type="checkbox"
                  checked={k9}
                  onChange={(e) => setK9(e.target.checked)}
                  className="accent-robotic-yellow"
                />
                K9 Explosive Detection Unit
              </label>
              <label className="flex items-center gap-3 text-xs terminal-text text-robotic-yellow/80">
                <input
                  type="checkbox"
                  checked={robot}
                  onChange={(e) => setRobot(e.target.checked)}
                  className="accent-robotic-yellow"
                />
                EOD Robot (ROV)
              </label>
              <label className="flex items-center gap-3 text-xs terminal-text text-robotic-yellow/80">
                Personnel:
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={personnel}
                  onChange={(e) => setPersonnel(parseInt(e.target.value, 10) || 1)}
                  className="w-16 px-2 py-1 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow text-sm"
                />
              </label>
            </div>
            <button
              onClick={initiateSweep}
              disabled={loading}
              className="w-full py-2 text-sm terminal-text uppercase tracking-wider border border-robotic-orange bg-robotic-orange/10 text-robotic-orange hover:bg-robotic-orange/20 disabled:opacity-50 transition-colors"
            >
              {loading ? '[SWEEPING...]' : '[INITIATE SWEEP]'}
            </button>
          </>
        ) : result.found ? (
          <div className="text-center space-y-3">
            <div className="text-red-500 font-bold text-lg terminal-text animate-pulse">
              SUSPICIOUS DEVICE FOUND
            </div>
            <p className="text-xs terminal-text text-robotic-yellow/80">
              {result.device_description}
            </p>
            {result.is_live && result.detonation_deadline && (
              <div className="text-red-400 text-xs terminal-text mt-2">
                LIVE DEVICE — Detonation timer active
              </div>
            )}
            <p className="text-[10px] terminal-text text-robotic-yellow/50">
              Container: {result.container_type?.replace(/_/g, ' ')}
            </p>
            <button
              onClick={onClose}
              className="mt-3 px-4 py-1 text-xs terminal-text border border-robotic-yellow/50 text-robotic-yellow/80 hover:bg-robotic-yellow/10"
            >
              [ACKNOWLEDGE]
            </button>
          </div>
        ) : (
          <div className="text-center space-y-3">
            <div className="text-green-400 font-bold text-lg terminal-text">AREA CLEAR</div>
            <p className="text-xs terminal-text text-robotic-yellow/70">
              {result.message || 'No suspicious items found in this area.'}
            </p>
            <button
              onClick={onClose}
              className="mt-3 px-4 py-1 text-xs terminal-text border border-robotic-yellow/50 text-robotic-yellow/80 hover:bg-robotic-yellow/10"
            >
              [ACKNOWLEDGE]
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
