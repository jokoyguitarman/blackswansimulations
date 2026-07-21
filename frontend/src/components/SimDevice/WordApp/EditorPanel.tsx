import type { CSSProperties } from 'react';
import { WordIcon } from './Icons';
import type { ContentGrade } from './types';

const METRICS: Array<{ key: keyof ContentGrade; label: string }> = [
  { key: 'accuracy', label: 'Accuracy' },
  { key: 'tone', label: 'Tone' },
  { key: 'clarity', label: 'Clarity' },
  { key: 'cultural_sensitivity', label: 'Sensitivity' },
  { key: 'persuasiveness', label: 'Persuasiveness' },
  { key: 'completeness', label: 'Completeness' },
  { key: 'role_fit', label: 'Role fit' },
];

function scoreColor(score: number): string {
  if (score >= 70) return 'var(--docs-success)';
  if (score >= 40) return 'var(--docs-warning)';
  return 'var(--docs-danger)';
}

export function EditorPanel({
  grade,
  grading,
  onGrade,
  onClose,
  mode,
}: {
  grade: ContentGrade | null;
  grading: boolean;
  onGrade: () => void;
  onClose: () => void;
  mode: 'sheet' | 'pane';
}) {
  const overall = Math.round(Number(grade?.overall ?? 0));

  return (
    <div className={`docs-editor-panel docs-editor-panel-${mode}`}>
      {mode === 'sheet' && <div className="docs-sheet-handle" />}
      <div className="docs-editor-panel-head">
        <div>
          <span className="docs-editor-kicker">AI writing review</span>
          <h2>Editor</h2>
        </div>
        <button className="docs-icon-button" onClick={onClose} aria-label="Close Editor">
          <WordIcon name="x" />
        </button>
      </div>

      {!grade ? (
        <div className="docs-editor-empty">
          <span className="docs-editor-empty-icon">
            <WordIcon name="sparkle" size={28} />
          </span>
          <strong>Review this document</strong>
          <p>
            Editor checks crisis facts, tone, clarity, completeness, and whether the response fits
            the author's team mandate.
          </p>
          <button className="docs-primary-button" onClick={onGrade} disabled={grading}>
            {grading ? 'Reviewing…' : 'Run Editor'}
          </button>
        </div>
      ) : (
        <div className="docs-editor-results">
          <div
            className="docs-editor-score"
            style={{ '--score-color': scoreColor(overall) } as CSSProperties}
          >
            <strong>{overall}</strong>
            <span>overall</span>
          </div>

          <div className="docs-editor-metrics">
            {METRICS.map(({ key, label }) => {
              const raw = grade[key];
              if (typeof raw !== 'number') return null;
              const value = Math.round(raw);
              return (
                <div className="docs-editor-metric" key={key}>
                  <div>
                    <span>{label}</span>
                    <strong style={{ color: scoreColor(value) }}>{value}</strong>
                  </div>
                  <div className="docs-editor-metric-track">
                    <span
                      style={{
                        width: `${Math.min(100, Math.max(0, value))}%`,
                        background: scoreColor(value),
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {grade.feedback && <p className="docs-editor-feedback">{grade.feedback}</p>}

          {grade.strengths && grade.strengths.length > 0 && (
            <div className="docs-editor-list docs-editor-strengths">
              <strong>Strengths</strong>
              <ul>
                {grade.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {grade.improvements && grade.improvements.length > 0 && (
            <div className="docs-editor-list docs-editor-improvements">
              <strong>Improvements</strong>
              <ul>
                {grade.improvements.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          <button className="docs-primary-button" onClick={onGrade} disabled={grading}>
            {grading ? 'Reviewing…' : 'Review again'}
          </button>
        </div>
      )}
    </div>
  );
}
