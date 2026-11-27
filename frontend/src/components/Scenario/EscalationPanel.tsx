import { useState } from 'react';
import {
  CHAIN_APPS,
  CHAIN_PLACEHOLDERS,
  URGENCIES,
  defaultTemplate,
  escalationChasesKey,
  renderChainTemplate,
  type ChainApp,
  type Urgency,
} from '@shared/escalationAuthoring';
import {
  escalationConfigFromDraft,
  escalationDraftIssues,
  type ChainStepDraft,
  type EscalationDraft,
} from './chainEditorModel';
import { escalationTimelineSentence } from './escalationTimelinePreview';

const inputCls =
  'w-full text-xs bg-surface border border-border rounded px-1.5 py-1 text-ink disabled:opacity-60';
const narrowCls =
  'w-16 text-xs bg-surface border border-border rounded px-1.5 py-1 text-ink';

const APP_LABEL: Record<ChainApp, string> = {
  same: 'same',
  email: 'email',
  group_chat: 'chat',
  npc_dm: 'NPC text',
  messenger_dm: 'Messenger',
  phone_call: 'call',
  social_feed: 'post',
};

const URGENCY_LABEL: Record<Urgency, string> = {
  reminder: 'reminder',
  follow_up: 'follow-up',
  urgent: 'urgent',
  final: 'final',
  escalated: 'escalated',
};

export interface ChainInjectOption {
  id: string;
  title: string;
  injectKey: string | null;
  triggerTime: number | null;
  conditionKeys: readonly string[];
}

export interface ChainStakeholderOption {
  id: string;
  name: string;
}

export function EscalationPanel({
  fieldId,
  rootApp,
  draft,
  onChange,
  stakeholders,
  teams,
  injects,
  rootKey,
  rootStakeholderId,
  rootTriggerMinute,
  durationMinutes,
  content,
  title,
}: {
  fieldId: string;
  rootApp: string;
  draft: EscalationDraft;
  onChange: (next: EscalationDraft) => void;
  stakeholders: ChainStakeholderOption[];
  teams: string[];
  injects: ChainInjectOption[];
  rootKey: string | null;
  rootStakeholderId: string | null;
  rootTriggerMinute: number | null;
  durationMinutes: number | null;
  content: string;
  title: string;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const set = (patch: Partial<EscalationDraft>) => onChange({ ...draft, ...patch });
  const config = escalationConfigFromDraft(draft);
  const otherInjects = injects
    .filter((item) => item.injectKey && item.injectKey !== rootKey)
    .map((item) => ({
      key: item.injectKey as string,
      trigger_time_minutes: item.triggerTime,
      condition_keys: item.conditionKeys,
    }));
  const issues = escalationDraftIssues({
    draft,
    rootApp,
    rootStakeholderId,
    stakeholderIds: stakeholders.map((item) => item.id),
    durationMinutes,
    rootKey,
    rootTriggerMinute,
    otherInjects,
  });
  const errors = issues.filter((issue) => issue.level === 'error');
  const chasers = injects.filter(
    (item) =>
      rootKey &&
      item.injectKey !== rootKey &&
      item.conditionKeys.some((key) => escalationChasesKey(key, rootKey)),
  );
  const senderName = (id: string) => stakeholders.find((item) => item.id === id)?.name ?? id;
  const sentence = escalationTimelineSentence(config, rootApp, {
    senderName,
    publishTitle: (key) => injects.find((item) => item.injectKey === key)?.title ?? key,
  });

  const updateStep = (index: number, patch: Partial<ChainStepDraft>) => {
    const steps = draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step));
    set({ steps });
  };

  return (
    <div className="mt-2 border border-border rounded p-2 bg-surface-2">
      <label className="flex items-center gap-2 text-[11px] font-semibold text-ink">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => set({ enabled: event.target.checked })}
        />
        If this goes unanswered, chase until answered
      </label>
      {draft.enabled && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink">
            <span className="text-muted">Stop when</span>
            {(
              [
                ['any_response', 'any reply'],
                ['relevant_response', 'a relevant reply'],
                ['passed_response', 'a good reply'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name={`chain-stop-on-${fieldId}`}
                  checked={draft.stop_on === value}
                  onChange={() => set({ stop_on: value })}
                />
                {label}
              </label>
            ))}
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.stop_on_contact}
                onChange={(event) => set({ stop_on_contact: event.target.checked })}
              />
              Also stop if they contact the sender another way
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink">
            <span className="text-muted">Chase</span>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`chain-scope-${fieldId}`}
                checked={draft.scope === 'per_team'}
                onChange={() => set({ scope: 'per_team' })}
              />
              Each team separately
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`chain-scope-${fieldId}`}
                checked={draft.scope === 'any_recipient'}
                onChange={() => set({ scope: 'any_recipient' })}
              />
              Until anyone replies
            </label>
            <label className="flex items-center gap-1.5">
              Max follow-ups
              <input
                aria-label="Max follow-ups"
                type="number"
                min={1}
                max={6}
                value={draft.max_steps}
                onChange={(event) => set({ max_steps: Number(event.target.value) })}
                className={narrowCls}
              />
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-ink border-collapse">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-2 font-medium">#</th>
                  <th className="py-1 pr-2 font-medium">After (min)</th>
                  <th className="py-1 pr-2 font-medium">Via</th>
                  <th className="py-1 pr-2 font-medium">Urgency</th>
                  <th className="py-1 pr-2 font-medium">From</th>
                  <th className="py-1 pr-2 font-medium">Content</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.steps.map((step, index) => (
                  <tr key={index} className="align-top border-t border-border">
                    <td className="py-1 pr-2">{index + 1}</td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`Step ${index + 1} after minutes`}
                        type="number"
                        min={1}
                        max={120}
                        value={step.after_minutes}
                        onChange={(event) =>
                          updateStep(index, { after_minutes: Number(event.target.value) })
                        }
                        className={narrowCls}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <select
                        aria-label={`Step ${index + 1} channel`}
                        value={step.app}
                        onChange={(event) => updateStep(index, { app: event.target.value as ChainApp })}
                        className={inputCls}
                      >
                        {CHAIN_APPS.map((app) => (
                          <option key={app} value={app}>
                            {APP_LABEL[app]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1 pr-2">
                      <select
                        aria-label={`Step ${index + 1} urgency`}
                        value={step.urgency}
                        onChange={(event) =>
                          updateStep(index, { urgency: event.target.value as Urgency })
                        }
                        className={inputCls}
                      >
                        {URGENCIES.map((urgency) => (
                          <option key={urgency} value={urgency}>
                            {URGENCY_LABEL[urgency]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1 pr-2 space-y-1">
                      <select
                        aria-label={`Step ${index + 1} sender`}
                        value={step.sender_stakeholder_id}
                        onChange={(event) =>
                          updateStep(index, { sender_stakeholder_id: event.target.value })
                        }
                        className={inputCls}
                      >
                        <option value="">Same sender</option>
                        {stakeholders.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      {step.app === 'phone_call' && (
                        <div className="flex items-center gap-1 text-muted">
                          rings
                          <input
                            aria-label={`Step ${index + 1} rings`}
                            type="number"
                            min={1}
                            max={6}
                            value={step.redial_attempts}
                            onChange={(event) =>
                              updateStep(index, { redial_attempts: Number(event.target.value) })
                            }
                            className={narrowCls}
                          />
                          ×
                        </div>
                      )}
                      {step.app === 'email' && (
                        <select
                          aria-label={`Step ${index + 1} cc team`}
                          value={step.cc_team}
                          onChange={(event) => updateStep(index, { cc_team: event.target.value })}
                          className={inputCls}
                        >
                          <option value="">No cc</option>
                          {teams.map((team) => (
                            <option key={team} value={team}>
                              cc {team}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="py-1 pr-2">
                      <button
                        type="button"
                        onClick={() => setEditing(index)}
                        className="text-brand hover:underline"
                      >
                        {step.content_mode === 'ai' ? 'AI brief' : step.template.trim() ? 'Edit…' : 'Default'}
                      </button>
                    </td>
                    <td className="py-1">
                      <button
                        type="button"
                        aria-label={`Remove step ${index + 1}`}
                        onClick={() => set({ steps: draft.steps.filter((_, i) => i !== index) })}
                        className="text-muted hover:text-danger"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <button
              type="button"
              onClick={() => set({ steps: [...draft.steps, blankAfter(draft.steps)] })}
              className="text-brand hover:underline"
            >
              + Add follow-up
            </button>
            <label className="flex items-center gap-1.5 text-ink">
              If still unanswered after the last one, publish
              <select
                aria-label="Publish when the chain is exhausted"
                value={draft.publish_inject_key}
                onChange={(event) => set({ publish_inject_key: event.target.value })}
                className={`${inputCls} w-auto max-w-[16rem]`}
              >
                <option value="">Nothing</option>
                {injects
                  .filter((item) => item.injectKey && item.triggerTime == null)
                  .map((item) => (
                    <option key={item.id} value={item.injectKey ?? ''}>
                      {item.title}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {draft.max_steps > draft.steps.length && draft.steps.length > 0 && (
            <p className="text-[11px] text-muted">
              Follow-ups after row {draft.steps.length} repeat the last one, at urgency final or higher.
            </p>
          )}
          <p className="text-[11px] text-ink">
            <span className="text-muted">Timeline preview: </span>
            {sentence}
          </p>
          {chasers.map((item) => (
            <p key={item.id} className="text-[11px] text-warning">
              “{item.title}” also chases this message — you may be chasing twice.
            </p>
          ))}
          {errors.map((issue) => (
            <p key={issue.message} className="text-[11px] text-danger">
              {issue.message}
            </p>
          ))}
        </div>
      )}
      {editing != null && draft.steps[editing] && (
        <ContentModal
          step={draft.steps[editing]}
          stepNo={editing + 1}
          maxSteps={draft.max_steps}
          content={content}
          title={title}
          onChange={(patch) => updateStep(editing, patch)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function blankAfter(steps: ChainStepDraft[]): ChainStepDraft {
  const previous = steps[steps.length - 1];
  return {
    after_minutes: previous?.after_minutes ?? 5,
    urgency: previous?.urgency ?? 'follow_up',
    app: 'same',
    content_mode: 'template',
    template: '',
    brief: '',
    sender_stakeholder_id: '',
    target_team: '',
    cc_team: '',
    redial_attempts: 1,
    redial_interval: 2,
  };
}

function ContentModal({
  step,
  stepNo,
  maxSteps,
  content,
  title,
  onChange,
  onClose,
}: {
  step: ChainStepDraft;
  stepNo: number;
  maxSteps: number;
  content: string;
  title: string;
  onChange: (patch: Partial<ChainStepDraft>) => void;
  onClose: () => void;
}) {
  const ask = content.split(/(?<=[.!?])\s+/).find((part) => part.includes('?'))?.trim() || title || 'an answer';
  const template = step.template.trim() ? step.template : defaultTemplate(step.urgency);
  const preview = renderChainTemplate(template, {
    sender_name: 'Pastor Daniel',
    recipient_team: 'Stakeholder Engagement',
    original_subject: title || 'your message',
    ask,
    minutes_waiting: 12,
    root_minute: 10,
    followups_sent: Math.max(0, stepNo - 1),
    missed_calls: 1,
    step: stepNo,
    max_steps: maxSteps,
    mood_line: 'I need an answer today.',
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
      <div
        role="dialog"
        aria-label={`Follow-up ${stepNo} content`}
        className="bg-surface border border-border rounded-lg p-3 w-full max-w-lg space-y-2"
      >
        <div className="text-xs font-semibold text-ink">Follow-up {stepNo} content</div>
        <label className="flex items-center gap-2 text-[11px] text-ink">
          <input
            type="checkbox"
            checked={step.content_mode === 'ai'}
            onChange={(event) => onChange({ content_mode: event.target.checked ? 'ai' : 'template' })}
          />
          Write this follow-up with AI
        </label>
        {step.content_mode === 'ai' ? (
          <textarea
            aria-label="AI brief"
            value={step.brief}
            rows={4}
            maxLength={300}
            onChange={(event) => onChange({ brief: event.target.value })}
            placeholder="What this follow-up should convey"
            className={`${inputCls} resize-y`}
          />
        ) : (
          <>
            <div className="flex flex-wrap gap-1">
              {CHAIN_PLACEHOLDERS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => onChange({ template: `${step.template}{${name}}` })}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted hover:text-ink"
                >
                  {`{${name}}`}
                </button>
              ))}
            </div>
            <textarea
              aria-label="Follow-up template"
              value={step.template}
              rows={5}
              onChange={(event) => onChange({ template: event.target.value })}
              placeholder={defaultTemplate(step.urgency)}
              className={`${inputCls} resize-y font-mono`}
            />
          </>
        )}
        <div>
          <div className="text-[10px] text-muted mb-0.5">Preview with sample values</div>
          <p className="text-[11px] text-ink whitespace-pre-wrap bg-surface-2 border border-border rounded p-2">
            {step.content_mode === 'ai'
              ? step.brief.trim() || 'The model writes this from the brief.'
              : preview}
          </p>
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 bg-brand text-white rounded">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
