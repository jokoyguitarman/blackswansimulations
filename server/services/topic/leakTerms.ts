/**
 * Case-insensitive whole-word or whole-phrase match.
 * WP2 has its own copy in peaceFeedCore (`matchesLeakTerms`); keep the two in sync
 * when those branches merge.
 */
export function matchesLeakTerms(text: string, terms: readonly string[]): boolean {
  if (!text || terms.length === 0) return false;
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    if (termMatches(text, trimmed)) return true;
  }
  return false;
}

function termMatches(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`,
    'iu',
  );
  return pattern.test(text);
}
