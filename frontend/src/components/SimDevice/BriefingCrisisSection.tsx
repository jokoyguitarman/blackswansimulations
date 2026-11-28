export const BRIEF_LABEL = 'text-[11px] font-semibold uppercase tracking-wider mb-1.5';

interface Props {
  locked: boolean;
  text: string | null;
}

/**
 * Crisis brief inside the desktop briefing. The lock shows no countdown and
 * no crisis text. Org and role copy stays in the parent.
 */
export function BriefingCrisisSection({ locked, text }: Props) {
  if (locked) {
    return (
      <div>
        <div className={BRIEF_LABEL} style={{ color: 'rgba(255,255,255,0.4)' }}>
          Crisis brief
        </div>
        <p className="text-[13px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
          Locked until the crisis starts.
        </p>
      </div>
    );
  }
  if (!text) return null;
  return (
    <div>
      <div className={BRIEF_LABEL} style={{ color: 'rgba(255,255,255,0.4)' }}>
        Crisis brief
      </div>
      <p className="text-[13px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.85)' }}>
        {text}
      </p>
    </div>
  );
}
