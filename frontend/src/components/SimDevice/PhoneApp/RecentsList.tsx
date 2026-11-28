import React from 'react';
import type { CallSummary } from './phoneClient';
import { WhenWritable } from '../surfaceReadOnly';

interface Props {
  calls: CallSummary[];
  filter: 'all' | 'missed';
  onFilter: (filter: 'all' | 'missed') => void;
  missedCount: number;
  onOpen: (call: CallSummary) => void;
  onCallback: (call: CallSummary) => void;
  headerNote?: string | null;
}

export default function RecentsList({
  calls,
  filter,
  onFilter,
  missedCount,
  onOpen,
  onCallback,
  headerNote,
}: Props) {
  const rows = collapse(calls).filter((row) => filter === 'all' || row.missed);
  return (
    <React.Fragment>
      <div className="flex h-full flex-col bg-[#f6f6f7] text-[#172033]">
        <header className="flex items-center justify-between px-4 pb-2 pt-4">
          <div>
            <h1 className="text-2xl font-semibold">Recents</h1>
            {headerNote && <p className="text-xs text-black/50">{headerNote}</p>}
          </div>
          <div className="flex rounded-full bg-black/5 p-0.5 text-xs">
            <button
              type="button"
              className={`rounded-full px-3 py-1 ${filter === 'all' ? 'bg-white shadow' : ''}`}
              onClick={() => onFilter('all')}
            >
              All
            </button>
            <button
              type="button"
              className={`rounded-full px-3 py-1 ${filter === 'missed' ? 'bg-white shadow' : ''}`}
              onClick={() => onFilter('missed')}
            >
              Missed{missedCount > 0 ? ` (${missedCount})` : ''}
            </button>
          </div>
        </header>
        <ul className="flex-1 overflow-y-auto">
          {rows.length === 0 && <li className="px-4 py-8 text-sm text-black/40">No calls yet.</li>}
          {rows.map((row) => (
            <li key={row.key} className="border-b border-black/5">
              <button
                type="button"
                onClick={() => onOpen(row.latest)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left"
              >
                <span className={`mt-1 text-lg ${row.missed ? 'text-[#FF3B30]' : 'text-black/40'}`}>
                  {row.latest.direction === 'callback' ? '↗' : '↙'}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-base font-medium ${row.missed ? 'text-[#FF3B30]' : ''}`}
                  >
                    {row.latest.caller_name}
                    {row.count > 1 ? ` (${row.count})` : ''}
                  </span>
                  <span className="block truncate text-xs text-black/50">
                    {row.missed ? 'missed' : row.latest.status}
                    {row.latest.answered_by_name
                      ? ` · answered by ${row.latest.answered_by_name}`
                      : ''}
                    {row.latest.duration_seconds
                      ? ` · ${formatDuration(row.latest.duration_seconds)}`
                      : ''}
                  </span>
                  {row.latest.opening && row.missed && (
                    <span className="mt-1 block truncate text-xs text-black/45">
                      voicemail: “{row.latest.opening}”
                    </span>
                  )}
                  {row.latest.next_attempt_at && (
                    <span className="mt-1 block text-xs text-amber-700">
                      next try {formatWhen(row.latest.next_attempt_at)}
                    </span>
                  )}
                </span>
              </button>
              {row.latest.can_callback && (
                <WhenWritable>
                  <div className="px-12 pb-3">
                    <button
                      type="button"
                      onClick={() => onCallback(row.latest)}
                      className="rounded-full bg-[#34C759] px-3 py-1 text-xs font-semibold text-white"
                    >
                      Call back
                    </button>
                  </div>
                </WhenWritable>
              )}
            </li>
          ))}
        </ul>
      </div>
    </React.Fragment>
  );
}

function collapse(
  calls: CallSummary[],
): Array<{ key: string; latest: CallSummary; count: number; missed: boolean }> {
  const groups = new Map<string, CallSummary[]>();
  for (const call of calls) {
    const list = groups.get(call.call_group_id) ?? [];
    list.push(call);
    groups.set(call.call_group_id, list);
  }
  return Array.from(groups.entries()).map(([key, list]) => {
    const sorted = [...list].sort((a, b) => b.attempt_no - a.attempt_no);
    const latest = sorted[0];
    const missed = sorted.every((call) => call.status === 'missed' || call.status === 'declined');
    const count =
      latest.group_missed_count ||
      sorted.filter((call) => call.status === 'missed' || call.status === 'declined').length;
    return { key, latest, count, missed };
  });
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${mins}:${String(rest).padStart(2, '0')}`;
}

function formatWhen(iso: string): string {
  const delta = Date.parse(iso) - Date.now();
  if (!Number.isFinite(delta)) return '';
  if (delta <= 0) return 'now';
  const mins = Math.ceil(delta / 60000);
  return `in ${mins} min`;
}
