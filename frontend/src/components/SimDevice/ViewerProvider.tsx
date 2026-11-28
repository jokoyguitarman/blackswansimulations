import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { loadStaffView } from '../../lib/viewAsClient';
import { releaseViewAsFrame, retainViewAsFrame } from '../../lib/viewAsFrame';
import type { ViewAsPlayer } from '../../lib/viewAsRoster';
import { SurfaceReadOnlyProvider } from './surfaceReadOnly';
import { ViewAsBanner } from './ViewAsBanner';

interface Probe {
  key: string;
  players: ViewAsPlayer[] | null;
}

/**
 * Opens a read-only player shell for `?view_as=<userId>`.
 * With the flag off, or with no query, the shell renders exactly as it does today
 * and no view-as header is published. The shell stays unmounted until the probe
 * returns, so its first fetches already carry the subject's headers.
 */
export function ViewerProvider({ children }: { children: ReactNode }) {
  const { sessionId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const requested = params.get('view_as');
  const probeKey = requested ? `${sessionId}:${requested}` : '';
  const [probe, setProbe] = useState<Probe | null>(null);

  useEffect(() => {
    if (!probeKey || !sessionId) {
      setProbe(null);
      return;
    }
    let cancelled = false;
    loadStaffView(sessionId)
      .then((payload) => {
        if (!cancelled) setProbe({ key: probeKey, players: payload?.players ?? null });
      })
      .catch(() => {
        if (!cancelled) setProbe({ key: probeKey, players: null });
      });
    return () => {
      cancelled = true;
    };
  }, [probeKey, sessionId]);

  const pending = probeKey !== '' && probe?.key !== probeKey;
  const players = !pending && probe?.key === probeKey ? probe.players : null;
  const subject = players?.find((player) => player.userId === requested) ?? null;

  // Publish before children render, so their first read and their fetches use the subject.
  const claim = useRef(0);
  claim.current = retainViewAsFrame(
    subject && sessionId ? { sessionId, userId: subject.userId, name: subject.name } : null,
  );

  useLayoutEffect(() => {
    return () => releaseViewAsFrame(claim.current);
  }, []);

  if (pending) return null;
  if (!subject || !players) return children;

  return (
    <SurfaceReadOnlyProvider readOnly>
      {children}
      <ViewAsBanner
        player={subject}
        players={players}
        onSwitch={(userId) => {
          navigate(`/sim/${sessionId}/desktop?view_as=${encodeURIComponent(userId)}`);
        }}
        onExit={() => navigate(`/sim/${sessionId}/trainer`)}
      />
    </SurfaceReadOnlyProvider>
  );
}
