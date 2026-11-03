// Shared Markdown helpers for the field-ops specification set.
//
// Used by scripts/build-field-ops-spec-html.mjs (renders HTML) and
// scripts/verify-field-ops-specs.mjs (checks the set), so both agree on how a
// heading becomes an anchor and on what counts as a heading, a table or a code block.
//
// The parser supports exactly the subset in docs/field-ops/README.md section 4:
// headings, paragraphs, bullet and numbered lists (nested), pipe tables, fenced code
// blocks (including mermaid), block quotes, horizontal rules, inline code, bold,
// italics and links. It has no dependencies.

/* ------------------------------------------------------------------ */
/* Escaping, inline stripping and slugs                                */
/* ------------------------------------------------------------------ */

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text of an inline Markdown string (for slugs, titles and the table of contents). */
export function stripInline(text) {
  return String(text)
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*]+)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_([^_]+)_(?!\w)/g, '$1$2');
}

/** GitHub-style anchor: "## 6. Server" becomes "6-server". */
export function slugify(text) {
  return stripInline(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Returns a function that slugifies in document order and de-duplicates (-1, -2, ...). */
export function makeSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/* ------------------------------------------------------------------ */
/* Line helpers                                                        */
/* ------------------------------------------------------------------ */

const TAB_WIDTH = 4;

function leadingSpaces(line) {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += TAB_WIDTH;
    else break;
  }
  return width;
}

/** Removes up to `columns` columns of leading whitespace. */
function dedent(line, columns) {
  let removed = 0;
  let k = 0;
  while (k < line.length && removed < columns) {
    if (line[k] === ' ') {
      removed += 1;
      k += 1;
    } else if (line[k] === '\t') {
      removed += TAB_WIDTH;
      k += 1;
    } else break;
  }
  return line.slice(k);
}

const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^ {0,3}>\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RE_FENCE = /^(\s*)(`{3,}|~{3,})([^`]*)$/;
const RE_MARKER = /^(\s*)([-*+]|\d{1,9}[.)])(?:(\s+)(.*)|$)/;

function fenceOpen(line) {
  const m = line.match(RE_FENCE);
  if (!m) return null;
  const info = m[3].trim();
  return {
    indent: leadingSpaces(m[1]),
    char: m[2][0],
    len: m[2].length,
    lang: info ? info.split(/\s+/)[0] : '',
  };
}

function fenceCloses(line, open) {
  const m = line.match(/^(\s*)(`{3,}|~{3,})\s*$/);
  return Boolean(m) && m[2][0] === open.char && m[2].length >= open.len;
}

function matchMarker(line) {
  const m = line.match(RE_MARKER);
  if (!m) return null;
  const indent = leadingSpaces(m[1]);
  const ordered = /\d/.test(m[2]);
  const spaces = m[3] ? (m[3].length > 4 ? 1 : m[3].length) : 1;
  return {
    indent,
    ordered,
    number: ordered ? parseInt(m[2], 10) : null,
    contentIndent: indent + m[2].length + spaces,
    text: m[4] ?? '',
  };
}

function isTableStart(line, next) {
  return (
    line.includes('|') &&
    next !== undefined &&
    next.includes('|') &&
    RE_TABLE_SEP.test(next) &&
    !RE_HR.test(next)
  );
}

/** Does this line end a paragraph? (CommonMark: only "1." may interrupt with a numbered list.) */
function interruptsParagraph(line, next) {
  if (!line.trim()) return true;
  if (RE_HEADING.test(line)) return true;
  if (fenceOpen(line)) return true;
  if (RE_HR.test(line)) return true;
  if (RE_QUOTE.test(line)) return true;
  const marker = matchMarker(line);
  if (marker && (!marker.ordered || marker.number === 1) && marker.text.trim()) return true;
  if (isTableStart(line, next)) return true;
  return false;
}

/** Splits a pipe-table row. Pipes inside inline code spans and escaped pipes stay in the cell. */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/* ------------------------------------------------------------------ */
/* Block parser                                                        */
/* ------------------------------------------------------------------ */

function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const separator = splitRow(lines[start + 1]);
  const align = separator.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !fenceOpen(lines[i])) {
    rows.push(splitRow(lines[i]));
    i += 1;
  }
  return { node: { type: 'table', header, align, rows, line: null }, next: i };
}

function parseList(lines, start, ctx) {
  const first = matchMarker(lines[start]);
  const baseIndent = first.indent;
  const ordered = first.ordered;
  const items = [];
  let i = start;

  while (i < lines.length) {
    // Skip blank lines between items; continue only if the next non-blank line is a sibling.
    let peek = i;
    while (peek < lines.length && !lines[peek].trim()) peek += 1;
    if (peek >= lines.length) break;
    const marker = matchMarker(lines[peek]);
    if (!marker || marker.indent !== baseIndent || marker.ordered !== ordered) break;
    if (RE_HR.test(lines[peek])) break;
    i = peek;

    const itemLines = [marker.text];
    const contentIndent = marker.contentIndent;
    i += 1;
    let openFence = null;

    while (i < lines.length) {
      const line = lines[i];

      if (openFence) {
        itemLines.push(dedent(line, contentIndent));
        if (fenceCloses(line, openFence)) openFence = null;
        i += 1;
        continue;
      }

      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
        if (j >= lines.length) {
          i = j;
          break;
        }
        if (leadingSpaces(lines[j]) > baseIndent) {
          itemLines.push('');
          i += 1;
          continue;
        }
        break;
      }

      const indent = leadingSpaces(line);
      if (indent > baseIndent) {
        const open = fenceOpen(line);
        if (open) openFence = open;
        itemLines.push(dedent(line, Math.min(indent, contentIndent)));
        i += 1;
        continue;
      }

      const sibling = matchMarker(line);
      if (sibling && sibling.indent === baseIndent) break;

      const previous = itemLines[itemLines.length - 1];
      if (previous.trim() && !interruptsParagraph(line, lines[i + 1])) {
        itemLines.push(line.trim());
        i += 1;
        continue;
      }
      break;
    }

    let checked = null;
    const firstText = itemLines[0];
    const task = firstText.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      checked = task[1] !== ' ';
      itemLines[0] = task[2];
    }
    items.push({ checked, blocks: parseBlocks(itemLines, ctx, null) });
  }

  return {
    node: { type: 'list', ordered, start: ordered ? first.number : null, items, line: null },
    next: i,
  };
}

/**
 * Parses lines into block nodes. `lineBase` is the absolute line index of lines[0] for
 * the top-level call (so headings and code blocks know where they are), else null.
 */
function parseBlocks(lines, ctx, lineBase) {
  const blocks = [];
  let i = 0;
  const lineOf = (index) => (lineBase === null ? null : lineBase + index + 1);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const open = fenceOpen(line);
    if (open) {
      const body = [];
      const startIndex = i;
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (fenceCloses(lines[i], open)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(dedent(lines[i], open.indent));
        i += 1;
      }
      if (!closed) {
        ctx.diagnostics.push({ type: 'unterminated_fence', line: lineOf(startIndex) });
      }
      blocks.push({
        type: 'code',
        lang: open.lang,
        text: body.join('\n'),
        line: lineOf(startIndex),
        endLine: lineBase === null ? null : lineBase + i,
      });
      continue;
    }

    const heading = line.match(RE_HEADING);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2], line: lineOf(i) });
      i += 1;
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr', line: lineOf(i) });
      i += 1;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const quoted = [];
      const startIndex = i;
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        quoted.push(lines[i].match(RE_QUOTE)[1]);
        i += 1;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(quoted, ctx, null), line: lineOf(startIndex) });
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const { node, next } = parseTable(lines, i);
      node.line = lineOf(i);
      blocks.push(node);
      i = next;
      continue;
    }

    const marker = matchMarker(line);
    if (marker) {
      const { node, next } = parseList(lines, i, ctx);
      node.line = lineOf(i);
      blocks.push(node);
      i = next;
      continue;
    }

    const buffer = [];
    const startIndex = i;
    while (i < lines.length) {
      if (buffer.length > 0 && interruptsParagraph(lines[i], lines[i + 1])) break;
      if (!lines[i].trim()) break;
      buffer.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'para', lines: buffer, text: buffer.join('\n'), line: lineOf(startIndex) });
  }

  return blocks;
}

/**
 * Parses a Markdown source. Returns { blocks, lines, diagnostics, headings }.
 * `headings` are the top-level headings with their `id` anchors assigned.
 */
export function parseMarkdown(source) {
  const text = String(source).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const ctx = { diagnostics: [] };
  const blocks = parseBlocks(lines, ctx, 0);
  const slugger = makeSlugger();
  const headings = [];
  for (const block of blocks) {
    if (block.type === 'heading') {
      block.id = slugger(block.text);
      headings.push(block);
    }
  }
  return { blocks, lines, diagnostics: ctx.diagnostics, headings };
}

/** Splits lines into level-2 sections: [{ heading, startLine, endLine, lines }] (1-based, inclusive). */
export function sectionsOf(parsed) {
  const h2 = parsed.headings.filter((h) => h.level === 2);
  return h2.map((heading, index) => {
    const startLine = heading.line;
    const endLine = index + 1 < h2.length ? h2[index + 1].line - 1 : parsed.lines.length;
    return {
      heading,
      startLine,
      endLine,
      lines: parsed.lines.slice(startLine, endLine),
    };
  });
}

/** Header block under the title: **Label:** value lines. Returns [{label, value}] or null. */
export function metaBlock(parsed) {
  const index = parsed.blocks.findIndex((b) => b.type === 'heading' && b.level === 1);
  if (index < 0) return null;
  const next = parsed.blocks[index + 1];
  if (!next || next.type !== 'para') return null;
  const entries = [];
  for (const line of next.lines) {
    const m = line.match(/^\*\*([^*]+?):\*\*\s*(.*)$/);
    if (!m) return entries.length >= 2 ? entries : null;
    entries.push({ label: m[1].trim(), value: m[2].trim() });
  }
  return entries.length >= 2 ? entries : null;
}

/** Parses the decision-log table of the master plan: Map(D-number -> { text, status, specs }). */
export function parseDecisions(source) {
  const map = new Map();
  for (const line of String(source).replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(/^\|\s*(D\d{1,2})\s*\|\s*(.*?)\s*\|\s*(Decided|Assumed)\s*\|\s*(.*?)\s*\|\s*$/);
    if (m) map.set(m[1], { id: m[1], text: m[2], status: m[3], specs: m[4] });
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Inline rendering                                                    */
/* ------------------------------------------------------------------ */

function rewriteHref(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#')) return url;
  const hashAt = url.indexOf('#');
  const pathPart = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  if (/\.md$/i.test(pathPart)) return pathPart.replace(/\.md$/i, '.html') + hash;
  return url;
}

function emphasis(html) {
  let s = html;
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (match, inner) => {
    const tag = inner.match(/^(Verified|Proposed|Assumed)\b/);
    if (tag) return `<strong class="tag tag-${tag[1].toLowerCase()}">${inner}</strong>`;
    return `<strong>${inner}</strong>`;
  });
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  return s;
}

/**
 * Renders inline Markdown to HTML. `ctx.decisions` (Map) turns D-numbers into
 * hover-titled references. Code spans ending in " (new)" get a small badge.
 */
export function renderInline(text, ctx = {}) {
  const stash = [];
  const put = (html) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  let s = String(text);

  // 1. Code spans.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (match, ticks, code) => {
    const body = code.replace(/^ (.*) $/s, '$1');
    const isNew = /\s\(new\)$/.test(body);
    const shown = isNew ? body.replace(/\s\(new\)$/, '') : body;
    const compact = shown.length <= 40 && !/\s/.test(shown);
    return put(
      `<code${compact ? ' class="nb"' : ''}>${escapeHtml(shown)}</code>${isNew ? '<span class="new">new</span>' : ''}`,
    );
  });

  // 2. Escape everything else.
  s = escapeHtml(s);

  // 3. Links.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, label, url) => {
    const href = rewriteHref(url.replace(/&amp;/g, '&')).replace(/&/g, '&amp;');
    const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
    const attrs = external ? ' target="_blank" rel="noopener"' : '';
    return put(`<a href="${href}"${attrs}>${emphasis(label)}</a>`);
  });

  // 4. Emphasis.
  s = emphasis(s);

  // 5. Standalone (new) markers outside code.
  s = s.replace(/\(new\)/g, '<span class="new">new</span>');

  // 6. Decision references (D1 to D99).
  if (ctx.decisions) {
    s = s.replace(/\bD(\d{1,2})\b/g, (match, n) => {
      const decision = ctx.decisions.get(`D${n}`);
      if (!decision) return match;
      const title = `${decision.id} (${decision.status}): ${decision.text}`;
      return `<abbr class="dref" title="${escapeHtml(title)}">${match}</abbr>`;
    });
  }

  // 7. Hard line breaks (two trailing spaces).
  s = s.replace(/ {2,}\n/g, '<br>\n');

  // 8. Restore stashed fragments (they may nest).
  let guard = 0;
  while (/\u0000\d+\u0000/.test(s) && guard < 8) {
    s = s.replace(/\u0000(\d+)\u0000/g, (match, index) => stash[Number(index)]);
    guard += 1;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Block rendering                                                     */
/* ------------------------------------------------------------------ */

function renderCode(block) {
  if (block.lang === 'mermaid') {
    return `<pre class="mermaid">${escapeHtml(block.text)}</pre>`;
  }
  const lang = block.lang || 'text';
  return (
    `<div class="codeblock" data-lang="${escapeHtml(lang)}">` +
    `<pre class="code"><code>${escapeHtml(block.text)}</code></pre></div>`
  );
}

function renderTable(block, ctx) {
  const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length));
  const cellAlign = (index) => (block.align[index] ? ` style="text-align:${block.align[index]}"` : '');
  const pad = (cells) => {
    const copy = cells.slice();
    while (copy.length < columns) copy.push('');
    return copy;
  };
  const head = pad(block.header)
    .map((cell, index) => `<th${cellAlign(index)}>${renderInline(cell, ctx)}</th>`)
    .join('');
  const body = block.rows
    .map(
      (row) =>
        `<tr>${pad(row)
          .map((cell, index) => `<td${cellAlign(index)}>${renderInline(cell, ctx)}</td>`)
          .join('')}</tr>`,
    )
    .join('\n');
  return `<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function renderList(block, ctx) {
  const tag = block.ordered ? 'ol' : 'ul';
  const startAttr = block.ordered && block.start && block.start !== 1 ? ` start="${block.start}"` : '';
  const hasTasks = block.items.some((item) => item.checked !== null);
  const items = block.items
    .map((item) => {
      const tight = item.blocks.length > 0 && item.blocks[0].type === 'para' && item.blocks.slice(1).every((b) => b.type !== 'para');
      const inner = item.blocks
        .map((child, index) => {
          if (tight && index === 0 && child.type === 'para') return renderInline(child.text, ctx);
          return renderBlock(child, ctx);
        })
        .join('\n');
      const box = item.checked === null ? '' : `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> `;
      return `<li${item.checked === null ? '' : ' class="task"'}>${box}${inner}</li>`;
    })
    .join('\n');
  return `<${tag}${startAttr}${hasTasks ? ' class="tasks"' : ''}>\n${items}\n</${tag}>`;
}

export function renderBlock(block, ctx = {}) {
  switch (block.type) {
    case 'heading': {
      const id = block.id ?? slugify(block.text);
      if (block.level === 1) return `<h1 id="${id}">${renderInline(block.text, ctx)}</h1>`;
      const numbered = block.level === 2 ? block.text.match(/^(\d+)\.\s+(.*)$/) : null;
      const label = numbered
        ? `<span class="num">${numbered[1]}</span>${renderInline(numbered[2], ctx)}`
        : renderInline(block.text, ctx);
      return `<h${block.level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this heading">#</a>${label}</h${block.level}>`;
    }
    case 'para':
      return `<p>${renderInline(block.text, ctx)}</p>`;
    case 'code':
      return renderCode(block);
    case 'list':
      return renderList(block, ctx);
    case 'table':
      return renderTable(block, ctx);
    case 'quote':
      return `<blockquote>${renderBlocks(block.blocks, ctx)}</blockquote>`;
    case 'hr':
      return '<hr>';
    default:
      return '';
  }
}

export function renderBlocks(blocks, ctx = {}) {
  return blocks.map((block) => renderBlock(block, ctx)).join('\n');
}
