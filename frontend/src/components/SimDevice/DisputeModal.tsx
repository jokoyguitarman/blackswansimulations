interface DisputeModalProps {
  authorName: string;
  authorHandle: string;
  preview: string;
  note: string;
  status: string | null;
  submitting: boolean;
  onNoteChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export default function DisputeModal({
  authorName,
  authorHandle,
  preview,
  note,
  status,
  submitting,
  onNoteChange,
  onCancel,
  onSubmit,
}: DisputeModalProps) {
  return (
    <div
      className="absolute inset-0 flex items-end justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 70 }}
      onClick={onCancel}
    >
      <div
        className="w-full rounded-t-2xl"
        style={{ backgroundColor: '#16181C', maxHeight: '85%', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h3 className="text-[17px] font-bold" style={{ color: '#E7E9EA' }}>
            Report misinformation
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

        <div className="px-5 mb-4">
          <p className="text-[12px] font-semibold mb-1.5" style={{ color: '#71767B' }}>
            What's wrong with this? Add any facts you have (optional)
          </p>
          <textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="Identify the false claim and cite any verified facts that counter it..."
            rows={4}
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
            disabled={submitting}
            className="w-full py-3 rounded-full text-[15px] font-semibold text-white"
            style={{ backgroundColor: '#F4212E', opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Submitting...' : 'Submit report'}
          </button>
          <p className="text-[11px] mt-2 text-center" style={{ color: '#71767B' }}>
            Moderation review takes a few minutes. Reports with no supporting facts are likely to be
            rejected and may affect your credibility.
          </p>
        </div>
      </div>
    </div>
  );
}
