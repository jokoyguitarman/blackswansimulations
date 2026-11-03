#!/usr/bin/env node
// Builds the HTML edition of the field-ops specification set.
//
//   node scripts/build-field-ops-spec-html.mjs
//
// Reads every docs/field-ops/*.md and writes a matching .html beside it, plus index.html.
// The Markdown is the source of truth: the HTML is generated and must not be edited by hand.
// Output is deterministic (no timestamps), so rebuilding an unchanged set changes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  escapeHtml,
  metaBlock,
  parseDecisions,
  parseMarkdown,
  renderBlocks,
  renderInline,
  sectionsOf,
  stripInline,
} from './lib/field-ops-md.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'docs', 'field-ops');

/* ------------------------------------------------------------------ */
/* Document registry                                                   */
/* ------------------------------------------------------------------ */

const LABELS = {
  README: { num: '', ws: '', label: 'About this set' },
  '00-master-plan': { num: '00', ws: 'All', label: 'Master plan' },
  '01-prerequisites': { num: '01', ws: 'WS0', label: 'Prerequisites' },
  '02-teams-and-doctrines': { num: '02', ws: 'WS1', label: 'Teams and doctrines' },
  '03-setup-screen': { num: '03', ws: 'WS2', label: 'Setup screen' },
  '04-site-picker': { num: '04', ws: 'WS3', label: 'Site picker' },
  '05-layout-step': { num: '05', ws: 'WS4', label: 'Layout step' },
  '06-compile-and-review': { num: '06', ws: 'WS5', label: 'Compile and review' },
  '07-device-and-physics': { num: '07', ws: 'WS6', label: 'Device and physics' },
  '08-people-or-ai': { num: '08', ws: 'WS7', label: 'People or AI' },
  '09-after-publish': { num: '09', ws: 'WS8', label: 'After publish' },
  '10-ui-spec-sheet': { num: '10', ws: 'UI', label: 'UI spec sheet' },
  '11-living-world': { num: '11', ws: 'WS9', label: 'Living world' },
};

function orderKey(name) {
  if (name === 'README') return -1;
  const n = parseInt(name, 10);
  return Number.isNaN(n) ? 999 : n;
}

function labelFor(name) {
  return LABELS[name] ?? { num: '', ws: '', label: name.replace(/^\d+-/, '').replace(/-/g, ' ') };
}

function readDocs() {
  const names = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort((a, b) => orderKey(a) - orderKey(b) || a.localeCompare(b));

  const masterPath = path.join(DIR, '00-master-plan.md');
  const decisions = fs.existsSync(masterPath)
    ? parseDecisions(fs.readFileSync(masterPath, 'utf8'))
    : new Map();

  return names.map((name) => {
    const source = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    const parsed = parseMarkdown(source);
    const h1 = parsed.headings.find((h) => h.level === 1);
    const meta = metaBlock(parsed);
    const text = parsed.lines.join('\n');
    const sections = sectionsOf(parsed);
    const tasksSection = sections.find((s) => /^\d+\.\s+Tasks\b/.test(s.heading.text));
    const acSection = sections.find((s) => /acceptance criteria/i.test(s.heading.text));
    const distinct = (re, haystack) => new Set([...haystack.matchAll(re)].map((m) => m[0])).size;
    const metaValue = (label) => meta?.find((m) => m.label.toLowerCase() === label)?.value ?? '';
    return {
      name,
      source,
      parsed,
      meta,
      decisions,
      title: h1 ? stripInline(h1.text) : name,
      labelInfo: labelFor(name),
      stats: {
        lines: parsed.lines.length,
        kb: Math.round(Buffer.byteLength(source, 'utf8') / 102.4) / 10,
        sections: sections.length,
        tasks: tasksSection ? distinct(/\bT\d+\.\d+\b/g, tasksSection.lines.join('\n')) : 0,
        acs: acSection ? distinct(/\bAC\d+\.\d+\b/g, acSection.lines.join('\n')) : distinct(/\bAC\d+\.\d+\b/g, text),
        workstream: metaValue('workstream'),
        dependsOn: metaValue('depends on'),
        flags: metaValue('flags'),
        migrations: metaValue('migrations'),
        status: metaValue('status'),
        baseline: metaValue('baseline'),
      },
    };
  });
}

const AGENT_PROMPT = `Implement task T<ws>.<n> from docs/field-ops/<spec>.md.

1. Read docs/field-ops/00-master-plan.md and the spec first. Use only the flag names, migration numbers,
   route prefixes, type names and component names the master plan allocates.
2. Do exactly what the task lists: its files, its steps, its tests. Do not touch other files.
   Where the spec cites existing code, open it and confirm it still matches before changing it.
3. Everything new stays behind its flag, and the legacy behaviour must be unchanged with the flag off.
   A migration must be additive, and the code must work before the migration is applied.
4. Add every new test file to the test script list in package.json.
5. When finished, run npm test and npx tsc --noEmit, then report which of the task's done-when
   conditions you observed and how. If something in the spec is wrong or missing, say so instead of guessing.`;

/* ------------------------------------------------------------------ */
/* Page template                                                       */
/* ------------------------------------------------------------------ */

const CSS = `
:root{
  --bg:#FAF8F4;--surface:#fff;--surface-2:#F4F1EA;--ink:#172033;--muted:#667085;
  --brand:#1E3A5F;--accent:#D97706;--accent-strong:#B45309;
  --border:#E4DFD4;--border-strong:#D6CFC0;--success:#15803D;--danger:#B91C1C;
  --deep:#0E1A2B;--deep-2:#13233A;--code-bg:#0F172A;--code-ink:#E2E8F0;
  --shadow:0 1px 2px rgba(23,32,51,.06),0 10px 26px -18px rgba(23,32,51,.28);
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.64 Inter,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--brand)}
code{font-family:var(--mono);font-size:.85em;background:var(--surface-2);padding:.08em .36em;border-radius:5px;border:1px solid var(--border);word-break:break-word}
p{margin:0 0 12px}
ul,ol{margin:0 0 12px;padding-left:22px}
li{margin:3px 0}
li>ul,li>ol{margin:4px 0 4px}
ul.tasks{list-style:none;padding-left:4px}
li.task input{margin-right:6px;vertical-align:-1px}
hr{border:0;border-top:1px solid var(--border);margin:26px 0}

.hero{background:radial-gradient(1100px 480px at 12% -25%,rgba(217,119,6,.30),transparent 62%),linear-gradient(180deg,var(--deep),var(--deep-2));color:#E5E7EB;padding:38px 32px 30px}
.hero .in{max-width:1400px;margin:0 auto;padding-left:316px}
.eyebrow{font:800 11px var(--mono);letter-spacing:.2em;text-transform:uppercase;color:#F59E0B}
.hero h1{font-size:36px;line-height:1.1;letter-spacing:-.025em;margin:10px 0 16px;color:#fff;font-weight:800;max-width:900px}
.metagrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;max-width:1100px}
.metagrid div{padding:9px 13px;border:1px solid rgba(255,255,255,.15);border-radius:12px;background:rgba(255,255,255,.05);font-size:13.5px;color:rgba(255,255,255,.85)}
.metagrid dt{font:700 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:2px}
.metagrid dd{margin:0}
.metagrid code{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.18);color:#FDE68A}
.metagrid a{color:#FCD34D}

.layout{max-width:1400px;margin:0 auto;display:grid;grid-template-columns:292px minmax(0,1fr) 236px}
.side,.rail{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;font-size:13px}
.side{padding:20px 14px 40px 22px;border-right:1px solid var(--border)}
.rail{padding:24px 14px 40px 8px}
.side h6,.rail h6{font:800 10px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:16px 0 5px 8px}
.side a{display:flex;gap:8px;align-items:baseline;padding:5px 8px;border-radius:8px;text-decoration:none;color:var(--ink);line-height:1.3}
.side a:hover{background:var(--surface-2)}
.side a.cur{background:color-mix(in srgb,var(--accent) 13%,#fff);font-weight:700}
.side a b{font:800 11px var(--mono);color:var(--accent-strong);min-width:22px}
.side a i{margin-left:auto;font:700 9.5px var(--mono);color:var(--muted);font-style:normal;letter-spacing:.04em}
.brandmark{font:800 12px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--brand);padding:2px 8px 6px}
.rail a{display:block;padding:3px 8px;border-left:2px solid var(--border);text-decoration:none;color:#475467;line-height:1.35}
.rail a.l3{padding-left:18px;font-size:12px}
.rail a:hover{color:var(--brand);border-left-color:var(--accent)}
.rail a.on{color:var(--brand);font-weight:700;border-left-color:var(--accent)}
main{padding:30px 44px 140px;min-width:0;max-width:1060px}

.doc h2{font-size:27px;letter-spacing:-.02em;color:var(--brand);line-height:1.2;font-weight:800;margin:54px 0 14px;padding-top:26px;border-top:1px solid var(--border);display:flex;gap:14px;align-items:baseline}
.doc h2:first-of-type{margin-top:8px;border-top:0;padding-top:0}
.doc h2 .num{font:800 13px var(--mono);color:var(--accent-strong);background:color-mix(in srgb,var(--accent) 12%,#fff);border:1px solid color-mix(in srgb,var(--accent) 38%,#fff);border-radius:10px;padding:5px 9px;flex:none;position:relative;top:-3px}
.doc h3{font:800 11.5px var(--mono);letter-spacing:.15em;text-transform:uppercase;color:var(--accent-strong);margin:32px 0 11px;display:flex;align-items:center;gap:10px}
.doc h3::after{content:"";flex:1;height:1px;background:var(--border)}
.doc h4{margin:20px 0 6px;font-size:15px;color:var(--brand)}
.doc h5,.doc h6{margin:14px 0 4px;font-size:14px;color:var(--brand)}
.anchor{opacity:0;margin-left:-20px;padding-right:8px;text-decoration:none;color:var(--muted);font-weight:400;position:absolute;transform:translateX(-4px)}
.doc h2 .anchor,.doc h3 .anchor,.doc h4 .anchor{position:relative;margin-left:0;padding-right:0;order:9;transform:none;font-size:.7em}
.doc h2:hover .anchor,.doc h3:hover .anchor,.doc h4:hover .anchor{opacity:1}

.tw{overflow-x:auto;margin:8px 0 16px;border-radius:12px;border:1px solid var(--border);background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{background:var(--surface-2);text-align:left;font:800 10px var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--muted);padding:8px 12px;white-space:nowrap}
td{padding:8px 12px;border-top:1px solid var(--border);vertical-align:top}
td:first-child{font-weight:600}
td code{white-space:normal}
td code.nb{white-space:nowrap;word-break:normal}
tbody tr:hover td{background:#FFFDF7}

.codeblock{position:relative;margin:10px 0 16px}
.codeblock::before{content:attr(data-lang);position:absolute;top:8px;right:84px;font:700 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:#94A3B8}
pre.code{margin:0;background:var(--code-bg);color:var(--code-ink);border-radius:12px;padding:16px 18px;overflow:auto;font:12.5px/1.55 var(--mono);box-shadow:var(--shadow)}
pre.code code{background:none;border:0;padding:0;color:inherit;font-size:inherit;word-break:normal}
.copy{position:absolute;top:6px;right:8px;font:700 10px var(--mono);letter-spacing:.08em;text-transform:uppercase;background:rgba(255,255,255,.08);color:#CBD5E1;border:1px solid rgba(255,255,255,.18);border-radius:7px;padding:4px 9px;cursor:pointer}
.copy:hover{background:rgba(255,255,255,.18)}
pre.mermaid{background:#fff;border:1px solid var(--border);border-radius:12px;padding:16px;overflow:auto;font:12.5px/1.5 var(--mono);text-align:center}

blockquote{margin:12px 0 16px;padding:12px 18px;background:#FFFBEB;border:1px solid #FDE68A;border-left:4px solid var(--accent);border-radius:10px}
blockquote p:last-child{margin:0}

.tag{font:800 10px var(--mono);letter-spacing:.07em;text-transform:uppercase;padding:2px 7px;border-radius:6px;border:1px solid}
.tag-verified{background:#F0FDF4;border-color:#BBF7D0;color:#15803D}
.tag-proposed{background:#EFF6FF;border-color:#BFDBFE;color:#1D4ED8}
.tag-assumed{background:#FFFBEB;border-color:#FDE68A;color:#B45309}
.new{font:800 9px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:#15803D;border:1px solid #86EFAC;background:#F0FDF4;border-radius:5px;padding:0 4px;margin-left:5px;vertical-align:1px}
abbr.dref{text-decoration:underline dotted var(--accent);text-underline-offset:3px;cursor:help;font-weight:600}

.docs-table td:nth-child(1){white-space:nowrap}
.pill{display:inline-block;font:700 10.5px var(--mono);letter-spacing:.04em;padding:2px 8px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);color:#475467;margin:1px 3px 1px 0}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 6px}
.stat{padding:10px 15px;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:var(--shadow)}
.stat b{display:block;font-size:23px;line-height:1.15;color:var(--brand)}
.stat span{font:700 10px var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.pager{display:flex;justify-content:space-between;gap:14px;margin-top:56px;padding-top:20px;border-top:1px solid var(--border)}
.pager a{flex:1;max-width:48%;padding:12px 16px;border:1px solid var(--border);border-radius:12px;background:#fff;text-decoration:none;box-shadow:var(--shadow)}
.pager a small{display:block;font:800 10px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.pager a.next{text-align:right;margin-left:auto}
.gen{margin-top:30px;font:12px var(--mono);color:var(--muted)}

@media (max-width:1180px){
  .layout{grid-template-columns:270px minmax(0,1fr)}
  .rail{display:none}
  .hero .in{padding-left:294px}
}
@media (max-width:880px){
  .layout{display:block}
  .side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--border)}
  .hero .in{padding-left:0}
  main{padding:22px 18px 80px}
}
@media print{
  .side,.rail,.copy,.pager,.anchor{display:none!important}
  .layout{display:block}
  .hero{background:#fff;color:#000;padding:0 0 12px}
  .hero h1{color:#000}
  .metagrid div{border-color:#bbb;color:#000;background:#fff}
  .metagrid dt{color:#555}
  main{padding:0;max-width:none}
  pre.code{white-space:pre-wrap;background:#f6f6f6;color:#000;box-shadow:none}
}
`;

const SCRIPT = `
(function(){
  document.querySelectorAll('.codeblock').forEach(function(block){
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'copy'; btn.textContent = 'Copy';
    btn.addEventListener('click', function(){
      var text = block.querySelector('code').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function(){
        btn.textContent = 'Copied'; setTimeout(function(){ btn.textContent = 'Copy'; }, 1400);
      }).catch(function(){ btn.textContent = 'Select and copy'; });
    });
    block.appendChild(btn);
  });
  var links = Array.prototype.slice.call(document.querySelectorAll('.rail a'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var byId = {};
  links.forEach(function(a){ byId[a.getAttribute('href').slice(1)] = a; });
  var heads = Array.prototype.slice.call(document.querySelectorAll('.doc h2[id], .doc h3[id]'));
  var obs = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting && byId[e.target.id]) {
        links.forEach(function(a){ a.classList.remove('on'); });
        byId[e.target.id].classList.add('on');
      }
    });
  }, { rootMargin: '0px 0px -75% 0px' });
  heads.forEach(function(h){ obs.observe(h); });
})();
`;

const MERMAID = `
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({
    startOnLoad: true,
    theme: 'neutral',
    themeVariables: { fontSize: '15px' },
    flowchart: { htmlLabels: true, useMaxWidth: false },
    sequence: { useMaxWidth: false },
  });
</script>`;

function navHtml(docs, current) {
  const link = (href, num, label, tag, cur) =>
    `<a href="${href}"${cur ? ' class="cur" aria-current="page"' : ''}><b>${num || '·'}</b>${escapeHtml(label)}${tag ? `<i>${escapeHtml(tag)}</i>` : ''}</a>`;
  const readme = docs.find((d) => d.name === 'README');
  const rest = docs.filter((d) => d.name !== 'README');
  return (
    `<div class="brandmark">Field ops specs</div>` +
    `<h6>Start</h6>` +
    link('index.html', '', 'Index', '', current === 'index') +
    (readme ? link('README.html', '', readme.labelInfo.label, '', current === 'README') : '') +
    `<h6>Specifications</h6>` +
    rest.map((d) => link(`${d.name}.html`, d.labelInfo.num, d.labelInfo.label, d.labelInfo.ws, current === d.name)).join('') +
    `<h6>Sources</h6>` +
    `<a href="../field-ops-user-journey.html"><b>↗</b>User journey document</a>` +
    `<a href="../design/warroom/field-ops-setup.html"><b>↗</b>UI mockup</a>`
  );
}

function railHtml(headings) {
  const items = headings
    .filter((h) => h.level === 2 || h.level === 3)
    .map((h) => `<a class="l${h.level}" href="#${h.id}">${escapeHtml(stripInline(h.text))}</a>`)
    .join('');
  return items ? `<h6>On this page</h6>${items}` : '';
}

function heroMeta(doc) {
  if (!doc.meta) return '';
  const items = doc.meta
    .map(
      (m) =>
        `<div><dt>${escapeHtml(m.label)}</dt><dd>${renderInline(m.value, { decisions: doc.decisions })}</dd></div>`,
    )
    .join('');
  return `<dl class="metagrid">${items}</dl>`;
}

function pager(docs, index) {
  const numbered = docs.filter((d) => d.name !== 'README');
  const at = numbered.findIndex((d) => d.name === docs[index].name);
  if (at < 0) return '';
  const prev = numbered[at - 1];
  const next = numbered[at + 1];
  const card = (doc, cls, label) =>
    `<a class="${cls}" href="${doc.name}.html"><small>${label}</small>${escapeHtml(
      [doc.labelInfo.num, doc.labelInfo.label].filter(Boolean).join('  '),
    )}</a>`;
  return `<div class="pager">${prev ? card(prev, 'prev', 'Previous') : '<span></span>'}${next ? card(next, 'next', 'Next') : ''}</div>`;
}

function shell({ title, current, docs, hero, body, rail, hasMermaid, footer }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · Field ops build specs</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700;800&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
${hero}
<div class="layout">
<nav class="side" aria-label="Specifications">${navHtml(docs, current)}</nav>
<main class="doc">
${body}
${footer}
</main>
<aside class="rail" aria-label="On this page">${rail}</aside>
</div>
<script>${SCRIPT}</script>${hasMermaid ? MERMAID : ''}
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

function renderDocPage(docs, index) {
  const doc = docs[index];
  const ctx = { decisions: doc.decisions };
  const blocks = doc.parsed.blocks;

  // Drop the H1 (shown in the hero) and the header block (shown as the meta grid).
  let startAt = 0;
  const h1Index = blocks.findIndex((b) => b.type === 'heading' && b.level === 1);
  if (h1Index >= 0) {
    startAt = h1Index + 1;
    if (doc.meta && blocks[startAt]?.type === 'para') startAt += 1;
  }
  const bodyBlocks = blocks.slice(0, h1Index >= 0 ? h1Index : 0).concat(blocks.slice(startAt));
  const body = `<article>${renderBlocks(bodyBlocks, ctx)}</article>${pager(docs, index)}`;
  const hasMermaid = doc.parsed.blocks.some((b) => b.type === 'code' && b.lang === 'mermaid');

  const hero = `<header class="hero"><div class="in">
<div class="eyebrow">Field operations War Room · build specification${doc.labelInfo.ws ? ` · ${escapeHtml(doc.labelInfo.ws)}` : ''}</div>
<h1>${renderInline(doc.title, ctx)}</h1>
${heroMeta(doc)}
</div></header>`;

  return shell({
    title: doc.title,
    current: doc.name,
    docs,
    hero,
    body,
    rail: railHtml(doc.parsed.headings),
    hasMermaid,
    footer: `<p class="gen">Generated from <code>docs/field-ops/${escapeHtml(doc.name)}.md</code> by <code>scripts/build-field-ops-spec-html.mjs</code>. Edit the Markdown, not this file.</p>`,
  });
}

function renderIndexPage(docs) {
  const numbered = docs.filter((d) => d.name !== 'README');
  const decisions = docs[0]?.decisions ?? new Map();
  const decided = [...decisions.values()].filter((d) => d.status === 'Decided').length;
  const master = numbered.find((d) => d.name === '00-master-plan');
  const masterMeta = (key) => {
    const value = master?.stats[key] ?? '';
    return value.replace(/^([a-z])(?=[a-z])/, (c) => c.toUpperCase());
  };
  const total = (key) => numbered.reduce((sum, d) => sum + (d.stats[key] || 0), 0);
  const pills = (value) =>
    value && !/^none$/i.test(value.replace(/[`.]/g, '').trim())
      ? value
          .split(/[,;]|\s+and\s+/)
          .map((v) => v.replace(/`/g, '').trim())
          .filter((v) => v && v.length < 60)
          .map((v) => `<span class="pill">${escapeHtml(v)}</span>`)
          .join('')
      : '<span class="pill">none</span>';

  const rows = numbered
    .map(
      (d) => `<tr>
<td><a href="${d.name}.html">${escapeHtml([d.labelInfo.num, d.labelInfo.label].join('  '))}</a></td>
<td>${escapeHtml(d.labelInfo.ws)}</td>
<td>${d.stats.lines.toLocaleString('en-GB')}</td>
<td>${d.stats.tasks || '·'}</td>
<td>${d.stats.acs || '·'}</td>
<td>${/^WS\d$/.test(d.labelInfo.ws) ? pills(d.stats.migrations) : '·'}</td>
<td>${/^WS\d$/.test(d.labelInfo.ws) ? pills(d.stats.flags) : '·'}</td>
<td>${escapeHtml(d.stats.dependsOn.replace(/`/g, '') || '·')}</td>
</tr>`,
    )
    .join('\n');

  const body = `<article>
<h2 id="what-this-is"><span class="num">1</span>What this set is</h2>
<p>The <a href="../field-ops-user-journey.html">user journey document</a> says <strong>what</strong> field operations should become and why. This set says <strong>how to build it</strong>: exact migrations, API contracts, file maps, component states, LLM contracts, tests, flags, commit plans and acceptance criteria, precise enough to hand to a coding agent. The <a href="../design/warroom/field-ops-setup.html">UI mockup</a> shows what it looks like, and the <a href="10-ui-spec-sheet.html">UI spec sheet</a> maps the mockup element by element.</p>
<p>Markdown is the source of truth; these pages are generated from it.</p>
<div class="stats">
<div class="stat"><b>${numbered.length}</b><span>Documents</span></div>
<div class="stat"><b>${total('lines').toLocaleString('en-GB')}</b><span>Lines</span></div>
<div class="stat"><b>${total('tasks')}</b><span>Tasks</span></div>
<div class="stat"><b>${total('acs')}</b><span>Acceptance criteria</span></div>
</div>

<h2 id="documents"><span class="num">2</span>Documents, in build order</h2>
<div class="tw docs-table"><table><thead><tr><th>Document</th><th>Stream</th><th>Lines</th><th>Tasks</th><th>ACs</th><th>Migrations</th><th>Flags</th><th>Depends on</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>

<h2 id="using-with-an-agent"><span class="num">3</span>Handing work to a coding agent</h2>
<ol>
<li>Give the agent the <a href="00-master-plan.html">master plan</a> and the one workstream spec it is building. Together they hold every name, number and contract it needs.</li>
<li>Name the task by its id (for example <code>T3.2</code>). Each task lists its files, steps, the observable done-when and the tests to add.</li>
<li>Ask for one commit per row in section 13 of the spec. Each commit has its own backtracking step.</li>
<li>Before merging, run <code>node scripts/verify-field-ops-specs.mjs</code> if a spec changed, and <code>npm test</code> plus <code>npx tsc --noEmit</code> if code changed.</li>
<li>If the work needs a name, flag, migration number or route that the spec does not allocate, stop and change the master plan first.</li>
</ol>
<p>A prompt that works as a starting point:</p>
<div class="codeblock" data-lang="prompt"><pre class="code"><code>${escapeHtml(AGENT_PROMPT)}</code></pre></div>

<h2 id="reading-the-tags"><span class="num">4</span>Reading the tags</h2>
<ul>
<li><strong class="tag tag-verified">Verified</strong> was read in the code on the baseline, with a <code>path:line</code> citation.</li>
<li><strong class="tag tag-proposed">Proposed</strong> is the design agreed in conversation and not yet built.</li>
<li><strong class="tag tag-assumed">Assumed</strong> is a default for an open decision. Hover a <abbr class="dref" title="Hover shows the decision">D-number</abbr> to read it; the owner can overrule any of them in the master plan's decision log.</li>
<li>A <span class="new">new</span> marker after a path means the file does not exist yet.</li>
</ul>
</article>`;

  const hero = `<header class="hero"><div class="in">
<div class="eyebrow">Field operations War Room</div>
<h1>Build specifications</h1>
<dl class="metagrid">
<div><dt>Status</dt><dd>${renderInline(masterMeta('status'), { decisions })}</dd></div>
<div><dt>Baseline</dt><dd>${renderInline(masterMeta('baseline'), { decisions })}</dd></div>
<div><dt>Decisions</dt><dd>${decisions.size} in the <a href="00-master-plan.html#3-decision-log">decision log</a>; ${decided} decided, ${decisions.size - decided} assumed.</dd></div>
</dl>
</div></header>`;

  return shell({
    title: 'Build specifications',
    current: 'index',
    docs,
    hero,
    body,
    rail: `<h6>On this page</h6><a class="l2" href="#what-this-is">What this set is</a><a class="l2" href="#documents">Documents</a><a class="l2" href="#using-with-an-agent">Handing work to an agent</a><a class="l2" href="#reading-the-tags">Reading the tags</a>`,
    hasMermaid: false,
    footer: `<p class="gen">Generated by <code>scripts/build-field-ops-spec-html.mjs</code>.</p>`,
  });
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function main() {
  const docs = readDocs();
  if (docs.length === 0) {
    console.error('No Markdown files found in docs/field-ops.');
    process.exit(1);
  }

  let problems = 0;
  for (const doc of docs) {
    for (const d of doc.parsed.diagnostics) {
      problems += 1;
      console.error(`${doc.name}.md: ${d.type} at line ${d.line}`);
    }
  }

  const written = [];
  docs.forEach((doc, index) => {
    const html = renderDocPage(docs, index);
    fs.writeFileSync(path.join(DIR, `${doc.name}.html`), html, 'utf8');
    written.push(doc);
  });
  fs.writeFileSync(path.join(DIR, 'index.html'), renderIndexPage(docs), 'utf8');

  const pad = (value, width) => String(value).padEnd(width);
  console.log(`${pad('document', 28)} ${pad('lines', 7)} ${pad('KB', 7)} ${pad('sections', 9)} ${pad('tasks', 6)} ACs`);
  for (const doc of written) {
    console.log(
      `${pad(doc.name, 28)} ${pad(doc.stats.lines, 7)} ${pad(doc.stats.kb, 7)} ${pad(doc.stats.sections, 9)} ${pad(doc.stats.tasks, 6)} ${doc.stats.acs}`,
    );
  }
  console.log(`\nWrote ${written.length} pages plus index.html to docs/field-ops/`);
  if (problems > 0) {
    console.error(`${problems} Markdown problem(s) found; the HTML may be incomplete.`);
    process.exit(1);
  }
}

main();
