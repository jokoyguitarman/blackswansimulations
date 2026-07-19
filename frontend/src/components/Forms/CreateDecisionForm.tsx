import { useState } from 'react';
import { api } from '../../lib/api';
import { VoiceMicButton } from '../VoiceMicButton';

interface CreateDecisionFormProps {
  sessionId: string;
  /** Incident this decision responds to. Omit for pre-emptive decisions. */
  incidentId?: string;
  onClose: () => void;
  onSuccess?: () => void;
  responseType?: string;
  teamName?: string;
  /** Pre-fill description for revision cycles */
  prefillDescription?: string;
  /** Editorial feedback to display above the form */
  editorialFeedback?: {
    editor_name: string;
    feedback: string;
    score: number;
    verdict: string;
  };
}

const SCRIPT_SECTIONS = [
  {
    key: 'opening',
    label: 'Opening — spokesperson identity',
    placeholder:
      'Who is speaking? State your name, role, rank, and authority. Example: "I am [Role], [Name], the designated spokesperson for this incident."',
    rows: 2,
  },
  {
    key: 'facts',
    label: 'Key facts — verified information',
    placeholder:
      'Specific numbers, locations, times. Distinguish confirmed from preliminary. Example: "At approximately [time], [specific event]. We can confirm [X] casualties are receiving treatment at [location]."',
    rows: 4,
  },
  {
    key: 'guidance',
    label: 'Public guidance — what to do',
    placeholder:
      'Clear instructions for the public. Example: "We urge residents within [area] to [evacuate/shelter/avoid]. A hotline has been established at [number]."',
    rows: 3,
  },
  {
    key: 'closing',
    label: 'Closing — empathy & next update',
    placeholder:
      'Express empathy for victims, commit to a follow-up timeline. Example: "Our thoughts are with the affected families. We will provide the next update at [time]."',
    rows: 2,
  },
] as const;

type ScriptSectionKey = (typeof SCRIPT_SECTIONS)[number]['key'];

export const CreateDecisionForm = ({
  sessionId,
  incidentId,
  onClose,
  onSuccess,
  responseType,
  teamName,
  prefillDescription,
  editorialFeedback,
}: CreateDecisionFormProps) => {
  const isMediaTeam = teamName ? /media|communi/i.test(teamName) : false;
  const isMediaStatement = responseType === 'media_statement';
  const showScriptEditor = isMediaStatement && isMediaTeam;
  const showCoordinationHint = isMediaStatement && !isMediaTeam;

  const [loading, setLoading] = useState(false);
  const [description, setDescription] = useState(prefillDescription ?? '');
  const [useStructuredMode, setUseStructuredMode] = useState(showScriptEditor);
  const [scriptSections, setScriptSections] = useState<Record<ScriptSectionKey, string>>({
    opening: '',
    facts: '',
    guidance: '',
    closing: '',
  });

  const isPreemptive = !incidentId;

  const buildDescription = (): string => {
    if (!useStructuredMode) return description;
    const parts: string[] = [];
    if (scriptSections.opening.trim())
      parts.push(`[SPOKESPERSON]\n${scriptSections.opening.trim()}`);
    if (scriptSections.facts.trim()) parts.push(`[KEY FACTS]\n${scriptSections.facts.trim()}`);
    if (scriptSections.guidance.trim())
      parts.push(`[PUBLIC GUIDANCE]\n${scriptSections.guidance.trim()}`);
    if (scriptSections.closing.trim()) parts.push(`[CLOSING]\n${scriptSections.closing.trim()}`);
    return parts.join('\n\n');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const finalDescription = buildDescription();
      if (!finalDescription.trim()) {
        alert('Please provide a description for your decision.');
        setLoading(false);
        return;
      }

      const payload: Record<string, unknown> = {
        session_id: sessionId,
        description: finalDescription,
        required_approvers: [],
      };
      if (incidentId) {
        payload.response_to_incident_id = incidentId;
      }
      if (isMediaStatement && isMediaTeam) {
        payload.decision_type = 'public_statement';
      }

      const result = await api.decisions.create(payload);
      const created = result?.data as { id: string } | undefined;
      if (!created?.id) {
        alert('Decision was created but could not execute. Please execute it from the list.');
        onSuccess?.();
        onClose();
        return;
      }
      await api.decisions.execute(created.id);

      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Failed to create or execute decision:', error);
      const message =
        error instanceof Error ? error.message : 'Failed to create or execute decision';
      alert(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-2xl shadow-lg max-w-2xl w-full flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex-shrink-0 px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-bold text-brand">
            {showScriptEditor
              ? 'Draft public statement'
              : isPreemptive
                ? 'Pre-emptive decision'
                : 'Respond to incident'}
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
            {editorialFeedback && (
              <div className="p-4 border border-accent/60 bg-accent/10">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-accent text-xs terminal-text font-bold">
                    Editorial Review — {editorialFeedback.verdict.replace('_', ' ')}
                  </span>
                  <span className="text-accent text-xs terminal-text">
                    Score: {editorialFeedback.score}/10
                  </span>
                </div>
                <p className="text-xs terminal-text text-muted italic">
                  {editorialFeedback.editor_name}:
                </p>
                <p className="text-xs terminal-text text-ink mt-1 whitespace-pre-wrap">
                  {editorialFeedback.feedback}
                </p>
              </div>
            )}

            {isPreemptive && !showScriptEditor && (
              <p className="text-xs terminal-text text-muted">
                This decision is not in response to a specific incident. Use this to establish
                pre-emptive measures, protocols, or resource allocations proactively.
              </p>
            )}

            {showCoordinationHint && (
              <div className="p-3 border border-brand/40 bg-brand/10">
                <p className="text-xs terminal-text text-brand">
                  This inject requires a public statement. Your team should coordinate with the
                  Media team — provide them with verified facts from your operational domain.
                </p>
              </div>
            )}

            {showScriptEditor && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setUseStructuredMode(true)}
                  className={`text-xs terminal-text px-3 py-1 border ${useStructuredMode ? 'border-success text-success bg-success/10' : 'border-border text-muted'}`}
                >
                  Structured script
                </button>
                <button
                  type="button"
                  onClick={() => setUseStructuredMode(false)}
                  className={`text-xs terminal-text px-3 py-1 border ${!useStructuredMode ? 'border-success text-success bg-success/10' : 'border-border text-muted'}`}
                >
                  Free text
                </button>
              </div>
            )}

            {useStructuredMode && showScriptEditor ? (
              SCRIPT_SECTIONS.map((section) => (
                <div key={section.key}>
                  <label className="block text-xs terminal-text text-ink mb-1">
                    {section.label}
                  </label>
                  <textarea
                    value={scriptSections[section.key]}
                    onChange={(e) =>
                      setScriptSections((prev) => ({ ...prev, [section.key]: e.target.value }))
                    }
                    className="w-full px-4 py-2 military-input terminal-text text-sm"
                    rows={section.rows}
                    placeholder={section.placeholder}
                  />
                </div>
              ))
            ) : (
              <div>
                <label className="block text-xs terminal-text text-ink mb-2">Description</label>
                <div className="relative">
                  <textarea
                    required
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full px-4 py-3 pr-12 military-input terminal-text"
                    rows={showScriptEditor ? 8 : 4}
                    placeholder={
                      showCoordinationHint
                        ? 'Coordinate with the Media team. Example: "Communicate to media team: We have 23 patients in treatment, 4 critical. All hazards contained."'
                        : isPreemptive
                          ? 'Describe your pre-emptive decision, protocol, or resource allocation...'
                          : 'Type or speak your decision...'
                    }
                  />
                  <VoiceMicButton
                    onTranscript={(text) =>
                      setDescription((prev) => (prev ? `${prev} ${text}` : text))
                    }
                    disabled={loading}
                    className="absolute bottom-2 right-2"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex-shrink-0 flex justify-end gap-3 px-6 py-4 border-t border-border bg-surface-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="military-button-outline px-6 py-3 border border-accent text-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="military-button px-6 py-3 border-success text-success hover:bg-success/10 disabled:opacity-50"
            >
              {loading ? 'Executing…' : showScriptEditor ? 'Submit for review' : 'Execute decision'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
