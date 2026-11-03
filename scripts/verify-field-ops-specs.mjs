#!/usr/bin/env node
// Checks the field-ops specification set (docs/field-ops/*.md).
//
//   node scripts/verify-field-ops-specs.mjs [--only=02,05] [--strict] [--allow-missing] [--quiet] [--deep]
//
// --deep also reads each cited code line: when the sentence around a citation names an identifier
// (a function, type or constant), that identifier must appear within a few lines of the cited
// range, and if it appears elsewhere in the file the check reports where, so drifted line
// numbers can be corrected.
//
// Fails (exit 1) on: missing template sections, citations to files that do not exist
// (unless marked "(new)"), line numbers past the end of a file, migration numbers outside a
// spec's allocation or used twice, flags that are neither existing nor in the master plan,
// links and anchors that do not resolve, unknown decision numbers, placeholder text, and
// inconsistent task or acceptance-criteria ids.
//
// Warnings (exit 1 only with --strict) cover softer problems: thin sections, bare file names,
// missing contract definitions, raw HTML, American spellings, routes outside the allocated
// prefixes. Safety-review hits are listed for a human to read; they never fail the run.
//
// The master plan (00-master-plan.md) is the source of truth for ranges, flags,
// component names and decisions; this script reads them from it.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { metaBlock, parseDecisions, parseMarkdown, sectionsOf, splitRow } from './lib/field-ops-md.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'docs', 'field-ops');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};
const ONLY = option('only')
  ? option('only')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null;
const STRICT = hasFlag('strict');
const ALLOW_MISSING = hasFlag('allow-missing');
const QUIET = hasFlag('quiet');
const DEEP = hasFlag('deep');

/* ------------------------------------------------------------------ */
/* Expected documents and headings                                     */
/* ------------------------------------------------------------------ */

const EXPECTED = [
  'README',
  '00-master-plan',
  '01-prerequisites',
  '02-teams-and-doctrines',
  '03-setup-screen',
  '04-site-picker',
  '05-layout-step',
  '06-compile-and-review',
  '07-device-and-physics',
  '08-people-or-ai',
  '09-after-publish',
  '10-ui-spec-sheet',
  '11-living-world',
];

const SPEC_HEADINGS = [
  '1. Purpose, goals and non-goals',
  '2. Decisions and assumptions',
  '3. Current state (verified)',
  '4. Target behaviour and acceptance criteria',
  '5. Data model',
  '6. Server',
  '7. Client',
  '8. AI and LLM contracts',
  '9. Security, privacy and safety',
  '10. Flags, rollout and observability',
  '11. Tests',
  '12. Tasks',
  '13. Commit plan and backtracking',
  '14. File map',
  '15. Risks and open questions',
  '16. Definition of done',
];

const MASTER_HEADINGS = [
  '1. Purpose and scope',
  '2. The product in one page',
  '3. Decision log',
  '4. Architecture overview',
  '5. Workstreams',
  '6. Dependencies and order of work',
  '7. Where things live',
  '8. Feature flags',
  '9. Migrations',
  '10. Shared contracts',
  '11. Global definition of done',
  '12. Environments and rollout',
  '13. Risks',
  '14. Traceability',
  '15. Glossary',
  '16. Change log',
];

const UI_HEADINGS = [
  '1. Purpose and how to use this sheet',
  '2. Design tokens and shared styles',
  '3. Page frame and navigation',
  '4. State 1: Setup',
  '5. State 2: No doctrine detected',
  '6. State 3: Lay out the scene',
  '7. State 4: Review after compile',
  '8. Interactions and behaviours',
  '9. Copy deck',
  '10. Accessibility',
  '11. Responsive behaviour',
  '12. Icons and assets',
  '13. Data bindings',
  '14. Mockup-only artefacts to drop',
  '15. Visual QA checklist',
  '16. Definition of done',
];

/** Document kind and workstream number from the file name. */
function kindOf(name) {
  if (name === 'README') return { kind: 'readme', ws: null };
  if (name === '00-master-plan') return { kind: 'master', ws: null };
  if (name === '10-ui-spec-sheet') return { kind: 'ui', ws: null };
  const n = parseInt(name, 10);
  // Files 01 to 09 are WS0 to WS8; 10 is the UI sheet, so 11 is WS9.
  return { kind: 'spec', ws: n >= 11 ? n - 2 : n - 1 };
}

const CONTRACT_OWNERS = {
  DeviceSpec: '07-device-and-physics',
  EffectEstimate: '07-device-and-physics',
  FootprintProposal: '03-setup-screen',
  FieldOpsSetupV2: '03-setup-screen',
  PressureBody: '03-setup-screen',
  AdversaryInput: '03-setup-screen',
  SiteSelection: '04-site-picker',
  BuildingRef: '04-site-picker',
  AgencyCard: '02-teams-and-doctrines',
  SceneConfigV2: '05-layout-step',
};

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

const findings = [];
const findingKeys = new Set();
function add(level, doc, line, code, message) {
  const key = `${level}|${doc}|${line ?? 0}|${code}|${message}`;
  if (findingKeys.has(key)) return;
  findingKeys.add(key);
  findings.push({ level, doc, line: line ?? 0, code, message });
}
const error = (doc, line, code, message) => add('error', doc, line, code, message);
const warn = (doc, line, code, message) => add('warn', doc, line, code, message);
const info = (doc, line, code, message) => add('info', doc, line, code, message);

/* ------------------------------------------------------------------ */
/* Repository helpers                                                  */
/* ------------------------------------------------------------------ */

let trackedCache = null;
function trackedFiles() {
  if (trackedCache) return trackedCache;
  try {
    trackedCache = execFileSync('git', ['ls-files'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    trackedCache = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'tmp'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else trackedCache.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    };
    walk(ROOT);
  }
  return trackedCache;
}

let baseIndex = null;
function filesByBase(base) {
  if (!baseIndex) {
    baseIndex = new Map();
    for (const rel of trackedFiles()) {
      const b = rel.slice(rel.lastIndexOf('/') + 1);
      if (!baseIndex.has(b)) baseIndex.set(b, []);
      baseIndex.get(b).push(rel);
    }
  }
  return baseIndex.get(base) ?? [];
}

const lineCountCache = new Map();
function lineCount(rel) {
  if (lineCountCache.has(rel)) return lineCountCache.get(rel);
  let count = null;
  try {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    count = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    count = null;
  }
  lineCountCache.set(rel, count);
  return count;
}

const existsRel = (rel) => fs.existsSync(path.join(ROOT, rel));

const htmlAnchorCache = new Map();
function htmlAnchors(absolute) {
  if (htmlAnchorCache.has(absolute)) return htmlAnchorCache.get(absolute);
  let anchors = new Set();
  try {
    const text = fs.readFileSync(absolute, 'utf8');
    anchors = new Set([...text.matchAll(/\b(?:id|name)="([^"]+)"/g)].map((m) => m[1]));
  } catch {
    /* ignore */
  }
  htmlAnchorCache.set(absolute, anchors);
  return anchors;
}

/* ------------------------------------------------------------------ */
/* Load the documents                                                  */
/* ------------------------------------------------------------------ */

function splitProseAndCode(lines) {
  const prose = [];
  const code = [];
  let fence = null;
  let block = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (!fence) {
      if (m && !m[3].includes('`')) {
        fence = { char: m[2][0], len: m[2].length, lang: m[3].trim().split(/\s+/)[0] || '' };
        block += 1;
        continue;
      }
      prose.push({ n: i + 1, text: line });
    } else {
      if (m && m[2][0] === fence.char && m[2].length >= fence.len && m[3].trim() === '') {
        fence = null;
        continue;
      }
      code.push({ n: i + 1, text: line, lang: fence.lang, block });
    }
  }
  return { prose, code };
}

const docs = new Map();
const missing = [];
for (const name of EXPECTED) {
  const file = path.join(DIR, `${name}.md`);
  if (!fs.existsSync(file)) {
    missing.push(name);
    continue;
  }
  const source = fs.readFileSync(file, 'utf8');
  const parsed = parseMarkdown(source);
  const { prose, code } = splitProseAndCode(parsed.lines);
  docs.set(name, {
    name,
    ...kindOf(name),
    source,
    parsed,
    meta: metaBlock(parsed),
    prose,
    code,
    anchors: new Set(parsed.headings.map((h) => h.id)),
    text: parsed.lines.join('\n'),
  });
}

for (const entry of fs.readdirSync(DIR)) {
  if (entry.endsWith('.md') && !EXPECTED.includes(entry.replace(/\.md$/, ''))) {
    warn(entry.replace(/\.md$/, ''), 0, 'unexpected_file', `${entry} is not part of the set listed in the README`);
  }
}

const selected = (name) => {
  if (!ONLY) return true;
  const num = name.slice(0, 2);
  return ONLY.includes(num) || ONLY.includes(name);
};

for (const name of missing) {
  if (!selected(name)) continue;
  (ALLOW_MISSING ? warn : error)(name, 0, 'missing_document', `docs/field-ops/${name}.md does not exist`);
}

/* ------------------------------------------------------------------ */
/* Master plan: ranges, flags, components, decisions                   */
/* ------------------------------------------------------------------ */

const master = docs.get('00-master-plan');
const decisions = master ? parseDecisions(master.source) : new Map();
const ranges = new Map(); // ws -> [from, to]
const masterFlags = new Set();
const components = new Map(); // name -> spec file prefix (e.g. "03")

if (master) {
  for (const line of master.parsed.lines) {
    const range = line.match(/^\|\s*WS(\d)\s*\|\s*(\d{3})\s*to\s*(\d{3})\s*\|/);
    if (range) ranges.set(Number(range[1]), [Number(range[2]), Number(range[3])]);
    const comp = line.match(/^\|\s*`(\w+)`\s*\|[^|]*\|\s*(\d{2})\s*\|\s*$/);
    if (comp) components.set(comp[1], comp[2]);
  }
  for (const m of master.text.matchAll(/\b(?:VITE_)?ENABLE_[A-Z0-9_]+\b/g)) masterFlags.add(m[0]);
} else if (!ONLY || ALLOW_MISSING) {
  warn('00-master-plan', 0, 'no_master', 'The master plan is missing, so ranges, flags and decisions cannot be checked');
}

const existingFlags = new Set();
{
  const roots = ['server/', 'frontend/src/', 'shared/', 'scripts/'];
  const extras = ['.env.example', 'frontend/.env.example', 'render.yaml', 'vercel.json', 'frontend/vercel.json'];
  const files = trackedFiles().filter(
    (f) => (roots.some((r) => f.startsWith(r)) && /\.(ts|tsx|js|mjs|json)$/.test(f)) || extras.includes(f),
  );
  for (const rel of files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\b(?:VITE_)?ENABLE_[A-Z0-9_]+\b/g)) existingFlags.add(m[0]);
  }
}

const mountPrefixes = new Set();
try {
  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.ts'), 'utf8');
  for (const m of index.matchAll(/app\.use\(\s*['"`](\/api[^'"`]*)['"`]/g)) mountPrefixes.add(m[1].replace(/\/$/, ''));
} catch {
  /* ignore */
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

function stripCodeSpans(text) {
  return text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, ' ');
}

function snippet(text, max = 110) {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/* ------------------------------------------------------------------ */
/* Check: structure                                                    */
/* ------------------------------------------------------------------ */

function checkStructure(doc) {
  const { name, kind, parsed } = doc;

  for (const d of parsed.diagnostics) {
    error(name, d.line, 'unterminated_fence', 'A fenced code block is never closed');
  }

  const h1s = parsed.headings.filter((h) => h.level === 1);
  if (h1s.length !== 1) error(name, h1s[1]?.line ?? 1, 'title', `Expected exactly one # title, found ${h1s.length}`);

  const required =
    kind === 'spec' ? SPEC_HEADINGS : kind === 'master' ? MASTER_HEADINGS : kind === 'ui' ? UI_HEADINGS : null;
  if (required) {
    const actual = parsed.headings.filter((h) => h.level === 2).map((h) => h.text.trim());
    const missingHeadings = required.filter((h) => !actual.includes(h));
    for (const h of missingHeadings) error(name, 0, 'missing_section', `Missing section heading "## ${h}"`);
    const extra = actual.filter((h) => !required.includes(h));
    for (const h of extra) {
      const at = parsed.headings.find((x) => x.level === 2 && x.text.trim() === h);
      error(name, at?.line, 'extra_section', `Unexpected level-2 heading "## ${h}" (the template has exactly ${required.length})`);
    }
    if (missingHeadings.length === 0 && extra.length === 0) {
      const inOrder = required.every((h, i) => actual[i] === h);
      if (!inOrder) error(name, 0, 'section_order', 'Level-2 headings are present but not in template order');
    }
  }

  // Header block.
  const meta = doc.meta ?? [];
  const labels = meta.map((m) => m.label.toLowerCase());
  const need =
    kind === 'spec'
      ? ['status', 'workstream', 'depends on', 'flags', 'migrations', 'baseline']
      : kind === 'master'
        ? ['status', 'workstream', 'depends on', 'flags', 'migrations', 'baseline']
        : kind === 'ui'
          ? ['status', 'depends on', 'baseline']
          : ['status'];
  for (const label of need) {
    if (!labels.includes(label)) error(name, 3, 'header_block', `Header block is missing "**${label[0].toUpperCase()}${label.slice(1)}:**"`);
  }
  if (kind === 'spec') {
    const ws = meta.find((m) => m.label.toLowerCase() === 'workstream')?.value ?? '';
    if (!new RegExp(`^WS${doc.ws}\\b`).test(ws.replace(/`/g, ''))) {
      error(name, 4, 'header_workstream', `Workstream header should start with WS${doc.ws} (found "${snippet(ws, 40)}")`);
    }
  }

  // Raw HTML and emojis (prose only).
  for (const { n, text } of doc.prose) {
    const plain = stripCodeSpans(text);
    if (/<\/?(?:div|span|br|table|tr|td|th|img|a|p|ul|ol|li|details|summary|b|i|strong|em|pre|h[1-6]|svg|script|style)\b[^>]*>/i.test(plain)) {
      warn(name, n, 'raw_html', `Raw HTML in Markdown: ${snippet(plain, 70)}`);
    }
    if (/\p{Extended_Pictographic}/u.test(plain)) {
      warn(name, n, 'emoji', `Emoji or pictograph in prose: ${snippet(plain, 70)}`);
    }
    const american = plain.match(
      /\b(behaviors?|organizations?|authoriz(?:e|es|ed|ation)|initializ(?:e|es|ed|ation)|normaliz(?:e|es|ed|ation)|optimiz(?:e|es|ed|ation)|minimiz(?:e|es|ed)|maximiz(?:e|es|ed)|analyz(?:e|es|ed)|recogniz(?:e|es|ed)|colors?|favorites?|centers?|centered|customiz(?:e|es|ed))\b/i,
    );
    if (american) warn(name, n, 'american_spelling', `American spelling "${american[0]}" (the set uses British spelling)`);
  }

  // Section-level checks for specs.
  if (kind === 'spec') {
    for (const section of sectionsOf(parsed)) {
      const body = section.lines.join('\n').trim();
      const heading = section.heading.text.trim();
      if (!body) {
        error(name, section.startLine, 'empty_section', `Section "${heading}" is empty`);
      } else if (!/^Not applicable\b/i.test(body) && body.length < 220) {
        warn(name, section.startLine, 'thin_section', `Section "${heading}" is thin (${body.length} characters)`);
      }
    }
    const text = doc.text.toLowerCase();
    const sec = (re) => sectionsOf(parsed).find((s) => re.test(s.heading.text));
    const commit = sec(/^13\./);
    if (commit && !/backtrack/i.test(commit.lines.join('\n'))) {
      warn(name, commit.startLine, 'no_backtracking', 'Section 13 does not describe backtracking');
    }
    const tests = sec(/^11\./);
    if (tests && !/package\.json/.test(tests.lines.join('\n')) && !/^Not applicable/i.test(tests.lines.join('\n').trim())) {
      warn(name, tests.startLine, 'tests_not_registered', 'Section 11 does not mention adding test files to the package.json test script');
    }
    if (doc.text.length < 12000) warn(name, 0, 'short_document', `Document is short for a build spec (${doc.text.length} characters)`);
    void text;
  }
}

/* ------------------------------------------------------------------ */
/* Check: citations                                                    */
/* ------------------------------------------------------------------ */

const EXT = 'ts|tsx|js|jsx|mjs|cjs|json|sql|html|md|css|svg|yml|yaml|sh|ps1|txt|env';
const CITE_CODE = new RegExp(
  `^((?:[\\w@.\\-\\[\\]]+/)*[\\w@.\\-\\[\\]]+\\.(?:${EXT}))(?::(\\d+)(?:-(\\d+))?)?(\\s+\\(new\\))?$`,
);
const CITE_DIR = /^((?:[\w@.\-\[\]]+\/)+)(?:\*{1,2}(?:\.\w+)?)?(\s+\(new\))?$/;
const CITE_PLAIN = new RegExp(
  `(?<![\\w/.@\\-])((?:[\\w@\\-]+/)+[\\w@.\\-]+\\.(?:${EXT})):(\\d+)(?:-(\\d+))?`,
  'g',
);

const newPaths = new Set(); // every path marked (new) anywhere in the set
const newPathDocs = new Map(); // path -> Set(doc names) that mark it (new)
const citationRecords = [];
function markNew(docName, cited) {
  newPaths.add(cited);
  if (!newPathDocs.has(cited)) newPathDocs.set(cited, new Set());
  newPathDocs.get(cited).add(docName);
}

function collectCitations(doc) {
  for (const { n, text } of doc.prose) {
    // Code spans.
    for (const m of text.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)) {
      const body = m[2].trim();
      const after = text.slice(m.index + m[0].length);
      const newAfter = /^\s*\(new\)/.test(after);
      let match = body.match(CITE_CODE);
      if (match) {
        const isNew = Boolean(match[4]) || newAfter;
        citationRecords.push({
          doc: doc.name,
          line: n,
          index: m.index,
          path: match[1],
          from: match[2] ? Number(match[2]) : null,
          to: match[3] ? Number(match[3]) : null,
          isNew,
        });
        if (isNew) markNew(doc.name, match[1]);
        continue;
      }
      match = body.match(CITE_DIR);
      if (match && !/[<>{}$]/.test(body)) {
        const isNew = Boolean(match[2]) || newAfter;
        citationRecords.push({ doc: doc.name, line: n, path: match[1], dir: true, from: null, to: null, isNew });
        if (isNew) markNew(doc.name, match[1]);
      }
    }
    // Plain "path:line" outside code spans.
    const plain = stripCodeSpans(text);
    for (const m of plain.matchAll(CITE_PLAIN)) {
      citationRecords.push({
        doc: doc.name,
        line: n,
        index: m.index,
        path: m[1],
        from: Number(m[2]),
        to: m[3] ? Number(m[3]) : null,
        isNew: false,
        plain: true,
      });
    }
  }
}

function verifyCitation(rec) {
  const { doc, line, path: cited, from, to, isNew } = rec;
  if (/^shared\/.*\.test\.ts$/.test(cited)) {
    error(
      doc,
      line,
      'shared_test_file',
      `${cited}: the frontend type-checks shared/ without Node types (frontend/tsconfig.json:7 and :34), so a test file there breaks "tsc && vite build". Put it under server/lib/fieldOps/ and import the module with a .js suffix`,
    );
  }
  if (/[<>{}$*]/.test(cited) && !rec.dir) {
    // glob in a file pattern: check the directory part only
    const dirPart = cited.slice(0, cited.lastIndexOf('/') + 1);
    if (dirPart && !/[<>{}$*]/.test(dirPart) && !isNew && !newPaths.has(dirPart) && !existsRel(dirPart.replace(/\/$/, ''))) {
      error(doc, line, 'cite_missing_dir', `Directory "${dirPart}" does not exist`);
    }
    return;
  }
  if (/^(node_modules\/|~|[A-Za-z]:|https?:|path\/to\/)/.test(cited)) return; // external or example paths
  if (/^\.{1,2}\//.test(cited)) return; // an import specifier such as './jobs.js', not a repository path

  if (rec.dir) {
    if (isNew || newPaths.has(cited)) return;
    // A directory that new files will live in is created by those files.
    if ([...newPaths].some((p) => p.startsWith(cited))) return;
    if (existsRel(cited.replace(/\/$/, ''))) return;
    if (existsRel(`docs/design/warroom/${cited.replace(/\/$/, '')}`)) return; // mockup assets, cited relative to the mockup
    error(doc, line, 'cite_missing_dir', `Directory "${cited}" does not exist and is not marked (new)`);
    return;
  }

  const hasSlash = cited.includes('/');
  let resolved = null;
  if (hasSlash) {
    if (existsRel(cited)) resolved = cited;
    else if (existsRel(`docs/field-ops/${cited}`)) resolved = `docs/field-ops/${cited}`;
    else if (existsRel(`docs/design/warroom/${cited}`)) resolved = `docs/design/warroom/${cited}`;
  } else if (existsRel(cited)) {
    resolved = cited; // a file at the repository root, such as package.json
  } else if (/\.(md|html)$/.test(cited) && existsRel(`docs/field-ops/${cited}`)) {
    resolved = `docs/field-ops/${cited}`;
  } else {
    // bare file name with a line number: look it up in the tracked files
    if (!rec.from) return; // a bare name without a line is not treated as a citation
    const candidates = filesByBase(cited);
    if (candidates.length === 1) {
      resolved = candidates[0];
      warn(doc, line, 'bare_file_name', `"${cited}" is cited without its directory; use ${resolved}`);
    } else if (candidates.length > 1) {
      const counts = candidates.map((c) => lineCount(c) ?? 0);
      warn(doc, line, 'bare_file_name', `"${cited}" is cited without its directory and matches ${candidates.length} files`);
      const max = Math.max(...counts);
      if (from > max || (to && to > max)) {
        error(doc, line, 'cite_line_range', `${cited}:${from}${to ? `-${to}` : ''} is beyond the end of every file with that name (longest has ${max} lines)`);
      }
      return;
    } else if (isNew || newPaths.has(cited)) {
      return;
    } else {
      error(doc, line, 'cite_missing_file', `"${cited}" was not found in the repository and is not marked (new)`);
      return;
    }
  }

  if (!resolved) {
    if (isNew || newPaths.has(cited)) {
      if (!isNew) warn(doc, line, 'cite_new_unmarked', `"${cited}" does not exist yet; mark it (new) where it is cited`);
      return;
    }
    error(doc, line, 'cite_missing_file', `"${cited}" does not exist and is not marked (new)`);
    return;
  }
  if (isNew && resolved === cited && !/^docs\/field-ops\//.test(cited)) {
    warn(doc, line, 'cite_new_exists', `"${cited}" is marked (new) but already exists`);
  }
  if (from !== null) {
    const total = lineCount(resolved);
    if (total === null) return;
    if (from < 1 || from > total || (to !== null && (to > total || to < from))) {
      error(doc, line, 'cite_line_range', `${cited}:${from}${to ? `-${to}` : ''} is outside the file (${total} lines)`);
      return;
    }
    if (DEEP) deepCheck(rec, resolved);
  }
}

const STOP_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean', 'void', 'type', 'code', 'file', 'line', 'lines',
  'const', 'this', 'that', 'with', 'from', 'into', 'data', 'body', 'path', 'name', 'text', 'list', 'item', 'items', 'none',
  'json', 'async', 'await', 'return', 'default', 'export', 'import', 'class', 'function', 'server', 'client', 'route',
  'routes', 'table', 'tables', 'field', 'fields', 'value', 'values', 'flag', 'flags', 'test', 'tests', 'step', 'steps',
]);

const sourceLinesCache = new Map();
function sourceLines(rel) {
  if (sourceLinesCache.has(rel)) return sourceLinesCache.get(rel);
  let lines = null;
  try {
    lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  } catch {
    lines = null;
  }
  sourceLinesCache.set(rel, lines);
  return lines;
}

/** Identifiers the sentence around a citation talks about (backticked names and CamelCase words). */
function identifiersNear(text) {
  const ids = new Set();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const token = m[1].trim().replace(/\(\)$/, '');
    if (CITE_CODE.test(token) || /\s/.test(token) || token.length < 4) continue;
    const last = token.split(/[.:]/).filter(Boolean).pop() ?? '';
    if (/^[A-Za-z_$][\w$]*$/.test(last) && last.length >= 4 && !STOP_WORDS.has(last.toLowerCase())) ids.add(last);
  }
  const rest = text.replace(/`[^`]*`/g, ' ');
  for (const m of rest.matchAll(/\b(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+)\b/g)) ids.add(m[0]);
  return [...ids];
}

function deepCheck(rec, resolved) {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|sql|json|css|html)$/.test(resolved)) return;
  const owner = docs.get(rec.doc);
  const raw = owner?.parsed.lines[rec.line - 1] ?? '';
  let at = raw.indexOf(`${rec.path}:${rec.from}`);
  if (at < 0) at = rec.index ?? 0;
  const windowText = raw.slice(Math.max(0, at - 170), at + 190).replace(/`[^`]*:\d+(?:-\d+)?[^`]*`/g, ' ');
  const ids = identifiersNear(windowText);
  if (ids.length === 0) return;
  const lines = sourceLines(resolved);
  if (!lines) return;
  const to = rec.to ?? rec.from;
  const low = Math.max(1, rec.from - 12);
  const high = Math.min(lines.length, to + 12);
  const region = lines.slice(low - 1, high).join('\n');
  if (ids.some((id) => region.includes(id))) return;

  // Nearest occurrence of each identifier to the cited range.
  const nearest = [];
  for (const id of ids) {
    let best = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes(id)) continue;
      const lineNo = i + 1;
      const distance = lineNo < rec.from ? rec.from - lineNo : lineNo > to ? lineNo - to : 0;
      if (best === null || distance < best.distance) best = { id, lineNo, distance };
    }
    if (best) nearest.push(best);
  }
  const range = `${resolved}:${rec.from}${rec.to ? `-${rec.to}` : ''}`;
  const close = nearest.filter((n) => n.distance <= 150).sort((a, b) => a.distance - b.distance);
  if (close.length > 0) {
    const hint = close
      .slice(0, 3)
      .map((n) => `${n.id} at line ${n.lineNo}`)
      .join('; ');
    warn(rec.doc, rec.line, 'cite_drift', `${range} may have drifted: ${hint}`);
  } else {
    info(
      rec.doc,
      rec.line,
      'cite_context',
      `${range} does not mention ${ids.slice(0, 4).join(', ')} nearby${
        nearest.length ? ` (nearest: ${nearest[0].id} at line ${nearest[0].lineNo})` : ' (not found in the file)'
      }`,
    );
  }
}

/** A code block that starts with "// shared/..." and imports zod would break the Vercel build (root node_modules is not installed there). */
function checkSharedZod(doc) {
  const blocks = new Map();
  for (const line of doc.code) {
    if (!blocks.has(line.block)) blocks.set(line.block, []);
    blocks.get(line.block).push(line);
  }
  for (const lines of blocks.values()) {
    const first = lines.find((l) => l.text.trim());
    const header = first?.text.match(/^\s*\/\/\s*(shared\/[\w./-]+\.ts)\b/);
    if (!header) continue;
    const hit = lines.find((l) => /\bfrom\s+['"](zod|zod\/[^'"]*)['"]/.test(l.text));
    if (hit) {
      error(
        doc.name,
        hit.n,
        'zod_in_shared',
        `${header[1]} imports zod. Vercel installs only frontend/node_modules, so shared/ must have no third-party imports (zod schemas belong under server/lib/fieldOps/)`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Check: links                                                        */
/* ------------------------------------------------------------------ */

function checkLinks(doc) {
  for (const { n, text } of doc.prose) {
    const plain = stripCodeSpans(text);
    for (const m of plain.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[2];
      if (/^(https?:|mailto:|tel:)/i.test(target)) continue;
      const hashAt = target.indexOf('#');
      const filePart = hashAt >= 0 ? target.slice(0, hashAt) : target;
      const anchor = hashAt >= 0 ? decodeURIComponent(target.slice(hashAt + 1)) : '';

      if (!filePart) {
        if (anchor && !doc.anchors.has(anchor)) error(doc.name, n, 'link_anchor', `Anchor "#${anchor}" does not exist in this document`);
        continue;
      }
      const absolute = path.resolve(DIR, filePart);
      if (!fs.existsSync(absolute)) {
        if (/\.md$/.test(filePart) && missing.includes(path.basename(filePart, '.md'))) {
          if (!ALLOW_MISSING && ONLY) continue;
        }
        error(doc.name, n, 'link_file', `Link target "${filePart}" does not exist`);
        continue;
      }
      if (!anchor) continue;
      if (/\.md$/.test(filePart)) {
        const other = docs.get(path.basename(filePart, '.md'));
        if (other && !other.anchors.has(anchor)) {
          error(doc.name, n, 'link_anchor', `Anchor "#${anchor}" does not exist in ${path.basename(filePart)}`);
        }
      } else if (/\.html$/.test(filePart)) {
        if (!htmlAnchors(absolute).has(anchor)) {
          error(doc.name, n, 'link_anchor', `Anchor "#${anchor}" does not exist in ${filePart}`);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Check: decisions, flags, placeholders                               */
/* ------------------------------------------------------------------ */

function checkDecisions(doc) {
  if (decisions.size === 0) return;
  for (const { n, text } of doc.prose) {
    const plain = stripCodeSpans(text);
    for (const m of plain.matchAll(/\bD(\d{1,3})\b/g)) {
      if (!decisions.has(`D${m[1]}`)) {
        error(doc.name, n, 'unknown_decision', `${m[0]} is not in the master plan's decision log (D1 to D${decisions.size})`);
      }
    }
  }
}

function checkFlags(doc) {
  const seen = new Set();
  const scan = (n, text) => {
    for (const m of text.matchAll(/\b(?:VITE_)?ENABLE_[A-Z0-9_]+\b/g)) {
      const flag = m[0];
      const key = `${flag}@${n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (masterFlags.has(flag) || existingFlags.has(flag)) continue;
      if (/[A-Z0-9]_$/.test(flag)) continue;
      error(doc.name, n, 'unknown_flag', `${flag} is neither an existing flag nor allocated in master plan section 8`);
    }
  };
  for (const { n, text } of doc.prose) scan(n, text);
  for (const { n, text } of doc.code) scan(n, text);
}

const PLACEHOLDER = /\b(TBD|TODO|FIXME|lorem ipsum)\b|\bXXX\b|\bto be (?:decided|determined|confirmed)\b/i;
function checkPlaceholders(doc) {
  for (const { n, text } of doc.prose) {
    const plain = stripCodeSpans(text);
    const hit = plain.match(PLACEHOLDER);
    if (hit) error(doc.name, n, 'placeholder', `Placeholder text "${hit[0]}"`);
    if (/^\s*(\.\.\.|…)\s*$/.test(text) || /\|\s*(\.\.\.|…)\s*(\||$)/.test(text)) {
      error(doc.name, n, 'placeholder', 'A stand-in ("...") where content should be');
    }
  }
  for (const { n, text, lang } of doc.code) {
    if (/^(ts|tsx|typescript)$/i.test(lang) && /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+\w+/.test(text)) {
      error(doc.name, n, 'enum_syntax', 'TypeScript enums are not allowed: frontend/tsconfig.json:24 sets erasableSyntaxOnly. Use a union of string literals and a const array');
    }
    const hit = text.match(/\b(TBD|TODO|FIXME)\b/);
    if (hit) error(doc.name, n, 'placeholder', `Placeholder text "${hit[0]}" in a code block`);
    if (/^\s*(?:\/\/|--|#|\/\*|\*)?\s*(?:\.\.\.|…)\s*(?:\*\/)?\s*$/.test(text)) {
      error(doc.name, n, 'placeholder', 'A stand-in ("...") line in a code block');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Check: migrations                                                   */
/* ------------------------------------------------------------------ */

const migrationNames = new Map(); // number -> Set(filenames)
function ownerOf(number) {
  for (const [ws, [from, to]] of ranges) {
    if (number >= from && number <= to) return ws;
  }
  return null;
}

function checkMigrations(doc) {
  const scan = (n, text) => {
    for (const m of text.matchAll(/\b(\d{3})_([a-z0-9][a-z0-9_]*)\.sql\b/g)) {
      const number = Number(m[1]);
      const filename = `${m[1]}_${m[2]}.sql`;
      if (number <= 217) {
        if (!existsRel(`migrations/${filename}`)) {
          error(doc.name, n, 'migration_missing', `migrations/${filename} does not exist`);
        }
        continue;
      }
      if (!migrationNames.has(number)) migrationNames.set(number, new Map());
      const byFile = migrationNames.get(number);
      if (!byFile.has(filename)) byFile.set(filename, new Set());
      byFile.get(filename).add(doc.name);

      if (ranges.size === 0) continue;
      const ownerWs = ownerOf(number);
      if (ownerWs === null) {
        (number > 248 ? warn : error)(doc.name, n, 'migration_unallocated', `${filename}: ${number} is outside every allocated range`);
        continue;
      }
      if (doc.kind === 'spec' && ownerWs !== doc.ws) {
        const ownerDoc = [...docs.values()].find((d) => d.kind === 'spec' && d.ws === ownerWs);
        if (ownerDoc && !ownerDoc.text.includes(filename)) {
          error(doc.name, n, 'migration_foreign', `${filename} belongs to WS${ownerWs}'s range, and that spec does not define it`);
        }
      }
    }
  };
  for (const { n, text } of doc.prose) scan(n, text);
  for (const { n, text } of doc.code) scan(n, text);

  if (doc.kind === 'spec') {
    const range = ranges.get(doc.ws);
    const value = doc.meta?.find((m) => m.label.toLowerCase() === 'migrations')?.value ?? '';
    const declared = [...value.matchAll(/\b(\d{3})\b/g)].map((m) => Number(m[1]));
    if (range) {
      for (const num of declared) {
        if (num < range[0] || num > range[1]) {
          error(doc.name, 5, 'migration_header_range', `Header lists migration ${num}, outside WS${doc.ws}'s range ${range[0]} to ${range[1]}`);
        }
      }
      if (declared.length === 0 && !/\bnone\b/i.test(value)) {
        warn(doc.name, 5, 'migration_header', 'Header "Migrations" lists no numbers and does not say "none"');
      }
      const own = [...doc.text.matchAll(/\b(\d{3})_[a-z0-9_]+\.sql\b/g)]
        .map((m) => Number(m[1]))
        .filter((num) => num >= range[0] && num <= range[1]);
      const hasSql = doc.code.some((c) => /\b(CREATE|ALTER)\s+(TABLE|INDEX|EXTENSION|FUNCTION|OR REPLACE)/i.test(c.text));
      if (own.length > 0 && !hasSql) warn(doc.name, 0, 'migration_no_sql', 'Migrations are named but no CREATE or ALTER statement appears in a code block');
    }
  }
}

function checkMigrationUniqueness() {
  for (const [number, byFile] of migrationNames) {
    if (byFile.size > 1) {
      const names = [...byFile.keys()].join(', ');
      const first = [...byFile.values()][0];
      error([...first][0], 0, 'migration_duplicate', `Migration number ${number} is used for different files: ${names}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Check: task and acceptance-criteria ids                             */
/* ------------------------------------------------------------------ */

function checkIds(doc) {
  if (doc.kind !== 'spec') return;
  const sections = sectionsOf(doc.parsed);
  const ac = sections.find((s) => /^4\./.test(s.heading.text));
  const tasks = sections.find((s) => /^12\./.test(s.heading.text));

  const definitions = (section, prefix) => {
    const out = [];
    section.lines.forEach((line, index) => {
      const n = section.startLine + 1 + index;
      const lead = line.match(
        new RegExp(`^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+|#{1,6}\\s+|\\|\\s*)?\\**\`?(${prefix}(\\d+)\\.(\\d+))\\b`),
      );
      if (lead) out.push({ id: lead[1], ws: Number(lead[2]), n });
    });
    return out;
  };

  if (ac) {
    const defs = definitions(ac, 'AC');
    if (defs.length < 3) warn(doc.name, ac.startLine, 'few_acs', `Section 4 defines ${defs.length} acceptance criteria (expected at least 3)`);
    const seen = new Set();
    for (const d of defs) {
      if (d.ws !== doc.ws) error(doc.name, d.n, 'ac_workstream', `${d.id} should be AC${doc.ws}.<n> in this spec`);
      if (seen.has(d.id)) error(doc.name, d.n, 'ac_duplicate', `${d.id} is defined twice`);
      seen.add(d.id);
    }
  }
  if (tasks) {
    const defs = definitions(tasks, 'T');
    if (defs.length < 4) warn(doc.name, tasks.startLine, 'few_tasks', `Section 12 defines ${defs.length} tasks (expected at least 4)`);
    const seen = new Set();
    for (const d of defs) {
      if (d.ws !== doc.ws) error(doc.name, d.n, 'task_workstream', `${d.id} should be T${doc.ws}.<n> in this spec`);
      if (seen.has(d.id)) error(doc.name, d.n, 'task_duplicate', `${d.id} is defined twice`);
      seen.add(d.id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Check: routes                                                       */
/* ------------------------------------------------------------------ */

function checkRoutes(doc) {
  if (doc.kind === 'readme') return;
  const allowed = ['/api/warroom/field-ops', '/api/field-ops'];
  const scan = (n, text, inCode) => {
    for (const m of text.matchAll(/(?<![\w.])(\/api\/[A-Za-z0-9_\-/:{}.]+)/g)) {
      const route = m[1].replace(/[.:]+$/, '');
      if (allowed.some((p) => route === p || route.startsWith(`${p}/`))) continue;
      const first = route.split('/').slice(0, 3).join('/');
      const known = [...mountPrefixes].some((p) => route === p || route.startsWith(`${p}/`) || first === p);
      if (!known) warn(doc.name, n, 'route_prefix', `Route ${route} is not under an allocated or existing prefix${inCode ? '' : ''}`);
      else if (/^\/api\/warroom\//.test(route)) {
        info(doc.name, n, 'route_existing', `Route ${route} is under the existing /api/warroom mount but not /api/warroom/field-ops (fine only if it is an existing route)`);
      }
    }
  };
  for (const { n, text } of doc.prose) scan(n, text, false);
  for (const { n, text } of doc.code) scan(n, text, true);
}

/* ------------------------------------------------------------------ */
/* Check: safety review list (for a human)                             */
/* ------------------------------------------------------------------ */

const SAFETY_PATTERNS = [
  /\b(detonators?|blasting caps?|igniters?|fuzes?|fuses?)\b/i,
  /\b(circuits?|solder\w*|wire the|wiring diagrams?|schematics?|breadboard)\b/i,
  /\b(recipes?|formulations?|proportions?|synthes[ie]s\w*|precursors?|stoichiometr\w*)\b/i,
  /\b(assembl(?:e|es|ed|y|ing)|how to (?:make|build)|step[- ]by[- ]step build)\b/i,
  /\b(arming|conceal(?:ed|ing|ment)?|booby[- ]?trap\w*)\b/i,
  /\b(RDX|PETN|HMX|TATP|HMTD|ANFO|nitroglycerin\w*|dynamite|semtex|ammonium nitrate|black powder|gunpowder|C-4)\b/i, // "C4" alone is a commit label
  /\b(maximi[sz]e (?:casualties|harm|damage|lethality)|optimi[sz]e (?:placement|casualties|lethality))\b/i,
  /\b(shrapnel|nails?|ball bearings?)\b/i,
];
const NEGATION = /\b(never|not|no|must not|does not|do not|without|forbid\w*|refuse\w*|reject\w*|prohibit\w*|excluded?|block\w*)\b/i;

function safetyScan(doc) {
  if (doc.kind === 'readme' || doc.kind === 'master') return;
  const lines = [...doc.prose.map((p) => ({ ...p, code: false })), ...doc.code.map((c) => ({ ...c, code: true }))].sort(
    (a, b) => a.n - b.n,
  );
  for (const { n, text } of lines) {
    for (const re of SAFETY_PATTERNS) {
      const hit = text.match(re);
      if (!hit) continue;
      const negated = NEGATION.test(text);
      info(doc.name, n, negated ? 'safety_stated_limit' : 'safety_review', `"${hit[0]}": ${snippet(text, 100)}`);
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Cross-document checks                                               */
/* ------------------------------------------------------------------ */

function checkCrossDocument() {
  // Canonical components live in their owner spec.
  for (const [component, prefix] of components) {
    const ownerName = EXPECTED.find((n) => n.startsWith(`${prefix}-`));
    const owner = ownerName ? docs.get(ownerName) : null;
    if (owner && !new RegExp(`\\b${component}\\b`).test(owner.text)) {
      warn(owner.name, 0, 'component_missing', `Canonical component \`${component}\` (master plan 10.4) is never mentioned in its owner spec`);
    }
  }
  // Contract types are defined by their owner.
  for (const [type, ownerName] of Object.entries(CONTRACT_OWNERS)) {
    const owner = docs.get(ownerName);
    if (!owner) continue;
    const defined = new RegExp(`\\b(?:interface|type|class)\\s+${type}\\b|\\b(?:const|export const)\\s+${type}Schema\\b`).test(owner.text);
    if (!defined) warn(ownerName, 0, 'contract_undefined', `${type} is owned by this spec but no definition (interface, type or zod schema) was found`);
  }
  // The same new file listed as "to be created" in the file maps (section 14) of two specs is a collision.
  // A row that names another workstream as the owner, or says the file is only touched, is not a creation:
  // such files are cited with "(new)" only because they do not exist yet.
  const created = new Map(); // path -> Set(doc names)
  const isSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  for (const doc of docs.values()) {
    if (doc.kind !== 'spec') continue;
    const fileMap = sectionsOf(doc.parsed).find((s) => /^14\./.test(s.heading.text));
    if (!fileMap) continue;
    const otherWs = (text) => [...String(text).matchAll(/\bWS(\d)\b/g)].some((m) => Number(m[1]) !== doc.ws);
    let ownerIdx = -1;
    for (const [index, line] of fileMap.lines.entries()) {
      const isRow = /^\s*\|/.test(line);
      if (!isRow) ownerIdx = -1;
      if (isSeparator(line)) continue;
      if (isRow && isSeparator(fileMap.lines[index + 1] ?? '')) {
        ownerIdx = splitRow(line).findIndex((cell) => /\bowner\b/i.test(cell));
        continue;
      }
      if (/\btouched\b/i.test(line)) continue;
      if (isRow && ownerIdx >= 0 && otherWs(splitRow(line)[ownerIdx] ?? '')) continue;
      if (!isRow && (/\bWS\d's\b/.test(line) || /\bowned by WS\d\b/i.test(line)) && otherWs(line)) continue;
      for (const m of line.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)) {
        const body = m[2].trim();
        const after = line.slice(m.index + m[0].length);
        const match = body.match(CITE_CODE) ?? body.match(CITE_DIR);
        if (!match) continue;
        const flagged = /\(new\)/.test(body) || /^\s*\(new\)/.test(after);
        if (!flagged) continue;
        const cited = match[1];
        if (!created.has(cited)) created.set(cited, new Set());
        created.get(cited).add(doc.name);
      }
    }
  }
  for (const [file, owners] of created) {
    if (owners.size > 1) {
      const names = [...owners].sort();
      warn(names[0], 0, 'new_path_collision', `${file} is created by the file maps of ${names.join(' and ')}; one spec should own it and the others should list it as touched`);
    }
  }
  // Every new flag in the master plan is used by at least one spec.
  for (const flag of masterFlags) {
    if (!/FIELDOPS/.test(flag) || flag.startsWith('VITE_')) continue;
    const used = [...docs.values()].some((d) => d.kind === 'spec' && d.text.includes(flag));
    if (!used && [...docs.values()].some((d) => d.kind === 'spec')) {
      info('00-master-plan', 0, 'flag_unused', `${flag} is allocated in the master plan but no spec mentions it`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Check: the UI spec sheet                                            */
/* ------------------------------------------------------------------ */

function checkUi(doc) {
  if (doc.kind !== 'ui') return;
  const sections = sectionsOf(doc.parsed);
  const states = sections.filter((s) => /^[4-7]\./.test(s.heading.text));
  let rows = 0;
  for (const section of states) {
    const text = section.lines.join('\n');
    if (!/Mockup lines/i.test(text)) {
      error(doc.name, section.startLine, 'ui_no_mockup_lines', `Section "${section.heading.text}" has no "Mockup lines" column`);
    }
    rows += section.lines.filter((l) => /^\|\s*\d+(?:\.\d+)*\s*\|/.test(l)).length;
  }
  const mockup = path.join(ROOT, 'docs', 'design', 'warroom', 'field-ops-setup.html');
  if (fs.existsSync(mockup)) {
    const html = fs.readFileSync(mockup, 'utf8');
    const count = (re) => (html.match(re) ?? []).length;
    const interactive = count(/<button\b/gi) + count(/<input\b/gi) + count(/<select\b/gi) + count(/<textarea\b/gi) + count(/<a\s[^>]*href=/gi);
    info(doc.name, 0, 'ui_coverage', `The mockup has ${interactive} buttons, inputs, selects, textareas and links; sections 4 to 7 have ${rows} numbered element rows`);
    if (rows < interactive * 0.6) {
      warn(doc.name, 0, 'ui_coverage_low', `Only ${rows} numbered element rows for ${interactive} interactive elements; check that every control appears once`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

for (const doc of docs.values()) collectCitations(doc);

for (const doc of docs.values()) {
  if (!selected(doc.name)) continue;
  checkStructure(doc);
  checkSharedZod(doc);
  checkLinks(doc);
  checkDecisions(doc);
  checkFlags(doc);
  checkPlaceholders(doc);
  checkMigrations(doc);
  checkIds(doc);
  checkRoutes(doc);
  checkUi(doc);
  safetyScan(doc);
}
for (const rec of citationRecords) {
  if (selected(rec.doc)) verifyCitation(rec);
}
checkMigrationUniqueness();
if (!ONLY) checkCrossDocument();
else {
  checkCrossDocument();
  for (let i = findings.length - 1; i >= 0; i -= 1) {
    if (!selected(findings[i].doc) && findings[i].doc !== 'README') findings.splice(i, 1);
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const order = { error: 0, warn: 1, info: 2 };
const byDoc = new Map();
for (const f of findings) {
  if (!byDoc.has(f.doc)) byDoc.set(f.doc, []);
  byDoc.get(f.doc).push(f);
}

const label = { error: 'ERROR', warn: 'WARN ', info: 'INFO ' };
let errors = 0;
let warnings = 0;
let infos = 0;

for (const name of [...byDoc.keys()].sort()) {
  const list = byDoc.get(name).sort((a, b) => order[a.level] - order[b.level] || a.line - b.line);
  const shown = list.filter((f) => !QUIET || f.level !== 'info');
  if (shown.length === 0) continue;
  console.log(`\n${name}.md`);
  for (const f of shown) {
    const where = f.line ? `docs/field-ops/${name}.md:${f.line}` : `docs/field-ops/${name}.md`;
    console.log(`  ${label[f.level]} ${f.code.padEnd(22)} ${f.message}\n        ${where}`);
  }
}
for (const f of findings) {
  if (f.level === 'error') errors += 1;
  else if (f.level === 'warn') warnings += 1;
  else infos += 1;
}

const checked = [...docs.values()].filter((d) => selected(d.name));
console.log('\n' + '-'.repeat(64));
console.log(
  `${checked.length} document(s) checked, ${decisions.size} decisions, ${components.size} canonical components, ${masterFlags.size} master flags.`,
);
console.log(`${errors} error(s), ${warnings} warning(s), ${infos} note(s).`);
if (!QUIET && infos > 0) console.log('Notes marked safety_review need a human read: they list device-related wording outside a stated prohibition.');

process.exit(errors > 0 || (STRICT && warnings > 0) ? 1 : 0);
