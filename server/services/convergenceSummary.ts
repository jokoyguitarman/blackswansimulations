export const CONVERGENCE_SUMMARY_MAX_CHARS = 12_000;

export interface SummaryInject {
  trigger_time_minutes?: number | null;
  title?: string | null;
}

/**
 * Storyline digest for the convergence prompt. Every team's name and inject
 * count is always included. Titles are appended round-robin so a long cast
 * does not fill the budget with the first teams' beats.
 */
export function buildConvergenceStorylineSummary(
  teamStorylines: Record<string, readonly SummaryInject[]>,
  maxChars = CONVERGENCE_SUMMARY_MAX_CHARS,
): string {
  const teams = Object.entries(teamStorylines);
  if (teams.length === 0) return '';
  const cap = Math.max(0, Math.floor(maxChars));
  const lines = teams.map(([team, injects]) => `${team} (${injects.length} injects):`);
  const separator = '\n\n';
  const lengthOf = (): number => {
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      n += lines[i].length;
      if (i > 0) n += separator.length;
    }
    return n;
  };

  const rounds = teams.reduce((max, [, injects]) => Math.max(max, injects.length), 0);
  for (let round = 0; round < rounds; round++) {
    for (let t = 0; t < teams.length; t++) {
      const inject = teams[t][1][round];
      if (!inject) continue;
      const title = String(inject.title ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const minute =
        inject.trigger_time_minutes == null || inject.trigger_time_minutes === undefined
          ? '?'
          : String(inject.trigger_time_minutes);
      const piece = `${lines[t].endsWith(':') ? ' ' : ', '}T+${minute}${title ? ` ${title}` : ''}`;
      if (lengthOf() + piece.length > cap) continue;
      lines[t] += piece;
    }
  }
  return lines.join(separator);
}
