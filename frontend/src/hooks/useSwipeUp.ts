import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

interface UseSwipeUpOptions {
  onTrigger: () => void;
  /** Minimum upward distance (px) for a quick flick. */
  threshold?: number;
  /** Max duration (ms) for the flick to count with just `threshold`. */
  fastMs?: number;
  /** Upward distance (px) that always triggers regardless of speed. */
  farPx?: number;
  /** Duration of the leave animation before `onTrigger` fires. */
  leaveMs?: number;
}

/**
 * Pointer-event swipe-up gesture (touch + mouse). Attach `handlers` to the drag handle and
 * `style` to the element that should follow the finger. Elements using it must not rely on
 * native vertical scrolling (the handle sets `touch-action: none`).
 */
export function useSwipeUp({
  onTrigger,
  threshold = 40,
  fastMs = 400,
  farPx = 120,
  leaveMs = 180,
}: UseSwipeUpOptions) {
  const startY = useRef<number | null>(null);
  const startT = useRef(0);
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const reset = useCallback(() => {
    startY.current = null;
    setDragging(false);
    setDy(0);
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== undefined && e.button !== 0) return;
    startY.current = e.clientY;
    startT.current = Date.now();
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (startY.current === null) return;
    setDy(Math.min(0, e.clientY - startY.current));
  }, []);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (startY.current === null) return;
      const d = e.clientY - startY.current;
      const dt = Date.now() - startT.current;
      startY.current = null;
      setDragging(false);
      const flick = d <= -threshold && dt <= fastMs;
      if (flick || d <= -farPx) {
        setLeaving(true);
        window.setTimeout(() => {
          onTrigger();
          setLeaving(false);
          setDy(0);
        }, leaveMs);
      } else {
        setDy(0);
      }
    },
    [onTrigger, threshold, fastMs, farPx, leaveMs],
  );

  const style: CSSProperties = {
    transform: leaving ? 'translateY(-130%)' : `translateY(${dy}px)`,
    transition: dragging ? 'none' : `transform ${leaveMs}ms ease-out`,
    opacity: leaving ? 0 : 1,
  };

  const handleStyle: CSSProperties = { touchAction: 'none' };

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: reset },
    style,
    handleStyle,
    dragging,
    leaving,
  };
}
