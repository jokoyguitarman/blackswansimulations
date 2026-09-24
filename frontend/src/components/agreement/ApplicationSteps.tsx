const STEPS = ['Your details', 'Review and download', 'Sign and upload'] as const;
const COMPACT_STEPS = ['Details', 'Download', 'Sign and upload'] as const;

/** Progress through the application. `current` past the last step marks everything done. */
export function ApplicationSteps({
  current,
  compact = false,
}: {
  current: 1 | 2 | 3 | 4;
  /** Shorter labels for narrow cards such as the signup form. */
  compact?: boolean;
}) {
  const labels = compact ? COMPACT_STEPS : STEPS;
  return (
    <ol
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${compact ? 'justify-center' : ''}`}
      aria-label="Application steps"
    >
      {labels.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <li
            key={label}
            className="flex items-center gap-2"
            aria-current={active ? 'step' : undefined}
          >
            <span
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${
                done
                  ? 'bg-success text-white'
                  : active
                    ? 'bg-brand text-white'
                    : 'border border-border bg-surface-2 text-muted'
              }`}
            >
              {done ? (
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={3}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              ) : (
                step
              )}
            </span>
            <span className={`text-xs font-semibold ${active ? 'text-ink' : 'text-muted'}`}>
              {label}
            </span>
            {!compact && step < labels.length && (
              <span className="hidden h-px w-6 bg-border sm:block" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}
