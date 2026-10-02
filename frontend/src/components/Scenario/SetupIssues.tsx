import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { WrIcon } from '../UI/WarRoomIcon';
import { pickIssue, type SetupIssue } from './setupValidation';

interface SetupIssuesValue {
  index: Map<string, SetupIssue[]>;
  reveal: boolean;
}

const SetupIssuesContext = createContext<SetupIssuesValue | null>(null);

export function SetupIssuesProvider({
  index,
  reveal,
  children,
}: {
  index: Map<string, SetupIssue[]>;
  reveal: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ index, reveal }), [index, reveal]);
  return <SetupIssuesContext.Provider value={value}>{children}</SetupIssuesContext.Provider>;
}

/** Issue lookup for Setup inputs; outside a provider every field reads as clean. */
export function useIssueLookup(): (field: string) => SetupIssue | null {
  const ctx = useContext(SetupIssuesContext);
  return useCallback(
    (field: string) => (ctx ? pickIssue(ctx.index.get(field), ctx.reveal) : null),
    [ctx],
  );
}

export function issueClass(issue: SetupIssue | null): string {
  if (!issue) return '';
  return issue.severity === 'error' ? 'wr-invalid' : 'wr-warn';
}

export function FieldNote({ issue, onDark }: { issue: SetupIssue | null; onDark?: boolean }) {
  if (!issue) return null;
  const warn = issue.severity === 'warning';
  return (
    <div className={`wr-note${warn ? ' warn' : ''}${onDark ? ' onDark' : ''}`}>
      <WrIcon name={warn ? 'info' : 'alert'} size={13} />
      <span>{issue.message}</span>
    </div>
  );
}

/** Scrolls a `data-field` anchor into view, focuses its input and pulses it. */
export function jumpToField(field: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`);
  if (!el) return false;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  const controls = el.matches('input, textarea, select')
    ? [el]
    : Array.from(el.querySelectorAll<HTMLElement>('input, textarea, select'));
  // Whole-block anchors (a roster, a rival card) hold several inputs or none: scroll only.
  const target = controls.length === 1 ? controls[0] : el;
  if (controls.length === 1) target.focus({ preventScroll: true });
  if (!reduce) {
    target.animate(
      [
        { boxShadow: '0 0 0 0 rgba(217, 119, 6, 0.55)' },
        { boxShadow: '0 0 0 12px rgba(217, 119, 6, 0)' },
      ],
      { duration: 750, iterations: 2, easing: 'ease-out' },
    );
  }
  return true;
}

function IssueRow({ issue, onPick }: { issue: SetupIssue; onPick: (issue: SetupIssue) => void }) {
  const body = (
    <>
      <span className={`dot${issue.severity === 'warning' ? ' warn' : ''}`} />
      <span className="txt">
        <span className="where">{issue.where}</span>
        <span className="msg">{issue.message}</span>
      </span>
    </>
  );
  return issue.field ? (
    <button type="button" className="row" onClick={() => onPick(issue)}>
      {body}
    </button>
  ) : (
    <div className="row">{body}</div>
  );
}

/** "3 things to fix" chip for the CTA bar; opens a list that jumps to each field. */
export function SetupIssueSummary({
  errors,
  warnings,
  open,
  onOpenChange,
}: {
  errors: SetupIssue[];
  warnings: SetupIssue[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  if (errors.length === 0 && warnings.length === 0) return null;
  const hasErrors = errors.length > 0;
  const pick = (issue: SetupIssue) => {
    onOpenChange(false);
    if (issue.field) jumpToField(issue.field);
  };

  return (
    <div className="wr-issues" ref={ref}>
      <button
        type="button"
        className={`wr-issuechip${hasErrors ? '' : ' warn'}`}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <WrIcon name={hasErrors ? 'alert' : 'info'} size={13} />
        <span aria-live="polite">
          {hasErrors
            ? `${errors.length} ${errors.length === 1 ? 'thing' : 'things'} to fix`
            : `${warnings.length} to double-check`}
        </span>
      </button>
      {open && (
        <div className="wr-issuepanel" role="dialog" aria-label="Setup checks">
          {hasErrors && <div className="head">Fix before building</div>}
          {errors.map((issue, i) => (
            <IssueRow key={`e${i}`} issue={issue} onPick={pick} />
          ))}
          {warnings.length > 0 && <div className="head warn">Worth a second look</div>}
          {warnings.map((issue, i) => (
            <IssueRow key={`w${i}`} issue={issue} onPick={pick} />
          ))}
        </div>
      )}
    </div>
  );
}
