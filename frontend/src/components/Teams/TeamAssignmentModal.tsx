import { useState, useEffect, useMemo } from 'react';
import { api } from '../../lib/api';
import { BotBadge } from '../UI/BotBadge';

interface TeamAssignmentModalProps {
  sessionId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

interface Participant {
  user_id: string;
  role: string;
  user?: {
    id: string;
    full_name: string;
    role: string;
    is_bot?: boolean;
  };
}

interface TeamAssignment {
  id: string;
  user_id: string;
  team_name: string;
  team_role?: string;
}

interface ScenarioTeam {
  team_name: string;
  team_description?: string | null;
  min_participants?: number | null;
  max_participants?: number | null;
  /** Contract §5.2 — organisation / function identity (multi-org scenarios). */
  org_key?: string | null;
  function_key?: string | null;
}

interface PendingChange {
  type: 'add' | 'remove';
  userId: string;
  teamName: string;
}

/** Organisation identity for the group band (from /sessions/:id/orgs). */
interface OrgInfo {
  org_key: string;
  display_name: string;
  short_name?: string;
  country?: string | null;
  is_primary?: boolean;
  /** 'players' | 'ai' — whether people or the engine run this organisation. */
  operation?: string;
}

/* ─── Layout constants (px) ──────────────────────────────────────────── */
/** Participant name column. */
const NAME_COL = 184;
/** Narrowest a team column may get before the matrix scrolls sideways
 *  (fits "Communications" on one line at the header's 11px bold). */
const TEAM_COL_MIN = 104;
/** Modal width bounds: max-w-5xl by default, widening (to just under a 1366px
 *  laptop viewport) when the scenario has more teams than fit at TEAM_COL_MIN. */
const MODAL_MIN = 1024;
const MODAL_MAX = 1320;
/** Horizontal chrome around the matrix: modal padding (2 × 24) + room for a
 *  vertical scrollbar so it never tips the matrix into sideways scrolling. */
const MODAL_CHROME = 48 + 20;

export const TeamAssignmentModal = ({
  sessionId,
  onClose,
  onSuccess,
}: TeamAssignmentModalProps) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [teamAssignments, setTeamAssignments] = useState<TeamAssignment[]>([]);
  const [scenarioTeams, setScenarioTeams] = useState<ScenarioTeam[]>([]);
  const [orgsByKey, setOrgsByKey] = useState<Record<string, OrgInfo>>({});
  const [isSocialSim, setIsSocialSim] = useState(false);

  // Multi-team mode (field ops): granular add/remove changes.
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  // Single-team mode (social crisis): one team per player, pending selection map.
  const [pendingTeamByUser, setPendingTeamByUser] = useState<Record<string, string | null>>({});

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const sessionResult = await api.sessions.get(sessionId);
      const session = sessionResult.data as {
        participants?: Participant[];
        scenario_id?: string;
        sim_mode?: string;
        trainer_id?: string;
      };
      const trainerId = session?.trainer_id;
      if (session?.participants) {
        setParticipants(session.participants.filter((p) => p.user_id !== trainerId));
      }
      setIsSocialSim(session?.sim_mode === 'social_media');

      const scenarioId = session?.scenario_id;
      if (scenarioId) {
        const scenarioTeamsResult = await api.teams.getScenarioTeams(scenarioId);
        setScenarioTeams((scenarioTeamsResult.data ?? []) as ScenarioTeam[]);
      } else {
        setScenarioTeams([]);
      }

      // Organisation names for the group band. Best-effort: the matrix falls
      // back to the raw org_key if this endpoint is unavailable.
      try {
        const orgsResult = await api.sessions.orgs(sessionId);
        const map: Record<string, OrgInfo> = {};
        for (const o of orgsResult.data?.orgs ?? []) {
          map[o.org_key] = {
            org_key: o.org_key,
            display_name: o.display_name,
            short_name: o.short_name,
            country: o.country,
            is_primary: o.is_primary,
            operation: (o as { operation?: string }).operation,
          };
        }
        setOrgsByKey(map);
      } catch {
        setOrgsByKey({});
      }

      const teamsResult = await api.teams.getSessionTeams(sessionId);
      setTeamAssignments(teamsResult.data || []);
      setPendingChanges([]);
      setPendingTeamByUser({});
    } catch (error) {
      console.error('Failed to load team assignment data:', error);
      alert('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  // Multi-org scenarios: columns grouped by organisation — the players' own
  // (primary) organisation first, then the others by name — then by team name.
  const sortedTeams = useMemo(() => {
    const orgRank = (key: string | null | undefined): string => {
      if (key === null || key === undefined) return '0';
      const o = orgsByKey[key];
      const primary = o ? o.is_primary === true : key === 'primary';
      return `${primary ? '1' : '2'}:${(o?.display_name ?? key).toLowerCase()}`;
    };
    return [...scenarioTeams].sort(
      (a, b) =>
        orgRank(a.org_key).localeCompare(orgRank(b.org_key)) ||
        a.team_name.localeCompare(b.team_name),
    );
  }, [scenarioTeams, orgsByKey]);
  const availableTeams = useMemo(() => sortedTeams.map((t) => t.team_name), [sortedTeams]);
  const orgGroups = useMemo(() => {
    const groups: Array<{ org_key: string | null; count: number }> = [];
    for (const t of sortedTeams) {
      const key = t.org_key ?? null;
      const last = groups[groups.length - 1];
      if (last && last.org_key === key) last.count += 1;
      else groups.push({ org_key: key, count: 1 });
    }
    return groups;
  }, [sortedTeams]);
  const isMultiOrg = orgGroups.filter((g) => g.org_key !== null).length > 1;

  const teamByName = useMemo(() => {
    const map = new Map<string, ScenarioTeam>();
    for (const t of scenarioTeams) map.set(t.team_name, t);
    return map;
  }, [scenarioTeams]);

  /** Index of the org group each team column belongs to (for alternating tint). */
  const orgIndexByTeam = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    let col = 0;
    for (const g of orgGroups) {
      for (let k = 0; k < g.count; k++) map.set(availableTeams[col++], i);
      i += 1;
    }
    return map;
  }, [orgGroups, availableTeams]);

  const orgLabel = (orgKey: string | null): string => {
    if (orgKey === null) return 'All organisations';
    const o = orgsByKey[orgKey];
    if (!o) return orgKey;
    return o.operation === 'ai' ? `${o.display_name} · AI-operated` : o.display_name;
  };
  const orgTitle = (orgKey: string | null): string => {
    if (orgKey === null) return 'Teams shared by every organisation';
    const o = orgsByKey[orgKey];
    if (!o) return orgKey;
    const parts = [o.display_name];
    if (o.country) parts.push(o.country);
    if (o.operation === 'ai') parts.push('run by the engine — seats here are usually AI teammates');
    return parts.join(' · ');
  };

  /** Column heading. In multi-org scenarios team names carry an org suffix
   *  ("Communications — DH"); the org band already says which organisation,
   *  so the column shows just the function. The full name stays in the tooltip. */
  const columnLabel = (teamName: string): string => {
    if (!isMultiOrg) return teamName;
    const def = teamByName.get(teamName);
    if (def?.function_key && teamName.startsWith(def.function_key)) return def.function_key;
    return teamName.replace(/\s+—\s+[^—]*$/, '');
  };

  // Widen the modal (up to MODAL_MAX) so every team column keeps at least
  // TEAM_COL_MIN; beyond that the matrix scrolls sideways as one unit.
  const modalMaxWidth = Math.min(
    MODAL_MAX,
    Math.max(MODAL_MIN, MODAL_CHROME + NAME_COL + availableTeams.length * TEAM_COL_MIN),
  );
  const gridTemplateColumns = `${NAME_COL}px repeat(${Math.max(availableTeams.length, 1)}, minmax(${TEAM_COL_MIN}px, 1fr))`;

  const getUserName = (userId: string): string => {
    const participant = participants.find((p) => p.user_id === userId);
    return participant?.user?.full_name ?? userId;
  };

  /* ─── Single-team mode (social crisis) ─────────────────────────────── */

  const serverTeamOf = (userId: string): string | null => {
    const rows = teamAssignments.filter((a) => a.user_id === userId);
    return rows.length > 0 ? rows[0].team_name : null;
  };

  const effectiveTeamOf = (userId: string): string | null => {
    if (userId in pendingTeamByUser) return pendingTeamByUser[userId];
    return serverTeamOf(userId);
  };

  const handleSelectTeam = (userId: string, teamName: string) => {
    const current = effectiveTeamOf(userId);
    const next = current === teamName ? null : teamName;
    setPendingTeamByUser((prev) => {
      const updated = { ...prev };
      if (next === serverTeamOf(userId)) {
        delete updated[userId];
      } else {
        updated[userId] = next;
      }
      return updated;
    });
  };

  const headcount = (teamName: string): number =>
    participants.filter((p) => effectiveTeamOf(p.user_id) === teamName).length;

  const singleModeChanges = Object.keys(pendingTeamByUser).length;

  const autoBalance = () => {
    const unassignedIds = participants
      .filter((p) => effectiveTeamOf(p.user_id) === null)
      .map((p) => p.user_id);
    if (unassignedIds.length === 0 || availableTeams.length === 0) return;

    const counts = new Map<string, number>(availableTeams.map((t) => [t, headcount(t)]));
    const updates: Record<string, string> = {};
    for (const userId of unassignedIds) {
      // Fill the team furthest below its minimum first, then the smallest team
      // that still has capacity, then simply the smallest.
      let best: string | null = null;
      let bestScore = Infinity;
      for (const teamName of availableTeams) {
        const team = teamByName.get(teamName);
        const count = counts.get(teamName) || 0;
        const max = team?.max_participants ?? Infinity;
        const min = team?.min_participants ?? 1;
        const overMax = count >= max ? 1000 : 0;
        const belowMin = count < min ? -100 : 0;
        const score = count + overMax + belowMin;
        if (score < bestScore) {
          bestScore = score;
          best = teamName;
        }
      }
      if (best) {
        updates[userId] = best;
        counts.set(best, (counts.get(best) || 0) + 1);
      }
    }
    setPendingTeamByUser((prev) => ({ ...prev, ...updates }));
  };

  const saveSingleMode = async () => {
    setSaving(true);
    const errors: string[] = [];
    for (const [userId, teamName] of Object.entries(pendingTeamByUser)) {
      try {
        if (teamName === null) {
          const current = serverTeamOf(userId);
          if (current) {
            await api.teams.removeTeamAssignment(sessionId, userId, current);
          }
        } else {
          // The server enforces move semantics (deletes other rows) for
          // social sessions, so a single assign call is sufficient.
          await api.teams.assignTeam(sessionId, userId, teamName);
        }
      } catch {
        errors.push(`${getUserName(userId)} → ${teamName ?? 'unassigned'}`);
      }
    }
    setSaving(false);
    if (errors.length > 0) {
      alert(`Some changes failed:\n${errors.join('\n')}`);
    }
    setPendingTeamByUser({});
    onSuccess?.();
    onClose();
  };

  /* ─── Multi-team mode (field ops) — original behaviour ─────────────── */

  const getEffectiveTeams = (userId: string): string[] => {
    const serverTeams = teamAssignments.filter((a) => a.user_id === userId).map((a) => a.team_name);
    const result = new Set(serverTeams);
    for (const change of pendingChanges) {
      if (change.userId !== userId) continue;
      if (change.type === 'add') result.add(change.teamName);
      if (change.type === 'remove') result.delete(change.teamName);
    }
    return Array.from(result);
  };

  const isTeamAssignedOnServer = (userId: string, teamName: string): boolean => {
    return teamAssignments.some((a) => a.user_id === userId && a.team_name === teamName);
  };

  const handleToggleTeam = (userId: string, teamName: string) => {
    const currentlyAssigned = getEffectiveTeams(userId).includes(teamName);
    setPendingChanges((prev) => {
      const filtered = prev.filter((c) => !(c.userId === userId && c.teamName === teamName));
      if (currentlyAssigned) {
        if (isTeamAssignedOnServer(userId, teamName)) {
          return [...filtered, { type: 'remove', userId, teamName }];
        }
        return filtered;
      } else {
        if (!isTeamAssignedOnServer(userId, teamName)) {
          return [...filtered, { type: 'add', userId, teamName }];
        }
        return filtered;
      }
    });
  };

  const saveMultiMode = async () => {
    if (pendingChanges.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    const errors: string[] = [];
    for (const change of pendingChanges) {
      try {
        if (change.type === 'add') {
          await api.teams.assignTeam(sessionId, change.userId, change.teamName);
        } else {
          await api.teams.removeTeamAssignment(sessionId, change.userId, change.teamName);
        }
      } catch {
        const name = getUserName(change.userId);
        errors.push(`${change.type === 'add' ? 'Assign' : 'Remove'} ${name} → ${change.teamName}`);
      }
    }
    setSaving(false);
    if (errors.length > 0) {
      alert(`Some changes failed:\n${errors.join('\n')}`);
    }
    setPendingChanges([]);
    onSuccess?.();
    onClose();
  };

  /* ─── Render ────────────────────────────────────────────────────────── */

  const changeCount = isSocialSim ? singleModeChanges : pendingChanges.length;

  const handleSaveAll = () => {
    if (changeCount === 0) {
      onClose();
      return;
    }
    if (isSocialSim) void saveSingleMode();
    else void saveMultiMode();
  };

  const handleCancel = () => {
    setPendingChanges([]);
    setPendingTeamByUser({});
    onClose();
  };

  // Note: the app's colour tokens are plain CSS variables, so Tailwind opacity
  // modifiers such as `bg-ink/40` resolve to transparent. The backdrop uses the
  // dedicated --overlay token instead.
  const backdropStyle = { background: 'var(--overlay)' } as const;

  if (loading) {
    return (
      <div
        className="fixed inset-0 backdrop-blur-sm flex items-center justify-center z-50"
        style={backdropStyle}
      >
        <div className="bg-surface border border-border rounded-2xl shadow-lg p-8">
          <p className="terminal-text text-ink">Loading…</p>
        </div>
      </div>
    );
  }

  const unassignedCount = isSocialSim
    ? participants.filter((p) => effectiveTeamOf(p.user_id) === null).length
    : participants.filter((p) => getEffectiveTeams(p.user_id).length === 0).length;
  const assignedCount = participants.length - unassignedCount;

  return (
    <div
      className="fixed inset-0 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      style={backdropStyle}
    >
      <div
        className="bg-surface border border-border rounded-2xl shadow-lg p-6 w-full max-h-[90vh] flex flex-col"
        style={{ maxWidth: modalMaxWidth }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-assignments-title"
      >
        <div className="flex justify-between items-start gap-4 mb-1">
          <div>
            <h2 id="team-assignments-title" className="text-xl terminal-text">
              Team assignments
            </h2>
            {isSocialSim && (
              <p className="text-xs text-muted mt-0.5">
                One team per player. Each team has its own storyline pressure, tasks and scoring
                rubric — hover a team name for its mission.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {changeCount > 0 && <span className="wr-p live">{changeCount} unsaved</span>}
            {isSocialSim && (
              <button
                type="button"
                onClick={autoBalance}
                disabled={saving || unassignedCount === 0}
                className="wr-btn sm"
                title="Distribute unassigned players evenly across the teams"
              >
                Auto-balance
              </button>
            )}
          </div>
        </div>

        {/* The matrix: one grid for the org band, the team header and every row,
            so the columns are shared and stay aligned. Scrolls both ways. */}
        <div className="flex-1 overflow-auto min-h-0 mt-3">
          {availableTeams.length === 0 ? (
            <p className="text-sm text-muted py-8 text-center">
              This scenario has no teams defined yet.
            </p>
          ) : (
            <div
              className={`wr-matrix${isMultiOrg ? ' has-orgs' : ''}`}
              style={{ gridTemplateColumns }}
            >
              {/* Organisation band (multi-org scenarios only) */}
              {isMultiOrg && (
                <>
                  <div className="c org name" aria-hidden="true" />
                  {orgGroups.map((g, i) => (
                    <div
                      key={`${g.org_key ?? 'all'}-${i}`}
                      className={`c org${i % 2 === 1 ? ' alt' : ''}`}
                      style={{ gridColumn: `span ${g.count}` }}
                      title={orgTitle(g.org_key)}
                    >
                      <span>{orgLabel(g.org_key)}</span>
                    </div>
                  ))}
                </>
              )}

              {/* Team header */}
              <div className="c th name">
                <span className="t">Participant</span>
              </div>
              {availableTeams.map((team) => {
                const def = teamByName.get(team);
                const count = isSocialSim ? headcount(team) : undefined;
                const min = def?.min_participants ?? 1;
                const max = def?.max_participants ?? null;
                const understaffed = isSocialSim && (count || 0) < min;
                const alt = (orgIndexByTeam.get(team) ?? 0) % 2 === 1;
                return (
                  <div
                    key={team}
                    className={`c th${alt ? ' alt' : ''}`}
                    title={def?.team_description ? `${team}\n\n${def.team_description}` : team}
                  >
                    <span className="t">{columnLabel(team)}</span>
                    {isSocialSim && (
                      <span className={`n${understaffed ? ' low' : ''}`}>
                        {count}/{max ?? '∞'}
                        {understaffed ? ' · unstaffed' : ''}
                      </span>
                    )}
                  </div>
                );
              })}

              {/* Participant rows */}
              {participants.map((participant) => {
                const name = getUserName(participant.user_id);
                const effectiveSingle = isSocialSim ? effectiveTeamOf(participant.user_id) : null;
                const effectiveMulti = isSocialSim ? [] : getEffectiveTeams(participant.user_id);
                const isUnassigned = isSocialSim
                  ? effectiveSingle === null
                  : effectiveMulti.length === 0;

                return (
                  <div
                    key={participant.user_id}
                    className="row"
                    role={isSocialSim ? 'radiogroup' : 'group'}
                    aria-label={`${name} — team`}
                  >
                    <div className="c name">
                      <div className="min-w-0">
                        <div className="who">
                          <span title={name}>{name}</span>
                          {participant.user?.is_bot && <BotBadge />}
                        </div>
                        {isUnassigned && <div className="sub">Unassigned</div>}
                      </div>
                    </div>

                    {availableTeams.map((team) => {
                      const isActive = isSocialSim
                        ? effectiveSingle === team
                        : effectiveMulti.includes(team);
                      const hasPending = isSocialSim
                        ? participant.user_id in pendingTeamByUser &&
                          (pendingTeamByUser[participant.user_id] === team ||
                            (serverTeamOf(participant.user_id) === team &&
                              pendingTeamByUser[participant.user_id] !== team))
                        : pendingChanges.some(
                            (c) => c.userId === participant.user_id && c.teamName === team,
                          );
                      const alt = (orgIndexByTeam.get(team) ?? 0) % 2 === 1;
                      const pickClass = [
                        'pick',
                        isSocialSim ? '' : 'sq',
                        isActive ? 'on' : 'off',
                        hasPending ? 'pending' : '',
                      ]
                        .filter(Boolean)
                        .join(' ');

                      return (
                        <div key={team} className={`c${alt ? ' alt' : ''}`}>
                          <button
                            type="button"
                            role={isSocialSim ? 'radio' : 'checkbox'}
                            aria-checked={isActive}
                            aria-label={`${name}: ${team}`}
                            disabled={saving}
                            onClick={() =>
                              isSocialSim
                                ? handleSelectTeam(participant.user_id, team)
                                : handleToggleTeam(participant.user_id, team)
                            }
                            className={pickClass}
                            title={
                              isActive ? `Remove ${name} from ${team}` : `Assign ${name} to ${team}`
                            }
                          >
                            {isSocialSim ? (
                              <span className="dot" aria-hidden="true" />
                            ) : (
                              <svg
                                className="tick"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M3 8.5l3.2 3L13 4.5" />
                              </svg>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Summary + legend */}
        {participants.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-xs text-muted mt-3 pt-2 border-t border-border">
            <div className="flex gap-4">
              <span>{assignedCount} assigned</span>
              {unassignedCount > 0 && (
                <span className="text-danger font-semibold">
                  {unassignedCount} unassigned
                  {isSocialSim ? ' — they will miss team-specific content and scoring' : ''}
                </span>
              )}
            </div>
            <div className="wr-matrix-legend">
              <span className="k">
                <i className={isSocialSim ? '' : 'sq'} /> assigned
              </span>
              {changeCount > 0 && (
                <>
                  <span className="k">
                    <i className={`new${isSocialSim ? '' : ' sq'}`} /> will be assigned
                  </span>
                  <span className="k">
                    <i className={`rm${isSocialSim ? '' : ' sq'}`} /> will be removed
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-4 mt-2 border-t border-border flex-shrink-0">
          <button
            type="button"
            onClick={handleSaveAll}
            disabled={saving}
            className={`wr-btn lg flex-1 ${changeCount > 0 ? 'accent' : ''}`}
          >
            {saving
              ? 'Saving…'
              : changeCount > 0
                ? `Save ${changeCount} change${changeCount !== 1 ? 's' : ''}`
                : 'Close'}
          </button>
          {changeCount > 0 && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="wr-btn lg flex-1"
            >
              Discard changes
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
