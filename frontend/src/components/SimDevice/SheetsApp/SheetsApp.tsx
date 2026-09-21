import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, type ContactRow, type ContactsWorkbook } from '../../../lib/api';
import { openAppWithIntent } from '../../../lib/appIntents';
import { useDeviceNav } from '../../../lib/deviceNav';
import './sheets-app.css';

export type SheetsAppVariant = 'mobile' | 'desktop';

type Column = {
  key:
    | 'name'
    | 'title'
    | 'organisation'
    | 'site_key'
    | 'email'
    | 'phone'
    | 'handle'
    | 'note'
    | 'owning_team'
    | 'org_display';
  label: string;
  width: number;
  action?: 'email' | 'chat' | 'phone';
};

const PLAYER_COLUMNS: Column[] = [
  { key: 'name', label: 'Name', width: 170 },
  { key: 'title', label: 'Title', width: 170 },
  { key: 'organisation', label: 'Organisation', width: 190 },
  { key: 'email', label: 'Email', width: 230, action: 'email' },
  { key: 'phone', label: 'Phone', width: 130, action: 'phone' },
  { key: 'handle', label: 'Chat', width: 150, action: 'chat' },
  { key: 'note', label: 'Notes', width: 320 },
];

/** Colleagues sheet: every player in the session (human or AI teammate, every office). */
const COLLEAGUE_COLUMNS: Column[] = [
  { key: 'name', label: 'Name', width: 190 },
  { key: 'title', label: 'Team', width: 190 },
  { key: 'organisation', label: 'Office', width: 240 },
  { key: 'email', label: 'Email', width: 250, action: 'email' },
  { key: 'handle', label: 'Chat', width: 150, action: 'chat' },
  { key: 'note', label: 'Notes', width: 260 },
];

/** Roster sheet (contract v3.2 `tier: 'roster'`): rank-and-file, grouped by site. */
const ROSTER_COLUMNS: Column[] = [
  { key: 'name', label: 'Name', width: 170 },
  { key: 'title', label: 'Role', width: 170 },
  { key: 'site_key', label: 'Site', width: 120 },
  { key: 'organisation', label: 'Organisation', width: 190 },
  { key: 'email', label: 'Email', width: 230, action: 'email' },
  { key: 'phone', label: 'Phone', width: 130, action: 'phone' },
  { key: 'handle', label: 'Chat', width: 150, action: 'chat' },
  { key: 'note', label: 'Notes', width: 320 },
];

/** Display text for a cell; distribution lists are badged with their member count. */
function cellText(col: Column, row: ContactRow): string {
  const raw = row[col.key];
  const value = raw == null || raw === '' ? '' : String(raw);
  if (col.key === 'name' && row.kind === 'group') {
    const count = row.members?.length ?? 0;
    const badge = /distribution list/i.test(value) ? '' : ' (distribution list)';
    return `${value}${badge}${count > 0 ? ` · ${count} members` : ''}`;
  }
  if (col.key === 'title' && row.kind === 'group' && value === '') return 'Distribution list';
  // Trainer-only marker on colleague rows (players are not told who is an AI teammate).
  if (col.key === 'note' && row.player_user_id && row.is_bot) {
    return value ? `${value} · AI teammate` : 'AI teammate';
  }
  return value;
}

const TRAINER_EXTRA: Column[] = [
  { key: 'owning_team', label: 'Owning team', width: 150 },
  { key: 'org_display', label: 'Organisation (org)', width: 170 },
];

function colLetter(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function SheetsApp({ variant }: { variant: SheetsAppVariant }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const deviceNav = useDeviceNav('contacts');
  const [workbook, setWorkbook] = useState<ContactsWorkbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSheet, setActiveSheet] = useState(0);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [teamFilter, setTeamFilter] = useState('');
  const [orgFilter, setOrgFilter] = useState('');
  const isMobile = variant === 'mobile';

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 2000);
  }, []);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const res = await api.contacts.workbook(sessionId, {
        team: teamFilter || undefined,
        org_key: orgFilter || undefined,
      });
      setWorkbook(res.data);
      setError(null);
      setActiveSheet((i) => Math.min(i, Math.max(0, (res.data.sheets.length || 1) - 1)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load contacts');
    } finally {
      setLoading(false);
    }
  }, [sessionId, teamFilter, orgFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const sheet = workbook?.sheets[activeSheet] ?? null;
  const rows: ContactRow[] = sheet?.rows ?? [];
  const isRosterSheet = sheet?.relationship === 'roster';
  const isColleagueSheet = sheet?.relationship === 'colleague';
  const columns = useMemo(() => {
    const baseCols = isColleagueSheet
      ? COLLEAGUE_COLUMNS
      : isRosterSheet
        ? ROSTER_COLUMNS
        : PLAYER_COLUMNS;
    // Colleague rows already show team and office; the trainer extras would repeat them.
    return workbook?.is_trainer && !isColleagueSheet ? [...baseCols, ...TRAINER_EXTRA] : baseCols;
  }, [workbook?.is_trainer, isRosterSheet, isColleagueSheet]);

  const teamLabel = workbook?.team?.function_key || workbook?.team?.team_name || null;
  const fileName = `Contacts_${(teamLabel || (workbook?.is_trainer ? 'AllTeams' : 'Team')).replace(/[^\w]+/g, '')}.xlsx`;
  const fileMeta = [
    teamLabel ? `${teamLabel} contacts` : workbook?.is_trainer ? 'All teams' : '',
    workbook?.org && workbook.multi_org
      ? `${workbook.org.display_name}${workbook.org.country ? ` · ${workbook.org.country}` : ''}`
      : '',
    'Read-only',
  ]
    .filter(Boolean)
    .join(' — ');

  const base = `/sim/${sessionId}`;

  const runAction = async (col: Column, row: ContactRow) => {
    if (!sessionId) return;
    if (col.action === 'email' && row.email) {
      openAppWithIntent(navigate, base, location.pathname, 'email', { compose_to: row.email });
      return;
    }
    if (col.action === 'phone' && row.phone) {
      try {
        await navigator.clipboard.writeText(row.phone);
        showToast(`Copied ${row.phone}`);
      } catch {
        showToast(row.phone);
      }
      return;
    }
    if (col.action === 'chat' && row.handle) {
      if (row.id.startsWith('fallback:')) {
        showToast('This contact is reachable by email only');
        return;
      }
      try {
        // Colleagues (players, human or AI) get a player-to-player DM; NPC contacts an NPC DM.
        const res = row.player_user_id
          ? await api.channels.createDM(sessionId, row.player_user_id)
          : await api.channels.createNpcDM(sessionId, row.id);
        openAppWithIntent(navigate, base, location.pathname, 'chat', { channel: res.data.id });
      } catch {
        showToast('Could not open a chat with this contact');
      }
    }
  };

  const selectedValue = (() => {
    if (!selected || !rows[selected.r]) return '';
    const col = columns[selected.c];
    return col ? cellText(col, rows[selected.r]) : '';
  })();
  const selectedRef = selected ? `${colLetter(selected.c)}${selected.r + 2}` : '';

  const back = () => deviceNav.goHome();

  const tabs = (
    <div className={`sheets-tabs ${isMobile ? '' : 'top'}`} role="tablist" aria-label="Sheets">
      {(workbook?.sheets ?? []).map((s, i) => (
        <button
          key={s.relationship}
          role="tab"
          aria-selected={i === activeSheet}
          className={`sheets-tab ${i === activeSheet ? 'active' : ''}`}
          onClick={() => {
            setActiveSheet(i);
            setSelected(null);
          }}
        >
          {s.label}
          <span className="sheets-tab-count">{s.rows.length}</span>
        </button>
      ))}
    </div>
  );

  const trainerFilters =
    workbook?.is_trainer && workbook.multi_org ? (
      <div className="sheets-filter-bar">
        <label>
          Team{' '}
          <input
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            placeholder="function, e.g. Stakeholder Engagement"
            style={{
              font: 'inherit',
              padding: '3px 6px',
              border: '1px solid #d4d4d4',
              borderRadius: 3,
            }}
          />
        </label>
        <label>
          Org key{' '}
          <input
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            placeholder="e.g. org_pnp_ph"
            style={{
              font: 'inherit',
              padding: '3px 6px',
              border: '1px solid #d4d4d4',
              borderRadius: 3,
            }}
          />
        </label>
      </div>
    ) : null;

  return (
    <div className={`sheets-app ${variant}`} style={{ position: 'relative' }}>
      <header className="sheets-title-bar">
        {isMobile && (
          <button className="sheets-icon-button" onClick={back} aria-label="Back home">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="sheets-file-name">{fileName}</div>
          <div className="sheets-file-meta">{fileMeta}</div>
        </div>
        <span className="sheets-icon-button" aria-hidden title="Excel">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#ffffff" opacity="0.9">
            <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h6v16h-6A1.5 1.5 0 0 1 3 18.5v-13Zm8.5-1.5H19.5A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-8V4Zm1.5 3v2h5V7h-5Zm0 4v2h5v-2h-5Zm0 4v2h5v-2h-5Z" />
          </svg>
        </span>
      </header>

      <div className="sheets-ribbon" aria-hidden>
        {['File', 'Home', 'Insert', 'Formulas', 'Data', 'Review', 'View'].map((t) => (
          <span key={t} className={`sheets-ribbon-tab ${t === 'Home' ? 'active' : ''}`}>
            {t}
          </span>
        ))}
        <span className="sheets-readonly-pill">Read-only · shared by your organisation</span>
      </div>

      {trainerFilters}
      {!isMobile && (workbook?.sheets.length ?? 0) > 0 && tabs}

      <div className="sheets-formula-bar">
        <span className="sheets-cell-ref">{selectedRef || (sheet ? 'A1' : '')}</span>
        <span className="sheets-formula-value" title={selectedValue}>
          {selectedValue}
        </span>
      </div>

      {loading ? (
        <div className="sheets-empty">Loading…</div>
      ) : error ? (
        <div className="sheets-empty">
          <strong>Could not open the workbook</strong>
          <span>{error}</span>
        </div>
      ) : !workbook || workbook.sheets.length === 0 ? (
        <div className="sheets-empty">
          <strong>
            {workbook?.source === 'none' && !workbook.team && !workbook.is_trainer
              ? 'Join a team to receive your contacts file.'
              : 'No contacts file for your team yet.'}
          </strong>
          <span>Contacts appear here once your organisation shares them with your department.</span>
        </div>
      ) : (
        <div className="sheets-grid-wrap">
          <table
            className="sheets-grid"
            style={{ width: 40 + columns.reduce((a, c) => a + c.width, 0) }}
          >
            <colgroup>
              <col style={{ width: 40 }} />
              {columns.map((c) => (
                <col key={c.key} style={{ width: c.width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="sheets-corner" />
                {columns.map((c, i) => (
                  <th key={c.key} className="sheets-col-header" title={c.label}>
                    {colLetter(i)}
                  </th>
                ))}
              </tr>
              <tr className="sheets-header-row">
                <th className="sheets-row-num">1</th>
                {columns.map((c) => (
                  <th key={c.key} className="sheets-col-header">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={row.id}>
                  <td className="sheets-row-num">{r + 2}</td>
                  {columns.map((c, ci) => {
                    const value = cellText(c, row);
                    const actionable = !!c.action && value !== '';
                    const isSel = selected?.r === r && selected?.c === ci;
                    return (
                      <td
                        key={c.key}
                        className={`${isSel ? 'selected' : ''} ${actionable ? 'actionable' : ''} ${value === '' ? 'muted' : ''}`}
                        title={
                          actionable
                            ? `${c.action === 'email' ? 'Compose email to' : c.action === 'chat' ? 'Chat with' : 'Copy'} ${value}`
                            : value
                        }
                        onClick={() => {
                          setSelected({ r, c: ci });
                          if (actionable) void runAction(c, row);
                        }}
                      >
                        {value === '' && c.key === 'phone' ? '—' : value}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="sheets-row-num">2</td>
                  <td className="muted" colSpan={columns.length}>
                    No contacts in this sheet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {isMobile && (workbook?.sheets.length ?? 0) > 0 && tabs}

      <div className="sheets-status-bar">
        <span>
          {sheet
            ? `${sheet.label} · ${rows.length} ${isColleagueSheet ? 'colleague' : 'contact'}${rows.length === 1 ? '' : 's'}`
            : 'Ready'}
        </span>
        <span>{workbook?.source === 'fallback' ? 'Built from correspondence' : '100%'}</span>
      </div>

      {toast && <div className="sheets-toast">{toast}</div>}
    </div>
  );
}

export function SheetsAppMobile() {
  return <SheetsApp variant="mobile" />;
}

export function SheetsAppDesktop() {
  return <SheetsApp variant="desktop" />;
}
