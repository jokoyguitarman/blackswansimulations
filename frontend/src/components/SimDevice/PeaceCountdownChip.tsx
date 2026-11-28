import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { peaceCountdownLabel } from '../../lib/peaceCountdown';

interface Props {
  sessionId: string;
  source: object | null;
  onStarted: () => void;
}

/** Trainer header. Players never mount this. Hidden once the crisis clock has started. */
export function PeaceCountdownChip({ sessionId, source, onStarted }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const label = peaceCountdownLabel(source, now);
  const counting = label != null;

  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [counting]);

  if (!label) return null;

  const startCrisis = async () => {
    setBusy(true);
    try {
      await api.sessions.endPeace(sessionId);
      onStarted();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not start the crisis');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-2">
      <span
        className="text-[11px] px-2 py-1 rounded font-semibold"
        style={{ backgroundColor: 'rgba(180, 83, 9, 0.12)', color: '#9A3412' }}
      >
        {label}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void startCrisis()}
        className="text-[11px] font-semibold px-3 py-1.5 rounded-lg hover:opacity-80 transition-opacity"
        style={{ backgroundColor: '#9A3412', color: '#fff' }}
      >
        {busy ? 'Starting…' : 'Start crisis now'}
      </button>
    </span>
  );
}
