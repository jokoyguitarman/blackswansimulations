export const RUBRIC_TONES = [
  'professional',
  'empathetic',
  'apologetic',
  'neutral',
  'defensive',
  'dismissive',
  'hostile',
  'evasive',
] as const;

const GENERIC_CRITERIA = [
  "Acknowledges the sender's message and concern",
  'Responds to what the sender asked for',
  'Consistent with the confirmed facts; introduces no unverified claims',
  'States a next step or commitment',
];

export interface RubricDraft {
  useGeneric: boolean;
  asks: string[];
  criteria: string[];
  tones: string[];
  passThreshold: number;
}

export interface RubricPayload {
  asks: string[];
  criteria: string[];
  expected_tone: string[];
  pass_threshold: number;
}

const inputCls =
  'w-full text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink disabled:opacity-60';

export function emptyRubricDraft(): RubricDraft {
  return {
    useGeneric: true,
    asks: [''],
    criteria: [''],
    tones: ['professional'],
    passThreshold: 2,
  };
}

export function rubricFromDelivery(raw: unknown): RubricDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyRubricDraft();
  const record = raw as Record<string, unknown>;
  const criteria = stringList(record.criteria);
  if (criteria.length === 0) return emptyRubricDraft();
  const tones = stringList(record.expected_tone).filter((tone) =>
    (RUBRIC_TONES as readonly string[]).includes(tone),
  );
  const threshold = record.pass_threshold;
  return {
    useGeneric: false,
    asks: stringList(record.asks),
    criteria,
    tones: tones.length > 0 ? tones : ['professional'],
    passThreshold:
      typeof threshold === 'number' && Number.isInteger(threshold) && threshold >= 1
        ? threshold
        : Math.min(2, criteria.length),
  };
}

export function rubricPayload(draft: RubricDraft): RubricPayload | null {
  if (draft.useGeneric) return null;
  const criteria = draft.criteria.map((item) => item.trim()).filter(Boolean);
  return {
    asks: draft.asks.map((item) => item.trim()).filter(Boolean),
    criteria,
    expected_tone: draft.tones.filter((tone) => (RUBRIC_TONES as readonly string[]).includes(tone)),
    pass_threshold: draft.passThreshold,
  };
}

export function rubricErrors(draft: RubricDraft): string[] {
  if (draft.useGeneric) return [];
  const payload = rubricPayload(draft);
  if (!payload) return [];
  const errors: string[] = [];
  if (payload.criteria.length === 0) errors.push('Add at least one rubric criterion');
  if (payload.expected_tone.length === 0) errors.push('Choose at least one expected tone');
  if (
    !Number.isInteger(payload.pass_threshold) ||
    payload.pass_threshold < 1 ||
    payload.pass_threshold > payload.criteria.length
  ) {
    errors.push('Pass threshold must be from 1 to the number of criteria');
  }
  return errors;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function RubricPanel({
  value,
  onChange,
}: {
  value: RubricDraft;
  onChange: (value: RubricDraft) => void;
}) {
  const errors = rubricErrors(value);
  const setList = (field: 'asks' | 'criteria', index: number, text: string) => {
    const next = [...value[field]];
    next[index] = text;
    onChange({ ...value, [field]: next });
  };
  return (
    <div
      className="mt-3 border border-border rounded p-2 bg-surface-2"
      data-section="response-rubric"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-ink">
          Response rubric (for replies to this inject)
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
          <input
            type="checkbox"
            checked={value.useGeneric}
            onChange={(event) => onChange({ ...value, useGeneric: event.target.checked })}
          />
          Use generic rubric
        </label>
      </div>
      {value.useGeneric ? (
        <ul className="mt-2 space-y-1 text-[11px] text-muted list-disc pl-4">
          {GENERIC_CRITERIA.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 space-y-2">
          <StringRows
            label="Asks"
            items={value.asks}
            addLabel="Add ask"
            onChange={(asks) => onChange({ ...value, asks })}
            onEdit={(index, text) => setList('asks', index, text)}
          />
          <StringRows
            label="Criteria"
            items={value.criteria}
            addLabel="Add criterion"
            onChange={(criteria) => onChange({ ...value, criteria })}
            onEdit={(index, text) => setList('criteria', index, text)}
          />
          <div>
            <div className="text-[11px] text-muted font-medium mb-1">Expected tone</div>
            <div className="flex flex-wrap gap-1.5">
              {RUBRIC_TONES.map((tone) => {
                const on = value.tones.includes(tone);
                return (
                  <button
                    key={tone}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      onChange({
                        ...value,
                        tones: on
                          ? value.tones.filter((item) => item !== tone)
                          : [...value.tones, tone],
                      })
                    }
                    className={`text-[10px] px-2 py-1 rounded border ${on ? 'bg-brand text-white border-brand' : 'bg-surface text-muted border-border'}`}
                  >
                    {tone}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="text-[11px] text-muted font-medium flex items-center gap-2">
            Pass when
            <input
              aria-label="Pass threshold"
              type="number"
              min={1}
              value={value.passThreshold}
              onChange={(event) =>
                onChange({ ...value, passThreshold: Number(event.target.value) })
              }
              className="w-16 text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink"
            />
            of the criteria are met
          </label>
        </div>
      )}
      {errors.map((error) => (
        <p key={error} className="mt-1 text-[11px] text-danger">
          {error}
        </p>
      ))}
    </div>
  );
}

function StringRows({
  label,
  items,
  addLabel,
  onChange,
  onEdit,
}: {
  label: string;
  items: string[];
  addLabel: string;
  onChange: (items: string[]) => void;
  onEdit: (index: number, text: string) => void;
}) {
  const rows = items.length > 0 ? items : [''];
  return (
    <div>
      <div className="text-[11px] text-muted font-medium mb-1">{label}</div>
      <div className="space-y-1">
        {rows.map((item, index) => (
          <div key={index} className="flex gap-1.5">
            <input
              aria-label={`${label} ${index + 1}`}
              value={item}
              onChange={(event) => onEdit(index, event.target.value)}
              className={inputCls}
            />
            <button
              type="button"
              aria-label={`Remove ${label} ${index + 1}`}
              className="text-muted hover:text-danger px-1"
              onClick={() => onChange(rows.filter((_, row) => row !== index))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="mt-1 text-[11px] text-brand hover:underline"
        onClick={() => onChange([...rows, ''])}
      >
        + {addLabel}
      </button>
    </div>
  );
}
