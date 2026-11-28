import { useEffect, useRef, useState } from 'react';
import { getBuild, type HeaderSource } from './buildClient';
import {
  claimPollTick,
  classifyPollStop,
  continuePolling,
  emptyPollState,
  isDeployGap,
  nextPollDelayMs,
  reducePoll,
  type BuildView,
  type PollState,
} from './buildStatus';

export { isDeployGap as isTransientPollStatus } from './buildStatus';

/**
 * Poll one build until it leaves `queued` or `running`. Network errors, timeouts
 * and deploy statuses (502/503/504) back off and show reconnecting. They never
 * end the build. A 401 just waits for the next tick, which reads a fresh token.
 * 404, 403 and 501 stop the loop. `nonce` restarts it after Resume.
 */
export function useBuildPolling(
  buildId: string | null,
  nonce: number,
  headers: HeaderSource,
  onUpdate: (view: BuildView, state: PollState) => void,
  onHalt: (reason: 'lost' | 'denied' | 'unavailable') => void,
): { reconnecting: boolean } {
  const [reconnecting, setReconnecting] = useState(false);
  const onUpdateRef = useRef(onUpdate);
  const onHaltRef = useRef(onHalt);
  const headersRef = useRef(headers);
  onUpdateRef.current = onUpdate;
  onHaltRef.current = onHalt;
  headersRef.current = headers;

  useEffect(() => {
    if (!buildId) {
      setReconnecting(false);
      return;
    }
    let stopped = false;
    let timer = 0;
    let inFlight = false;
    let wakeAgain = false;
    let state = emptyPollState();

    const delay = () =>
      nextPollDelayMs(state.consecutiveErrors, document.visibilityState === 'hidden');

    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), ms);
    };

    const tick = async () => {
      if (stopped) return;
      if (claimPollTick(inFlight) === 'queue') {
        wakeAgain = true;
        return;
      }
      inFlight = true;
      wakeAgain = false;
      try {
        const result = await getBuild(buildId, state.nextAfter, () => headersRef.current());
        if (stopped) return;
        const halt = classifyPollStop(result.status);
        if (halt) {
          stopped = true;
          setReconnecting(false);
          onHaltRef.current(halt);
          return;
        }
        const payload = result.data;
        if (!result.ok || !payload?.build) {
          state = reducePoll(state, {
            type: 'poll_error',
            transient: isDeployGap(result.status),
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
        if (continuePolling(payload.build.status)) schedule(delay());
        else stopped = true;
      } finally {
        inFlight = false;
        if (wakeAgain && !stopped) {
          wakeAgain = false;
          schedule(0);
        }
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
