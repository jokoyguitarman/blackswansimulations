/**
 * Renders the storyboard as a self-contained HTML page.
 *
 *   npx tsx demo-run/storyboard-html.ts
 *
 * v3 renders SEQUENCES as filmstrips rather than single frames, because the
 * film is now continuous takes of a live interface rather than stills with
 * camera moves painted on. A one-frame panel cannot tell you whether a
 * sequence feels urgent; a strip of beats with a motion tag on each one can.
 *
 * Every panel is drawn from the real set dressing and the real shot list, so
 * what gets approved here is what gets shot.
 */

import fs from 'node:fs';
import path from 'node:path';

import { EMAILS, PHOTOS, stagedByKey } from './stage.js';
import {
  ACTS,
  BEAT_COUNT,
  DESKTOP_SEQUENCES,
  HOLD_BEATS,
  LIVE_BEATS,
  SEQUENCES,
  TOTAL_SEC,
  TYPING_BEATS,
  seqSec,
  type Beat,
  type Motion,
  type Panel,
  type Sequence,
} from './storyboard.js';

const OUT_DIR = path.resolve('demo-run', 'output', 'storyboard');

/** Photos are served over HTTP at shoot time; the page needs them on disk. */
const localPhoto = (url: string): string => `../../assets/${url.split('/').pop() ?? ''}`;

/**
 * The product's own icons and wallpaper, downscaled into demo-run/assets/icons.
 *
 * Letter tiles were a placeholder and they undersold the thing — the shipped
 * app has real app icons and a real wallpaper, and the desktop is a large part
 * of what the trailer is showing off. Using the actual artwork means the
 * storyboard is judged on what will genuinely be on screen.
 */
const asset = (file: string): string => `../../assets/icons/${file}`;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const nl2br = (s: string): string => esc(s).replace(/\n/g, '<br/>');

/** Wrap the framed phrase so the page can draw the lens on it. */
function mark(body: string, highlight?: string): string {
  const safe = nl2br(body);
  if (!highlight) return safe;
  const target = nl2br(highlight);
  const at = safe.indexOf(target);
  if (at === -1) return safe;
  return safe.slice(0, at) + `<mark class="lens">${target}</mark>` + safe.slice(at + target.length);
}

const num = (n: number): string => n.toLocaleString('en-SG');
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * Person avatars stay as coloured initials, because that is genuinely what the
 * Fakebook app renders — but using its exact palette and hash, so a face in the
 * storyboard is the same colour it will be on the day.
 */
const AVATAR_COLORS = ['#1877F2', '#42B72A', '#F02849', '#FF6D00', '#8B5CF6', '#0EA5E9'];
function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function avatar(name: string, tone?: string, size = 34): string {
  const bg = tone ?? avatarColor(name);
  return `<div class="ava" style="background:${bg};width:${size}px;height:${size}px;flex:0 0 ${size}px;font-size:${Math.round(size * 0.42)}px">${esc(name.charAt(0).toUpperCase())}</div>`;
}

/** Organisations and outlets get a fixed brand tone; people get the hash. */
const toneFor = (t: string, name: string): string =>
  t === 'official_account' ? '#0B7A4B' : t === 'npc_media' ? '#C8102E' : avatarColor(name);

function fbPost(p: Extract<Panel, { kind: 'fbPost' }>): string {
  const s = stagedByKey(p.postKey);
  const c = p.counters ?? {
    views: num(s.views ?? 0),
    likes: num(s.likes ?? 0),
    shares: num(s.reposts ?? 0),
  };
  const media = (s.mediaUrls ?? [])
    .map((u) => `<img class="fb-media" src="${localPhoto(u)}" alt=""/>`)
    .join('');
  const comments = (p.comments ?? [])
    .map(
      (x) => `
      <div class="fb-comment${x.highlight ? ' framed' : ''}">
        ${avatar(x.name, x.name.startsWith('AMP') ? '#0B7A4B' : undefined, 26)}
        <div class="fb-bubble">
          <div class="fb-cname">${esc(x.name)}</div>
          <div class="fb-ctext">${nl2br(x.text)}</div>
          ${x.likes ? `<div class="fb-cmeta">👍 ${num(x.likes)}</div>` : ''}
        </div>
      </div>`,
    )
    .join('');

  return `
  <div class="fb${p.arriving ? ' arriving' : ''}">
    ${p.arriving ? '<div class="arrive-flag">NEW</div>' : ''}
    <div class="fb-head">
      ${avatar(s.displayName, toneFor(s.authorType, s.displayName))}
      <div>
        <div class="fb-name">${esc(s.displayName)}</div>
        <div class="fb-sub">${esc(s.handle)} · 12m · 🌐</div>
      </div>
    </div>
    <div class="fb-body">${mark(s.content, p.highlight)}</div>
    ${media}
    <div class="fb-stats"><span>👍❤️😡 ${c.likes}</span><span>${c.shares} shares · ${c.views} views</span></div>
    <div class="fb-bar"><div class="act">👍 Like</div><div class="act">💬 Comment</div><div class="act">↗ Share</div></div>
    ${comments ? `<div class="fb-comments">${comments}</div>` : ''}
  </div>`;
}

/** A stack of feed cards — for scroll and arrival beats. */
function fbFeed(p: Extract<Panel, { kind: 'fbFeed' }>): string {
  const cards = p.postKeys
    .map((k) => {
      const s = stagedByKey(k);
      const arriving = (p.arrivingKeys ?? []).includes(k);
      const thumb = (s.mediaUrls ?? [])[0];
      return `
      <div class="mini${arriving ? ' arriving' : ''}">
        ${arriving ? '<span class="arrive-flag">NEW</span>' : ''}
        <div class="mini-head">
          ${avatar(s.displayName, toneFor(s.authorType, s.displayName), 22)}
          <span class="mini-name">${esc(clip(s.displayName, 26))}</span>
        </div>
        <div class="mini-body">${esc(clip(s.content.replace(/\n+/g, ' '), 96))}</div>
        ${thumb ? `<img class="mini-media" src="${localPhoto(thumb)}" alt=""/>` : ''}
        <div class="mini-stats">👍 ${num(s.likes ?? 0)} · ${num(s.reposts ?? 0)} shares</div>
      </div>`;
    })
    .join('');
  return `<div class="feed${p.calm ? ' calm' : ''}">${cards}</div>`;
}

function fbCompose(p: Extract<Panel, { kind: 'fbCompose' }>): string {
  const typed = p.typedChars ?? p.text.length;
  return `
  <div class="fb compose">
    <div class="cmp-head"><span class="cmp-cancel">Cancel</span><span class="cmp-title">Create post</span><span class="cmp-post">Post</span></div>
    ${
      p.asPage
        ? `<div class="cmp-as"><span class="cmp-as-label">Posting as:</span><span class="chip">You</span><span class="chip on">✓ ${esc(clip(p.pageName ?? 'Page', 34))}</span></div>`
        : ''
    }
    <div class="cmp-body">
      ${avatar(p.asPage ? (p.pageName ?? 'A') : p.author, p.asPage ? '#0B7A4B' : '#1877F2', 30)}
      <div class="cmp-text"><span class="typed">${esc(p.text.slice(0, typed))}</span><span class="caret"></span><span class="untyped">${esc(p.text.slice(typed))}</span></div>
    </div>
    ${p.attachment ? `<img class="cmp-attach" src="${localPhoto(p.attachment)}" alt=""/>` : ''}
    <div class="cmp-foot"><span>🖼</span><span>🎬</span><span>😊</span></div>
  </div>`;
}

function dmPanel(p: Extract<Panel, { kind: 'dm' }>): string {
  const msgs = p.messages
    .map(
      (m) => `
      <div class="dm-msg${m.me ? ' me' : ''}${p.arriving ? ' arriving' : ''}">
        <div class="dm-bub">${esc(m.text)}</div>
      </div>`,
    )
    .join('');
  const shared = p.sharedPost
    ? `<div class="dm-shared${p.arriving ? ' arriving' : ''}">
         <div class="dm-shared-tag">SHARED POST</div>
         <div class="dm-shared-author">${esc(p.sharedPost.author)}</div>
         <div class="dm-shared-prev">${esc(p.sharedPost.preview)}</div>
       </div>`
    : '';
  return `
  <div class="dm">
    <div class="dm-head">${avatar(p.from, undefined, 26)}<span>${esc(p.from)}</span></div>
    <div class="dm-body">
      ${msgs || '<div class="dm-empty">No messages yet</div>'}
      ${shared}
    </div>
    <div class="dm-input">Type a message…</div>
  </div>`;
}

function newsPanel(p: Extract<Panel, { kind: 'news' }>): string {
  return `
  <div class="news">
    <div class="news-mast">${esc(p.outlet)}</div>
    <div class="news-tag">BREAKING</div>
    <h1 class="news-h1">${mark(p.headline, p.highlight)}</h1>
    <div class="news-sub">${esc(p.sub)}</div>
    <div class="news-body">${esc(p.body)}</div>
  </div>`;
}

const READ_CURSOR = `<div class="readpath"><i></i><span>guided read</span></div>`;

function emailList(p: Extract<Panel, { kind: 'emailList' }>): string {
  const rows = EMAILS.map(
    (e, i) => `
    <div class="mail-row${e.key === p.focusKey ? ' framed' : ''}${p.arriving && i === 0 ? ' arriving' : ''}">
      ${p.arriving && i === 0 ? '<span class="arrive-flag">NEW</span>' : ''}
      <span class="dot"></span>
      <div class="mail-meta">
        <div class="mail-from">${esc(clip(e.fromName, 30))}</div>
        <div class="mail-subj">${esc(e.subject)}</div>
      </div>
      <span class="pri ${e.priority}">${e.priority.toUpperCase()}</span>
    </div>`,
  ).join('');
  return `<div class="mail"><div class="mail-head">Inbox · 3 unread</div>${rows}${p.arriving ? '' : READ_CURSOR}</div>`;
}

function emailRead(p: Extract<Panel, { kind: 'emailRead' }>): string {
  const e = EMAILS.find((x) => x.key === p.emailKey);
  if (!e) return '<div class="mail">missing email</div>';
  return `
  <div class="mail">
    <div class="mail-head">${esc(clip(e.subject, 54))}</div>
    <div class="mail-from-line">${esc(e.fromName)}</div>
    <div class="mail-body">${mark(e.body, p.highlight)}</div>
    ${p.highlight ? READ_CURSOR : ''}
  </div>`;
}

function emailReply(p: Extract<Panel, { kind: 'emailReply' }>): string {
  const typed = p.typedChars ?? p.text.length;
  return `
  <div class="mail">
    <div class="mail-head">${esc(clip(p.subject, 54))}</div>
    <div class="mail-from-line">To: ${esc(p.to)}</div>
    <div class="mail-body"><span class="typed">${nl2br(p.text.slice(0, typed))}</span><span class="caret"></span><span class="untyped">${nl2br(p.text.slice(typed))}</span></div>
    <div class="mail-send">Send</div>
  </div>`;
}

function chatPanel(p: Extract<Panel, { kind: 'chat' }>): string {
  const cycle = (p.messages.length + 1) * 1.1;
  const msgs = p.messages
    .map(
      (m, i) => `
    <div class="msg ${m.me ? 'me' : ''}${m.highlight ? ' framed' : ''}${p.live ? ' live' : ''}"
         style="${p.live ? `animation-delay:${(i * 1.1).toFixed(2)}s;animation-duration:${cycle.toFixed(2)}s` : ''}">
      <div class="msg-from">${esc(m.from)}</div>
      <div class="msg-bub">${esc(m.text)}</div>
    </div>`,
    )
    .join('');
  return `<div class="chat"><div class="chat-head"><span>${esc(p.channel)}</span>${p.live ? '<span class="live-tag">LIVE</span>' : ''}</div>${msgs}</div>`;
}

function dashboard(p: Extract<Panel, { kind: 'dashboard' }>): string {
  const gauge = (label: string, val: number, invert = false): string => {
    const good = invert ? val < 40 : val > 60;
    const mid = invert ? val < 65 : val > 40;
    const tone = good ? '#22C55E' : mid ? '#F59E0B' : '#EF4444';
    return `<div class="g"><div class="g-lab">${esc(label)}</div><div class="g-val" style="color:${tone}">${val}%</div><div class="g-track"><div class="g-fill" style="width:${val}%;background:${tone}"></div></div></div>`;
  };
  const spark =
    p.trend === 'falling'
      ? 'M0,10 L30,16 L60,30 L90,52 L120,64 L150,72'
      : p.trend === 'rising'
        ? 'M0,72 L30,66 L60,54 L90,34 L120,22 L150,16'
        : 'M0,26 L30,24 L60,27 L90,25 L120,26 L150,24';
  const tone = p.trend === 'rising' ? '#22C55E' : p.trend === 'falling' ? '#EF4444' : '#64748B';
  return `
  <div class="dash">
    <div class="dash-head"><span>Amanah Under Fire — Live</span><span class="dash-clock">T+11:42</span></div>
    <div class="gauges">
      ${gauge('Public Trust', p.trust)}${gauge('Comm. Safety', p.safety)}
      ${gauge('Narrative', p.narrative)}${gauge('Escalation', p.risk, true)}
    </div>
    <svg class="spark" viewBox="0 0 150 80" preserveAspectRatio="none"><path d="${spark}" fill="none" stroke="${tone}" stroke-width="3"/></svg>
    ${p.alert ? `<div class="dash-alert">${esc(p.alert)}</div>` : ''}
  </div>`;
}

function mosaic(p: Extract<Panel, { kind: 'mosaic' }>): string {
  return `<div class="mosaic">${Array.from({ length: p.tiles }, (_, i) => `<div class="tile t${i % 5}"></div>`).join('')}</div>`;
}

/**
 * Title cards in the brand's own language rather than invented for the trailer.
 *
 * The website's signature treatment is a JetBrains Mono, uppercase,
 * 0.18em-tracked amber kicker sitting above an Inter extrabold heading on deep
 * navy — it appears above nearly every section on the marketing site, so using
 * it here makes the trailer and the landing page read as one piece of work.
 */
function cardPanel(p: Extract<Panel, { kind: 'card' }>): string {
  return `
  <div class="endcard${p.light ? ' light' : ''}">
    ${p.logo ? `<div class="ec-logo"><img src="${asset('prophyion-mark.png')}" alt="Prophyion"/></div>` : ''}
    ${p.kicker ? `<div class="ec-kicker">${esc(p.kicker)}</div>` : ''}
    ${p.lines.map((l, i) => `<div class="ec-line" style="animation-delay:${(0.25 + i * 0.28).toFixed(2)}s">${esc(l)}</div>`).join('')}
    ${p.sub ? `<div class="ec-sub">${esc(p.sub)}</div>` : ''}
  </div>`;
}

/**
 * The desktop shell's real app registry, in its real order, with the real icon
 * artwork. Mirrors APP_REGISTRY in DesktopShell.tsx — including that the sixth
 * app is Docs rather than Drafts, which the earlier mock got wrong.
 */
const DESK_APPS: [string, string, string][] = [
  ['social', 'Z', 'icon-social.png'],
  ['facebook', 'Fakebook', 'icon-facebook.png'],
  ['email', 'Mail', 'icon-mail.png'],
  ['news', 'News', 'icon-news.png'],
  ['chat', 'TeamChat', 'icon-chat.png'],
  ['docs', 'Docs', 'icon-docs.svg'],
];

const deskIcon = (id: string): string =>
  asset(DESK_APPS.find(([i]) => i === id)?.[2] ?? 'icon-facebook.png');

/**
 * The windowed desktop.
 *
 * Drawn because the environment is a large part of what is being sold — a
 * taskbar, real windows and a wallpaper say "this is somebody's working day"
 * far faster than any amount of feed content can.
 */
function desktopPanel(p: Extract<Panel, { kind: 'desktop' }>): string {
  const open = p.open ?? [];
  const minimised = p.minimised ?? [];

  const icons = DESK_APPS.map(
    ([id, label, file]) => `
      <div class="dk-icon${p.launching === id ? ' launching' : ''}">
        <div class="dk-tile"><img src="${asset(file)}" alt="${esc(label)}"/></div>
        <span>${esc(label)}</span>
        ${p.launching === id ? '<i class="dk-arrow"></i>' : ''}
      </div>`,
  ).join('');

  const front = open[open.length - 1];
  const win = front
    ? `<div class="dk-win">
         <div class="dk-titlebar">
           <span class="dk-tb-left"><img src="${deskIcon(front)}" alt=""/></span>
           <span class="dk-tb-title">${esc(p.windowTitle ?? front)}</span>
           <span class="dk-tb-btns"><i class="min"></i><i class="max"></i><i class="close"></i></span>
         </div>
         <div class="dk-winbody">${p.inWindow ? renderPanel(p.inWindow) : ''}</div>
       </div>`
    : '';

  const taskbar = DESK_APPS.map(([id, label, file]) => {
    const isOpen = open.includes(id);
    const isMin = minimised.includes(id);
    if (!isOpen && !isMin) return '';
    return `<span class="dk-task${isOpen ? ' open' : ''}${isMin ? ' min' : ''}">
              <img src="${asset(file)}" alt=""/>${esc(label)}
            </span>`;
  }).join('');

  return `
  <div class="desk">
    <div class="dk-icons">${icons}</div>
    ${win}
    <div class="dk-taskbar">${taskbar}<span class="dk-clock">15:42</span></div>
  </div>`;
}

function reportModal(p: Extract<Panel, { kind: 'reportModal' }>): string {
  const opts: [string, string][] = [
    ['hate_speech', 'Hate speech'],
    ['incitement_to_violence', 'Incitement to violence'],
    ['misinformation', 'Misinformation'],
    ['organized_harassment', 'Organized harassment'],
    ['harmful_narrative', 'Harmful narrative'],
    ['other', 'Something else'],
  ];
  const typed = p.typedChars ?? p.reason.length;
  return `
  <div class="sheet">
    <div class="sheet-head">Report this post</div>
    <div class="sheet-sub">Why are you reporting this?</div>
    ${opts
      .map(
        ([v, l]) =>
          `<div class="opt${p.category === v ? ' on' : ''}">${esc(l)}${p.category === v ? '<b>✓</b>' : ''}</div>`,
      )
      .join('')}
    <div class="sheet-sub">Add details</div>
    <div class="sheet-text">
      <span class="typed">${esc(p.reason.slice(0, typed))}</span><span class="caret"></span><span class="untyped">${esc(p.reason.slice(typed))}</span>
    </div>
    <div class="sheet-btn">Submit report</div>
  </div>`;
}

function disputeModal(p: Extract<Panel, { kind: 'disputeModal' }>): string {
  const typed = p.typedChars ?? p.note.length;
  return `
  <div class="sheet">
    <div class="sheet-head">${esc(p.heading)}</div>
    <div class="sheet-sub">Identify the false claim and cite verified facts</div>
    <div class="sheet-text tall">
      <span class="typed">${esc(p.note.slice(0, typed))}</span><span class="caret"></span><span class="untyped">${esc(p.note.slice(typed))}</span>
    </div>
    ${p.status ? `<div class="sheet-ok">${esc(p.status)}</div>` : '<div class="sheet-btn">Submit report</div>'}
  </div>`;
}

function retracted(p: Extract<Panel, { kind: 'retracted' }>): string {
  return `
  <div class="news">
    <div class="news-mast">The Independent Ledger</div>
    <div class="retract-banner">
      <b>This article has been retracted</b>
      <span>${esc(p.note)}</span>
    </div>
    <h1 class="news-h1 struck">${esc(p.headline)}</h1>
    <div class="news-body">Families who rely on AMP assistance say they have been left in the dark…</div>
  </div>`;
}

function renderPanel(panel: Panel): string {
  switch (panel.kind) {
    case 'desktop':
      return desktopPanel(panel);
    case 'reportModal':
      return reportModal(panel);
    case 'disputeModal':
      return disputeModal(panel);
    case 'retracted':
      return retracted(panel);
    case 'fbPost':
      return fbPost(panel);
    case 'fbFeed':
      return fbFeed(panel);
    case 'fbCompose':
      return fbCompose(panel);
    case 'dm':
      return dmPanel(panel);
    case 'news':
      return newsPanel(panel);
    case 'emailList':
      return emailList(panel);
    case 'emailRead':
      return emailRead(panel);
    case 'emailReply':
      return emailReply(panel);
    case 'chat':
      return chatPanel(panel);
    case 'dashboard':
      return dashboard(panel);
    case 'mosaic':
      return mosaic(panel);
    case 'card':
      return cardPanel(panel);
  }
}

// ---------------------------------------------------------------------------

const MOTION: Record<Motion, { glyph: string; label: string; tone: string }> = {
  scroll: { glyph: '↕', label: 'scroll', tone: '#60A5FA' },
  arrive: { glyph: '⤓', label: 'arrives live', tone: '#F0B429' },
  type: { glyph: '⌨', label: 'live typing', tone: '#34D399' },
  navigate: { glyph: '⇥', label: 'app transition', tone: '#A78BFA' },
  count: { glyph: '⇡', label: 'counters move', tone: '#FB923C' },
  cursor: { glyph: '➜', label: 'guided cursor', tone: '#22D3EE' },
  press: { glyph: '⊙', label: 'control pressed', tone: '#F472B6' },
  react: { glyph: '✷', label: 'UI responds', tone: '#C084FC' },
  hold: { glyph: '▣', label: 'still — earned', tone: '#94A3B8' },
};

function beatCard(b: Beat, i: number): string {
  const m = MOTION[b.motion];
  return `
  <div class="beat">
    <div class="beat-top">
      <span class="beat-i">${i + 1}</span>
      <span class="motion" style="--tone:${m.tone}">${m.glyph} ${esc(m.label)}</span>
      <span class="beat-sec">${b.sec}s</span>
    </div>
    <div class="beat-frame">${renderPanel(b.panel)}</div>
    <div class="beat-label">${esc(b.label)}</div>
    <p class="beat-what">${esc(b.what)}</p>
    ${b.how ? `<p class="beat-how">${esc(b.how)}</p>` : ''}
  </div>`;
}

function sequenceBlock(s: Sequence): string {
  const start = SEQUENCES.slice(0, s.n - 1).reduce((t, x) => t + seqSec(x), 0);
  const tc = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(Math.round(start % 60)).padStart(2, '0')}`;
  return `
  <section class="seq" id="seq-${s.n}">
    <header class="seq-head">
      <div class="seq-id">
        <span class="seq-n">SEQ ${String(s.n).padStart(2, '0')}</span>
        <span class="seq-tc">${tc}</span>
      </div>
      <div class="seq-title">
        <h3>${esc(s.title)}</h3>
        <div class="seq-screen">${s.screen ? esc(s.screen) : 'Graphic'} · ${esc(s.app)} · <span class="shell-tag">${s.shell}</span> · ${seqSec(s)}s continuous</div>
      </div>
      <div class="seq-purpose">${esc(s.purpose)}</div>
    </header>
    ${s.audio ? `<div class="seq-audio">♪ ${esc(s.audio)}</div>` : ''}
    <div class="strip">${s.beats.map(beatCard).join('<div class="arrow">›</div>')}</div>
  </section>`;
}

function actSection(actN: number): string {
  const act = ACTS.find((a) => a.n === actN)!;
  const seqs = SEQUENCES.filter((s) => s.act === actN);
  const dur = seqs.reduce((t, s) => t + seqSec(s), 0);
  return `
  <section class="act">
    <header class="act-head">
      <span class="act-n">ACT ${act.n}</span>
      <h2>${esc(act.title)}</h2>
      <p>${esc(act.note)}</p>
      <span class="act-dur">${seqs.length} sequences · ${dur}s</span>
    </header>
    ${seqs.map(sequenceBlock).join('')}
  </section>`;
}

const CSS = `
:root{--bg:#0B0D10;--panel:#14181E;--line:#232A33;--ink:#E8ECF1;--dim:#8A97A6;
  --accent:#F0B429;--blue:#1877F2;--fbbg:#F0F2F5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 "Inter",-apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1500px;margin:0 auto;padding:56px 28px 140px}

.masthead{border-bottom:1px solid var(--line);padding-bottom:26px}
.masthead .kicker{letter-spacing:.22em;font-size:11px;color:var(--accent);font-weight:700}
.masthead h1{font-size:42px;line-height:1.08;margin:12px 0 8px;letter-spacing:-.02em}
.masthead .sub{color:var(--dim);max-width:74ch}
.stats{display:flex;gap:30px;margin-top:22px;flex-wrap:wrap}
.stats div{font-size:13px;color:var(--dim)}
.stats b{display:block;font-size:22px;color:var(--ink);font-weight:650}

.spine{margin:30px 0 6px;padding:20px 24px;border-left:3px solid var(--accent);
  background:#12161C;border-radius:0 8px 8px 0}
.spine h3{margin:0 0 8px;font-size:12px;letter-spacing:.14em;color:var(--accent)}
.spine p{margin:0 0 10px;color:#C7D0DA;max-width:88ch}
.spine p:last-child{margin-bottom:0}
.spine em{color:var(--ink);font-style:normal;font-weight:600}

.legend{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0 0;padding:16px 20px;
  background:#101419;border:1px solid var(--line);border-radius:8px}
.legend .lg-t{width:100%;font-size:11px;letter-spacing:.14em;color:var(--dim);margin-bottom:4px}

.act{margin-top:56px}
.act-head{display:grid;grid-template-columns:auto 1fr auto;gap:4px 16px;align-items:baseline;
  padding-bottom:14px;border-bottom:1px solid var(--line)}
.act-n{font-size:11px;letter-spacing:.2em;color:var(--accent);font-weight:700}
.act-head h2{margin:0;font-size:26px;letter-spacing:-.01em}
.act-head p{grid-column:2;margin:0;color:var(--dim);font-size:14px}
.act-dur{grid-row:1;grid-column:3;font-size:12px;color:var(--dim)}

.seq{margin-top:30px;padding:20px 0 6px;border-bottom:1px solid #161B21}
.seq-head{display:grid;grid-template-columns:92px minmax(220px,1fr) 2fr;gap:20px;align-items:start}
.seq-n{display:block;font-size:13px;font-weight:800;color:var(--accent);letter-spacing:.08em}
.seq-tc{display:block;font-size:11px;color:var(--dim);margin-top:4px;font-variant-numeric:tabular-nums}
.seq-title h3{margin:0;font-size:21px;letter-spacing:-.01em}
.seq-screen{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-top:5px}
.shell-tag{color:#A78BFA;font-weight:700}
.seq-purpose{color:#B8C3CF;font-size:14px;line-height:1.6}
.seq-audio{margin:12px 0 0 112px;font-size:12.5px;color:#9FD8C0}

.strip{display:flex;gap:0;align-items:flex-start;margin-top:16px;overflow-x:auto;
  padding:4px 2px 14px}
.arrow{flex:0 0 26px;text-align:center;color:#3A4552;font-size:24px;padding-top:120px;user-select:none}
.beat{flex:0 0 292px;min-width:292px}
.beat-top{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.beat-i{width:19px;height:19px;border-radius:50%;background:#232A33;color:#9AA7B5;
  font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
.motion{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  color:var(--tone);border:1px solid color-mix(in srgb,var(--tone) 45%,transparent);
  background:color-mix(in srgb,var(--tone) 12%,transparent);padding:2px 7px;border-radius:3px}
.beat-sec{margin-left:auto;font-size:11px;color:var(--dim)}
.beat-frame{background:var(--fbbg);border:1px solid var(--line);border-radius:9px;
  padding:10px;height:250px;overflow:hidden;display:flex;align-items:flex-start;justify-content:center}
.beat-frame > *{zoom:.60}
.beat-label{margin-top:9px;font-size:13.5px;font-weight:650;color:#EDF1F6}
.beat-what{margin:4px 0 0;font-size:12.5px;line-height:1.5;color:#9FADBC}
.beat-how{margin:6px 0 0;font-size:11.5px;line-height:1.45;color:#6E7C8B;font-style:italic}

/* --- Fakebook --- */
.fb{width:410px;background:#fff;border:1px solid #CED0D4;border-radius:8px;overflow:hidden;
  font:14px/1.4 "Segoe UI",Helvetica,Arial,sans-serif;color:#050505;position:relative}
.ava{border-radius:50%;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center}
.fb-head{display:flex;gap:9px;align-items:center;padding:10px 12px 6px}
.fb-name{font-weight:650;font-size:14px}
.fb-sub{font-size:11.5px;color:#65676B}
.fb-body{padding:2px 12px 9px;font-size:14px;line-height:1.42}
.fb-media{display:block;width:100%;max-height:190px;object-fit:cover}
.fb-stats{display:flex;justify-content:space-between;padding:7px 12px;font-size:11.5px;color:#65676B}
.fb-bar{display:flex;border-top:1px solid #CED0D4;padding:1px 6px}
.fb-bar .act{flex:1;text-align:center;padding:6px 0;font-size:12.5px;font-weight:600;color:#65676B}
.fb-comments{border-top:1px solid #E4E6EB;padding:8px 12px 11px}
.fb-comment{display:flex;gap:7px;margin-bottom:8px}
.fb-bubble{background:#F0F2F5;border-radius:15px;padding:6px 11px;max-width:320px}
.fb-cname{font-weight:650;font-size:12px}
.fb-ctext{font-size:13px;line-height:1.38}
.fb-cmeta{font-size:10.5px;color:#65676B;margin-top:2px}
.fb-comment.framed .fb-bubble{background:#FFF6E0;box-shadow:0 0 0 2px var(--accent)}

/* arrival treatment */
.arriving{box-shadow:0 0 0 2px var(--accent),0 6px 18px rgba(240,180,41,.18);
  animation:drop 2.6s cubic-bezier(.2,.9,.3,1.15) infinite}
@keyframes drop{0%,6%{opacity:0;transform:translateY(-14px)}14%,88%{opacity:1;transform:none}97%,100%{opacity:1}}
.arrive-flag{position:absolute;top:6px;right:6px;z-index:4;background:var(--accent);color:#0B0D10;
  font-size:8.5px;font-weight:800;letter-spacing:.1em;padding:2px 6px;border-radius:3px}

/* feed stack */
.feed{width:410px;display:flex;flex-direction:column;gap:7px}
.mini{background:#fff;border:1px solid #CED0D4;border-radius:7px;padding:8px 10px;position:relative}
.feed.calm .mini{opacity:.95}
.mini-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.mini-name{font-size:12.5px;font-weight:650;color:#050505}
.mini-body{font-size:12px;line-height:1.4;color:#1C1E21}
.mini-media{display:block;width:100%;height:74px;object-fit:cover;border-radius:4px;margin-top:6px}
.mini-stats{font-size:10.5px;color:#65676B;margin-top:5px}

/* composer */
.compose{width:410px}
.cmp-head{display:flex;justify-content:space-between;align-items:center;padding:10px 13px;
  border-bottom:1px solid #DADDE1;font-size:13.5px}
.cmp-cancel{color:#65676B;font-weight:600}
.cmp-title{font-weight:700;font-size:15px}
.cmp-post{background:#1877F2;color:#fff;font-weight:700;padding:4px 14px;border-radius:6px;font-size:12.5px}
.cmp-as{display:flex;gap:6px;align-items:center;padding:7px 13px;background:#F0F2F5;
  border-bottom:1px solid #E4E6EB;font-size:11.5px}
.cmp-as-label{color:#65676B}
.chip{padding:3px 9px;border-radius:14px;border:1px solid #CED0D4;color:#65676B;font-weight:650}
.chip.on{background:#E7F3FF;border-color:#1877F2;color:#1877F2}
.cmp-body{display:flex;gap:9px;padding:11px 13px}
.cmp-text{font-size:14px;line-height:1.5;min-height:92px}
.typed{color:#050505}.untyped{color:#BCC0C4}
.caret{display:inline-block;width:2px;height:15px;background:#1877F2;vertical-align:-3px;
  animation:blink .9s steps(1) infinite;margin:0 1px}
@keyframes blink{50%{opacity:0}}
.cmp-attach{display:block;width:calc(100% - 26px);margin:0 13px 9px;border-radius:7px;
  max-height:108px;object-fit:cover;border:1px solid #DADDE1}
.cmp-foot{display:flex;gap:15px;padding:8px 13px;border-top:1px solid #DADDE1;font-size:16px}

/* DM */
.dm{width:410px;background:#fff;border:1px solid #CED0D4;border-radius:8px;overflow:hidden;
  font:13px/1.45 "Segoe UI",Helvetica,sans-serif;color:#050505}
.dm-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #E4E6EB;
  font-weight:650;font-size:13.5px}
.dm-body{padding:12px;min-height:120px;display:flex;flex-direction:column;gap:8px}
.dm-empty{color:#8A94A0;font-size:12px;text-align:center;padding:28px 0}
.dm-msg{max-width:80%}
.dm-msg.me{align-self:flex-end}
.dm-bub{background:#F0F2F5;border-radius:15px;padding:8px 12px;font-size:13.5px}
.dm-msg.me .dm-bub{background:#1877F2;color:#fff}
.dm-shared{border:1px solid #CED0D4;border-radius:8px;overflow:hidden;position:relative}
.dm-shared-tag{background:#F0F2F5;font-size:8.5px;letter-spacing:.1em;font-weight:800;
  color:#65676B;padding:3px 9px}
.dm-shared-author{font-weight:650;font-size:12.5px;padding:7px 9px 0}
.dm-shared-prev{font-size:12px;color:#65676B;padding:2px 9px 9px;line-height:1.4}
.dm-input{padding:9px 12px;border-top:1px solid #E4E6EB;color:#8A94A0;font-size:12.5px;
  background:#F7F8FA}

/* News */
.news{width:410px;background:#fff;border-radius:8px;padding:15px 17px 16px;color:#111;
  font-family:Georgia,"Times New Roman",serif;border:1px solid #DADDE1}
.news-mast{font-family:"Segoe UI",sans-serif;font-weight:800;letter-spacing:.14em;
  font-size:10.5px;color:#C8102E;border-bottom:2px solid #C8102E;padding-bottom:6px}
.news-tag{display:inline-block;background:#C8102E;color:#fff;font-family:"Segoe UI",sans-serif;
  font-size:9px;font-weight:800;letter-spacing:.12em;padding:3px 7px;border-radius:3px;margin:11px 0 7px}
.news-h1{font-size:23px;line-height:1.2;margin:0 0 8px}
.news-sub{font-size:13px;color:#444;line-height:1.45;margin-bottom:10px}
.news-body{font-size:12.5px;color:#555;line-height:1.6}

/* Email */
.mail{width:410px;background:#fff;border:1px solid #DADDE1;border-radius:8px;overflow:hidden;
  font:13px/1.5 "Segoe UI",Helvetica,sans-serif;color:#1F2328;position:relative}
.mail-head{background:#F6F8FA;padding:9px 13px;font-weight:700;font-size:13px;border-bottom:1px solid #DADDE1}
.mail-row{display:flex;gap:9px;align-items:center;padding:9px 13px;border-bottom:1px solid #EEF0F2;position:relative}
.mail-row.framed{background:#FFF6E0;box-shadow:inset 0 0 0 2px var(--accent)}
.dot{width:8px;height:8px;border-radius:50%;background:#1877F2;flex:0 0 8px}
.mail-meta{flex:1;min-width:0}
.mail-from{font-weight:650;font-size:12px}
.mail-subj{font-size:11.5px;color:#57606A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pri{font-size:8.5px;font-weight:800;letter-spacing:.07em;padding:2px 6px;border-radius:3px}
.pri.urgent{background:#FDECEA;color:#C0271A}
.pri.high{background:#FFF3E0;color:#B45309}
.pri.normal{background:#EEF0F2;color:#57606A}
.mail-from-line{padding:7px 13px;font-size:11.5px;color:#57606A;border-bottom:1px solid #EEF0F2}
.mail-body{padding:11px 13px;font-size:12px;line-height:1.62;max-height:170px;overflow:hidden}
.mail-send{margin:0 13px 11px;display:inline-block;background:#1877F2;color:#fff;font-weight:700;
  padding:5px 16px;border-radius:6px;font-size:12px}
.readpath{position:absolute;inset:0;pointer-events:none}
.readpath i{position:absolute;width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.9);
  box-shadow:0 0 0 1px rgba(0,0,0,.38),0 1px 5px rgba(0,0,0,.4);
  animation:read 4.6s cubic-bezier(.4,.1,.3,1) infinite}
.readpath span{position:absolute;right:6px;top:6px;font-size:8px;letter-spacing:.1em;
  text-transform:uppercase;color:#fff;background:rgba(0,0,0,.45);padding:2px 5px;border-radius:3px}
@keyframes read{0%{top:20%;left:11%;opacity:0}7%{opacity:.95}30%{top:40%;left:27%}
  56%{top:58%;left:20%}82%{top:76%;left:31%;opacity:.95}100%{top:79%;left:31%;opacity:0}}

/* Chat */
.chat{width:410px;background:#11151B;border:1px solid #232A33;border-radius:8px;padding:11px;
  font:13px/1.5 "Segoe UI",Helvetica,sans-serif}
.chat-head{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#7C8899;
  padding-bottom:8px;border-bottom:1px solid #232A33;margin-bottom:9px;
  display:flex;justify-content:space-between;align-items:center}
.live-tag{font-size:8.5px;letter-spacing:.1em;color:#0B0D10;background:var(--accent);
  padding:2px 6px;border-radius:3px;font-weight:800}
.msg{margin-bottom:8px;max-width:84%}
.msg.me{margin-left:auto;text-align:right}
.msg-from{font-size:10px;color:#6B7787;margin-bottom:2px}
.msg-bub{display:inline-block;background:#1C232C;color:#DDE4EC;padding:6px 10px;border-radius:11px;
  text-align:left;font-size:12.5px}
.msg.me .msg-bub{background:#1E4B8F;color:#EAF2FF}
.msg.framed .msg-bub{box-shadow:0 0 0 2px var(--accent);background:#2A2416;color:#FFE9B8}
.msg.live{animation-name:pop;animation-timing-function:cubic-bezier(.2,.9,.3,1.2);
  animation-iteration-count:infinite;animation-fill-mode:both}
@keyframes pop{0%,4%{opacity:0;transform:translateY(9px) scale(.97)}
  9%,86%{opacity:1;transform:none}96%,100%{opacity:0;transform:translateY(-4px)}}

/* Dashboard */
.dash{width:430px;background:#0E1116;border:1px solid #232A33;border-radius:8px;padding:13px;
  font:13px/1.4 "Inter","Segoe UI",sans-serif}
.dash-head{display:flex;justify-content:space-between;font-size:10.5px;letter-spacing:.1em;
  text-transform:uppercase;color:#7C8899;padding-bottom:10px;border-bottom:1px solid #232A33}
.dash-clock{color:var(--accent);font-variant-numeric:tabular-nums}
.gauges{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0}
.g-lab{font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:#6B7787;margin-bottom:4px}
.g-val{font-size:20px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.g-track{height:4px;background:#1C232C;border-radius:2px;margin-top:6px;overflow:hidden}
.g-fill{height:100%;border-radius:2px}
.spark{width:100%;height:58px;display:block;margin-top:4px}
.dash-alert{margin-top:8px;background:#2A1618;border:1px solid #5B2126;color:#FF8A8A;
  font-size:10px;font-weight:800;letter-spacing:.08em;padding:6px 10px;border-radius:5px}

/* Mosaic + cards */
.mosaic{width:410px;display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.tile{aspect-ratio:16/10;border-radius:3px;background:#1A2230}
.tile.t0{background:#16202D}.tile.t1{background:#1D2A3A}.tile.t2{background:#132030}
.tile.t3{background:#22303F}.tile.t4{background:#1A2735}
/* Brand title cards: deep navy #0E1A2B, amber #D97706 mono kicker,
   Inter extrabold tracking-tight. Matches the marketing site exactly. */
.endcard{width:410px;height:210px;background:#0E1A2B;display:flex;flex-direction:column;
  align-items:center;justify-content:center;border-radius:8px;gap:2px;position:relative;
  overflow:hidden;font-family:"Inter",-apple-system,"Segoe UI",sans-serif}
.endcard::before{content:'';position:absolute;inset:0;
  background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);
  background-size:32px 32px}
.endcard::after{content:'';position:absolute;top:-40%;left:50%;width:70%;height:80%;
  transform:translateX(-50%);
  background:radial-gradient(ellipse at center,rgba(217,119,6,.16),transparent 70%)}
.endcard.light{background:#FAF8F4}
.endcard.light .ec-line{color:#172033}
.endcard.light .ec-sub{color:#6B7280}
.ec-kicker{position:relative;z-index:2;font-family:"JetBrains Mono",monospace;font-size:10px;
  text-transform:uppercase;letter-spacing:.18em;color:#D97706;font-weight:600;margin-bottom:10px;
  animation:cardIn .5s ease-out both}
.ec-line{position:relative;z-index:2;font-size:29px;font-weight:800;letter-spacing:-.022em;
  color:#FFFFFF;line-height:1.12;animation:cardIn .55s cubic-bezier(.2,.8,.3,1) both}
.ec-sub{position:relative;z-index:2;font-size:11.5px;color:rgba(255,255,255,.55);margin-top:12px;
  max-width:290px;text-align:center;line-height:1.55;animation:cardIn .6s ease-out .9s both}
/* The swan mark sits on a white disc, exactly as .brand-mark does on the site,
   so it stays legible against the deep navy. */
.ec-logo{position:relative;z-index:2;width:42px;height:42px;border-radius:9999px;background:#fff;
  display:flex;align-items:center;justify-content:center;margin-bottom:12px;
  animation:cardIn .5s ease-out both}
.ec-logo img{width:30px;height:30px;object-fit:contain;display:block}
@keyframes cardIn{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}

/* --- Desktop shell --- */
.desk{width:430px;height:264px;position:relative;border-radius:8px;overflow:hidden;
  background:#0e1a2b url("../../assets/icons/wallpaper.jpg") center/cover no-repeat;
  font:12px/1.4 "Segoe UI",Helvetica,sans-serif}
.dk-icons{position:absolute;top:10px;left:10px;display:grid;grid-template-columns:repeat(2,52px);
  gap:6px 10px;z-index:1}
.dk-icon{display:flex;flex-direction:column;align-items:center;gap:3px;position:relative}
.dk-tile{width:32px;height:32px;border-radius:8px;overflow:hidden;
  background:rgba(30,30,30,.55);backdrop-filter:blur(6px);
  box-shadow:0 2px 6px rgba(0,0,0,.45)}
.dk-tile img{width:100%;height:100%;object-fit:cover;display:block}
.dk-icon span{font-size:8.5px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9);text-align:center}
.dk-icon.launching .dk-tile{box-shadow:0 0 0 2px #F0B429,0 2px 10px rgba(240,180,41,.5);
  animation:dkPulse 1.6s ease-in-out infinite}
@keyframes dkPulse{50%{transform:scale(1.08)}}
.dk-arrow{position:absolute;left:26px;top:20px;width:12px;height:15px;
  background:#fff;clip-path:polygon(0 0,0 78%,26% 60%,46% 100%,62% 92%,44% 56%,74% 54%);
  filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));animation:dkNudge 1.6s ease-in-out infinite}
@keyframes dkNudge{50%{transform:translate(2px,2px)}}
.dk-win{position:absolute;left:74px;top:16px;right:12px;bottom:34px;border-radius:7px;
  overflow:hidden;background:#1C1C1E;box-shadow:0 12px 34px rgba(0,0,0,.55);z-index:2;
  animation:winOpen .45s cubic-bezier(.2,.9,.3,1.05) both}
@keyframes winOpen{from{opacity:0;transform:scale(.93)}to{opacity:1;transform:none}}
.dk-titlebar{height:22px;background:#2C2C2E;display:flex;align-items:center;
  justify-content:space-between;padding:0 7px;gap:6px}
.dk-tb-left{display:flex;align-items:center}
.dk-tb-left img{width:11px;height:11px;border-radius:2px;display:block}
.dk-tb-title{font-size:9.5px;color:#D8DCE2;font-weight:600;flex:1;text-align:center}
.dk-tb-btns{display:flex;gap:4px}
.dk-tb-btns i{width:7px;height:7px;border-radius:50%;display:block}
.dk-tb-btns i.min{background:#FEBC2E}
.dk-tb-btns i.max{background:#28C840}
.dk-tb-btns i.close{background:#FF5F57}
.dk-winbody{position:absolute;inset:22px 0 0;overflow:hidden;background:#F0F2F5;
  display:flex;justify-content:center;padding-top:6px}
.dk-winbody > *{zoom:.68}
.dk-taskbar{position:absolute;left:0;right:0;bottom:0;height:26px;background:rgba(10,14,22,.88);
  backdrop-filter:blur(8px);display:flex;align-items:center;gap:4px;padding:0 8px;z-index:3}
.dk-task{font-size:8.5px;color:#C3CBD6;padding:3px 6px;border-radius:4px;
  display:inline-flex;align-items:center;gap:4px}
.dk-task img{width:11px;height:11px;border-radius:2px;display:block}
.dk-task.open{color:#fff;background:rgba(255,255,255,.14)}
.dk-task.min{color:#C3CBD6;background:rgba(255,255,255,.06)}
.dk-clock{margin-left:auto;font-size:8.5px;color:#9AA7B5;font-variant-numeric:tabular-nums}

/* --- Report / dispute sheets --- */
.sheet{width:340px;background:#000;border:1px solid #2F3336;border-radius:12px;padding:14px;
  font:13px/1.45 "Segoe UI",Helvetica,sans-serif;color:#E7E9EA}
.sheet-head{font-size:16px;font-weight:800;margin-bottom:10px}
.sheet-sub{font-size:11px;color:#71767B;font-weight:600;margin:9px 0 5px}
.opt{border:1px solid #2F3336;border-radius:8px;padding:7px 10px;margin-bottom:5px;font-size:12.5px;
  display:flex;justify-content:space-between;align-items:center}
.opt.on{border-color:#1D9BF0;background:rgba(29,155,240,.15);color:#1D9BF0;font-weight:650}
.opt b{color:#1D9BF0}
.sheet-text{border:1px solid #2F3336;border-radius:8px;padding:9px;min-height:52px;font-size:12px;
  line-height:1.5}
.sheet-text.tall{min-height:78px}
.sheet-text .typed{color:#E7E9EA}
.sheet-text .untyped{color:#4A5057}
.sheet-btn{margin-top:11px;background:#F4212E;color:#fff;font-weight:700;text-align:center;
  padding:9px;border-radius:9999px;font-size:13px}
.sheet-ok{margin-top:11px;color:#34C759;font-weight:700;font-size:12.5px;text-align:center}

.retract-banner{background:#FDECEA;border:1px solid #F0556A;border-radius:7px;padding:9px 11px;
  margin:11px 0 9px;font-family:"Segoe UI",sans-serif}
.retract-banner b{display:block;font-size:12.5px;color:#C62828}
.retract-banner span{display:block;font-size:11px;color:#8E6B6B;margin-top:3px;line-height:1.45}
.news-h1.struck{text-decoration:line-through;text-decoration-color:rgba(198,40,40,.5);opacity:.62}

mark.lens{background:#FFF0C2;color:#111;box-shadow:0 0 0 2px var(--accent);border-radius:2px;padding:0 2px}
.chat mark.lens{background:#3A3116;color:#FFE9B8}

@media (prefers-reduced-motion:reduce){
  .arriving,.msg.live,.readpath i{animation:none}
}
@media print{body{background:#fff;color:#000}.seq{break-inside:avoid}}
`;

function legend(): string {
  const items = (Object.keys(MOTION) as Motion[])
    .map((k) => {
      const m = MOTION[k];
      return `<span class="motion" style="--tone:${m.tone}">${m.glyph} ${esc(m.label)}</span>`;
    })
    .join('');
  return `<div class="legend"><div class="lg-t">EVERY BEAT MOVES — THIS IS WHAT MOVES IN IT</div>${items}</div>`;
}

function html(): string {
  const mins = Math.floor(TOTAL_SEC / 60);
  const secs = TOTAL_SEC % 60;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Amanah Under Fire — Trailer Storyboard v3</title>
<style>${CSS}</style>
</head><body>
<div class="wrap">

  <header class="masthead">
    <div class="kicker">PROPHYION · TRAILER · SHOT PLAN v3 — LIVE ACTION</div>
    <h1>Amanah Under Fire</h1>
    <p class="sub">Continuous takes of the real interface being used, not stills with camera moves
    painted on. Every beat below has something physically moving in it, and each panel is drawn from
    the actual set dressing — real copy, real photographs.</p>
    <div class="stats">
      <div><b>${SEQUENCES.length}</b> sequences</div>
      <div><b>${BEAT_COUNT}</b> beats</div>
      <div><b>${mins}m ${secs}s</b> of source</div>
      <div><b>${LIVE_BEATS.length}</b> arrive live on camera</div>
      <div><b>${TYPING_BEATS.length}</b> live-typing beats</div>
      <div><b>${DESKTOP_SEQUENCES}</b> in the windowed desktop</div>
      <div><b>${HOLD_BEATS.length}</b> still frames in the whole film</div>
    </div>
  </header>

  <div class="spine">
    <h3>THE SPINE</h3>
    <p>One woman asks one question: <em>my child’s bursary — is it still coming?</em> It sits on
    screen unanswered while the lie machine runs and the team gets it wrong once, publicly. The film
    is over when they earn the right to answer her by name.</p>
    <p>The film opens on an ordinary afternoon, because the crisis only lands if you felt what it
    displaced. A friend sends a link. She reads the article. She comes back to a feed that is no
    longer the same place — and the posts keep arriving while she is still reading it.</p>
  </div>

  ${legend()}

  <div class="spine" style="margin-top:22px;border-left-color:#34D399">
    <h3 style="color:#34D399">HOW THE MOTION IS REAL</h3>
    <p>The device apps have no polling and no Supabase realtime — they update only when the server
    broadcasts over Socket.IO from inside an API route. A direct database insert shows nothing on an
    open page. So anything that has to <em>arrive</em> on camera goes through the product’s own path:
    NPC posts and emails are published as <em>injects</em>, DMs through the messenger endpoint,
    comments as authenticated replies, and counters via the like route and the engine’s own tick.
    What you see arriving in the trailer is the product genuinely doing it.</p>
  </div>

  ${ACTS.map((a) => actSection(a.n)).join('')}

</div></body></html>`;
}

function markdown(): string {
  const lines: string[] = [
    '# Amanah Under Fire — trailer shot plan v3 (live action)',
    '',
    '<!-- Generated by demo-run/storyboard-html.ts. Edit demo-run/storyboard.ts instead. -->',
    '',
    `**${SEQUENCES.length} sequences · ${BEAT_COUNT} beats · ${Math.floor(TOTAL_SEC / 60)}m ${TOTAL_SEC % 60}s of source · Fakebook**`,
    '',
    '## The spine',
    '',
    'One woman asks one question: my child’s bursary — is it still coming? It sits on screen',
    'unanswered while the lie machine runs and the team gets it wrong once, publicly. The film is',
    'over when they earn the right to answer her by name.',
    '',
    'The film opens on an ordinary afternoon, because the crisis only lands if you felt what it',
    'displaced. A friend sends a link. She reads the article. She comes back to a feed that is no',
    'longer the same place — and the posts keep arriving while she is still reading it.',
    '',
    '## How the motion is real',
    '',
    'The device apps have no polling and no Supabase realtime; they update only when the server',
    'broadcasts over Socket.IO from inside an API route. A direct database insert shows nothing on',
    'an open page. So anything that must arrive on camera goes through the product’s own path:',
    '',
    '| Behaviour | Path |',
    '| --- | --- |',
    '| NPC post lands in an open feed | `POST /api/injects/:id/publish` (delivery_config.app = social_feed) |',
    '| Email lands in an open inbox | the same, app = email |',
    '| DM lands in an open thread | `POST /api/social/messenger/send` |',
    '| Comment lands under a post | `POST /api/social/posts` with `reply_to_post_id` |',
    '| Counters climb | `POST /api/social/posts/:id/like` + the 30s engine tick |',
    '',
    'Only the pre-crisis dressing is inserted directly, because the page loads after it.',
    '',
  ];

  for (const act of ACTS) {
    const seqs = SEQUENCES.filter((s) => s.act === act.n);
    lines.push(
      `## Act ${act.n} — ${act.title}`,
      '',
      `_${act.note}_  `,
      `${seqs.length} sequences · ${seqs.reduce((t, s) => t + seqSec(s), 0)}s`,
      '',
    );
    for (const s of seqs) {
      lines.push(
        `### SEQ ${String(s.n).padStart(2, '0')} — ${s.title}`,
        '',
        `**${s.screen || 'Graphic'} · ${s.app} · ${seqSec(s)}s continuous**`,
        '',
        s.purpose,
        '',
      );
      if (s.audio) lines.push(`_Sound: ${s.audio}_`, '');
      for (const [i, b] of s.beats.entries()) {
        lines.push(`${i + 1}. **${b.label}** (${MOTION[b.motion].label}, ${b.sec}s) — ${b.what}`);
        if (b.how) lines.push(`   - _${b.how}_`);
      }
      lines.push('');
    }
  }

  lines.push(
    '## Photography',
    '',
    'Five generated stills, served from `demo-run/assets` at `/staged` during the shoot. They are',
    'deliberately not copied into the SPA build — nothing fictional ships inside the product.',
    '',
    '| File | Used for |',
    '| --- | --- |',
    `| \`${PHOTOS.calmIftar.split('/').pop()}\` | The ordinary afternoon. Seq 01. |`,
    `| \`${PHOTOS.newsBuilding.split('/').pop()}\` | The outlet’s own share, and the DM card. |`,
    `| \`${PHOTOS.communityHall.split('/').pop()}\` | Bursary counter. Her question, then AMP’s proof. |`,
    `| \`${PHOTOS.hotelDinner.split('/').pop()}\` | The “evidence” that proves nothing. Seq 07. |`,
    `| \`${PHOTOS.crowdOutside.split('/').pop()}\` | Escalation made physical. Seq 09. |`,
    '',
    'The community-hall photo answering the hotel-dinner photo is the visual argument of the film:',
    'same grammar, opposite truth.',
    '',
  );

  return lines.join('\n');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, 'storyboard.html');
fs.writeFileSync(file, html(), 'utf8');
const md = path.resolve('demo-run', 'STORYBOARD.md');
fs.writeFileSync(md, markdown(), 'utf8');
console.log(`Storyboard written: ${file}`);
console.log(`Prose version:      ${md}`);
console.log(
  `${SEQUENCES.length} sequences · ${BEAT_COUNT} beats · ${Math.floor(TOTAL_SEC / 60)}m ${TOTAL_SEC % 60}s`,
);
console.log(
  `${LIVE_BEATS.length} beats arrive live · ${TYPING_BEATS.length} typing · ${HOLD_BEATS.length} holds`,
);
