import type { RedialDraft } from './chainEditorModel';

const inputCls =
  'w-16 text-xs bg-surface border border-border rounded px-2 py-1 text-ink disabled:opacity-60';

export function RedialFields({
  fieldId,
  draft,
  onChange,
  senderLabel,
}: {
  fieldId: string;
  draft: RedialDraft;
  onChange: (next: RedialDraft) => void;
  senderLabel: string;
}) {
  const set = (patch: Partial<RedialDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="mt-2 border border-border rounded p-2 bg-surface-2 space-y-2">
      <div className="text-[11px] font-semibold text-ink">If this call is missed</div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink">
        <span>Ring for</span>
        <input
          aria-label="Ring seconds"
          type="number"
          min={10}
          max={60}
          value={draft.ring_seconds}
          onChange={(event) => set({ ring_seconds: Number(event.target.value) })}
          className={inputCls}
        />
        <span>s</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink">
        <span>If missed, ring again</span>
        <input
          aria-label="Extra rings"
          type="number"
          min={0}
          max={5}
          value={draft.extra_rings}
          onChange={(event) => set({ extra_rings: Number(event.target.value) })}
          className={inputCls}
        />
        <span>more times every</span>
        <input
          aria-label="Redial interval minutes"
          type="number"
          min={1}
          max={30}
          value={draft.interval_minutes}
          onChange={(event) => set({ interval_minutes: Number(event.target.value) })}
          className={inputCls}
        />
        <span>min</span>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-ink">
        <input
          type="checkbox"
          checked={draft.stop_on_contact}
          onChange={(event) => set({ stop_on_contact: event.target.checked })}
        />
        Stop if they contact {senderLabel} another way
      </label>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink">
        <span className="text-muted">Voicemail</span>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name={`voicemail-each-${fieldId}`}
            checked={!draft.voicemail_each}
            onChange={() => set({ voicemail_each: false })}
          />
          Once at the end
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name={`voicemail-each-${fieldId}`}
            checked={draft.voicemail_each}
            onChange={() => set({ voicemail_each: true })}
          />
          Every missed ring
        </label>
      </div>
    </div>
  );
}
