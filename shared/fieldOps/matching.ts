const PUNCTUATION = new Set([
  '/',
  '\\',
  '|',
  '—',
  '–',
  '-',
  '_',
  '.',
  ',',
  ';',
  ':',
  '(',
  ')',
  '[',
  ']',
  "'",
  '"',
]);

const STOP = new Set([
  'team',
  'teams',
  'unit',
  'units',
  'the',
  'of',
  'dept',
  'department',
  'division',
  'section',
  'group',
  'service',
  'services',
]);

/**
 * 02 §6.5. NFKC, lower case, "&" to " and ", the listed punctuation to spaces,
 * other non-letters dropped, Latin diacritics removed, stop tokens dropped.
 */
export function normaliseTeamText(value: string): string {
  const nfkc = value.normalize('NFKC').replaceAll('đ', 'd').replaceAll('Đ', 'd').toLowerCase();
  const stripped = stripLatinMarks(nfkc);
  let text = '';
  for (const char of stripped) {
    if (char === '&') {
      text += ' and ';
      continue;
    }
    if (
      PUNCTUATION.has(char) ||
      char === '\u200b' ||
      char === '\u200c' ||
      char === '\u200d' ||
      char === '\ufeff'
    ) {
      text += ' ';
      continue;
    }
    if (/\p{L}|\p{N}|\p{M}|\s/u.test(char)) text += char;
  }
  return text
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP.has(token))
    .join(' ');
}

function stripLatinMarks(value: string): string {
  let out = '';
  const decomposed = value.normalize('NFD');
  for (let index = 0; index < decomposed.length; index += 1) {
    const char = decomposed[index] ?? '';
    const code = char.charCodeAt(0);
    const mark = code >= 0x0300 && code <= 0x036f;
    const previous = out.at(-1) ?? '';
    if (mark && /\p{Script=Latin}/u.test(previous)) continue;
    out += char;
  }
  return out.normalize('NFC');
}
