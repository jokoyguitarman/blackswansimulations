import { useEffect, useRef, useState } from 'react';

/**
 * The single session-wide "bot intellect" control (docs/ai-teammate-bots-plan.md §9.1).
 * One slider for every AI teammate in the session; bots read the value on their next turn.
 */

export type IntellectBand = 'Novice' | 'Competent' | 'Proficient' | 'Expert';

export function intellectBand(value: number): IntellectBand {
  if (value < 25) return 'Novice';
  if (value < 50) return 'Competent';
  if (value < 75) return 'Proficient';
  return 'Expert';
}

const BAND_DESCRIPTIONS: Record<IntellectBand, string> = {
  Novice: 'Slow, vague, drifts out of lane, ignores misinformation and deadlines.',
  Competent: 'Answers what lands on its desk, mostly in lane, patchy on facts and timing.',
  Proficient: 'Fact-led and in lane, counters misinformation, coordinates through chat.',
  Expert: 'Fast, precise, reviews before publishing, relays intel, plays to the rubric.',
};

const BAND_COLOR: Record<IntellectBand, string> = {
  Novice: '#B45309',
  Competent: '#6B7280',
  Proficient: '#1E3A5F',
  Expert: '#047857',
};

interface Props {
  value: number;
  onCommit: (value: number) => Promise<void> | void;
  disabled?: boolean;
  compact?: boolean;
}

export function IntellectSlider({ value, onCommit, disabled, compact }: Props) {
  const [local, setLocal] = useState(value);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = useRef(value);

  useEffect(() => {
    // Accept external changes (another tab, websocket) when we are not mid-drag.
    if (!timer.current) {
      setLocal(value);
      lastCommitted.current = value;
    }
  }, [value]);

  const band = intellectBand(local);

  const change = (next: number) => {
    setLocal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      if (next === lastCommitted.current) return;
      setSaving(true);
      try {
        await onCommit(next);
        lastCommitted.current = next;
      } finally {
        setSaving(false);
      }
    }, 450);
  };

  return (
    <div className={compact ? '' : 'space-y-1'}>
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-bold uppercase tracking-wide text-muted">
          Bot intellect
        </label>
        <span className="text-xs font-bold" style={{ color: BAND_COLOR[band] }}>
          {band} · {local}
          {saving ? ' · saving…' : ''}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={local}
        disabled={disabled}
        onChange={(e) => change(Number(e.target.value))}
        className="w-full accent-brand"
        aria-label="Bot intellect"
        aria-valuetext={`${band} (${local})`}
      />
      <div className="flex justify-between text-[10px] text-muted">
        <span>Novice</span>
        <span>Competent</span>
        <span>Proficient</span>
        <span>Expert</span>
      </div>
      {!compact && <p className="text-xs text-muted">{BAND_DESCRIPTIONS[band]}</p>}
    </div>
  );
}
