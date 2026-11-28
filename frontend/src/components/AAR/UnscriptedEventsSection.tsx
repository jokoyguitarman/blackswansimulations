export interface UnscriptedEventRow {
  minute: number;
  target: string;
  cause: string;
  text: string;
  guardrails: string;
  fairness: string;
  decision: string;
  approver: string;
  edits: string;
  outcome: string;
}

export interface FairnessSummaryRow {
  team: string;
  negative_load: number;
  positive_load: number;
  unscripted_events: number;
}

export interface UnscriptedSectionData {
  events: UnscriptedEventRow[];
  withheld: UnscriptedEventRow[];
  fairness: FairnessSummaryRow[];
  replay: { available: boolean; ok: boolean; mismatches: number };
}

function asSection(data: unknown): UnscriptedSectionData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as Partial<UnscriptedSectionData>;
  const replay = row.replay;
  return {
    events: Array.isArray(row.events) ? row.events : [],
    withheld: Array.isArray(row.withheld) ? row.withheld : [],
    fairness: Array.isArray(row.fairness) ? row.fairness : [],
    replay:
      replay && typeof replay === 'object'
        ? {
            available: replay.available === true,
            ok: replay.ok === true,
            mismatches: typeof replay.mismatches === 'number' ? replay.mismatches : 0,
          }
        : { available: false, ok: false, mismatches: 0 },
  };
}

export function UnscriptedEventsSection({ data }: { data: unknown }) {
  const section = asSection(data);
  if (!section) return null;
  const replay = replayLine(section.replay);
  return (
    <div data-testid="unscripted-events" className="space-y-4 text-xs terminal-text">
      <p className="text-muted" data-testid="director-replay-status">
        {replay}
      </p>
      <div data-testid="fairness-summary">
        <div className="text-muted mb-1">Fairness summary</div>
        {section.fairness.length === 0 ? (
          <p className="text-muted">No staffed teams were scored for unscripted load.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-muted border-b border-border">
                  <th className="text-left py-1 pr-2">Team</th>
                  <th className="text-left py-1 pr-2">Negative load</th>
                  <th className="text-left py-1 pr-2">Positive load</th>
                  <th className="text-left py-1 pr-2">Unscripted events</th>
                </tr>
              </thead>
              <tbody>
                {section.fairness.map((team) => (
                  <tr key={team.team} className="border-b border-border">
                    <td className="py-1 pr-2">{team.team}</td>
                    <td className="py-1 pr-2">{team.negative_load}</td>
                    <td className="py-1 pr-2">{team.positive_load}</td>
                    <td className="py-1 pr-2">{team.unscripted_events}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <EventTable title="Unscripted events" rows={section.events} empty="No unscripted events were published." />
      {section.withheld.length > 0 && (
        <EventTable
          title="Not published (trainers and admins)"
          rows={section.withheld}
          empty=""
        />
      )}
    </div>
  );
}

function replayLine(replay: UnscriptedSectionData['replay']): string {
  if (!replay.available) return 'Replay status is unavailable.';
  if (replay.ok) return 'Replay matches the stored director log.';
  const count = replay.mismatches;
  return `Replay differs from the stored log (${count} mismatch${count === 1 ? '' : 'es'}).`;
}

function EventTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: UnscriptedEventRow[];
  empty: string;
}) {
  return (
    <div>
      <div className="text-muted mb-1">{title}</div>
      {rows.length === 0 ? (
        <p className="text-muted">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-muted border-b border-border">
                <th className="text-left py-1 pr-2">Minute</th>
                <th className="text-left py-1 pr-2">Target</th>
                <th className="text-left py-1 pr-2">Cause</th>
                <th className="text-left py-1 pr-2">Text</th>
                <th className="text-left py-1 pr-2">Guardrails</th>
                <th className="text-left py-1 pr-2">Fairness</th>
                <th className="text-left py-1 pr-2">Decision</th>
                <th className="text-left py-1 pr-2">Approver</th>
                <th className="text-left py-1 pr-2">Edits</th>
                <th className="text-left py-1 pr-2">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.minute}-${index}`} className="border-b border-border align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">T+{row.minute}</td>
                  <td className="py-1 pr-2">{row.target}</td>
                  <td className="py-1 pr-2 max-w-[180px]">{row.cause}</td>
                  <td className="py-1 pr-2 max-w-[240px] whitespace-pre-wrap">{row.text}</td>
                  <td className="py-1 pr-2">{row.guardrails}</td>
                  <td className="py-1 pr-2">{row.fairness}</td>
                  <td className="py-1 pr-2">{row.decision}</td>
                  <td className="py-1 pr-2">{row.approver}</td>
                  <td className="py-1 pr-2 max-w-[220px] whitespace-pre-wrap">{row.edits}</td>
                  <td className="py-1 pr-2">{row.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
