import { useEffect, useState } from 'react';

/**
 * Screen wake lock for a long build on a phone.
 * Requests `screen` while `active` and the page is visible, asks again when the
 * page returns to the foreground, and releases when `active` turns false or the
 * component unmounts. Unsupported browsers and NotAllowedError are ignored.
 */
export function useWakeLock(active: boolean): { supported: boolean; held: boolean } {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!active || !supported) {
      setHeld(false);
      return;
    }

    let cancelled = false;
    let pending = false;
    let sentinel: WakeLockSentinel | null = null;

    const acquire = async () => {
      if (cancelled || pending || sentinel) return;
      if (document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (cancelled || document.visibilityState !== 'visible') {
          try {
            await next.release();
          } catch {
            /* already released */
          }
          return;
        }
        sentinel = next;
        setHeld(true);
        next.addEventListener('release', () => {
          if (sentinel !== next) return;
          sentinel = null;
          if (!cancelled) setHeld(false);
        });
      } catch {
        // NotAllowedError (page hidden or permission denied) and any other rejection.
        if (!cancelled) setHeld(false);
      } finally {
        pending = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const current = sentinel;
      sentinel = null;
      setHeld(false);
      if (current) {
        current.release().catch(() => {
          /* already released */
        });
      }
    };
  }, [active, supported]);

  return { supported, held };
}
