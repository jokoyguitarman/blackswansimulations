import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';

interface TeamHeatState {
  heat_percentage?: number;
  mistake_points?: number;
  total_decisions?: number;
}

interface DemoMetricsOverlayProps {
  sessionId: string;
  currentState: Record<string, unknown>;
}

interface CounterEntry {
  key: string;
  label: string;
  color?: string;
  alert?: boolean;
}

interface FlagEntry {
  key: string;
  label: string;
}

interface PanelDef {
  title: string;
  stateKey: string;
  alts?: string[];
  counters: CounterEntry[];
  flags?: FlagEntry[];
}

const PANEL_DEFS: PanelDef[] = [
  {
    title: 'MEDICAL TRIAGE',
    stateKey: 'triage_state',
    counters: [
      { key: 'total_patients', label: 'Total Patients' },
      { key: 'red_immediate', label: 'RED (Immediate)', color: 'text-red-400' },
      { key: 'yellow_delayed', label: 'YELLOW (Delayed)', color: 'text-yellow-400' },
      { key: 'green_minor', label: 'GREEN (Minor)', color: 'text-green-400' },
      { key: 'black_deceased', label: 'BLACK (Deceased)', color: 'text-gray-400' },
      { key: 'awaiting_triage', label: 'Awaiting Triage' },
      { key: 'in_treatment', label: 'In Treatment' },
      { key: 'ready_for_transport', label: 'Ready for Transport' },
      { key: 'transported', label: 'Transported' },
      { key: 'deaths_on_site', label: 'Deaths On Site', alert: true },
    ],
    flags: [
      { key: 'prioritisation_decided', label: 'Prioritisation Set' },
      { key: 'triage_zone_established', label: 'Triage Zone Set' },
      { key: 'supply_request_made', label: 'Supplies Requested' },
      { key: 'mass_casualty_declared', label: 'MCI Declared' },
      { key: 'hospital_coordination', label: 'Hospital Coord.' },
    ],
  },
  {
    title: 'FIRE / RESCUE',
    stateKey: 'fire_rescue_state',
    alts: ['fire_state'],
    counters: [
      { key: 'hazards_active', label: 'Hazards Active', alert: true },
      { key: 'hazards_resolved', label: 'Hazards Resolved' },
      { key: 'active_fires', label: 'Active Fires', alert: true },
      { key: 'fires_contained', label: 'Fires Contained' },
      { key: 'fires_resolved', label: 'Fires Resolved' },
      { key: 'casualties_in_hot_zone', label: 'Casualties in Hot Zone', alert: true },
      { key: 'extracted_to_warm', label: 'Extracted to Warm' },
      { key: 'debris_cleared', label: 'Debris Cleared' },
    ],
    flags: [
      { key: 'hot_zone_declared', label: 'Hot Zone Declared' },
      { key: 'warm_zone_established', label: 'Warm Zone Set' },
      { key: 'cold_zone_established', label: 'Cold Zone Set' },
      { key: 'sar_initiated', label: 'SAR Initiated' },
    ],
  },
  {
    title: 'EVACUATION',
    stateKey: 'evacuation_state',
    counters: [
      { key: 'total_evacuated', label: 'Total Evacuated' },
      { key: 'civilians_at_assembly', label: 'At Assembly Point' },
      { key: 'still_inside', label: 'Still Inside', alert: true },
      { key: 'in_transit', label: 'In Transit' },
      { key: 'convergent_crowds_count', label: 'Convergent Crowds' },
    ],
    flags: [
      { key: 'flow_control_decided', label: 'Flow Control' },
      { key: 'marshals_deployed', label: 'Marshals Deployed' },
      { key: 'assembly_point_established', label: 'Assembly Point' },
      { key: 'evacuation_routes_announced', label: 'Routes Announced' },
      { key: 'coordination_with_triage', label: 'Triage Coord.' },
    ],
  },
  {
    title: 'BOMB SQUAD',
    stateKey: 'bomb_squad_state',
    counters: [
      { key: 'active_threats', label: 'Active Threats', alert: true },
      { key: 'tips_received', label: 'Tips Received' },
      { key: 'devices_found', label: 'Devices Found' },
      { key: 'devices_rendered_safe', label: 'Rendered Safe' },
      { key: 'false_alarms_cleared', label: 'False Alarms' },
      { key: 'sweeps_completed', label: 'Sweeps Completed' },
      { key: 'detonations', label: 'Detonations', alert: true },
      { key: 'exclusion_zones_active', label: 'Exclusion Zones' },
    ],
    flags: [
      { key: 'exclusion_zone_established', label: 'Exclusion Zone Set' },
      { key: 'secondary_sweep_complete', label: 'Secondary Sweep' },
      { key: 'render_safe_started', label: 'Render-Safe Started' },
    ],
  },
  {
    title: 'MEDIA & COMMS',
    stateKey: 'media_state',
    counters: [
      { key: 'statements_issued', label: 'Statements Issued' },
      { key: 'misinformation_addressed_count', label: 'Misinfo Addressed' },
      { key: 'content_drafts_submitted', label: 'Content Drafts' },
    ],
    flags: [
      { key: 'first_statement_issued', label: 'First Statement' },
      { key: 'spokesperson_designated', label: 'Spokesperson' },
      { key: 'press_conference_held', label: 'Press Conference' },
      { key: 'camera_placement_decided', label: 'Camera Placement' },
      { key: 'media_holding_area_established', label: 'Media Holding Area' },
      { key: 'regular_updates_planned', label: 'Regular Updates' },
      { key: 'social_media_monitoring', label: 'Social Monitoring' },
      { key: 'victim_dignity_respected', label: 'Victim Dignity' },
    ],
  },
  {
    title: 'PURSUIT / INTEL',
    stateKey: 'pursuit_state',
    counters: [],
    flags: [
      { key: 'suspect_localised', label: 'Suspect Localised' },
      { key: 'perimeter_established', label: 'Perimeter Set' },
      { key: 'cctv_reviewed', label: 'CCTV Reviewed' },
      { key: 'witness_statements_collected', label: 'Witness Statements' },
      { key: 'intel_shared_with_teams', label: 'Intel Shared' },
    ],
  },
];

function resolveState(
  state: Record<string, unknown>,
  panel: PanelDef,
): Record<string, unknown> | null {
  const primary = state[panel.stateKey] as Record<string, unknown> | undefined;
  if (primary && typeof primary === 'object') return primary;
  for (const alt of panel.alts ?? []) {
    const s = state[alt] as Record<string, unknown> | undefined;
    if (s && typeof s === 'object') return s;
  }
  return null;
}

export function DemoMetricsOverlay({ sessionId, currentState }: DemoMetricsOverlayProps) {
  const [state, setState] = useState<Record<string, unknown>>(currentState);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setState(currentState);
  }, [currentState]);

  const handleEvent = useCallback((event: WebSocketEvent) => {
    if (event.type === 'state.updated') {
      const payload = event.data as { state?: Record<string, unknown> };
      const stateData = payload.state;
      if (stateData && typeof stateData === 'object') {
        setState((prev) => ({ ...prev, ...stateData }));
      }
    }
  }, []);

  useWebSocket({
    sessionId,
    eventTypes: ['state.updated'],
    onEvent: handleEvent,
  });

  const heatMeter = (state.heat_meter ?? {}) as Record<string, TeamHeatState>;
  const heatTeams = Object.entries(heatMeter).filter(([, v]) => v?.heat_percentage !== undefined);

  return (
    <div className="absolute top-16 left-4 z-[999] flex flex-col gap-1.5 w-[200px] max-h-[calc(100vh-280px)] overflow-y-auto scrollbar-thin scrollbar-thumb-robotic-yellow/30">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="self-start px-2 py-1 text-[10px] terminal-text uppercase tracking-wider bg-robotic-gray-300/90 border border-robotic-yellow/40 rounded backdrop-blur-sm text-robotic-yellow/70 hover:text-robotic-yellow"
      >
        {collapsed ? '▶ METRICS' : '▼ METRICS'}
      </button>

      {!collapsed && (
        <>
          {/* Heat Meter */}
          <div className="bg-robotic-gray-300/90 border border-robotic-yellow/30 rounded p-2.5 backdrop-blur-sm">
            <div className="text-[10px] terminal-text uppercase text-robotic-yellow/60 mb-1.5 tracking-wider">
              HEAT METER
            </div>
            {heatTeams.length === 0 ? (
              <div className="text-[10px] terminal-text text-robotic-yellow/30 italic">
                Awaiting first decisions...
              </div>
            ) : (
              <div className="space-y-1.5">
                {heatTeams.map(([name, data]) => {
                  const pct = data.heat_percentage ?? 0;
                  const barColor =
                    pct >= 60
                      ? 'bg-red-500'
                      : pct >= 40
                        ? 'bg-orange-500'
                        : pct >= 20
                          ? 'bg-yellow-500'
                          : 'bg-green-500';
                  const textColor =
                    pct >= 60
                      ? 'text-red-400'
                      : pct >= 40
                        ? 'text-orange-400'
                        : pct >= 20
                          ? 'text-yellow-400'
                          : 'text-green-400';
                  return (
                    <div key={name} className="flex items-center gap-2">
                      <span className="text-[10px] terminal-text text-robotic-yellow/60 uppercase w-16 shrink-0 truncate">
                        {name}
                      </span>
                      <div className="flex-1 h-2 bg-robotic-gray-100 rounded-sm overflow-hidden">
                        <div
                          className={`h-full ${barColor} transition-all duration-700`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                      <span
                        className={`text-[10px] terminal-text font-mono font-bold w-8 text-right ${textColor}`}
                      >
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Curated Team Panels */}
          {PANEL_DEFS.map((panel) => {
            const teamState = resolveState(state, panel);
            if (!teamState) return null;

            const rows = panel.counters
              .map((c) => {
                const raw = teamState[c.key];
                if (typeof raw !== 'number') return null;
                return { ...c, value: raw };
              })
              .filter(Boolean) as (CounterEntry & { value: number })[];

            const flagRows = (panel.flags ?? [])
              .map((f) => ({ ...f, done: !!teamState[f.key] }))
              .filter(Boolean);

            if (rows.length === 0 && flagRows.length === 0) return null;

            return (
              <div
                key={panel.stateKey}
                className="bg-robotic-gray-300/90 border border-robotic-yellow/30 rounded p-2.5 backdrop-blur-sm"
              >
                <div className="text-[10px] terminal-text uppercase text-robotic-yellow/60 mb-1 tracking-wider">
                  {panel.title}
                </div>
                {rows.length > 0 && (
                  <div className="space-y-0.5">
                    {rows.map(({ key, label, value, color, alert }) => {
                      const isAlert = alert && value > 0;
                      const textClass =
                        color ?? (isAlert ? 'text-red-400' : 'text-robotic-gray-50/80');
                      return (
                        <div
                          key={key}
                          className={`flex justify-between text-[11px] terminal-text ${textClass}`}
                        >
                          <span className="truncate mr-2">{label}</span>
                          <span className="font-mono shrink-0">{value}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {flagRows.length > 0 && (
                  <>
                    {rows.length > 0 && <div className="border-t border-robotic-yellow/10 my-1" />}
                    <div className="space-y-0.5">
                      {flagRows.map(({ key, label, done }) => (
                        <div
                          key={key}
                          className={`flex items-center gap-1.5 text-[10px] terminal-text ${done ? 'text-green-400' : 'text-robotic-gray-50/30'}`}
                        >
                          <span className="shrink-0 w-3 text-center">
                            {done ? '\u2713' : '\u2022'}
                          </span>
                          <span className="truncate">{label}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
