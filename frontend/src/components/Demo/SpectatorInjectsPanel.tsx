import { useState, useCallback, useRef, useEffect } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';
import { api } from '../../lib/api';

interface InjectEntry {
  id: string;
  title: string;
  description: string;
  severity: string;
  triggerType: string;
  timestamp: Date;
  natoGrade?: string;
}

interface SpectatorInjectsPanelProps {
  sessionId: string;
}

const SEVERITY_STYLES: Record<
  string,
  { border: string; bg: string; badge: string; dot: string; borderColor: string }
> = {
  critical: {
    border: 'border-red-500/60',
    bg: 'bg-red-500/10',
    badge: 'bg-red-600 text-white',
    dot: 'bg-red-500',
    borderColor: '#ef4444',
  },
  high: {
    border: 'border-orange-500/60',
    bg: 'bg-orange-500/10',
    badge: 'bg-orange-500 text-white',
    dot: 'bg-orange-500',
    borderColor: '#f97316',
  },
  medium: {
    border: 'border-yellow-500/60',
    bg: 'bg-yellow-500/10',
    badge: 'bg-yellow-600 text-white',
    dot: 'bg-yellow-500',
    borderColor: '#eab308',
  },
  low: {
    border: 'border-blue-500/60',
    bg: 'bg-blue-500/10',
    badge: 'bg-blue-500 text-white',
    dot: 'bg-blue-500',
    borderColor: '#3b82f6',
  },
};

const DEFAULT_STYLE = SEVERITY_STYLES.medium;

function getSeverityStyle(severity: string) {
  return SEVERITY_STYLES[severity] ?? DEFAULT_STYLE;
}

function formatTriggerType(t: string): string {
  if (t === 'quality_failure') return 'QUALITY';
  if (t === 'environmental_inconsistency') return 'ENV CHECK';
  if (t === 'specificity_failure') return 'SPECIFICITY';
  if (t === 'time_based') return 'SCHEDULED';
  if (t === 'containment_breach') return 'BREACH';
  if (t === 'deterioration') return 'DETERIORATION';
  return t.toUpperCase().replace(/_/g, ' ');
}

export function SpectatorInjectsPanel({ sessionId }: SpectatorInjectsPanelProps) {
  const [injects, setInjects] = useState<InjectEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [newFlash, setNewFlash] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const handleEvent = useCallback((event: WebSocketEvent) => {
    if (event.type === 'inject.published') {
      const inject = (event.data as { inject?: Record<string, unknown> })?.inject;
      if (!inject) return;

      // Check for NATO grade in state_effect.adversary_sighting
      const stateEffect = inject.state_effect as Record<string, unknown> | undefined;
      const sighting = stateEffect?.adversary_sighting as Record<string, unknown> | undefined;
      let natoGrade: string | undefined;
      if (sighting) {
        const src = (sighting.intel_source as string) || '';
        const conf = (sighting.confidence as string) || '';
        const radius = (sighting.accuracy_radius_m as number) || 500;
        const srcMap: Record<string, string> = {
          body_camera: 'A',
          dash_camera: 'A',
          cctv_operator: 'B',
          cctv: 'B',
          facial_recognition: 'B',
          license_plate_reader: 'B',
          aerial_unit: 'B',
          helicopter_thermal: 'B',
          tracking_team: 'C',
          forensic_team: 'C',
          radio_intercept: 'C',
          k9_tracking: 'C',
          cell_tower: 'C',
          security_guard: 'D',
          store_clerk: 'D',
          taxi_driver: 'D',
          anonymous_caller: 'E',
          social_media: 'E',
          bystander: 'E',
          eyewitness: 'E',
          informant: 'D',
        };
        const rel = srcMap[src.toLowerCase().replace(/[\s-]/g, '_')] || 'F';
        const cred =
          conf === 'high' && radius <= 50
            ? '1'
            : conf === 'high'
              ? '2'
              : conf === 'medium'
                ? '3'
                : conf === 'low' && radius <= 300
                  ? '4'
                  : '5';
        natoGrade = `${rel}${cred}`;
      }

      const entry: InjectEntry = {
        id: (inject.id as string) ?? `inj-${Date.now()}`,
        title: (inject.title as string) ?? 'Inject',
        description: (inject.description as string) ?? '',
        severity: (inject.severity as string) ?? 'medium',
        triggerType: (inject.trigger_type as string) ?? 'time_based',
        timestamp: new Date(),
        natoGrade,
      };

      setInjects((prev) => {
        if (prev.some((i) => i.id === entry.id)) return prev;
        return [entry, ...prev].slice(0, 50);
      });

      setNewFlash(true);
      setTimeout(() => setNewFlash(false), 2000);
    }

    if (event.type === 'sighting_debunked') {
      const d = event.data as { zone_label?: string; debunked_at_minutes?: number };
      const entry: InjectEntry = {
        id: `debunk-${Date.now()}`,
        title: `DEBUNKED: ${d.zone_label || 'Unknown'}`,
        description: `Intelligence at ${d.zone_label} confirmed FALSE LEAD at T+${Math.round(d.debunked_at_minutes ?? 0)}min`,
        severity: 'critical',
        triggerType: 'DEBUNK',
        timestamp: new Date(),
      };
      setInjects((prev) => [entry, ...prev].slice(0, 50));
      setNewFlash(true);
      setTimeout(() => setNewFlash(false), 2000);
    }
  }, []);

  useWebSocket({
    sessionId,
    onEvent: handleEvent,
    eventTypes: ['inject.published', 'sighting_debunked'],
  });

  useEffect(() => {
    const loadExisting = async () => {
      try {
        const result = await api.sessions.publishedInjects(sessionId);
        const existing = (result.data as Array<Record<string, unknown>>) || [];
        if (existing.length === 0) return;

        const entries: InjectEntry[] = existing.map((d) => ({
          id: (d.id as string) ?? `inj-${Date.now()}`,
          title: (d.title as string) ?? 'Inject',
          description: (d.description as string) ?? '',
          severity: (d.severity as string) ?? 'medium',
          triggerType: (d.trigger_type as string) ?? 'time_based',
          timestamp: new Date((d.created_at as string) ?? Date.now()),
        }));

        setInjects((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const newEntries = entries.filter((e) => !existingIds.has(e.id));
          if (newEntries.length === 0) return prev;
          return [...prev, ...newEntries].slice(0, 50);
        });
      } catch {
        // Non-critical — WebSocket will pick up new ones
      }
    };
    loadExisting();
  }, [sessionId]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [injects.length]);

  return (
    <div className="absolute top-16 right-4 z-[999] flex flex-col" style={{ maxHeight: '400px' }}>
      {/* Header / toggle */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className={`flex items-center justify-between px-3 py-2 rounded-t-lg border backdrop-blur-md transition-all ${
          newFlash
            ? 'bg-red-600/30 border-red-500/60'
            : 'bg-robotic-gray-300/90 border-robotic-yellow/40'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs terminal-text uppercase text-robotic-yellow font-bold">
            INJECTS
          </span>
          {injects.length > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] terminal-text bg-robotic-red/80 text-white rounded-full min-w-[18px] text-center">
              {injects.length}
            </span>
          )}
        </div>
        <span className="text-xs terminal-text text-robotic-yellow/50">
          {collapsed ? '▲' : '▼'}
        </span>
      </button>

      {/* Inject list */}
      {!collapsed && (
        <div
          ref={listRef}
          className="w-72 overflow-y-auto rounded-b-lg border border-t-0 border-robotic-yellow/30 bg-robotic-gray-300/90 backdrop-blur-md scrollbar-thin scrollbar-thumb-robotic-yellow/30"
          style={{ maxHeight: '340px' }}
        >
          {injects.length === 0 && (
            <div className="px-3 py-6 text-center">
              <span className="text-xs terminal-text text-robotic-yellow/40">
                No injects yet...
              </span>
            </div>
          )}

          {injects.map((inj, idx) => {
            const style = getSeverityStyle(inj.severity);
            const isNew = idx === 0 && newFlash;
            return (
              <div
                key={inj.id}
                className={`px-3 py-2.5 border-b border-robotic-yellow/10 ${style.bg} transition-all ${
                  isNew ? 'animate-pulse' : ''
                }`}
                style={{ borderLeftWidth: 3, borderLeftColor: style.borderColor }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <div className={`w-1.5 h-1.5 rounded-full ${style.dot} shrink-0`} />
                  <span
                    className={`px-1.5 py-0.5 text-[9px] terminal-text uppercase rounded ${style.badge}`}
                  >
                    {inj.severity}
                  </span>
                  <span className="px-1.5 py-0.5 text-[9px] terminal-text uppercase rounded bg-robotic-gray-200/50 text-robotic-yellow/70 border border-robotic-yellow/20">
                    {formatTriggerType(inj.triggerType)}
                  </span>
                  {inj.natoGrade && (
                    <span
                      className="px-1.5 py-0.5 text-[9px] terminal-text font-black rounded font-mono"
                      style={{
                        backgroundColor:
                          (/^[AB][12]/.test(inj.natoGrade)
                            ? '#22c55e'
                            : /^[CD][34]/.test(inj.natoGrade)
                              ? '#f59e0b'
                              : '#ef4444') + '22',
                        color: /^[AB][12]/.test(inj.natoGrade)
                          ? '#22c55e'
                          : /^[CD][34]/.test(inj.natoGrade)
                            ? '#f59e0b'
                            : '#ef4444',
                        border: `1px solid ${/^[AB][12]/.test(inj.natoGrade) ? '#22c55e' : /^[CD][34]/.test(inj.natoGrade) ? '#f59e0b' : '#ef4444'}44`,
                      }}
                    >
                      {inj.natoGrade}
                    </span>
                  )}
                  <span className="ml-auto text-[9px] terminal-text text-robotic-yellow/40">
                    {inj.timestamp.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                </div>
                <div className="text-xs terminal-text text-robotic-yellow font-semibold leading-tight">
                  {inj.title}
                </div>
                {inj.description && (
                  <div className="text-[10px] terminal-text text-robotic-yellow/50 mt-1 leading-snug line-clamp-3">
                    {inj.description}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
