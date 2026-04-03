import { useState, useCallback, useRef, useEffect } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';
import { api } from '../../lib/api';

interface DecisionEntry {
  id: string;
  teamName: string;
  creatorName: string;
  title: string;
  description: string;
  type: string;
  status: string;
  aiVerdict: string;
  aiNote: string;
  timestamp: Date;
}

interface SpectatorDecisionsPanelProps {
  sessionId: string;
}

const TEAM_COLORS: Record<string, string> = {
  police: '#3b82f6',
  triage: '#ef4444',
  medical: '#ef4444',
  health: '#ef4444',
  evacuation: '#22c55e',
  civil: '#22c55e',
  media: '#a855f7',
  fire: '#f97316',
  hazmat: '#f97316',
  fire_hazmat: '#f97316',
  intelligence: '#6366f1',
  negotiation: '#06b6d4',
  security: '#eab308',
};

function getTeamColor(teamName: string): string {
  const key = teamName.toLowerCase().replace(/[\s-]+/g, '_');
  for (const [k, color] of Object.entries(TEAM_COLORS)) {
    if (key.includes(k)) return color;
  }
  return '#94a3b8';
}

function statusBadge(status: string): { text: string; cls: string } {
  switch (status) {
    case 'executed':
      return { text: 'EXECUTED', cls: 'bg-green-600 text-white' };
    case 'proposed':
      return { text: 'PROPOSED', cls: 'bg-blue-500 text-white' };
    case 'approved':
      return { text: 'APPROVED', cls: 'bg-cyan-500 text-white' };
    case 'rejected':
      return { text: 'REJECTED', cls: 'bg-red-600 text-white' };
    default:
      return { text: status.toUpperCase(), cls: 'bg-gray-500 text-white' };
  }
}

function verdictStyle(v: string): { icon: string; cls: string } {
  if (v === 'positive' || v === 'correct') return { icon: '\u2713', cls: 'text-green-400' };
  if (v === 'negative' || v === 'issue_detected') return { icon: '\u2717', cls: 'text-red-400' };
  return { icon: '\u25CB', cls: 'text-yellow-400' };
}

export function SpectatorDecisionsPanel({ sessionId }: SpectatorDecisionsPanelProps) {
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [newFlash, setNewFlash] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleEvent = useCallback((event: WebSocketEvent) => {
    if (event.type !== 'decision.executed' && event.type !== 'decision.proposed') return;

    const decision = (event.data as { decision?: Record<string, unknown> })?.decision;
    if (!decision) return;

    const creator = decision.creator as { full_name?: string } | undefined;
    const teamName = (decision.team_name as string) ?? (creator?.full_name as string) ?? 'Unknown';
    const aiEval = decision.ai_evaluation as Record<string, unknown> | undefined;

    const entry: DecisionEntry = {
      id: (decision.id as string) ?? `dec-${Date.now()}`,
      teamName,
      creatorName: (creator?.full_name as string) ?? teamName,
      title: (decision.title as string) ?? 'Decision',
      description: (decision.description as string) ?? '',
      type: (decision.decision_type as string) ?? '',
      status: event.type === 'decision.executed' ? 'executed' : 'proposed',
      aiVerdict: (aiEval?.verdict as string) ?? '',
      aiNote: (aiEval?.note as string) ?? (aiEval?.explanation as string) ?? '',
      timestamp: new Date(),
    };

    setDecisions((prev) => {
      const existing = prev.findIndex((d) => d.id === entry.id);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = entry;
        return updated;
      }
      return [entry, ...prev].slice(0, 100);
    });

    setNewFlash(true);
    setTimeout(() => setNewFlash(false), 2000);
  }, []);

  useWebSocket({
    sessionId,
    onEvent: handleEvent,
    eventTypes: ['decision.executed', 'decision.proposed'],
  });

  // Load existing decisions on mount so we don't miss any that fired before WebSocket connected
  useEffect(() => {
    const loadExisting = async () => {
      try {
        const result = await api.decisions.list(sessionId);
        const existing = (result.data as Array<Record<string, unknown>>) || [];
        if (existing.length === 0) return;

        const entries: DecisionEntry[] = existing.map((d) => {
          const creator = d.creator as { full_name?: string } | undefined;
          const teamName = (d.team_name as string) ?? (creator?.full_name as string) ?? 'Unknown';
          const aiEval = d.ai_evaluation as Record<string, unknown> | undefined;
          return {
            id: (d.id as string) ?? `dec-${Date.now()}`,
            teamName,
            creatorName: (creator?.full_name as string) ?? teamName,
            title: (d.title as string) ?? 'Decision',
            description: (d.description as string) ?? '',
            type: (d.decision_type as string) ?? (d.type as string) ?? '',
            status: (d.status as string) ?? 'executed',
            aiVerdict: (aiEval?.verdict as string) ?? '',
            aiNote: (aiEval?.note as string) ?? (aiEval?.explanation as string) ?? '',
            timestamp: new Date((d.created_at as string) ?? Date.now()),
          };
        });

        setDecisions((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const newEntries = entries.filter((e) => !existingIds.has(e.id));
          if (newEntries.length === 0) return prev;
          return [...prev, ...newEntries].slice(0, 100);
        });
      } catch {
        // Non-critical — WebSocket will pick up new ones
      }
    };
    loadExisting();
  }, [sessionId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ left: 0, behavior: 'smooth' });
    }
  }, [decisions.length]);

  return (
    <div className="absolute bottom-[30px] left-0 right-0 z-[998] flex flex-col">
      {/* Header bar */}
      <div
        className={`flex items-center px-4 py-1.5 border-t border-x border-robotic-yellow/40 rounded-t-lg mx-4 backdrop-blur-md transition-all cursor-pointer ${
          newFlash
            ? 'bg-blue-600/30 border-blue-500/60'
            : 'bg-robotic-gray-300/95 border-robotic-yellow/40'
        }`}
        onClick={() => setCollapsed((c) => !c)}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs terminal-text uppercase text-robotic-yellow font-bold">
            DECISIONS
          </span>
          {decisions.length > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] terminal-text bg-blue-600/80 text-white rounded-full min-w-[18px] text-center">
              {decisions.length}
            </span>
          )}
          <span className="text-xs terminal-text text-robotic-yellow/50">
            {collapsed ? '\u25B2' : '\u25BC'}
          </span>
        </div>
      </div>

      {/* Horizontal scrollable cards */}
      {!collapsed && (
        <div className="bg-robotic-gray-300/95 border-t border-robotic-yellow/30 backdrop-blur-md">
          <div
            ref={scrollRef}
            className="flex gap-3 px-4 py-2 overflow-x-auto"
            style={{ maxHeight: '180px' }}
          >
            {decisions.length === 0 && (
              <div className="flex items-center justify-center w-full py-4">
                <span className="text-xs terminal-text text-robotic-yellow/40">
                  No decisions yet...
                </span>
              </div>
            )}

            {decisions.map((dec, idx) => {
              const isNew = idx === 0 && newFlash;
              const color = getTeamColor(dec.teamName);
              const badge = statusBadge(dec.status);
              const verdict = dec.aiVerdict ? verdictStyle(dec.aiVerdict) : null;
              const isExpanded = expandedId === dec.id;

              return (
                <div
                  key={dec.id}
                  className={`shrink-0 rounded-lg border border-robotic-yellow/20 bg-black/30 cursor-pointer hover:bg-black/40 transition-all ${
                    isNew ? 'animate-pulse' : ''
                  } ${isExpanded ? 'w-[400px]' : 'w-[280px]'}`}
                  style={{ borderTopWidth: 3, borderTopColor: color }}
                  onClick={() => setExpandedId(isExpanded ? null : dec.id)}
                >
                  <div className="px-3 py-2">
                    {/* Header */}
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="text-[10px] terminal-text font-bold uppercase"
                        style={{ color }}
                      >
                        {dec.teamName.replace(/_/g, ' ')}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 text-[9px] terminal-text uppercase rounded ${badge.cls}`}
                      >
                        {badge.text}
                      </span>
                      {dec.type && (
                        <span className="px-1.5 py-0.5 text-[9px] terminal-text uppercase rounded bg-robotic-gray-200/50 text-robotic-yellow/70 border border-robotic-yellow/20">
                          {dec.type.replace(/_/g, ' ')}
                        </span>
                      )}
                      {verdict && (
                        <span className={`text-xs font-bold ${verdict.cls}`}>{verdict.icon}</span>
                      )}
                      <span className="ml-auto text-[9px] terminal-text text-robotic-yellow/40 shrink-0">
                        {dec.timestamp.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                    </div>

                    {/* Title */}
                    <div className="text-xs terminal-text text-robotic-yellow font-semibold leading-tight mb-1">
                      {dec.title}
                    </div>

                    {/* Description */}
                    {dec.description && (
                      <div
                        className={`text-[11px] terminal-text text-robotic-yellow/60 leading-snug whitespace-pre-wrap overflow-y-auto ${
                          isExpanded ? 'max-h-[100px]' : 'line-clamp-2'
                        }`}
                      >
                        {dec.description}
                      </div>
                    )}

                    {/* AI Evaluation */}
                    {isExpanded && dec.aiNote && (
                      <div className="mt-2 px-2 py-1.5 rounded bg-black/40 border border-robotic-yellow/15">
                        <div className="text-[9px] terminal-text text-robotic-yellow/40 uppercase mb-0.5">
                          AI Evaluation
                        </div>
                        <div className="text-[11px] terminal-text text-robotic-yellow/70 leading-snug whitespace-pre-wrap">
                          {dec.aiNote}
                        </div>
                      </div>
                    )}

                    {/* Expand hint */}
                    {!isExpanded && dec.description && dec.description.length > 100 && (
                      <div className="text-[9px] terminal-text text-robotic-yellow/30 mt-1">
                        Click to expand...
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
