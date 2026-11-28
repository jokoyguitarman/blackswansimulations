import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DependencyDue } from '@shared/teamDependencies';
import {
  buildPanelView,
  canHold,
  canWaive,
  type HeldItem,
  type PanelEdgeInput,
  type PanelStatus,
  type PressureEvent,
} from '@shared/crossTeamPanel';
import { ApiError, api } from '../../lib/api';
import { useWebSocket } from '../../hooks/useWebSocket';

const PANEL_POLL_MS = 30_000;

export interface EdgePayload {
  id: string;
  upstream: { team_name: string };
  downstream: Array<{ team_name: string }>;
  deliverable: string;
  why: string;
  due: DependencyDue;
  lag_minutes: number;
  inert?: boolean;
  state: {
    status: PanelStatus;
    broken_minute: number | null;
    met_minute: number | null;
    recovered_minute: number | null;
    hold_until_minute: number | null;
    upstream: string | null;
    downstream: string[];
  };
}

export interface PanelPayload {
  available: boolean;
  elapsed_minute: number;
  edges: EdgePayload[];
  anchors: Record<string, number>;
  events: PressureEvent[];
  held: HeldItem[];
}

interface DependencyChanged {
  dep_id?: string;
  status?: PanelStatus;
  broken_minute?: number | null;
  met_minute?: number | null;
  recovered_minute?: number | null;
  hold_until_minute?: number | null;
  upstream?: string | null;
  downstream?: string[];
}

const CHIP_STYLE: Record<string, { background: string; color: string; label: string }> = {
  pending: { background: '#F4F1EA', color: '#6B7280', label: 'Pending' },
  at_risk: { background: '#FEF3C7', color: '#B45309', label: 'At risk' },
  broken: { background: '#FEE2E2', color: '#B91C1C', label: 'Broken' },
  met: { background: '#DCFCE7', color: '#15803D', label: 'Met' },
  late: { background: '#FFEDD5', color: '#C2410C', label: 'Late' },
  waived: { background: '#E5E7EB', color: '#4B5563', label: 'Waived' },
};

export function edgesFromPayload(edges: readonly EdgePayload[]): PanelEdgeInput[] {
  return edges.map((edge) => ({
    id: edge.id,
    upstream_name: edge.state.upstream || edge.upstream.team_name,
    downstream_names:
      edge.state.downstream.length > 0
        ? edge.state.downstream
        : edge.downstream.map((team) => team.team_name),
    deliverable: edge.deliverable,
    why: edge.why,
    due: edge.due,
    lag_minutes: edge.lag_minutes,
    status: edge.state.status,
    broken_minute: edge.state.broken_minute,
    met_minute: edge.state.met_minute,
    recovered_minute: edge.state.recovered_minute,
    hold_until_minute: edge.state.hold_until_minute,
    inert: edge.inert,
  }));
}

export function DependenciesPanelView({
  payload,
  elapsed,
  readOnly = false,
  busyId = null,
  error = null,
  onHold,
  onWaive,
}: {
  payload: PanelPayload;
  elapsed: number;
  readOnly?: boolean;
  busyId?: string | null;
  error?: string | null;
  onHold?: (depId: string) => void;
  onWaive?: (depId: string) => void;
}) {
  const view = useMemo(
    () =>
      buildPanelView({
        edges: edgesFromPayload(payload.edges),
        elapsed,
        anchors: payload.anchors ?? {},
        events: payload.events ?? [],
        held: payload.held ?? [],
      }),
    [payload, elapsed],
  );
  if (!payload.available) return null;
  return (
    <section
      data-testid="dependencies-panel"
      className="rounded-xl border overflow-hidden"
      style={{ backgroundColor: '#FFFFFF', borderColor: '#E4DFD4' }}
    >
      <div
        className="px-4 py-2.5 border-b text-xs font-semibold tracking-wider uppercase"
        style={{ borderColor: '#E4DFD4', color: '#6B7280' }}
      >
        Dependencies
      </div>
      <div className="p-4 space-y-4">
        {view.pressure.length > 0 && (
          <div data-testid="pressure-strip">
            <div className="text-[10px] font-semibold mb-1.5" style={{ color: '#64748b' }}>
              Pressure in the last 15 min
            </div>
            <div className="flex flex-wrap gap-2">
              {view.pressure.map((row) => (
                <div
                  key={row.team}
                  className="text-[11px] rounded-lg px-2 py-1"
                  style={{ backgroundColor: '#F4F1EA', color: '#172033' }}
                >
                  <span className="font-semibold">{row.team}</span>
                  <span style={{ color: '#6B7280' }}>
                    {' '}
                    · authored {row.authored} · cross-team {row.cross_team} · unscripted{' '}
                    {row.unscripted}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {view.held.length > 0 && (
          <ul className="space-y-1" data-testid="held-list">
            {view.held.map((item) => (
              <li key={item.inject_key} className="text-[11px]" style={{ color: '#B45309' }}>
                <span className="font-semibold">{item.inject_key}</span>
                {' · '}
                {item.reason_label}
              </li>
            ))}
          </ul>
        )}
        {view.groups.length === 0 ? (
          <p className="text-[12px]" style={{ color: '#6B7280' }}>
            No team dependencies in this session.
          </p>
        ) : (
          view.groups.map((group) => (
            <div key={group.team}>
              <div className="text-[12px] font-bold mb-1.5" style={{ color: '#1E3A5F' }}>
                {group.team}
              </div>
              <div className="space-y-2">
                {group.edges.map((edge) => {
                  const chip = CHIP_STYLE[edge.chip] ?? CHIP_STYLE.pending;
                  return (
                    <div
                      key={`${group.team}-${edge.id}`}
                      className="rounded-lg px-3 py-2"
                      style={{ backgroundColor: '#FAF8F4', border: '1px solid #E4DFD4' }}
                      data-testid={`dependency-${edge.id}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[12px] font-semibold" style={{ color: '#172033' }}>
                            {edge.upstream_name} → {group.team}
                          </div>
                          <div className="text-[12px]" style={{ color: '#172033' }}>
                            {edge.deliverable}
                          </div>
                          {edge.why && (
                            <div className="text-[11px]" style={{ color: '#6B7280' }}>
                              {edge.why}
                            </div>
                          )}
                          {edge.inert && (
                            <div className="text-[11px]" style={{ color: '#B45309' }}>
                              Upstream team is no longer in the scenario.
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5"
                            style={{ backgroundColor: chip.background, color: chip.color }}
                          >
                            {chip.label}
                          </span>
                          {edge.countdown_minutes != null && (
                            <span
                              className="text-[11px] font-semibold"
                              style={{ color: '#B91C1C' }}
                              data-testid={`countdown-${edge.id}`}
                            >
                              consequence in {edge.countdown_minutes} min
                            </span>
                          )}
                        </div>
                      </div>
                      {!readOnly && (canHold(edge.status) || canWaive(edge.status)) && (
                        <div className="flex gap-2 mt-2">
                          {canHold(edge.status) && (
                            <button
                              type="button"
                              disabled={busyId === edge.id}
                              onClick={() => onHold?.(edge.id)}
                              className="text-[11px] font-semibold px-2 py-1 rounded-lg disabled:opacity-50"
                              style={{ backgroundColor: '#E4DFD4', color: '#1E3A5F' }}
                            >
                              Hold 5 min
                            </button>
                          )}
                          {canWaive(edge.status) && (
                            <button
                              type="button"
                              disabled={busyId === edge.id}
                              onClick={() => onWaive?.(edge.id)}
                              className="text-[11px] font-semibold px-2 py-1 rounded-lg disabled:opacity-50"
                              style={{
                                backgroundColor: '#FFFFFF',
                                color: '#1E3A5F',
                                border: '1px solid #E4DFD4',
                              }}
                            >
                              Waive
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
        {error && (
          <p className="text-[11px]" style={{ color: '#B91C1C' }}>
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export default function DependenciesPanel({
  sessionId,
  elapsedMinutes,
  readOnly = false,
}: {
  sessionId: string;
  elapsedMinutes: number;
  readOnly?: boolean;
}) {
  const [payload, setPayload] = useState<PanelPayload | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const json = await api.sessions.dependencyPanel<PanelPayload>(sessionId);
      if (json.data) setPayload(json.data);
    } catch {
      setPayload(null);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    if (readOnly) return;
    const id = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(id);
  }, [load, readOnly]);

  useWebSocket({
    sessionId,
    enabled: !readOnly,
    eventTypes: ['dependency.changed'],
    onEvent: (evt) => {
      const data = evt.data as DependencyChanged | undefined;
      if (!data?.dep_id || !data.status) {
        void load();
        return;
      }
      setPayload((current) => {
        if (!current) return current;
        const edges = current.edges.map((edge) => {
          if (edge.id !== data.dep_id) return edge;
          return {
            ...edge,
            state: {
              ...edge.state,
              status: data.status ?? edge.state.status,
              broken_minute: data.broken_minute ?? edge.state.broken_minute,
              met_minute: data.met_minute ?? edge.state.met_minute,
              recovered_minute: data.recovered_minute ?? edge.state.recovered_minute,
              hold_until_minute:
                data.hold_until_minute === undefined
                  ? edge.state.hold_until_minute
                  : data.hold_until_minute,
              upstream: data.upstream === undefined ? edge.state.upstream : data.upstream,
              downstream: data.downstream ?? edge.state.downstream,
            },
          };
        });
        return { ...current, edges };
      });
    },
  });

  const command = useCallback(
    async (depId: string, action: 'hold' | 'waive') => {
      setBusyId(depId);
      setError(null);
      try {
        const json = await api.sessions.dependencyCommand<EdgePayload['state']>(
          sessionId,
          depId,
          action,
        );
        const next = json.data;
        setPayload((current) => {
          if (!current) return current;
          return {
            ...current,
            edges: current.edges.map((edge) =>
              edge.id === depId ? { ...edge, state: { ...edge.state, ...next } } : edge,
            ),
          };
        });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'That dependency could not be updated.');
      } finally {
        setBusyId(null);
      }
    },
    [sessionId],
  );

  if (!payload?.available) return null;
  const elapsed = Math.max(elapsedMinutes, payload.elapsed_minute);
  return (
    <DependenciesPanelView
      payload={payload}
      elapsed={elapsed}
      readOnly={readOnly}
      busyId={busyId}
      error={error}
      onHold={(depId) => void command(depId, 'hold')}
      onWaive={(depId) => void command(depId, 'waive')}
    />
  );
}
