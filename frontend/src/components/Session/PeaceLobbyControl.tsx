import { useEffect, useState } from 'react';
import { PEACE_PERIOD_MAX_SECONDS } from '@shared/peaceFeed';
import { lobbyPeaceMinutes, lobbyPeaceSeconds, lobbyPeaceVisible, type LobbyPeace } from '../../lib/peaceLobby';

const MAX_MINUTES = PEACE_PERIOD_MAX_SECONDS / 60;

export function PeaceLobbyFields({
  enabled,
  minutes,
  onEnabled,
  onMinutes,
}: {
  enabled: boolean;
  minutes: number;
  onEnabled: (enabled: boolean) => void;
  onMinutes: (minutes: number) => void;
}) {
  return (
    <div className="wr-note" style={{ marginBottom: 12 }}>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} />
        Peace period: {enabled ? `${Math.max(0, Math.floor(minutes) || 0)} min` : 'off'}
      </label>
      <label className="text-[11px] text-muted font-medium" style={{ display: 'block', marginTop: 8 }}>
        Minutes
        <input
          type="number"
          min={0}
          max={MAX_MINUTES}
          value={minutes}
          disabled={!enabled}
          onChange={(event) => onMinutes(Number(event.target.value))}
          className="mt-0.5 block w-24 text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink disabled:opacity-60"
        />
      </label>
    </div>
  );
}

interface Props {
  social: boolean;
  trainer: boolean;
  /** From the session payload. Absent when the flag is off or there is no feed. */
  peace: LobbyPeace | null | undefined;
  onSeconds: (seconds: number | undefined) => void;
}

/** Start-panel peace switch. It does not fetch; the session load already has the offer. */
export function PeaceLobbyControl({ social, trainer, peace, onSeconds }: Props) {
  const shown = lobbyPeaceVisible({ social, trainer, peace });
  const [enabled, setEnabled] = useState(true);
  const [minutes, setMinutes] = useState(() => lobbyPeaceMinutes(peace));

  useEffect(() => {
    setMinutes(lobbyPeaceMinutes(peace));
    setEnabled(true);
  }, [peace]);

  const seconds = lobbyPeaceSeconds({ shown, enabled, minutes });

  useEffect(() => {
    onSeconds(seconds);
  }, [seconds, onSeconds]);

  if (!shown) return null;

  return (
    <PeaceLobbyFields
      enabled={enabled}
      minutes={minutes}
      onEnabled={setEnabled}
      onMinutes={setMinutes}
    />
  );
}
