/**
 * Which generation layers a brief diff touches.
 * Keyword overlap plus the model's per-layer flags. Severity `story` selects
 * every layer that still has an inject. Narrative and briefing are not inject
 * layers; the delta runner revises them only when severity is `story`.
 */

export interface FactChange {
  kind: 'add' | 'change' | 'remove';
  old?: string;
  new?: string;
}

export interface EntityRename {
  from: string;
  to: string;
}

export interface BriefDiff {
  severity: 'cosmetic' | 'facts' | 'story';
  fact_changes: FactChange[];
  renamed_entities: EntityRename[];
  added_premises: string[];
  removed_premises: string[];
  timeline_change?: string;
  /**
   * The diff model's own layer list. The printed BriefDiff does not include it;
   * §9.5 step 4 asks for this flag alongside keyword overlap.
   */
  affected_layers?: string[];
  /**
   * Groups named by an added premise that have no persona yet.
   * One later call generates at most 10 personas for them (§9.5 step 8).
   */
  new_groups?: string[];
}

export interface LayeredInject {
  layer: string;
  title?: string | null;
  content?: string | null;
}

const STOP = new Set([
  'that',
  'this',
  'with',
  'from',
  'have',
  'been',
  'were',
  'they',
  'their',
  'about',
  'into',
  'after',
  'before',
  'which',
  'while',
  'where',
  'there',
  'these',
  'those',
  'will',
  'would',
  'could',
  'should',
  'your',
  'their',
]);

export function emptyBriefDiff(severity: BriefDiff['severity'] = 'cosmetic'): BriefDiff {
  return {
    severity,
    fact_changes: [],
    renamed_entities: [],
    added_premises: [],
    removed_premises: [],
  };
}

/**
 * Branch and dependency layers are revised with their parent, not as their own
 * brief-revision call. `branch:<parent_key>` follows the parent inject.
 * `dependency:<id>` follows the dependency edge.
 */
export function revisesWithParent(layer: string): boolean {
  return layer.startsWith('branch:') || layer.startsWith('dependency:');
}

/** Layers whose injects mention a removed premise or a changed fact, or that the model flagged. */
export function affectedLayers(diff: BriefDiff, injects: readonly LayeredInject[]): string[] {
  const present = new Set(
    injects.map((inject) => inject.layer).filter((layer) => layer.length > 0),
  );
  const flagged = new Set((diff.affected_layers ?? []).filter((layer) => present.has(layer)));
  const found = new Set<string>();
  if (diff.severity === 'story') {
    for (const layer of present) found.add(layer);
  }
  for (const layer of flagged) found.add(layer);
  if (diff.severity !== 'story') {
    for (const inject of injects) {
      if (!inject.layer || found.has(inject.layer)) continue;
      if (mentionsBriefChange(`${inject.title ?? ''}\n${inject.content ?? ''}`, diff)) {
        found.add(inject.layer);
      }
    }
  }
  return [...found].sort();
}

export function mentionsBriefChange(text: string, diff: BriefDiff): boolean {
  const hay = text.toLowerCase();
  if (!hay.trim()) return false;
  const phrases = [
    ...diff.removed_premises,
    ...diff.fact_changes.flatMap((change) => [change.old, change.new]),
  ].filter((phrase): phrase is string => typeof phrase === 'string' && phrase.trim().length > 0);
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase().trim();
    if (needle.length >= 4 && hay.includes(needle)) return true;
    const tokens = significantTokens(needle);
    if (tokens.length === 0) continue;
    const hits = tokens.filter((token) => hay.includes(token));
    const needed = Math.min(2, tokens.length);
    if (hits.length >= needed && hits.some((token) => token.length >= 5)) return true;
  }
  return false;
}

function significantTokens(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !STOP.has(token));
}
