import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { remainingBesideApply } from '../../lib/editModeBanner';
import { orphanChoiceLabel, type OrphanChoiceInput } from '../../lib/orphanGating';
import type { ReviewRow, ReviewSection } from '../../lib/reviewSections';
import {
  editHistoryLine,
  editHistoryWho,
  lobbySetupNotice,
  visibleEditHistory,
  type EditHistoryRow,
} from '../../lib/setupEditHistory';
import { WrIcon } from '../UI/WarRoomIcon';

export function SetupEditBanner({
  text,
  onAbandon,
  abandoning,
  missingDraft,
  onRestart,
}: {
  text: string;
  onAbandon: () => void;
  abandoning: boolean;
  missingDraft: boolean;
  onRestart: () => void;
}) {
  return (
    <div className="wr-note" style={{ margin: '0 0 16px' }} role="status">
      <WrIcon name="edit" size={14} />
      <span>{missingDraft ? 'This edit has no draft. Abandon it and start again.' : text}</span>
      <span className="ml-auto flex gap-2">
        {missingDraft ? (
          <button type="button" className="wr-btn sm accent" onClick={onRestart} disabled={abandoning}>
            Abandon and start again
          </button>
        ) : (
          <button type="button" className="wr-btn sm" onClick={onAbandon} disabled={abandoning}>
            {abandoning ? 'Abandoning…' : 'Abandon edit'}
          </button>
        )}
      </span>
    </div>
  );
}

export function RemovalConfirm({
  text,
  onKeep,
  onCancel,
}: {
  text: string;
  onKeep: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="wr-note" style={{ margin: '12px 0' }} role="dialog" aria-label="Confirm removal">
      <WrIcon name="alert" size={14} />
      <span>{text}</span>
      <span className="ml-auto flex gap-2">
        <button type="button" className="wr-btn sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="wr-btn sm remove" onClick={onKeep}>
          Remove
        </button>
      </span>
    </div>
  );
}

function RowBody({ row }: { row: ReviewRow }) {
  return (
    <div className="min-w-0">
      <div className="font-extrabold text-ink text-sm">{row.title}</div>
      <div className="text-xs text-muted">{row.detail}</div>
      {row.before && row.after && row.before !== row.after && (
        <div className="text-xs mt-1">
          <div className="text-muted">{row.before}</div>
          <div className="text-ink">{row.after}</div>
        </div>
      )}
      {!row.before && row.after && <div className="text-xs text-ink mt-1">{row.after}</div>}
      {row.reason && <div className="text-xs text-muted mt-1">{row.reason}</div>}
    </div>
  );
}

export function SetupEditReview({
  sections,
  rejected,
  decisions,
  unresolved,
  planning,
  applying,
  remaining,
  error,
  onToggleRow,
  onKeepSection,
  onDecide,
  onApply,
}: {
  sections: ReviewSection[];
  rejected: ReadonlySet<string>;
  decisions: Readonly<Record<string, OrphanChoiceInput | undefined>>;
  unresolved: readonly string[];
  planning: boolean;
  applying: boolean;
  remaining: number | null;
  error: string | null;
  onToggleRow: (injectId: string) => void;
  onKeepSection: (injectIds: string[], keep: boolean) => void;
  onDecide: (id: string, decision: OrphanChoiceInput) => void;
  onApply: () => void;
}) {
  const blocked = planning || unresolved.length > 0 || applying;
  return (
    <div className="space-y-4">
      {sections.length === 0 && (
        <p className="text-sm text-muted">Nothing to review yet. Build the edit first.</p>
      )}
      {sections.map((section) => {
        const rejectable = section.rows.filter((row) => row.rejectable && row.injectId);
        const allKept = rejectable.length > 0 && rejectable.every((row) => row.injectId && rejected.has(row.injectId));
        return (
          <section key={section.id} className="wr-node" style={{ '--g': 'var(--f-org)' } as CSSProperties}>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="font-extrabold text-ink">{section.title}</h3>
              {section.keepAllOriginals && (
                <button
                  type="button"
                  className="wr-btn sm ml-auto"
                  onClick={() =>
                    onKeepSection(
                      rejectable.map((row) => row.injectId as string),
                      !allKept,
                    )
                  }
                >
                  {allKept ? 'Accept this section' : 'Keep all originals in this section'}
                </button>
              )}
            </div>
            <div className="space-y-2">
              {section.rows.map((row) => {
                const kept = row.injectId ? rejected.has(row.injectId) : false;
                const decision = decisions[row.id];
                return (
                  <div key={row.id} className="flex items-start gap-3 border border-border rounded p-2">
                    <RowBody row={row} />
                    {row.rejectable && row.injectId && (
                      <button type="button" className={`wr-btn sm shrink-0${kept ? ' accent' : ''}`} onClick={() => onToggleRow(row.injectId as string)}>
                        {kept ? 'Using original' : 'Keep original'}
                      </button>
                    )}
                    {section.id === 'orphans' && (
                      <div className="shrink-0 flex flex-col gap-1">
                        <select
                          className="wr-field"
                          aria-label={`Decision for ${row.title}`}
                          value={decision?.choice ?? ''}
                          onChange={(event) =>
                            onDecide(row.id, { choice: event.target.value, team_name: decision?.team_name, inject_key: decision?.inject_key })
                          }
                        >
                          <option value="">Choose…</option>
                          {(row.choices ?? []).map((choice) => (
                            <option key={choice} value={choice}>
                              {orphanChoiceLabel(choice)}
                            </option>
                          ))}
                        </select>
                        {(decision?.choice === 'retarget' || decision?.choice === 'reassign') && (
                          <input
                            className="wr-field"
                            placeholder={decision.choice === 'reassign' ? 'Team name' : 'Inject key or team'}
                            value={decision.team_name || decision.inject_key || ''}
                            onChange={(event) =>
                              onDecide(row.id, {
                                choice: decision.choice,
                                ...(decision.choice === 'reassign'
                                  ? { team_name: event.target.value }
                                  : { inject_key: event.target.value }),
                              })
                            }
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="wr-ctabar" style={{ marginTop: 4 }}>
        <span className="hint">
          {unresolved.length > 0
            ? `${unresolved.length} ${unresolved.length === 1 ? 'decision' : 'decisions'} still needed`
            : 'Brief and swap revisions apply unless you keep the original.'}
        </span>
        <span className="grow" />
        <span className="text-xs text-muted">{remainingBesideApply(remaining)}</span>
        <button type="button" className="wr-btn accent lg" disabled={blocked} onClick={onApply}>
          {applying ? 'Applying…' : 'Apply changes to scenario'}
        </button>
      </div>
    </div>
  );
}

export function SetupEditApplied({
  summary,
  remaining,
  sessions,
}: {
  summary: Record<string, unknown>;
  remaining: number | null;
  sessions: Array<{
    id: string;
    scheduled_start_time: string | null;
    unassigned_players: Array<{ user_id: string; team_name: string }>;
    new_teams: string[];
  }>;
}) {
  return (
    <div className="wr-node" style={{ '--g': 'var(--success)' } as CSSProperties}>
      <h3 className="font-extrabold text-ink mb-2">Changes applied</h3>
      <p className="text-sm text-muted">{editHistoryLine(summary)}</p>
      <p className="text-xs text-muted mt-1">{remainingBesideApply(remaining)}</p>
      {sessions.length > 0 && (
        <ul className="mt-3 space-y-2">
          {sessions.map((session) => (
            <li key={session.id} className="text-sm">
              <Link to={`/sessions/${session.id}`} className="text-accent">
                Scheduled session
              </Link>
              {session.scheduled_start_time ? ` · ${session.scheduled_start_time}` : ''}
              {session.new_teams.length > 0 && <div className="text-xs text-muted">New teams: {session.new_teams.join(', ')}</div>}
              {session.unassigned_players.length > 0 && (
                <div className="text-xs text-muted">
                  Unassigned: {session.unassigned_players.map((player) => player.team_name).join(', ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EditHistoryList({ rows, isAdmin }: { rows: readonly EditHistoryRow[]; isAdmin: boolean }) {
  const visible = visibleEditHistory(rows, isAdmin);
  if (visible.length === 0) return null;
  return (
    <section>
      <h5>
        <WrIcon name="edit" /> Setup edits <span className="n">{visible.length}</span>
      </h5>
      {visible.map((row) => (
        <div key={row.id} className="row">
          <span className="wr-mono">{row.edit_number ?? '—'}</span>
          <div>
            <b>{editHistoryWho(row)}</b>
            <span>
              {row.applied_at || row.created_at
                ? new Date(row.applied_at || row.created_at).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })
                : ''}
              {row.status === 'applied' ? ` · ${editHistoryLine(row.applied_summary)}` : ` · ${row.status}`}
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}

export function LobbySetupNotice({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.sessions
      .getSetupChanges(sessionId)
      .then((res) => {
        if (!cancelled) setText(lobbySetupNotice(res.changes));
      })
      .catch(() => {
        if (!cancelled) setText(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  if (!text) return null;
  return (
    <div className="wr-note" style={{ margin: '0 0 12px' }} role="status">
      <WrIcon name="alert" size={13} />
      <span>{text}</span>
    </div>
  );
}
