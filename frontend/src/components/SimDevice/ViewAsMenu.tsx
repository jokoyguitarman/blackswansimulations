import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadStaffView } from '../../lib/viewAsClient';
import { viewAsOptionLabel, viewedByText, type ViewAsPlayer } from '../../lib/viewAsRoster';

/**
 * "View as…" for the trainer console and a concluded session page.
 * Hidden unless ENABLE_STAFF_VIEW_AS is on (the staff-view probe is not 200).
 */
export function ViewAsMenu({
  sessionId,
  showViewedBy = false,
}: {
  sessionId: string;
  /** Admins on the trainer console. The server sends names only to admins. */
  showViewedBy?: boolean;
}) {
  const navigate = useNavigate();
  const [players, setPlayers] = useState<ViewAsPlayer[] | null>(null);
  const [viewedBy, setViewedBy] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setPlayers(null);
    setViewedBy([]);
    loadStaffView(sessionId)
      .then((payload) => {
        if (cancelled || !payload) return;
        setPlayers(payload.players);
        setViewedBy(payload.viewedBy);
      })
      .catch(() => {
        if (!cancelled) setPlayers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!players) return null;

  const viewed = showViewedBy ? viewedByText(viewedBy) : '';

  return (
    <React.Fragment>
      <div className="flex items-center gap-2">
        <ViewAsSelect
          label="View as"
          players={players}
          value=""
          placeholder="View as…"
          onChange={(userId) => {
            navigate(`/sim/${sessionId}/desktop?view_as=${encodeURIComponent(userId)}`);
          }}
        />
        {viewed ? (
          <span className="text-[11px]" style={{ color: '#64748b' }}>
            {viewed}
          </span>
        ) : null}
      </div>
    </React.Fragment>
  );
}

export function ViewAsSelect({
  label,
  players,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  players: readonly ViewAsPlayer[];
  value: string;
  placeholder?: string;
  onChange: (userId: string) => void;
}) {
  return (
    <React.Fragment>
      <label
        className="flex items-center gap-1 text-[11px] font-semibold"
        style={{ color: '#1E3A5F' }}
      >
        <span className="sr-only">{label}</span>
        <select
          aria-label={label}
          value={value}
          onChange={(event) => {
            const userId = event.target.value;
            if (userId) onChange(userId);
          }}
          className="text-[11px] font-medium px-2 py-1.5 rounded-lg"
          style={{ backgroundColor: '#FFFFFF', color: '#1E3A5F', border: '1px solid #E4DFD4' }}
        >
          {placeholder ? <option value="">{placeholder}</option> : null}
          {players.map((player) => (
            <option key={player.userId} value={player.userId}>
              {viewAsOptionLabel(player)}
            </option>
          ))}
        </select>
      </label>
    </React.Fragment>
  );
}
