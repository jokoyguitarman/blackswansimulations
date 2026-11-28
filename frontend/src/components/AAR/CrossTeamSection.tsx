import type { CrossTeamSection as CrossTeamSectionData } from '@shared/crossTeamAar';

function asSection(data: unknown): CrossTeamSectionData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as Partial<CrossTeamSectionData>;
  return {
    provenance: row.provenance === 'recorded' ? 'recorded' : 'inferred',
    edges: Array.isArray(row.edges) ? row.edges : [],
    chains: Array.isArray(row.chains) ? row.chains : [],
    teams: Array.isArray(row.teams) ? row.teams : [],
  };
}

export function CrossTeamSection({ data }: { data: unknown }) {
  const section = asSection(data);
  if (!section) return null;
  const empty =
    section.edges.length === 0 && section.chains.length === 0 && section.teams.length === 0;
  return (
    <div data-testid="cross-team-aar" className="space-y-4 text-xs terminal-text">
      {section.provenance === 'inferred' && (
        <p className="text-muted">
          Cause and effect is inferred. This session has no trigger record.
        </p>
      )}
      {empty ? (
        <p className="text-muted">No cross-team dependencies were in play.</p>
      ) : (
        <>
          {section.teams.length > 0 && (
            <div>
              <div className="text-muted mb-1">Per team</div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-muted border-b border-border">
                      <th className="text-left py-1 pr-2">Team</th>
                      <th className="text-left py-1 pr-2">Caused</th>
                      <th className="text-left py-1 pr-2">Received</th>
                      <th className="text-left py-1 pr-2">Authored</th>
                      <th className="text-left py-1 pr-2">Cross-team</th>
                      <th className="text-left py-1 pr-2">Unscripted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.teams.map((team) => (
                      <tr key={team.team} className="border-b border-border">
                        <td className="py-1 pr-2">{team.team}</td>
                        <td className="py-1 pr-2">{team.caused}</td>
                        <td className="py-1 pr-2">{team.received}</td>
                        <td className="py-1 pr-2">
                          {team.pressure.authored} ({team.share.authored}%)
                        </td>
                        <td className="py-1 pr-2">
                          {team.pressure.cross_team} ({team.share.cross_team}%)
                        </td>
                        <td className="py-1 pr-2">
                          {team.pressure.unscripted} ({team.share.unscripted}%)
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div>
            <div className="text-muted mb-1">Cause chains</div>
            {section.chains.length === 0 ? (
              <p className="text-muted">No cause chain was recorded.</p>
            ) : (
              <ol className="space-y-2 list-decimal ml-4">
                {section.chains.map((chain) => (
                  <li key={chain.id} className="text-ink">
                    {chain.text}
                  </li>
                ))}
              </ol>
            )}
          </div>
          {section.edges.length > 0 && (
            <div>
              <div className="text-muted mb-1">Dependencies</div>
              <div className="space-y-3">
                {section.edges.map((edge) => (
                  <div key={edge.dep_id} className="border border-border p-2">
                    <div>
                      {edge.upstream} → {edge.downstream.join(', ')} · {edge.deliverable}
                    </div>
                    <div className="text-muted">
                      {edge.due} · {edge.outcome}
                      {edge.broken_minute != null ? ` · broken T+${edge.broken_minute}` : ''}
                      {edge.met_minute != null ? ` · met T+${edge.met_minute}` : ''}
                      {edge.recovered_minute != null ? ` · late T+${edge.recovered_minute}` : ''}
                    </div>
                    {edge.consequences.map((item) => (
                      <div key={item.inject_key}>
                        T+{item.minute ?? '—'} {item.teams.join(', ')} received “{item.title}” (
                        {item.origin_label}
                        {item.depth > 1 ? `, depth ${item.depth}` : ''})
                        {item.response ? ` · ${item.response}` : ''}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
