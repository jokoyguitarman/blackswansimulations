import { useEffect, useRef, useState } from 'react';
import { getBuild, type HeaderSource } from './buildClient';
import {
  emptyPollState,
  nextPollDelayMs,
  reducePoll,
  type BuildView,
  type PollState,
} from './buildStatus';

/** Proxy and gateway statuses a Render deploy produces while the new process boots. */
export function isTransientPollStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 502 || status === 503 || status === 504;
}

/**
 * Poll one build until it leaves `queued` or `running`. Network errors, timeouts
 * and deploy statuses (502/503/504) back off and show reconnecting. They never
 * end the build. A 401 just waits for the next tick, which reads a fresh token.
 * A 404 reports the build as gone. `nonce` restarts the loop after Resume.
 */
export function useBuildPolling(
  buildId: string | null,
  nonce: number,
  headers: HeaderSource,
  onUpdate: (view: BuildView, state: PollState) => void,
  onLost: () => void,
): { reconnecting: boolean } {
  const [reconnecting, setReconnecting] = useState(false);
  const onUpdateRef = useRef(onUpdate);
  const onLostRef = useRef(onLost);
  const headersRef = useRef(headers);
  onUpdateRef.current = onUpdate;
  onLostRef.current = onLost;
  headersRef.current = headers;

  useEffect(() => {
    if (!buildId) {
      setReconnecting(false);
      return;
    }
    let stopped = false;
    let timer = 0;
    let state = emptyPollState();

    const delay = () =>
      nextPollDelayMs(state.consecutiveErrors, document.visibilityState === 'hidden');

    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), ms);
    };

    const tick = async () => {
      if (stopped) return;
      const result = await getBuild(buildId, state.nextAfter, () => headersRef.current());
      if (stopped) return;
      if (result.status === 404) {
        onLostRef.current();
        return;
      }
      const payload = result.data;
      if (!result.ok || !payload?.build) {
        state = reducePoll(state, {
          type: 'poll_error',
          transient: isTransientPollStatus(result.status) || result.status >= 500,
        });
        setReconnecting(state.reconnecting);
        schedule(delay());
        return;
      }
      state = reducePoll(state, {
        type: 'poll_ok',
        log: payload.log ?? [],
        nextAfter: payload.next_after ?? state.nextAfter,
      });
      setReconnecting(false);
      onUpdateRef.current(payload.build, state);
      if (payload.build.status === 'queued' || payload.build.status === 'running') {
        schedule(delay());
      }
    };

    const soon = () => {
      if (document.visibilityState === 'hidden') return;
      schedule(0);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') soon();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', soon);
    void tick();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', soon);
    };
  }, [buildId, nonce]);

  return { reconnecting };
}
