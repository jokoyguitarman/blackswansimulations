export type PreviewQuantifier = 'all' | 'any' | 'at_least';

export interface PreviewInput {
  quantifier: PreviewQuantifier;
  threshold: number;
  appear: readonly string[];
  cancel: readonly string[];
  notBefore: number | null;
}

function soften(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Plain-English preview of an appear list, its cancel list, and not-before. */
export function conditionPreviewSentence(input: PreviewInput): string {
  const appear = input.appear.map(soften).filter(Boolean);
  const cancel = input.cancel.map(soften).filter(Boolean);
  const parts: string[] = [];
  if (appear.length === 0) {
    parts.push('Fires when its conditions are met.');
  } else if (input.quantifier === 'all') {
    parts.push(`Fires when ${appear.join(' AND ')}.`);
  } else if (input.quantifier === 'any') {
    parts.push(`Fires when any of these hold: ${appear.join(' OR ')}.`);
  } else {
    const n = Math.max(1, Math.floor(input.threshold));
    parts.push(`Fires when at least ${n} of these hold: ${listAnd(appear)}.`);
  }
  if (cancel.length > 0) parts.push(`Cancelled if ${cancel.join(' OR ')}.`);
  if (input.notBefore != null && input.notBefore > 0) {
    parts.push(`Not before T+${input.notBefore}.`);
  }
  return parts.join(' ');
}
