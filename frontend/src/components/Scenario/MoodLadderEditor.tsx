import { useState } from 'react';
import {
  MOOD_RECOVERIES,
  moodPreviewLine,
  type MoodCond,
  type MoodConsequence,
  type MoodLadder,
  type MoodRecovery,
  type MoodRung,
  type MoodWhen,
  type WaitProfile,
} from '@shared/moodLadder';

const inputCls =
  'w-full text-xs bg-surface border border-border rounded px-1.5 py-1 text-ink';
const narrowCls = 'w-16 text-xs bg-surface border border-border rounded px-1.5 py-1 text-ink';

const TONES = [
  'dismissive',
  'evasive',
  'hostile',
  'defensive',
  'professional',
  'empathetic',
  'apologetic',
  'neutral',
];

const CONSEQUENCE_TYPES = [
  'publish_inject',
  'verdict_lock',
  'persuadability',
  'grievance_append',
  'stop_chains',
  'notify_trainer',
] as const;

export interface LadderInjectOption {
  key: string;
  title: string;
  conditional: boolean;
}

const RECOVERY_LABEL: Record<MoodRecovery, string> = {
  one_rung_per_good_reply: 'one step per good reply',
  reset_on_good_reply: 'back to calm on a good reply',
  none: 'does not recover',
};

type CondKind =
  | 'wait_minutes_gte'
  | 'missed_calls_gte'
  | 'unanswered_messages_gte'
  | 'followups_sent_gte'
  | 'prior_tone_in'
  | 'prior_failed_gte'
  | 'prior_passed_gte';

const COND_LABEL: Record<CondKind, string> = {
  wait_minutes_gte: 'waited ≥',
  missed_calls_gte: 'missed calls ≥',
  unanswered_messages_gte: 'unanswered ≥',
  followups_sent_gte: 'follow-ups ≥',
  prior_tone_in: 'last tone ∈',
  prior_failed_gte: 'failed replies ≥',
  prior_passed_gte: 'passed replies ≥',
};

function condKind(cond: MoodCond): CondKind {
  if (cond.missed_calls_gte != null) return 'missed_calls_gte';
  if (cond.unanswered_messages_gte != null) return 'unanswered_messages_gte';
  if (cond.followups_sent_gte != null) return 'followups_sent_gte';
  if (cond.prior_tone_in != null) return 'prior_tone_in';
  if (cond.prior_failed_gte != null) return 'prior_failed_gte';
  if (cond.prior_passed_gte != null) return 'prior_passed_gte';
  return 'wait_minutes_gte';
}

function condOfKind(kind: CondKind): MoodCond {
  if (kind === 'prior_tone_in') return { prior_tone_in: ['dismissive'] };
  if (kind === 'wait_minutes_gte') return { wait_minutes_gte: 5 };
  return { [kind]: 1 };
}

export function MoodLadderEditor({
  fieldId,
  ladder,
  onChange,
  injects,
  errors,
}: {
  fieldId: string;
  ladder: MoodLadder;
  onChange: (next: MoodLadder) => void;
  injects: LadderInjectOption[];
  errors: string[];
}) {
  const [waited, setWaited] = useState(14);
  const [missed, setMissed] = useState(2);
  const [unanswered, setUnanswered] = useState(1);
  const [tone, setTone] = useState('');
  const gaveUp = ladder.gave_up_after_minutes ?? 30;
  const profile: WaitProfile = {
    at_minute: waited,
    episode_anchor_minute: 0,
    wait_minutes: Number.isFinite(waited) ? waited : 0,
    missed_calls: Number.isFinite(missed) ? missed : 0,
    unanswered_messages: Number.isFinite(unanswered) ? unanswered : 0,
    followups_sent: 0,
    prior_tones: tone ? [tone] : [],
    prior_failed: 0,
    prior_passed: 0,
    gave_up_after: gaveUp,
  };
  const preview = ladder.rungs.length > 0 ? moodPreviewLine(ladder, profile) : null;
  const updateRung = (index: number, patch: Partial<MoodRung>) => {
    onChange({
      ...ladder,
      rungs: ladder.rungs.map((rung, i) => (i === index ? { ...rung, ...patch } : rung)),
    });
  };

  return (
    <div className="mt-3 border border-border rounded p-2 bg-surface-2 space-y-2">
      <div className="text-[11px] font-semibold text-ink">Mood when kept waiting</div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink">
        <label className="flex items-center gap-1.5">
          Gives up after
          <input
            aria-label="Gives up after minutes"
            type="number"
            min={1}
            disabled={ladder.gave_up_after_minutes == null}
            value={ladder.gave_up_after_minutes ?? 30}
            onChange={(event) =>
              onChange({ ...ladder, gave_up_after_minutes: Number(event.target.value) })
            }
            className={narrowCls}
          />
          min
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={ladder.gave_up_after_minutes == null}
            onChange={(event) =>
              onChange({
                ...ladder,
                gave_up_after_minutes: event.target.checked ? null : 30,
              })
            }
          />
          Use the call-back window (30 min)
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink">
        <span className="text-muted">When very upset this person gets</span>
        {(['angry', 'disappointed'] as const).map((variant) => (
          <label key={variant} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`escalated-variant-${fieldId}`}
              checked={ladder.escalated_variant === variant}
              onChange={() => onChange({ ...ladder, escalated_variant: variant })}
            />
            {variant}
          </label>
        ))}
        <label className="flex items-center gap-1.5">
          Recovers
          <select
            aria-label="Mood recovery"
            value={ladder.recovery}
            onChange={(event) =>
              onChange({ ...ladder, recovery: event.target.value as MoodRecovery })
            }
            className={`${inputCls} w-auto`}
          >
            {MOOD_RECOVERIES.map((recovery) => (
              <option key={recovery} value={recovery}>
                {RECOVERY_LABEL[recovery]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="space-y-2">
        {ladder.rungs.map((rung, index) => (
          <RungCard
            key={`${rung.id}-${index}`}
            rung={rung}
            first={index === 0}
            injects={injects}
            onChange={(patch) => updateRung(index, patch)}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink">
        <span className="text-muted">Preview</span>
        <label className="flex items-center gap-1">
          waited
          <input
            aria-label="Preview minutes waited"
            type="number"
            min={0}
            value={waited}
            onChange={(event) => setWaited(Number(event.target.value))}
            className={narrowCls}
          />
          min
        </label>
        <label className="flex items-center gap-1">
          missed
          <input
            aria-label="Preview missed calls"
            type="number"
            min={0}
            value={missed}
            onChange={(event) => setMissed(Number(event.target.value))}
            className={narrowCls}
          />
        </label>
        <label className="flex items-center gap-1">
          unanswered
          <input
            aria-label="Preview unanswered messages"
            type="number"
            min={0}
            value={unanswered}
            onChange={(event) => setUnanswered(Number(event.target.value))}
            className={narrowCls}
          />
        </label>
        <label className="flex items-center gap-1">
          last tone
          <select
            aria-label="Preview last tone"
            value={tone}
            onChange={(event) => setTone(event.target.value)}
            className={`${inputCls} w-auto`}
          >
            <option value="">—</option>
            {TONES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>
      {preview && (
        <p className="text-[11px] text-ink">
          → {preview.label}
          {preview.opening ? ` · opening: “${preview.opening}”` : ' · opening: (default)'}
        </p>
      )}
      {preview && (
        <pre className="text-[10px] text-muted whitespace-pre-wrap bg-surface border border-border rounded p-2">
          {preview.block}
        </pre>
      )}
      {errors.map((message) => (
        <p key={message} className="text-[11px] text-danger">
          {message}
        </p>
      ))}
    </div>
  );
}

function RungCard({
  rung,
  first,
  injects,
  onChange,
}: {
  rung: MoodRung;
  first: boolean;
  injects: LadderInjectOption[];
  onChange: (patch: Partial<MoodRung>) => void;
}) {
  const when = rung.when ?? {};
  const setBucket = (bucket: 'any' | 'all', conds: MoodCond[]) => {
    const next: MoodWhen = { ...when };
    if (conds.length === 0) delete next[bucket];
    else next[bucket] = conds;
    onChange({ when: next });
  };
  return (
    <div className="border border-border rounded p-2 bg-surface">
      <div className="text-[11px] font-semibold text-ink">
        {rung.label}
        <span className="text-muted font-normal"> · {rung.id}</span>
        {rung.terminal ? <span className="text-muted font-normal"> · gives up</span> : null}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 mt-1">
        <div>
          <div className="text-[10px] text-muted mb-1">Reached when</div>
          {first ? (
            <p className="text-[11px] text-muted">— base mood</p>
          ) : (
            <>
              <CondList
                label="any"
                conds={when.any ?? []}
                onChange={(conds) => setBucket('any', conds)}
              />
              <CondList
                label="all"
                conds={when.all ?? []}
                onChange={(conds) => setBucket('all', conds)}
              />
            </>
          )}
        </div>
        <div>
          <div className="text-[10px] text-muted mb-1">Says</div>
          <input
            aria-label={`${rung.label} opening`}
            value={rung.script.opening ?? ''}
            placeholder="(default)"
            onChange={(event) =>
              onChange({
                script: {
                  ...rung.script,
                  opening: event.target.value.trim() ? event.target.value : null,
                },
              })
            }
            className={inputCls}
          />
          {rung.script.lines.map((line, index) => (
            <div key={index} className="flex gap-1 mt-1">
              <input
                aria-label={`${rung.label} line ${index + 1}`}
                value={line}
                onChange={(event) => {
                  const lines = rung.script.lines.map((item, i) =>
                    i === index ? event.target.value : item,
                  );
                  onChange({ script: { ...rung.script, lines } });
                }}
                className={inputCls}
              />
              <button
                type="button"
                aria-label={`Remove ${rung.label} line ${index + 1}`}
                onClick={() =>
                  onChange({
                    script: {
                      ...rung.script,
                      lines: rung.script.lines.filter((_, i) => i !== index),
                    },
                  })
                }
                className="text-muted hover:text-danger text-xs"
              >
                ✕
              </button>
            </div>
          ))}
          {rung.script.lines.length < 3 && (
            <button
              type="button"
              onClick={() =>
                onChange({ script: { ...rung.script, lines: [...rung.script.lines, ''] } })
              }
              className="text-[10px] text-brand hover:underline mt-1"
            >
              + line
            </button>
          )}
          <textarea
            aria-label={`${rung.label} reply style`}
            value={rung.reply_style}
            rows={2}
            onChange={(event) => onChange({ reply_style: event.target.value })}
            className={`${inputCls} resize-y mt-1`}
          />
        </div>
        <div>
          <div className="text-[10px] text-muted mb-1">Then</div>
          {rung.consequences.map((consequence, index) => (
            <ConsequenceRow
              key={index}
              consequence={consequence}
              injects={injects}
              onChange={(next) => {
                const consequences = rung.consequences.map((item, i) => (i === index ? next : item));
                onChange({ consequences });
              }}
              onRemove={() =>
                onChange({ consequences: rung.consequences.filter((_, i) => i !== index) })
              }
            />
          ))}
          <button
            type="button"
            onClick={() =>
              onChange({
                consequences: [...rung.consequences, { type: 'notify_trainer' }],
              })
            }
            className="text-[10px] text-brand hover:underline"
          >
            + consequence
          </button>
        </div>
      </div>
    </div>
  );
}

function CondList({
  label,
  conds,
  onChange,
}: {
  label: 'any' | 'all';
  conds: MoodCond[];
  onChange: (next: MoodCond[]) => void;
}) {
  return (
    <div className="mb-1">
      <div className="text-[10px] text-muted">{label}</div>
      {conds.map((cond, index) => (
        <div key={index} className="flex items-center gap-1 mt-0.5">
          <select
            aria-label={`${label} condition ${index + 1}`}
            value={condKind(cond)}
            onChange={(event) => {
              const next = conds.map((item, i) =>
                i === index ? condOfKind(event.target.value as CondKind) : item,
              );
              onChange(next);
            }}
            className={inputCls}
          >
            {(Object.keys(COND_LABEL) as CondKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {COND_LABEL[kind]}
              </option>
            ))}
          </select>
          <CondValue
            cond={cond}
            onChange={(next) => onChange(conds.map((item, i) => (i === index ? next : item)))}
          />
          <button
            type="button"
            aria-label={`Remove ${label} condition ${index + 1}`}
            onClick={() => onChange(conds.filter((_, i) => i !== index))}
            className="text-muted hover:text-danger"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...conds, { wait_minutes_gte: 5 }])}
        className="text-[10px] text-brand hover:underline"
      >
        + {label}
      </button>
    </div>
  );
}

function CondValue({ cond, onChange }: { cond: MoodCond; onChange: (next: MoodCond) => void }) {
  if (cond.prior_tone_in) {
    const selected = new Set(cond.prior_tone_in);
    return (
      <span className="flex flex-wrap gap-1">
        {TONES.map((tone) => (
          <label key={tone} className="flex items-center gap-0.5 text-[10px] text-ink">
            <input
              type="checkbox"
              checked={selected.has(tone)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(tone);
                else next.delete(tone);
                onChange({ prior_tone_in: TONES.filter((item) => next.has(item)) });
              }}
            />
            {tone}
          </label>
        ))}
      </span>
    );
  }
  if (cond.wait_minutes_gte === 'gave_up_after') {
    return <span className="text-[10px] text-muted whitespace-nowrap">gives-up time</span>;
  }
  const kind = condKind(cond);
  const value = cond[kind];
  return (
    <input
      aria-label="Condition threshold"
      type="number"
      min={0}
      value={typeof value === 'number' ? value : 0}
      onChange={(event) => onChange({ [kind]: Number(event.target.value) })}
      className={narrowCls}
    />
  );
}

function ConsequenceRow({
  consequence,
  injects,
  onChange,
  onRemove,
}: {
  consequence: MoodConsequence;
  injects: LadderInjectOption[];
  onChange: (next: MoodConsequence) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 mb-1">
      <select
        aria-label="Consequence type"
        value={consequence.type}
        onChange={(event) => onChange(consequenceOf(event.target.value))}
        className={`${inputCls} w-auto`}
      >
        {CONSEQUENCE_TYPES.map((type) => (
          <option key={type} value={type}>
            {type.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      {consequence.type === 'publish_inject' && (
        <select
          aria-label="Press inject"
          value={consequence.inject_key}
          onChange={(event) => onChange({ type: 'publish_inject', inject_key: event.target.value })}
          className={`${inputCls} w-auto max-w-[12rem]`}
        >
          <option value="">Choose inject</option>
          {injects
            .filter((item) => item.conditional || item.key === consequence.inject_key)
            .map((item) => (
              <option key={item.key} value={item.key}>
                {item.title}
              </option>
            ))}
        </select>
      )}
      {consequence.type === 'persuadability' && (
        <select
          aria-label="Persuadability"
          value={consequence.value}
          onChange={(event) => onChange({ type: 'persuadability', value: event.target.value })}
          className={`${inputCls} w-auto`}
        >
          {['none', 'low', 'medium', 'high'].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      )}
      {consequence.type === 'grievance_append' && (
        <input
          aria-label="Grievance line"
          value={consequence.text}
          onChange={(event) => onChange({ type: 'grievance_append', text: event.target.value })}
          className={inputCls}
        />
      )}
      {consequence.type === 'notify_trainer' && (
        <input
          aria-label="Trainer note"
          value={consequence.message ?? ''}
          placeholder="optional note"
          onChange={(event) =>
            onChange({
              type: 'notify_trainer',
              ...(event.target.value.trim() ? { message: event.target.value } : {}),
            })
          }
          className={inputCls}
        />
      )}
      <button type="button" onClick={onRemove} className="text-muted hover:text-danger" aria-label="Remove consequence">
        ✕
      </button>
    </div>
  );
}

function consequenceOf(type: string): MoodConsequence {
  if (type === 'publish_inject') return { type: 'publish_inject', inject_key: '' };
  if (type === 'verdict_lock') return { type: 'verdict_lock', value: 'keep' };
  if (type === 'persuadability') return { type: 'persuadability', value: 'low' };
  if (type === 'grievance_append') return { type: 'grievance_append', text: '' };
  if (type === 'stop_chains') return { type: 'stop_chains' };
  return { type: 'notify_trainer' };
}
