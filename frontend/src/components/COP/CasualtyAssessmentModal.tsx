import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { CasualtyData } from './CasualtyPin';

interface CasualtyAssessmentModalProps {
  casualty: CasualtyData;
  sessionId: string;
  teamName: string;
  onClose: () => void;
  onAssess: (casualtyId: string, triageColor: string) => Promise<void>;
}

const TRIAGE_OPTIONS: Array<{
  color: string;
  label: string;
  bg: string;
  border: string;
  description: string;
}> = [
  {
    color: 'green',
    label: 'GREEN — Minor',
    bg: 'bg-green-900/40',
    border: 'border-green-500',
    description: 'Walking wounded. Can wait for treatment. Minor injuries only.',
  },
  {
    color: 'yellow',
    label: 'YELLOW — Delayed',
    bg: 'bg-yellow-900/40',
    border: 'border-yellow-500',
    description: 'Serious but not immediately life-threatening. Needs treatment within 1 hour.',
  },
  {
    color: 'red',
    label: 'RED — Immediate',
    bg: 'bg-red-900/40',
    border: 'border-red-500',
    description: 'Life-threatening injuries requiring immediate intervention.',
  },
  {
    color: 'black',
    label: 'BLACK — Deceased / Expectant',
    bg: 'bg-gray-900/40',
    border: 'border-gray-500',
    description: 'Deceased or injuries incompatible with survival given available resources.',
  },
];

export const CasualtyAssessmentModal = ({
  casualty,
  onClose,
  onAssess,
}: CasualtyAssessmentModalProps) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conds = casualty.conditions as Record<string, unknown>;
  const injuries = (conds.injuries as Array<Record<string, unknown>>) ?? [];
  const visibleDesc = (conds.visible_description as string) ?? '';
  const mobility = (conds.mobility as string) ?? 'unknown';
  const consciousness = (conds.consciousness as string) ?? 'unknown';
  const breathing = (conds.breathing as string) ?? 'unknown';
  const accessibility = (conds.accessibility as string) ?? 'open';
  const existingTag = (casualty as unknown as Record<string, unknown>).player_triage_color as
    | string
    | undefined;

  const handleSubmit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAssess(casualty.id, selected);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assessment failed — is a medic nearby?');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#0f1218] border border-robotic-yellow/30 rounded-lg shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-robotic-yellow/20">
          <h3 className="text-sm font-bold terminal-text text-robotic-yellow uppercase tracking-wider">
            Patient Assessment
          </h3>
          <button
            onClick={onClose}
            className="text-robotic-yellow/40 hover:text-robotic-yellow text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Patient description + triage options — scrollable area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="p-4 space-y-3 border-b border-robotic-yellow/10">
            {visibleDesc && (
              <p className="text-sm text-robotic-yellow/80 leading-relaxed">{visibleDesc}</p>
            )}

            <div className="grid grid-cols-3 gap-2 text-xs terminal-text">
              <div>
                <span className="text-robotic-yellow/40">Mobility:</span>
                <span className="ml-1 text-robotic-yellow capitalize">
                  {mobility.replace(/_/g, ' ')}
                </span>
              </div>
              <div>
                <span className="text-robotic-yellow/40">Conscious:</span>
                <span className="ml-1 text-robotic-yellow capitalize">{consciousness}</span>
              </div>
              <div>
                <span className="text-robotic-yellow/40">Breathing:</span>
                <span className="ml-1 text-robotic-yellow capitalize">{breathing}</span>
              </div>
            </div>

            {accessibility !== 'open' && (
              <div className="text-xs terminal-text text-orange-400 capitalize">
                Access: {accessibility.replace(/_/g, ' ')}
              </div>
            )}

            {injuries.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs terminal-text text-robotic-yellow/50 uppercase">
                  Visible injuries:
                </div>
                {injuries.map((inj, i) => (
                  <div
                    key={i}
                    className="text-xs text-robotic-yellow/70 pl-2 border-l border-robotic-yellow/20"
                  >
                    <span className="capitalize font-medium">
                      {String(inj.type ?? '').replace(/_/g, ' ')}
                    </span>
                    {typeof inj.severity === 'string' && inj.severity && (
                      <span className="text-robotic-yellow/40 ml-1">({inj.severity})</span>
                    )}
                    {typeof inj.body_part === 'string' && inj.body_part && (
                      <span className="text-robotic-yellow/50 ml-1">— {inj.body_part}</span>
                    )}
                    {typeof inj.visible_signs === 'string' && inj.visible_signs && (
                      <div className="text-robotic-yellow/40 mt-0.5">{inj.visible_signs}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {existingTag && (
              <div className="text-xs terminal-text text-robotic-yellow/50">
                Previously tagged: <span className="uppercase font-bold">{existingTag}</span>
              </div>
            )}
          </div>

          {/* Triage color selection */}
          <div className="p-4 space-y-2">
            <div className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2">
              Assign triage tag:
            </div>
            {TRIAGE_OPTIONS.map((opt) => (
              <button
                key={opt.color}
                onClick={() => setSelected(opt.color)}
                className={`w-full text-left p-3 rounded border-2 transition-all ${
                  selected === opt.color
                    ? `${opt.bg} ${opt.border} shadow-lg`
                    : 'border-transparent bg-white/5 hover:bg-white/10'
                }`}
              >
                <div className="text-sm font-bold terminal-text text-robotic-yellow">
                  {opt.label}
                </div>
                <div className="text-xs text-robotic-yellow/50 mt-0.5">{opt.description}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Actions — always visible at bottom */}
        <div className="p-4 border-t border-robotic-yellow/20 flex items-center gap-3 shrink-0">
          {error && <div className="text-xs text-red-400 flex-1">{error}</div>}
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs terminal-text text-robotic-yellow/60 hover:text-robotic-yellow border border-robotic-yellow/20 rounded"
          >
            CANCEL
          </button>
          <button
            onClick={handleSubmit}
            disabled={!selected || submitting}
            className="px-6 py-2 text-xs terminal-text bg-green-700 hover:bg-green-600 text-white rounded border border-green-500 disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
          >
            {submitting ? 'TAGGING...' : 'CONFIRM TAG'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
