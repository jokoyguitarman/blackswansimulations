/**
 * A live trend line for a single metric.
 *
 * The dashboard could tell a trainer what public trust IS, but not what it was
 * doing — and in a crisis exercise the direction matters more than the level.
 * A score of 48 falling fast and a score of 48 recovering call for opposite
 * interventions, and the gauge alone cannot tell them apart.
 *
 * The path re-draws itself whenever a new point lands, so movement is visible
 * from across a room.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';

interface Props {
  history: number[];
  /** Line colour. Usually the same tone the gauge is already using. */
  color: string;
  width?: number;
  height?: number;
  /** Draw a faint fill under the line. */
  fill?: boolean;
}

export function MetricSparkline({
  history,
  color,
  width = 220,
  height = 44,
  fill = true,
}: Props): ReactElement | null {
  const pathRef = useRef<SVGPathElement>(null);
  const [len, setLen] = useState(0);

  // Re-run the draw whenever the series grows, so a new reading visibly extends
  // the line rather than silently appearing.
  useEffect(() => {
    const el = pathRef.current;
    if (!el) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const total = el.getTotalLength();
    setLen(total);
    if (reduceMotion || total === 0) return;
    el.animate([{ strokeDashoffset: total * 0.18 }, { strokeDashoffset: 0 }], {
      duration: 520,
      easing: 'cubic-bezier(.33,.7,.4,1)',
      fill: 'both',
    });
  }, [history]);

  if (history.length < 2) return null;

  const pad = 3;
  const lo = Math.min(...history);
  const hi = Math.max(...history);
  // A flat series would divide by zero and also deserves a flat line, not noise.
  const span = hi - lo < 1 ? 1 : hi - lo;

  const pts = history.map((v, i) => {
    const x = pad + (i / (history.length - 1)) * (width - pad * 2);
    const y = height - pad - ((v - lo) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {fill && <path d={area} fill={color} opacity={0.1} />}
      <path
        ref={pathRef}
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={len || undefined}
      />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.8} fill={color} />
    </svg>
  );
}
