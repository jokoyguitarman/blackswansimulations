import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError } from '../../lib/api';
import type { CallCoverage } from '@shared/sessionCallCoverage';
import { WrIcon } from '../UI/WarRoomIcon';

export function CallCoveragePanel({
  sessionId,
  userId,
  onCoverage,
}: {
  sessionId: string;
  userId?: string;
  onCoverage: (coverage: CallCoverage | null) => void;
}) {
  const [coverage, setCoverage] = useState<CallCoverage | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const filled = useRef(false);
  const onCoverageRef = useRef(onCoverage);
  onCoverageRef.current = onCoverage;

  const load = useCallback(async () => {
    try {
      const result = await api.sessions.getCallCoverage(sessionId);
      setCoverage(result.data);
      onCoverageRef.current(result.data);
      return result.data;
    } catch (error) {
      console.error('Failed to load call coverage', error);
      onCoverageRef.current(null);
      return null;
    }
  }, [sessionId]);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      const data = await load();
      if (cancel || !data || filled.current) return;
      const empty = data.items.some((item) => item.kind === 'line' && item.required && item.assignees.length === 0);
      if (!empty) return;
      filled.current = true;
      try {
        await api.sessions.autofillCallTakers(sessionId);
        if (!cancel) await load();
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setMessage('Call takers could not be auto-filled from this server. Assign them yourself.');
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [load, sessionId]);

  if (!coverage?.applies) return null;
  const ready = coverage.items.filter((item) => !item.required || item.satisfied).length;
  const held = userId
    ? coverage.items.filter(
        (item) => item.kind === 'line' && item.assignees.some((assignee) => assignee.user_id === userId),
      )
    : [];

  return (
    <div className="wr-map" aria-labelledby="lobby-call-coverage-title">
      <div className="wr-sech" style={{ margin: '0 0 12px', '--g': 'var(--f-org)' } as CSSProperties}>
        <h2 id="lobby-call-coverage-title">
          <WrIcon name="phone" size={16} /> Before you start · Calls & messages
          <span className="n">
            {ready} / {coverage.items.length || 0} ready
          </span>
        </h2>
        <p>
          {coverage.mode === 'enforce'
            ? 'Required roles and lines must be covered before the session can start.'
            : 'This scenario is in warning mode. Gaps are shown and do not block the start.'}
        </p>
        <div className="ml-auto">
          <button type="button" className="wr-btn" disabled={busy} onClick={() => void refill()}>
            Auto-fill call takers
          </button>
        </div>
      </div>
      {held.length > 0 && (
        <div className="wr-note" style={{ margin: '0 0 12px' }}>
          <span>You hold the {held.map((item) => item.label).join(', ')} line</span>
        </div>
      )}
      {message && <div className="wr-note" style={{ margin: '0 0 12px' }}>{message}</div>}
      <div className="grid grid-cols-1 gap-2">
        {coverage.items.map((item) => {
          const mark = !item.required ? '⚠' : item.satisfied ? '✔' : '✖';
          return (
            <div
              key={`${item.kind}:${item.key}`}
              className={`wr-node${item.required && !item.satisfied ? ' wr-invalid' : ''}`}
              style={{ '--g': item.satisfied ? 'var(--success)' : item.required ? 'var(--danger)' : 'var(--warning)' } as CSSProperties}
            >
              <div className="text-sm font-extrabold text-ink">
                {mark} {item.kind === 'role' ? 'Role' : item.kind === 'line' ? 'Line' : 'Team'} {item.label}
              </div>
              <div className="text-xs text-muted mt-1">
                {item.assignees.length === 0
                  ? '— nobody —'
                  : item.assignees.map((assignee) => `${assignee.name}${assignee.online ? ' ●' : ' ○'}`).join(', ')}
                {item.reason === 'no_member' ? ' · no members in team' : ''}
                {item.reason === 'no_line_holder' ? ' · no line holder' : ''}
                {item.reason === 'too_many_players' ? ' · too many players' : ''}
              </div>
              <div className="text-xs text-muted mt-1">
                {item.needed_by
                  .map((need) =>
                    need.branch_only
                      ? `only if “${need.title}” fires`
                      : `T+${need.minute ?? '—'} ${need.app.replace(/_/g, ' ')}`,
                  )
                  .join(' · ')}
              </div>
              {item.kind === 'role' && (
                <AssignSelect
                  sessionId={sessionId}
                  kind="role"
                  roleId={item.key}
                  teamName={item.team_name}
                  onChanged={() => void load()}
                />
              )}
              {item.kind === 'line' && (
                <AssignSelect
                  sessionId={sessionId}
                  kind="line"
                  teamName={item.team_name}
                  onChanged={() => void load()}
                />
              )}
            </div>
          );
        })}
      </div>
      {coverage.load.length > 0 && (
        <div className="mt-3 text-xs text-muted">
          {coverage.load.map((row) => (
            <div key={row.user_id}>
              {row.name}: {row.roles.length} roles + {row.lines.length} lines · {row.scheduled_contacts} contacts · overlap {row.max_overlap}
              {row.level !== 'ok' ? ` · ${row.level}` : ''}
            </div>
          ))}
        </div>
      )}
      {coverage.warnings.length > 0 && (
        <div className="wr-note" style={{ marginTop: 12 }}>
          <span>{coverage.warnings[0]}</span>
        </div>
      )}
    </div>
  );

  async function refill() {
    setBusy(true);
    setMessage(null);
    try {
      await api.sessions.autofillCallTakers(sessionId);
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setMessage('Presence is not available on this server, so nobody was picked.');
      } else {
        setMessage('Auto-fill failed.');
      }
    } finally {
      setBusy(false);
    }
  }
}

function AssignSelect({
  sessionId,
  kind,
  teamName,
  roleId,
  onChanged,
}: {
  sessionId: string;
  kind: 'role' | 'line';
  teamName: string;
  roleId?: string;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<Array<{ user_id: string; name: string }>>([]);
  const [value, setValue] = useState('');

  useEffect(() => {
    let cancel = false;
    void api.teams
      .getSessionTeams(sessionId)
      .then((result) => {
        if (cancel) return;
        const rows = (result.data as Array<{ user_id: string; team_name: string; user?: { full_name?: string } }>).filter(
          (row) => row.team_name === teamName,
        );
        setMembers(rows.map((row) => ({ user_id: row.user_id, name: row.user?.full_name || 'Player' })));
      })
      .catch(() => setMembers([]));
    return () => {
      cancel = true;
    };
  }, [sessionId, teamName]);

  return (
    <label className="mt-2 block text-xs">
      Assign
      <select
        className="ml-2 rounded border border-black/10 bg-white px-2 py-1"
        value={value}
        onChange={(event) => {
          const userId = event.target.value;
          setValue(userId);
          if (!userId) return;
          const request =
            kind === 'role' && roleId
              ? api.sessions.setRoles(sessionId, roleId, [userId])
              : api.sessions.setCallTakers(sessionId, teamName, [userId]);
          void request.then(() => onChanged()).catch(() => setValue(''));
        }}
      >
        <option value="">Choose…</option>
        {members.map((member) => (
          <option key={member.user_id} value={member.user_id}>
            {member.name}
          </option>
        ))}
      </select>
    </label>
  );
}
