interface DisputeModalProps {
  authorName: string;
  authorHandle: string;
  preview: string;
  claim: string;
  facts: string;
  status: string | null;
  submitting: boolean;
  onClaimChange: (v: string) => void;
  onFactsChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export default function DisputeModal({
  authorName,
  authorHandle,
  preview,
  claim,
  facts,
  status,
  submitting,
  onClaimChange,
  onFactsChange,
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
            Dispute with facts
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
            What is inaccurate?
          </p>
          <textarea
            value={claim}
            onChange={(e) => onClaimChange(e.target.value)}
            placeholder="Identify the specific false or misleading claim..."
            rows={2}
            className="w-full rounded-lg p-3 text-[14px] resize-none outline-none"
            style={{ backgroundColor: '#000000', color: '#E7E9EA', border: '1px solid #2F3336' }}
          />
        </div>

        <div className="px-5 mb-4">
          <p className="text-[12px] font-semibold mb-1.5" style={{ color: '#71767B' }}>
            Provide your facts / evidence
          </p>
          <textarea
            value={facts}
            onChange={(e) => onFactsChange(e.target.value)}
            placeholder="Cite the verified facts that counter this claim..."
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
            disabled={submitting}
            className="w-full py-3 rounded-full text-[15px] font-semibold text-white"
            style={{ backgroundColor: '#F4212E', opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Submitting...' : 'Submit dispute'}
          </button>
          <p className="text-[11px] mt-2 text-center" style={{ color: '#71767B' }}>
            Moderation review takes a few minutes. Frivolous disputes may affect your credibility.
          </p>
        </div>
      </div>
    </div>
  );
}
