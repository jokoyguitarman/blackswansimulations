import { useEffect, useState } from 'react';
import { PEACE_PERIOD_MAX_SECONDS, type PeaceFeed } from '@shared/peaceFeed';
import { ApiError, api } from '../../lib/api';
import { lobbyPeaceMinutes, lobbyPeaceSeconds, lobbyPeaceVisible } from '../../lib/peaceLobby';

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
  scenarioId: string | null | undefined;
  social: boolean;
  trainer: boolean;
  onSeconds: (seconds: number | undefined) => void;
}

/**
 * Start-panel peace switch. Hidden unless the peace-feed route answers and
 * the scenario has a feed the editor left on. A 404 (flag off) renders nothing.
 */
export function PeaceLobbyControl({ scenarioId, social, trainer, onSeconds }: Props) {
  const [feed, setFeed] = useState<PeaceFeed | null>(null);
  const [probeStatus, setProbeStatus] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [minutes, setMinutes] = useState(lobbyPeaceMinutes(null));

  useEffect(() => {
    if (!social || !trainer || !scenarioId) {
      setProbeStatus(null);
      setFeed(null);
      return;
    }
    let cancelled = false;
    api.scenarios
      .getPeaceFeed(scenarioId)
      .then((res) => {
        if (cancelled) return;
        setProbeStatus(200);
        setFeed(res.data.peace_period);
        setEnabled(res.data.peace_period?.enabled !== false);
        setMinutes(lobbyPeaceMinutes(res.data.peace_period));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProbeStatus(err instanceof ApiError ? err.status : 0);
        setFeed(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scenarioId, social, trainer]);

  const shown = lobbyPeaceVisible({ social, trainer, probeStatus, feed });
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
