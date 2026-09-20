import { useEffect, useRef, useState } from 'react';

/**
 * Ease a number towards a new value instead of snapping to it.
 *
 * The gauge bars already slide over 500ms, but the figures above them jumped,
 * which reads as the display glitching rather than the situation changing. On a
 * trust score that is actively falling, the movement is the information — a
 * trainer glancing up should be able to tell the direction without having to
 * remember what the number was a moment ago.
 *
 * Interruptible: if a new value arrives mid-flight the animation continues from
 * wherever it currently is rather than restarting from the previous target, so
 * a rapid series of updates reads as one continuous slide.
 */
export function useCountUp(target: number, durationMs = 700): number {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const [display, setDisplay] = useState(safeTarget);
  // The value actually on screen right now, so an interrupted run resumes.
  const currentRef = useRef(safeTarget);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const from = currentRef.current;
    if (reduceMotion || from === safeTarget) {
      currentRef.current = safeTarget;
      setDisplay(safeTarget);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = from + (safeTarget - from) * eased;
      currentRef.current = value;
      setDisplay(value);
      if (t < 1) frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [safeTarget, durationMs]);

  return display;
}

/**
 * Rolling history of a metric, for drawing a live trend line.
 *
 * Kept in the component rather than fetched, because the dashboard already
 * receives every update it needs over the socket and the 12s poll — there is no
 * reason to ask the server for a series it is effectively already streaming.
 */
export function useMetricHistory(value: number, cap = 40): number[] {
  const [history, setHistory] = useState<number[]>(() => (Number.isFinite(value) ? [value] : []));
  const lastRef = useRef<number | null>(null);

  useEffect(() => {
    if (!Number.isFinite(value)) return;
    // Only record genuine movement; the poll re-delivers the same number every
    // 12 seconds and a flat run of duplicates makes the curve unreadable.
    if (lastRef.current !== null && Math.abs(lastRef.current - value) < 0.5) return;
    lastRef.current = value;
    setHistory((prev) => [...prev, value].slice(-cap));
  }, [value, cap]);

  return history;
}
