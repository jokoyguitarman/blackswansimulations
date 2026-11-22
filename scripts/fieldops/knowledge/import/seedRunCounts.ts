/** Counts stored on one `fieldops_seed_runs` row. The row is per library. */

export interface SeedRunFigures {
  rowsDrafted: number;
  rowsRefused: number;
  sourcesCited: number;
}

export interface CountRecord {
  library: string;
  recordKind: string;
}

/**
 * A run.json total describes the whole research run. It is written on the
 * library row only when every staged record of that run is in this library.
 * A run that spans libraries uses this library's staged records, so summing
 * the rows does not repeat the run total. Figures are read from the top
 * level and from `counts` (including `distinct_sources`). A non-empty
 * `refused` list wins over a summary count.
 */
export function seedRunFigures(
  document: Record<string, unknown>,
  records: CountRecord[],
  library: string,
  libraries: string[],
): SeedRunFigures {
  const mine = records.filter((record) => record.library === library);
  const staged: SeedRunFigures = {
    rowsDrafted: mine.length,
    rowsRefused: mine.filter((record) => record.recordKind === 'refused').length,
    sourcesCited: mine.filter((record) => record.recordKind === 'source').length,
  };
  if (libraries.length !== 1) return staged;
  return {
    rowsDrafted:
      numberOf(document.rows_drafted) ?? countOf(document, 'rows_drafted') ?? staged.rowsDrafted,
    rowsRefused: refusedOf(document) ?? staged.rowsRefused,
    sourcesCited: sourcesOf(document) ?? staged.sourcesCited,
  };
}

function countsOf(document: Record<string, unknown>): Record<string, unknown> | null {
  const counts = document.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  return counts as Record<string, unknown>;
}

function countOf(document: Record<string, unknown>, key: string): number | null {
  const counts = countsOf(document);
  return counts ? numberOf(counts[key]) : null;
}

function refusedOf(document: Record<string, unknown>): number | null {
  if (Array.isArray(document.refused) && document.refused.length > 0) {
    return document.refused.length;
  }
  return numberOf(document.rows_refused) ?? countOf(document, 'rows_refused');
}

function sourcesOf(document: Record<string, unknown>): number | null {
  return (
    numberOf(document.sources_cited) ??
    countOf(document, 'sources_cited') ??
    countOf(document, 'distinct_sources')
  );
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
