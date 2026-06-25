export const VIOLATION_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'hate_speech', label: 'Hate speech', hint: 'Attacks a group based on identity' },
  {
    value: 'incitement_to_violence',
    label: 'Incitement to violence',
    hint: 'Calls for or threatens harm',
  },
  { value: 'misinformation', label: 'Misinformation', hint: 'False or misleading claims' },
  {
    value: 'organized_harassment',
    label: 'Organized harassment',
    hint: 'Coordinated pressure or pile-ons',
  },
  {
    value: 'harmful_narrative',
    label: 'Harmful narrative',
    hint: 'Damaging, inflammatory framing',
  },
  { value: 'other', label: 'Something else', hint: 'Another policy violation' },
];

interface ReportModalProps {
  authorName: string;
  authorHandle: string;
  preview: string;
  category: string;
  reason: string;
  status: string | null;
  submitting: boolean;
  onCategoryChange: (v: string) => void;
  onReasonChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export default function ReportModal({
  authorName,
  authorHandle,
  preview,
  category,
  reason,
  status,
  submitting,
  onCategoryChange,
  onReasonChange,
  onCancel,
  onSubmit,
}: ReportModalProps) {
  return (
    <div
      className="absolute inset-0 flex items-end justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 70 }}
      onClick={onCancel}
    >
      <div
        className="w-full rounded-t-2xl"
        style={{ backgroundColor: '#16181C', maxHeight: '90%', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h3 className="text-[17px] font-bold" style={{ color: '#E7E9EA' }}>
            Report this post
          </h3>
          <button
            onClick={onCancel}
            className="text-[15px] font-medium"
            style={{ color: '#71767B' }}
          >
            Cancel
          </button>
        </div>

        <div
          className="mx-5 mb-3 p-3 rounded-lg"
          style={{ backgroundColor: '#000000', border: '1px solid #2F3336' }}
        >
          <p className="text-[12px] font-semibold" style={{ color: '#E7E9EA' }}>
            {authorName} <span style={{ color: '#71767B' }}>{authorHandle}</span>
          </p>
          <p className="text-[12px] mt-1" style={{ color: '#71767B' }}>
            {preview.length > 140 ? preview.slice(0, 140) + '...' : preview}
          </p>
        </div>

        <div className="px-5 mb-3">
          <p className="text-[12px] font-semibold mb-1.5" style={{ color: '#71767B' }}>
            Why are you reporting this?
          </p>
          <div className="flex flex-col gap-1.5">
            {VIOLATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onCategoryChange(opt.value)}
                className="w-full text-left rounded-lg px-3 py-2.5 transition-colors"
                style={{
                  backgroundColor: category === opt.value ? 'rgba(29,155,240,0.15)' : '#000000',
                  border: `1px solid ${category === opt.value ? '#1D9BF0' : '#2F3336'}`,
                }}
              >
                <p
                  className="text-[14px] font-semibold"
                  style={{ color: category === opt.value ? '#1D9BF0' : '#E7E9EA' }}
                >
                  {opt.label}
                </p>
                <p className="text-[11px]" style={{ color: '#71767B' }}>
                  {opt.hint}
                </p>
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 mb-4">
          <p className="text-[12px] font-semibold mb-1.5" style={{ color: '#71767B' }}>
            Add details (optional)
          </p>
          <textarea
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Explain what policy this post violates..."
            rows={3}
            className="w-full rounded-lg p-3 text-[14px] resize-none outline-none"
            style={{ backgroundColor: '#000000', color: '#E7E9EA', border: '1px solid #2F3336' }}
          />
        </div>

        {status && (
          <p className="px-5 text-[12px] mb-2 font-medium" style={{ color: '#F4212E' }}>
            {status}
          </p>
        )}

        <div className="px-5 pb-6">
          <button
            onClick={onSubmit}
            disabled={submitting || !category}
            className="w-full py-3 rounded-full text-[15px] font-semibold text-white"
            style={{ backgroundColor: '#F4212E', opacity: submitting || !category ? 0.6 : 1 }}
          >
            {submitting ? 'Submitting...' : 'Submit report'}
          </button>
          <p className="text-[11px] mt-2 text-center" style={{ color: '#71767B' }}>
            Reporting content that does not break the rules (legitimate criticism or opinion) can
            count against your moderation record.
          </p>
        </div>
      </div>
    </div>
  );
}
