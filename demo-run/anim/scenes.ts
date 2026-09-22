/**
 * Scene components for the rendered trailer.
 *
 * These are the same surfaces the storyboard draws, rebuilt at full 1920x1080
 * instead of thumbnail scale. Fidelity comes from using the product's own
 * values — Fakebook's #1877F2 and #F0F2F5, its avatar colour hash, the shipped
 * app icons and wallpaper, the brand's navy and amber — so the render reads as
 * the software rather than as an illustration of it.
 *
 * Everything here is pure string building. No animation: motion is declared
 * separately as tracks and applied by runtime.js, which keeps the markup
 * seekable and the timing in one place.
 */

import { EMAILS, PHOTOS, stagedByKey } from '../stage.js';

/** Design size. Rendered at deviceScaleFactor 2 for a 3840x2160 output. */
export const W = 1920;
export const H = 1080;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nl2br = (s: string): string => esc(s).replace(/\n/g, '<br/>');
const num = (n: number): string => n.toLocaleString('en-SG');

/** Assets live beside the page; the renderer serves demo-run/assets at /a. */
export const asset = (file: string): string => `/a/icons/${file}`;
export const photo = (url: string): string => `/a/${url.split('/').pop() ?? ''}`;

const AVATAR_COLORS = ['#1877F2', '#42B72A', '#F02849', '#FF6D00', '#8B5CF6', '#0EA5E9'];
export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const toneFor = (t: string, name: string): string =>
  t === 'official_account' ? '#0B7A4B' : t === 'npc_media' ? '#C8102E' : avatarColor(name);

function ava(name: string, size: number, tone?: string): string {
  return `<div class="ava" style="background:${tone ?? avatarColor(name)};width:${size}px;height:${size}px;flex:0 0 ${size}px;font-size:${Math.round(size * 0.44)}px">${esc(name.charAt(0).toUpperCase())}</div>`;
}

// ---------------------------------------------------------------------------
// Desktop shell
// ---------------------------------------------------------------------------

export const DESK_APPS: [string, string, string][] = [
  ['social', 'Z', 'icon-social.png'],
  ['facebook', 'Fakebook', 'icon-facebook.png'],
  ['email', 'Mail', 'icon-mail.png'],
  ['news', 'News', 'icon-news.png'],
  ['chat', 'TeamChat', 'icon-chat.png'],
  ['docs', 'Docs', 'icon-docs.svg'],
];

const deskIconFile = (id: string): string =>
  DESK_APPS.find(([i]) => i === id)?.[2] ?? 'icon-facebook.png';
const deskTitle = (id: string): string => DESK_APPS.find(([i]) => i === id)?.[1] ?? id;

export interface WindowSpec {
  app: string;
  body: string;
  /** Window rect in CSS px. Defaults to a comfortable centred size. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/**
 * The whole desktop: wallpaper, icons, zero or more windows, taskbar.
 *
 * Windows get an id so tracks can move, fade or scale them individually —
 * that is how minimise and restore are animated rather than toggled.
 */
export function desktop(opts: {
  windows?: WindowSpec[];
  /** Apps shown in the taskbar as present. */
  taskbar?: string[];
  /** Apps drawn dimmed in the taskbar, i.e. minimised. */
  minimised?: string[];
  clock?: string;
}): string {
  const wins = opts.windows ?? [];
  const bar = opts.taskbar ?? wins.map((w) => w.app);

  const icons = DESK_APPS.map(
    ([id, label, file]) => `
    <div class="dk-icon" id="ic-${id}">
      <div class="dk-tile"><img src="${asset(file)}" alt=""/></div>
      <span>${esc(label)}</span>
    </div>`,
  ).join('');

  const windows = wins
    .map((w, i) => {
      const x = w.x ?? 300;
      const y = w.y ?? 90;
      const width = w.w ?? 1320;
      const height = w.h ?? 860;
      return `
      <div class="dk-win" id="win-${w.app}" style="left:${x}px;top:${y}px;width:${width}px;height:${height}px;z-index:${10 + i}">
        <div class="dk-titlebar">
          <span class="dk-tb-left"><img src="${asset(deskIconFile(w.app))}" alt=""/></span>
          <span class="dk-tb-title">${esc(deskTitle(w.app))}</span>
          <span class="dk-tb-btns"><i class="min"></i><i class="max"></i><i class="close"></i></span>
        </div>
        <div class="dk-winbody" id="body-${w.app}">${w.body}</div>
      </div>`;
    })
    .join('');

  const tasks = bar
    .map(
      (id) =>
        `<span class="dk-task${(opts.minimised ?? []).includes(id) ? ' min' : ' open'}" id="task-${id}">
           <img src="${asset(deskIconFile(id))}" alt=""/>${esc(deskTitle(id))}
         </span>`,
    )
    .join('');

  return `
  <div class="desk">
    <div class="dk-icons">${icons}</div>
    ${windows}
    <div class="dk-taskbar">${tasks}<span class="dk-clock">${opts.clock ?? '15:42'}</span></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Fakebook
// ---------------------------------------------------------------------------

export interface PostOpts {
  /** Mark a phrase so the edit can push in on it. */
  highlight?: string;
  comments?: { name: string; text: string; likes?: number; id?: string }[];
  /** Override the seeded counters, for climbing shots. */
  counters?: { likes: number; shares: number; views: number };
  /** Element id, so tracks can target this card. */
  id?: string;
  /** Draw the report icon in its flagged (amber) state. */
  flagged?: boolean;
  /** Show an open comment composer under the post. */
  composer?: { author: string; id: string };
}

export function fbPost(key: string, o: PostOpts = {}): string {
  const s = stagedByKey(key);
  const likes = o.counters?.likes ?? s.likes ?? 0;
  const shares = o.counters?.shares ?? s.reposts ?? 0;
  const views = o.counters?.views ?? s.views ?? 0;
  const id = o.id ?? `post-${key}`;

  const body = o.highlight
    ? nl2br(s.content).replace(
        nl2br(o.highlight),
        `<mark class="lens">${nl2br(o.highlight)}</mark>`,
      )
    : nl2br(s.content);

  const media = (s.mediaUrls ?? [])
    .map((u) => `<img class="fb-media" src="${photo(u)}" alt=""/>`)
    .join('');

  const comments = (o.comments ?? [])
    .map(
      (c) => `
    <div class="fb-comment"${c.id ? ` id="${c.id}"` : ''}>
      ${ava(c.name, 40, c.name.startsWith('AMP') ? '#0B7A4B' : undefined)}
      <div class="fb-bubble">
        <div class="fb-cname">${esc(c.name)}</div>
        <div class="fb-ctext">${nl2br(c.text)}</div>
        ${c.likes ? `<div class="fb-cmeta">👍 ${num(c.likes)}</div>` : ''}
      </div>
    </div>`,
    )
    .join('');

  const composer = o.composer
    ? `<div class="fb-composer">
         ${ava(o.composer.author, 36, '#0B7A4B')}
         <div class="fb-cinput" id="${o.composer.id}"></div>
       </div>`
    : '';

  return `
  <div class="fb" id="${id}">
    <div class="fb-head">
      ${ava(s.displayName, 56, toneFor(s.authorType, s.displayName))}
      <div class="fb-who">
        <div class="fb-name">${esc(s.displayName)}</div>
        <div class="fb-sub">${esc(s.handle)} · 12m · 🌐</div>
      </div>
      <div class="fb-more${o.flagged ? ' flagged' : ''}" id="${id}-report">⋯</div>
    </div>
    <div class="fb-body">${body}</div>
    ${media}
    <div class="fb-stats">
      <span>👍❤️😡 <b id="${id}-likes">${num(likes)}</b></span>
      <span><b id="${id}-shares">${num(shares)}</b> shares · <b id="${id}-views">${num(views)}</b> views</span>
    </div>
    <div class="fb-bar"><div class="act">👍 Like</div><div class="act">💬 Comment</div><div class="act">↗ Share</div></div>
    ${comments || composer ? `<div class="fb-comments">${comments}${composer}</div>` : ''}
  </div>`;
}

/** A scrollable feed column. Give posts ids so arrivals can be animated. */
export function fbFeed(cards: string[], opts: { id?: string; composer?: boolean } = {}): string {
  const compose = opts.composer
    ? `<div class="fb-newpost">${ava('You', 44, '#1877F2')}<div class="fb-newbox">What's on your mind?</div></div>`
    : '';
  return `
  <div class="fb-app">
    <div class="fb-topbar">
      <span class="fb-logo">fakebook</span>
      <div class="fb-search">Search Fakebook</div>
      <div class="fb-icons"><span id="fb-msg">💬</span><span>🔔</span><span class="fb-me">F</span></div>
    </div>
    <div class="fb-scroll" id="${opts.id ?? 'feed'}">
      ${compose}
      ${cards.join('')}
      <div style="height:200px"></div>
    </div>
  </div>`;
}

export function fbCompose(o: { pageName: string; textId: string; attachment?: string }): string {
  return `
  <div class="fb-app">
    <div class="cmp">
      <div class="cmp-head">
        <span class="cmp-cancel">Cancel</span>
        <span class="cmp-title">Create post</span>
        <span class="cmp-post" id="cmp-post">Post</span>
      </div>
      <div class="cmp-as">
        <span class="cmp-as-label">Posting as:</span>
        <span class="chip">You</span>
        <span class="chip on" id="cmp-aspage">✓ ${esc(o.pageName)}</span>
      </div>
      <div class="cmp-body">
        ${ava(o.pageName, 48, '#0B7A4B')}
        <div class="cmp-text" id="${o.textId}"></div>
      </div>
      ${o.attachment ? `<img class="cmp-attach" id="cmp-attach" src="${photo(o.attachment)}" alt=""/>` : ''}
      <div class="cmp-foot"><span>🖼</span><span>🎬</span><span>😊</span></div>
    </div>
  </div>`;
}

/**
 * The Fakebook top bar, with the messenger badge and an optional toast.
 *
 * Split out because the badge and the notification pill are how a DM announces
 * itself. A message that simply exists when the scene cuts to it gives the
 * audience no reason to believe anyone noticed it arriving.
 */
function fbTopbar(o: { badge?: boolean; toast?: { from: string; preview: string } } = {}): string {
  return `
  <div class="fb-topbar">
    <span class="fb-logo">fakebook</span>
    <div class="fb-search">Search Fakebook</div>
    <div class="fb-icons">
      <span class="fb-ico" id="fb-msg">💬${o.badge ? '<i class="fb-badge" id="fb-badge">1</i>' : ''}</span>
      <span class="fb-ico">🔔</span>
      <span class="fb-me">F</span>
    </div>
  </div>
  ${
    o.toast
      ? `<div class="fb-toast" id="fb-toast">
           ${ava(o.toast.from, 44)}
           <div class="fb-toast-body">
             <div class="fb-toast-title">New message from ${esc(o.toast.from)}</div>
             <div class="fb-toast-prev">${esc(o.toast.preview)}</div>
           </div>
         </div>`
      : ''
  }`;
}

export interface DmMessage {
  text: string;
  id?: string;
  me?: boolean;
  time?: string;
  shared?: { author: string; preview: string; photo?: string; platform?: string };
}

/**
 * Messenger, matching FacebookMessengerView: a thread list on the left, the
 * conversation on the right, incoming bubbles in #F0F2F5 with a squared
 * bottom-left corner and outgoing in #1877F2 squared bottom-right, and the
 * shared-post card nested inside its bubble rather than floating beside it.
 */
export function messenger(o: {
  from: string;
  messages: DmMessage[];
  threads?: { name: string; preview: string; unread?: boolean; active?: boolean }[];
  badge?: boolean;
  /** Render the page inbox tab as selected, for the operator sequence. */
  asPage?: string;
}): string {
  const msgs = o.messages
    .map((m) => {
      const shared = m.shared
        ? `<div class="dm-card${m.me ? ' mine' : ''}">
             ${m.shared.photo ? `<img class="dm-card-img" src="${photo(m.shared.photo)}" alt=""/>` : ''}
             <div class="dm-card-txt">
               <div class="dm-card-author">${esc(m.shared.author)}</div>
               <div class="dm-card-prev">${esc(m.shared.preview)}</div>
               <div class="dm-card-plat">${esc(m.shared.platform ?? 'Fakebook')} post</div>
             </div>
           </div>`
        : '';
      return `
      <div class="dm-row${m.me ? ' me' : ''}"${m.id ? ` id="${m.id}"` : ''}>
        <div class="dm-bub${m.me ? ' me' : ''}">
          ${shared}
          <div class="dm-text">${esc(m.text)}</div>
          <div class="dm-time">${esc(m.time ?? '1m')}</div>
        </div>
      </div>`;
    })
    .join('');

  const threads = (
    o.threads ?? [{ name: o.from, preview: o.messages[0]?.text ?? '', unread: true, active: true }]
  )
    .map(
      (t) => `
      <div class="dm-thread${t.active ? ' active' : ''}">
        ${ava(t.name, 52)}
        <div class="dm-thread-txt">
          <div class="dm-thread-name">${esc(t.name)}</div>
          <div class="dm-thread-prev">${esc(t.preview)}</div>
        </div>
        ${t.unread ? '<i class="dm-unread"></i>' : ''}
      </div>`,
    )
    .join('');

  return `
  <div class="fb-app">
    ${fbTopbar({ badge: o.badge })}
    <div class="dm-wrap">
      <div class="dm-list">
        <div class="dm-list-head">Chats</div>
        ${
          o.asPage
            ? `<div class="dm-tabs"><span class="dm-tab">You</span><span class="dm-tab on">${esc(o.asPage)}</span></div>`
            : ''
        }
        ${threads}
      </div>
      <div class="dm-conv">
        <div class="dm-conv-head">
          <span class="dm-back">‹</span>${ava(o.from, 48)}<span class="dm-conv-name">${esc(o.from)}</span>
        </div>
        <div class="dm-conv-body" id="dm-body">${msgs}</div>
        <div class="dm-conv-input">Aa</div>
      </div>
    </div>
  </div>`;
}

/** The feed with a messenger badge and an incoming-message toast. */
export function fbFeedWithToast(
  cards: string[],
  o: { id?: string; badge?: boolean; toast?: { from: string; preview: string } },
): string {
  return `
  <div class="fb-app">
    ${fbTopbar({ badge: o.badge, toast: o.toast })}
    <div class="fb-scroll" id="${o.id ?? 'feed'}">
      ${cards.join('')}
      <div style="height:200px"></div>
    </div>
  </div>`;
}

/** Page notifications panel: the public demanding answers of the org. */
export function pageNotifications(items: { who: string; what: string; id?: string }[]): string {
  return `
  <div class="fb-app">
    ${fbTopbar({})}
    <div class="notif">
      <div class="notif-head">Notifications · AMP</div>
      ${items
        .map(
          (n) => `
        <div class="notif-row"${n.id ? ` id="${n.id}"` : ''}>
          ${ava(n.who, 52)}
          <div class="notif-txt"><b>${esc(n.who)}</b> ${esc(n.what)}</div>
          <i class="notif-dot"></i>
        </div>`,
        )
        .join('')}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// News, mail, chat
// ---------------------------------------------------------------------------

/**
 * The News app's headline list.
 *
 * Opening the app straight onto a single article skipped the part that makes it
 * feel like a news app: a wire of competing headlines you have to scan. It also
 * matters narratively — the AMP story sitting third in a list of unrelated news
 * is how a crisis actually looks before it is the only thing anyone is talking
 * about.
 */
export function newsList(o: {
  items: {
    outlet: string;
    headline: string;
    time: string;
    photo?: string;
    tag?: string;
    id?: string;
  }[];
  scrollId?: string;
}): string {
  return `
  <div class="news-app">
    <div class="news-mast">Newswire · Singapore</div>
    <div class="news-scroll" id="${o.scrollId ?? 'news-list'}">
      ${o.items
        .map(
          (n) => `
        <div class="nl-row"${n.id ? ` id="${n.id}"` : ''}>
          ${n.photo ? `<img class="nl-img" src="${photo(n.photo)}" alt=""/>` : '<div class="nl-img nl-blank"></div>'}
          <div class="nl-txt">
            ${n.tag ? `<span class="nl-tag">${esc(n.tag)}</span>` : ''}
            <div class="nl-head">${esc(n.headline)}</div>
            <div class="nl-meta">${esc(n.outlet)} · ${esc(n.time)}</div>
          </div>
        </div>`,
        )
        .join('')}
      <div style="height:160px"></div>
    </div>
  </div>`;
}

export function news(o: {
  outlet: string;
  headline: string;
  sub: string;
  paras: string[];
  highlight?: string;
  retracted?: string;
  scrollId?: string;
  /** Article hero image. The DM preview had one; the article itself did not. */
  photo?: string;
}): string {
  const head = o.highlight
    ? esc(o.headline).replace(esc(o.highlight), `<mark class="lens">${esc(o.highlight)}</mark>`)
    : esc(o.headline);
  return `
  <div class="news-app">
    <div class="news-mast">${esc(o.outlet)}</div>
    <div class="news-scroll" id="${o.scrollId ?? 'news-scroll'}">
      ${
        o.retracted
          ? `<div class="retract" id="retract-banner"><b>This article has been retracted</b><span>${esc(o.retracted)}</span></div>`
          : ''
      }
      <div class="news-tag">BREAKING</div>
      <h1 class="news-h1${o.retracted ? ' struck' : ''}">${head}</h1>
      <div class="news-sub">${esc(o.sub)}</div>
      ${o.photo ? `<img class="news-hero" src="${photo(o.photo)}" alt=""/>` : ''}
      ${o.paras.map((p) => `<p class="news-p">${esc(p)}</p>`).join('')}
      ${o.retracted ? '' : '<div class="news-dispute" id="news-dispute">⚑ Dispute / Request Correction</div>'}
      <div style="height:120px"></div>
    </div>
  </div>`;
}

export function mailList(o: { focus?: string; arrivingId?: string }): string {
  const rows = EMAILS.map(
    (e) => `
    <div class="mail-row${e.key === o.focus ? ' framed' : ''}"${e.key === 'email-press' && o.arrivingId ? ` id="${o.arrivingId}"` : ''}>
      <span class="dot"></span>
      <div class="mail-meta">
        <div class="mail-from">${esc(e.fromName)}</div>
        <div class="mail-subj">${esc(e.subject)}</div>
      </div>
      <span class="pri ${e.priority}">${e.priority.toUpperCase()}</span>
    </div>`,
  ).join('');
  return `<div class="mail-app"><div class="mail-head">Inbox · 3 unread</div><div class="mail-scroll" id="mail-scroll">${rows}</div></div>`;
}

/**
 * An inbox with the reading pane, so opening Mail lands on the list.
 *
 * Cutting straight into an open email skipped the moment that carries the
 * pressure: seeing how many unread things are waiting before choosing one.
 */
export function mailInbox(o: { focus?: string; arrivingId?: string; listId?: string }): string {
  const rows = EMAILS.map(
    (e) => `
    <div class="mail-row${e.key === o.focus ? ' framed' : ''}"${e.key === 'email-press' && o.arrivingId ? ` id="${o.arrivingId}"` : ''}>
      <span class="dot"></span>
      <div class="mail-meta">
        <div class="mail-from">${esc(e.fromName)}</div>
        <div class="mail-subj">${esc(e.subject)}</div>
      </div>
      <span class="pri ${e.priority}">${e.priority.toUpperCase()}</span>
    </div>`,
  ).join('');
  return `
  <div class="mail-app">
    <div class="mail-head">Inbox · ${EMAILS.length} unread</div>
    <div class="mail-scroll" id="${o.listId ?? 'mail-scroll'}">${rows}<div style="height:120px"></div></div>
  </div>`;
}

export function mailRead(key: string, o: { highlight?: string; replyId?: string } = {}): string {
  const e = EMAILS.find((x) => x.key === key);
  if (!e) return '<div class="mail-app">missing</div>';
  const body = o.highlight
    ? nl2br(e.body).replace(nl2br(o.highlight), `<mark class="lens">${nl2br(o.highlight)}</mark>`)
    : nl2br(e.body);
  return `
  <div class="mail-app">
    <div class="mail-head">${esc(e.subject)}</div>
    <div class="mail-scroll" id="mail-scroll">
      <div class="mail-from-line">${esc(e.fromName)} &lt;${esc(e.fromAddress)}&gt;</div>
      ${o.replyId ? `<div class="mail-reply"><div class="mail-reply-to">To: ${esc(e.fromAddress)}</div><div class="mail-reply-body" id="${o.replyId}"></div><div class="mail-send">Send</div></div>` : ''}
      <div class="mail-body">${body}</div>
      <div style="height:120px"></div>
    </div>
  </div>`;
}

export function chat(o: {
  channel: string;
  messages: { from: string; text: string; me?: boolean; id?: string }[];
  inputId?: string;
}): string {
  const msgs = o.messages
    .map(
      (m) => `
    <div class="msg${m.me ? ' me' : ''}"${m.id ? ` id="${m.id}"` : ''}>
      <div class="msg-from">${esc(m.from)}</div>
      <div class="msg-bub">${esc(m.text)}</div>
    </div>`,
    )
    .join('');
  return `
  <div class="chat-app">
    <div class="chat-head">${esc(o.channel)}</div>
    <div class="chat-scroll" id="chat-scroll">${msgs}</div>
    <div class="chat-input"><div class="chat-field" id="${o.inputId ?? 'chat-input'}"></div><span class="chat-send">➤</span></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export function reportSheet(o: { selected?: string; reasonId: string }): string {
  const opts: [string, string][] = [
    ['hate_speech', 'Hate speech'],
    ['incitement_to_violence', 'Incitement to violence'],
    ['misinformation', 'Misinformation'],
    ['organized_harassment', 'Organized harassment'],
    ['harmful_narrative', 'Harmful narrative'],
    ['other', 'Something else'],
  ];
  return `
  <div class="sheet" id="report-sheet" data-xf="translate(-50%,-50%)">
    <div class="sheet-head">Report this post</div>
    <div class="sheet-sub">Why are you reporting this?</div>
    ${opts.map(([v, l]) => `<div class="opt" id="opt-${v}">${esc(l)}${o.selected === v ? '<b>✓</b>' : ''}</div>`).join('')}
    <div class="sheet-sub">Add details</div>
    <div class="sheet-text" id="${o.reasonId}"></div>
    <div class="sheet-btn" id="report-submit">Submit report</div>
  </div>`;
}

export function disputeSheet(o: { noteId: string; status?: string }): string {
  return `
  <div class="sheet" id="dispute-sheet" data-xf="translate(-50%,-50%)">
    <div class="sheet-head">Request Correction / Takedown</div>
    <div class="sheet-sub">Identify the false claim and cite verified facts</div>
    <div class="sheet-text tall" id="${o.noteId}"></div>
    ${o.status ? `<div class="sheet-ok" id="dispute-status">${esc(o.status)}</div>` : '<div class="sheet-btn" id="dispute-submit">Submit report</div>'}
  </div>`;
}

// ---------------------------------------------------------------------------
// Trainer dashboard
// ---------------------------------------------------------------------------

export interface GaugeSpec {
  key: string;
  label: string;
  value: number;
  invert?: boolean;
}

export function dashboard(o: {
  gauges: GaugeSpec[];
  overall: number;
  trend: 'flat' | 'falling' | 'rising';
  alert?: string;
  clock?: string;
}): string {
  const tone = (v: number, invert?: boolean): string => {
    const good = invert ? v < 40 : v > 60;
    const mid = invert ? v < 65 : v > 40;
    return good ? '#22C55E' : mid ? '#F59E0B' : '#EF4444';
  };
  const gauges = o.gauges
    .map(
      (g) => `
      <div class="g">
        <div class="g-lab">${esc(g.label)}</div>
        <div class="g-val" id="g-${g.key}" style="color:${tone(g.value, g.invert)}">${Math.round(g.value)}</div>
        <div class="g-track"><div class="g-fill" id="gb-${g.key}" style="width:${g.value}%;background:${tone(g.value, g.invert)}"></div></div>
      </div>`,
    )
    .join('');

  const path =
    o.trend === 'falling'
      ? 'M0,26 L90,38 L180,74 L280,126 L380,158 L470,178'
      : o.trend === 'rising'
        ? 'M0,178 L90,164 L180,132 L280,86 L380,52 L470,36'
        : 'M0,64 L90,60 L180,66 L280,62 L380,64 L470,60';
  const stroke = o.trend === 'rising' ? '#22C55E' : o.trend === 'falling' ? '#EF4444' : '#64748B';

  return `
  <div class="dash">
    <div class="dash-head"><span>Amanah Under Fire — Live</span><span class="dash-clock">${o.clock ?? 'T+11:42'}</span></div>
    <div class="dash-hero">
      <div class="dash-big" id="g-overall" style="color:${tone(o.overall)}">${Math.round(o.overall)}</div>
      <div class="dash-big-lab">Overall Sentiment</div>
    </div>
    <div class="gauges">${gauges}</div>
    <svg class="spark" viewBox="0 0 470 200" preserveAspectRatio="none">
      <path id="spark-path" d="${path}" fill="none" stroke="${stroke}" stroke-width="5"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    ${o.alert ? `<div class="dash-alert" id="dash-alert">${esc(o.alert)}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Graphics
// ---------------------------------------------------------------------------

export function mosaic(tiles = 25): string {
  return `<div class="mosaic">${Array.from({ length: tiles }, (_, i) => `<div class="tile" id="tile-${i}"></div>`).join('')}</div>`;
}

export function card(o: {
  kicker?: string;
  lines: string[];
  sub?: string;
  logo?: boolean;
}): string {
  return `
  <div class="endcard">
    ${o.logo ? `<div class="ec-logo" id="ec-logo"><img src="${asset('prophyion-mark.png')}" alt=""/></div>` : ''}
    ${o.kicker ? `<div class="ec-kicker" id="ec-kicker">${esc(o.kicker)}</div>` : ''}
    ${o.lines.map((l, i) => `<div class="ec-line" id="ec-line-${i}">${esc(l)}</div>`).join('')}
    ${o.sub ? `<div class="ec-sub" id="ec-sub">${esc(o.sub)}</div>` : ''}
  </div>`;
}

const gaugeTone = (v: number, invert?: boolean): string => {
  const good = invert ? v < 40 : v > 60;
  const mid = invert ? v < 65 : v > 40;
  return good ? '#22C55E' : mid ? '#F59E0B' : '#EF4444';
};

/**
 * Phone shell.
 *
 * A portrait handset in a landscape frame leaves two large dead margins, so the
 * phone sits left of centre and a live stats panel takes the right side. That
 * fixes the composition and does useful work at the same time: the audience
 * sees the consequence of what is happening on the handset without needing a
 * separate cut away to the dashboard.
 *
 * The backdrop is the marketing site's own `.deep-grid` treatment over one of
 * its hero photographs, so the trailer and the landing page share a look.
 */
export function phone(
  body: string,
  opts: {
    stats?: { gauges: GaugeSpec[]; trend: 'flat' | 'falling' | 'rising'; caption?: string };
    bg?: string;
  } = {},
): string {
  const panel = opts.stats
    ? `
    <div class="side" id="side-panel" data-xf="translateY(-50%)">
      <div class="side-kicker">Live · public sentiment</div>
      ${opts.stats.gauges
        .map(
          (g) => `
        <div class="side-g">
          <div class="side-g-top">
            <span class="side-g-lab">${esc(g.label)}</span>
            <span class="side-g-val" id="sg-${g.key}" style="color:${gaugeTone(g.value, g.invert)}">${Math.round(g.value)}</span>
          </div>
          <div class="side-g-track"><div class="side-g-fill" id="sgb-${g.key}"
            style="width:${g.value}%;background:${gaugeTone(g.value, g.invert)}"></div></div>
        </div>`,
        )
        .join('')}
      <svg class="side-spark" viewBox="0 0 420 130" preserveAspectRatio="none">
        <path id="side-spark-path" fill="none" stroke-width="4" stroke-linecap="round"
          stroke="${opts.stats.trend === 'rising' ? '#22C55E' : opts.stats.trend === 'falling' ? '#EF4444' : '#64748B'}"
          d="${
            opts.stats.trend === 'falling'
              ? 'M0,16 L84,26 L168,52 L252,84 L336,104 L420,118'
              : opts.stats.trend === 'rising'
                ? 'M0,118 L84,106 L168,84 L252,52 L336,28 L420,14'
                : 'M0,64 L84,60 L168,66 L252,62 L336,64 L420,60'
          }"/>
      </svg>
      ${opts.stats.caption ? `<div class="side-cap">${esc(opts.stats.caption)}</div>` : ''}
    </div>`
    : '';

  return `
  <div class="phone-stage${opts.stats ? ' with-side' : ''}"
       ${opts.bg ? `style="--bgimg:url('/a/bg/${opts.bg}')"` : ''}>
    <div class="phone" id="phone" data-xf="translate(-50%,-50%)">
      <div class="phone-notch"></div>
      <div class="phone-screen">${body}</div>
    </div>
    ${panel}
  </div>`;
}

/**
 * The organisation's own page.
 *
 * Mirrors OrgPageView: cover band, logo, name with the verified tick, handle,
 * bio, follower count, then only that page's own posts. Showing this matters
 * because it is where an operator sees their own track record — what the
 * organisation has already said is the context for what it says next.
 */
export function orgPage(o: {
  name: string;
  handle: string;
  bio: string;
  followers: string;
  posts: {
    text: string;
    time: string;
    likes: string;
    comments: string;
    photo?: string;
    id?: string;
  }[];
  composerId?: string;
}): string {
  return `
  <div class="fb-app">
    <div class="page-scroll" id="page-scroll">
      <div class="page-head">
        <div class="page-cover"></div>
        <div class="page-id">
          <div class="page-logo">${esc(o.name.charAt(0))}</div>
          <div class="page-meta">
            <div class="page-name">${esc(o.name)} <span class="page-tick">✓</span></div>
            <div class="page-handle">${esc(o.handle)} · ${esc(o.followers)} followers</div>
            <div class="page-bio">${esc(o.bio)}</div>
          </div>
        </div>
        <div class="page-tabs"><span class="on">Posts</span><span>About</span><span>Photos</span><span>Community</span></div>
      </div>
      ${
        o.composerId
          ? `<div class="page-compose">
               <div class="page-compose-head">
                 <div class="page-logo sm">${esc(o.name.charAt(0))}</div>
                 <span>Posting as ${esc(o.name)}</span>
               </div>
               <div class="page-compose-box" id="${o.composerId}"></div>
               <div class="page-compose-foot"><span class="page-post-btn">Post</span></div>
             </div>`
          : ''
      }
      ${o.posts
        .map(
          (p) => `
        <div class="page-post"${p.id ? ` id="${p.id}"` : ''}>
          <div class="page-post-head">
            <div class="page-logo sm">${esc(o.name.charAt(0))}</div>
            <div>
              <div class="page-post-name">${esc(o.name)} <span class="page-tick">✓</span></div>
              <div class="page-post-time">${esc(p.time)}</div>
            </div>
          </div>
          <div class="page-post-body">${nl2br(p.text)}</div>
          ${p.photo ? `<img class="page-post-img" src="${photo(p.photo)}" alt=""/>` : ''}
          <div class="page-post-stats">👍 ${esc(p.likes)} · ${esc(p.comments)} comments</div>
        </div>`,
        )
        .join('')}
      <div style="height:200px"></div>
    </div>
  </div>`;
}

/** Full-frame brand wipe, for transitions between shells. */
export function wipe(): string {
  return `<div class="wipe" id="wipe"></div>`;
}

export { esc, nl2br, num, PHOTOS };
