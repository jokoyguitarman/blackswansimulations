import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { websocketClient } from '../../lib/websocketClient';
import {
  directorPanel,
  type DirectorPanelModel,
} from '@shared/directorPanel';
import type { DirectorMode } from '@shared/directorModes';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}`;
  return cleanPath;
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  };
}

function previewModel(): DirectorPanelModel {
  return directorPanel({
    enabled: true,
    mode: 'auto',
    modeMax: 'auto',
    scenarioMode: 'auto',
    sessionMode: null,
    paused: false,
    budgetUsed: 6,
    budgetLimit: 20,
    tolerance: 2,
    fairness: [
      { team: 'Ops', negative: 4, share: 1.75, over: true },
      { team: 'Comms', negative: 2, share: 1.75, over: false },
      { team: 'Legal', negative: 0, share: 1.75, over: false },
      { team: 'CS', negative: 1, share: 1.75, over: false },
    ],
    stakeholderNames: { stk_maria: 'Maria Tan (Straits Times)' },
    now: new Date(Date.now() + 0),
    proposals: [
      {
        id: 'preview-proposal',
        seq: 3,
        minute: 27,
        status: 'proposed',
        reason:
          'Legal has been silent for 12 min while Communications waits for statement approval (dep_legal_stmt).',
        autoPublishAt: new Date(Date.now() + 42_000).toISOString(),
        proposal: {
          kind: 'consequence',
          title: 'Comment on the Bay 3 incident',
          content:
            'Subject: Comment on the Bay 3 incident — I understand your communications team is waiting on legal…',
          severity: 'medium',
          app: 'email',
          target_teams: ['Legal'],
          sender: { stakeholder_id: 'stk_maria' },
        },
        guardrails: [{ id: 'consistent', ok: true, detail: 'Consistent with the facts' }],
        consistencyStatus: 'consistent',
      },
    ],
  });
}

export function AiDirectorPanel({
  sessionId,
  preview = false,
}: {
  sessionId: string;
  preview?: boolean;
}) {
  const [model, setModel] = useState<DirectorPanelModel | null>(preview ? previewModel() : null);
  const [askOpen, setAskOpen] = useState(false);
  const [hint, setHint] = useState('');
  const [team, setTeam] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (preview) {
      setModel(previewModel());
      return;
    }
    try {
      const headers = await authHeaders();
      const response = await fetch(apiUrl(`/api/sessions/${sessionId}/director`), { headers });
      if (!response.ok) return;
      const body = (await response.json()) as { data?: DirectorPanelModel };
      if (body.data) setModel(body.data);
    } catch {
      /* the panel stays on the last snapshot */
    }
  }, [preview, sessionId]);

  useEffect(() => {
    void load();
    if (preview) return;
    const timer = window.setInterval(() => void load(), 4000);
    const types = ['director.proposal', 'director.published', 'director.expired', 'director.rejected'];
    const offs = types.map((type) => websocketClient.on(type, () => void load()));
    return () => {
      window.clearInterval(timer);
      offs.forEach((off) => off());
    };
  }, [load, preview]);

  async function send(path: string, method: string, body?: unknown) {
    if (preview) return;
    setError(null);
    const headers = await authHeaders();
    const response = await fetch(apiUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? 'The director could not do that');
    }
    await load();
  }

  if (!model?.enabled) return null;
  const left = Math.max(0, model.budgetLimit - model.budgetUsed);
  const modes: DirectorMode[] = ['off', 'suggest', 'auto'];

  return (
    <section
      className="rounded-lg p-3"
      style={{ backgroundColor: '#FFFFFF', border: '1px solid #E4DFD4' }}
      aria-label="AI director"
    >
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h2 className="text-sm font-bold" style={{ color: '#1E3A5F' }}>
          AI director
        </h2>
        <div className="flex items-center gap-2 text-[11px]" style={{ color: '#374151' }}>
          <span>Mode:</span>
          {modes.map((mode) => {
            const allowed = modeRank(mode) <= modeRank(model.modeMax);
            return (
              <label key={mode} className="inline-flex items-center gap-1 capitalize">
                <input
                  type="radio"
                  name={`director-mode-${sessionId}`}
                  checked={model.mode === mode}
                  disabled={!allowed || preview}
                  onChange={() => void send(`/api/sessions/${sessionId}/director`, 'PATCH', { mode })}
                />
                {mode}
              </label>
            );
          })}
        </div>
        <span className="text-[11px]" style={{ color: '#64748b' }}>
          Budget: {left} of {model.budgetLimit} calls this hour
        </span>
        <span className="grow" />
        <button
          type="button"
          className="text-[11px] font-semibold px-2 py-1 rounded"
          style={{ backgroundColor: '#F4F1EA', color: '#1E3A5F', border: '1px solid #E4DFD4' }}
          onClick={() => setAskOpen((open) => !open)}
        >
          Ask the director
        </button>
        <button
          type="button"
          className="text-[11px] font-semibold px-2 py-1 rounded"
          style={{ backgroundColor: model.paused ? '#1E3A5F' : '#FFFFFF', color: model.paused ? '#fff' : '#1E3A5F', border: '1px solid #E4DFD4' }}
          disabled={preview}
          onClick={() => void send(`/api/sessions/${sessionId}/director`, 'PATCH', { pause: !model.paused })}
        >
          {model.paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      {model.fairness.length > 0 && (
        <p className="text-[11px] mb-2" style={{ color: '#374151' }}>
          Fairness:{' '}
          {model.fairness.map((team) => (
            <span key={team.team} className="mr-3">
              {team.team} {bar(team.filled)} {team.negative}
            </span>
          ))}
          <span style={{ color: '#64748b' }}>(negative load; tolerance ±{model.tolerance})</span>
        </p>
      )}
      {askOpen && (
        <form
          className="flex flex-wrap gap-2 mb-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(`/api/sessions/${sessionId}/director/request`, 'POST', {
              ...(team.trim() ? { team: team.trim() } : {}),
              ...(hint.trim() ? { hint: hint.trim() } : {}),
            }).then(() => {
              setHint('');
              setAskOpen(false);
            });
          }}
        >
          <input
            value={team}
            onChange={(event) => setTeam(event.target.value)}
            placeholder="Team (optional)"
            className="text-[11px] px-2 py-1 rounded border"
            style={{ borderColor: '#E4DFD4' }}
          />
          <input
            value={hint}
            onChange={(event) => setHint(event.target.value)}
            placeholder="Hint, for example make it harder for Legal"
            className="text-[11px] px-2 py-1 rounded border flex-1 min-w-[12rem]"
            style={{ borderColor: '#E4DFD4' }}
          />
          <button type="submit" className="text-[11px] font-semibold px-2 py-1 rounded" style={{ backgroundColor: '#1E3A5F', color: '#fff' }}>
            Ask
          </button>
        </form>
      )}
      {error && (
        <p className="text-[11px] mb-2" style={{ color: '#B91C1C' }}>
          {error}
        </p>
      )}
      <div className="space-y-2">
        {model.cards.length === 0 && (
          <p className="text-[11px]" style={{ color: '#64748b' }}>
            {model.mode === 'off' ? 'The director is off.' : 'No proposal waiting.'}
          </p>
        )}
        {model.cards.map((card) => (
          <article key={card.id} className="rounded p-3" style={{ backgroundColor: '#FAF8F4', border: '1px solid #E4DFD4' }}>
            <p className="text-[12px] font-semibold" style={{ color: '#1E3A5F' }}>
              T+{card.minute} · for {card.team} · {card.app.replace('_', ' ')} from {card.sender} · {card.severity}
              {card.countdownLabel ? ` · publishing in ${card.countdownLabel}` : ' · needs approval'}
            </p>
            {card.reason && (
              <p className="text-[11px] mt-1" style={{ color: '#374151' }}>
                Why: {card.reason}
              </p>
            )}
            {editing === card.id ? (
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                className="w-full text-[12px] mt-2 p-2 rounded border"
                style={{ borderColor: '#E4DFD4' }}
              />
            ) : (
              <p className="text-[12px] mt-1" style={{ color: '#172033' }}>
                “{card.content}”
              </p>
            )}
            <p className="text-[11px] mt-1" style={{ color: '#15803D' }}>
              {card.checks}
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              <button
                type="button"
                className="text-[11px] font-semibold px-2 py-1 rounded"
                style={{ backgroundColor: '#1E3A5F', color: '#fff' }}
                disabled={preview}
                onClick={() =>
                  void send(`/api/sessions/${sessionId}/director/proposals/${card.id}/approve`, 'POST', editing === card.id ? { content: draft } : {})
                }
              >
                {card.needsApproval ? 'Approve' : 'Publish now'}
              </button>
              <button
                type="button"
                className="text-[11px] font-semibold px-2 py-1 rounded"
                style={{ backgroundColor: '#FFFFFF', color: '#1E3A5F', border: '1px solid #E4DFD4' }}
                onClick={() => {
                  setEditing(editing === card.id ? null : card.id);
                  setDraft(card.content);
                }}
              >
                Edit…
              </button>
              <button
                type="button"
                className="text-[11px] font-semibold px-2 py-1 rounded"
                style={{ backgroundColor: '#FFFFFF', color: '#B91C1C', border: '1px solid #E4DFD4' }}
                disabled={preview}
                onClick={() => void send(`/api/sessions/${sessionId}/director/proposals/${card.id}/veto`, 'POST', {})}
              >
                Veto
              </button>
              <button
                type="button"
                className="text-[11px] font-semibold px-2 py-1 rounded"
                style={{ backgroundColor: '#FFFFFF', color: '#1E3A5F', border: '1px solid #E4DFD4' }}
                disabled={preview}
                onClick={() =>
                  void send(`/api/sessions/${sessionId}/director/snooze`, 'POST', {
                    team: card.team.split(',')[0]?.trim() || card.team,
                    minutes: 10,
                  })
                }
              >
                Snooze {card.team.split(',')[0]} 10 min
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function modeRank(mode: DirectorMode): number {
  if (mode === 'auto') return 2;
  if (mode === 'suggest') return 1;
  return 0;
}

function bar(filled: number): string {
  return `${'▮'.repeat(filled)}${'▯'.repeat(Math.max(0, 4 - filled))}`;
}
