/**
 * The trailer, as renderable clips.
 *
 * One clip per storyboard sequence. Each is a static DOM tree plus a list of
 * tracks; runtime.js turns time into the visual state. Nothing here runs on a
 * clock, so a clip renders identically every time and can be re-rendered after
 * a copy change in under a minute.
 *
 * Times are milliseconds from the start of the clip.
 */

import {
  card,
  chat,
  dashboard,
  desktop,
  disputeSheet,
  fbCompose,
  fbFeed,
  fbFeedWithToast,
  fbPost,
  mailList,
  mailRead,
  messenger,
  mosaic,
  mailInbox,
  news,
  newsList,
  orgPage,
  pageNotifications,
  phone,
  reportSheet,
  wipe,
  PHOTOS,
} from './scenes.js';

export interface Track {
  prop:
    | 'opacity' | 'x' | 'y' | 'scale' | 'rotate' | 'scroll' | 'type' | 'number'
    | 'widthPct' | 'classAt' | 'draw' | 'spark' | 'visible' | 'cursor';
  sel?: string;
  keys?: [number, number][];
  /** spark only: plot box and value range. */
  w?: number;
  h?: number;
  min?: number;
  max?: number;
  points?: number;
  ease?: 'linear' | 'out' | 'in' | 'inOut' | 'back';
  text?: string;
  showRest?: boolean;
  prefix?: string;
  suffix?: string;
  class?: string;
  at?: number;
  from?: number;
  to?: number;
  /** cursor only */
  x?: [number, number][];
  y?: [number, number][];
  clicks?: number[];
  subtle?: boolean;
}

export interface Clip {
  id: string;
  seq: number;
  title: string;
  durationMs: number;
  html: string;
  tracks: Track[];
}

// ---------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------

/** Desktop icon centres, matching the 2-column grid in styles.ts. */
const ICON: Record<string, [number, number]> = {
  social: [94, 71],
  facebook: [240, 71],
  email: [94, 196],
  news: [240, 196],
  chat: [94, 321],
  docs: [240, 321],
};

/** Taskbar entry centres, left to right along the bar. */
const taskX = (i: number): number => 20 + 80 + i * 168;
const TASK_Y = 1054;

const WIN = { x: 300, y: 90, w: 1320, h: 860 };
/** Minimise button sits in the traffic-light cluster, right of the title bar. */
const minBtn: [number, number] = [WIN.x + WIN.w - 74, WIN.y + 22];

/** A window opening: the shell's own 0.25s scale-and-fade. */
const windowOpen = (app: string, at: number): Track[] => [
  { prop: 'opacity', sel: `#win-${app}`, keys: [[at - 1, 0], [at, 0], [at + 260, 1]], ease: 'out' },
  { prop: 'scale', sel: `#win-${app}`, keys: [[at - 1, 0.93], [at, 0.93], [at + 260, 1]], ease: 'back' },
];

/** A window collapsing to the taskbar. */
const windowMin = (app: string, at: number): Track[] => [
  { prop: 'opacity', sel: `#win-${app}`, keys: [[at, 1], [at + 240, 0]], ease: 'in' },
  { prop: 'scale', sel: `#win-${app}`, keys: [[at, 1], [at + 240, 0.9]], ease: 'in' },
  { prop: 'y', sel: `#win-${app}`, keys: [[at, 0], [at + 240, 120]], ease: 'in' },
];

/** A post dropping into the top of a feed. */
const arrive = (sel: string, at: number): Track[] => [
  { prop: 'opacity', sel, keys: [[at - 1, 0], [at, 0], [at + 300, 1]], ease: 'out' },
  { prop: 'y', sel, keys: [[at - 1, -26], [at, -26], [at + 380, 0]], ease: 'back' },
];

/** A comment bubble appearing in a thread. */
const pop = (sel: string, at: number): Track[] => [
  { prop: 'opacity', sel, keys: [[at - 1, 0], [at, 0], [at + 220, 1]], ease: 'out' },
  { prop: 'y', sel, keys: [[at - 1, 14], [at, 14], [at + 320, 0]], ease: 'back' },
];

/** Type `text` into `sel` between two times, at a readable rate. */
const typeInto = (sel: string, text: string, from: number, to: number): Track => ({
  prop: 'type',
  sel,
  text,
  keys: [
    [from, 0],
    [to, text.length],
  ],
  ease: 'linear',
});

/**
 * A brand wipe at both ends of a clip.
 *
 * Cutting straight from a windowed desktop to a floating handset is a jarring
 * change of physical scale. A short dip through the marketing grid covers the
 * change and reads as deliberate rather than as an edit mistake. One track with
 * four keys, not two tracks — two would fight, and the later one would win.
 */
const shellWipe = (durationMs: number): Track => ({
  prop: 'opacity',
  sel: '#wipe',
  keys: [
    [0, 1],
    [340, 0],
    [durationMs - 340, 0],
    [durationMs, 1],
  ],
  ease: 'inOut',
});

/**
 * Stats panel values easing, plus a trend line drawn from the trust series.
 *
 * The graph shares the trust keyframes, so its shape is the metric rather than
 * a decorative curve that happens to slope the right way. It also grows left to
 * right across the clip, which makes it a record of what just happened.
 */
const sideMove = (
  from: Record<string, number>,
  to: Record<string, number>,
  t0: number,
  t1: number,
  clipMs: number,
): Track[] => [
  ...Object.keys(to).flatMap((k) => [
    { prop: 'number' as const, sel: `#sg-${k}`, keys: [[t0, from[k]], [t1, to[k]]] as [number, number][], ease: 'out' as const },
    { prop: 'widthPct' as const, sel: `#sgb-${k}`, keys: [[t0, from[k]], [t1, to[k]]] as [number, number][], ease: 'out' as const },
  ]),
  {
    prop: 'spark' as const,
    sel: '#side-spark-path',
    keys: [[0, from.trust], [t0, from.trust], [t1, to.trust]] as [number, number][],
    from: 0,
    to: clipMs,
    w: 420,
    h: 130,
    min: 20,
    max: 85,
    ease: 'out' as const,
  },
];

/** Pointer path through a list of waypoints, with optional clicks. */
function cursor(points: [number, number, number][], clicks: number[] = [], subtle = false): Track {
  return {
    prop: 'cursor',
    x: points.map(([t, x]) => [t, x] as [number, number]),
    y: points.map(([t, , y]) => [t, y] as [number, number]),
    clicks,
    subtle,
    ease: 'inOut',
  };
}

const CALM = ['calm-iftar', 'calm-anniversary', 'calm-tuition', 'calm-mosque'];
const AMP_PAGE = 'AMP (Association for Muslim Professionals)';

/**
 * What was already said in the crisis channel.
 *
 * A crisis chat that is empty when you open it is the least believable thing in
 * the film — by this point the team has been in it for forty minutes. These sit
 * on screen from the first frame of every chat scene; only the new messages
 * animate in, and the view stays pinned near the bottom.
 */
const CHAT_HISTORY = [
  { from: 'Devi (Compliance)', text: 'Logging this as a live incident. Case file open, nothing cleared for release yet.' },
  { from: 'Shahrizal (Legal)', text: 'Do not confirm any figure. We have one internal number and it is not verified.' },
  { from: 'Daniel (Comms)', text: 'Three false claims trending now — frozen assistance, $1m shortfall, and a hotel photo.' },
  { from: 'Nurul Aisyah', text: 'Noted. Working on a holding line. Nobody replies to anything without me seeing it.', me: true },
];

// ---------------------------------------------------------------------------
// ACT I
// ---------------------------------------------------------------------------

const calmFeed = fbFeed(CALM.map((k) => fbPost(k, { id: `post-${k}` })), { composer: true });

const clip01: Clip = {
  id: 'seq01',
  seq: 1,
  title: 'The workstation',
  durationMs: 9000,
  html: desktop({ windows: [{ app: 'facebook', body: calmFeed, ...WIN }], taskbar: ['facebook'] }),
  tracks: [
    // The window is not there until she opens it.
    { prop: 'opacity', sel: '#win-facebook', keys: [[0, 0], [5600, 0]] },
    { prop: 'opacity', sel: '#task-facebook', keys: [[0, 0], [5600, 0], [5900, 1]] },
    ...windowOpen('facebook', 5700),
    // Idle, then cross to the Fakebook icon, then double-click.
    cursor(
      [
        [0, 1180, 690],
        [2600, 1180, 690],
        [4600, ICON.facebook[0], ICON.facebook[1]],
        [9000, ICON.facebook[0], ICON.facebook[1]],
      ],
      [5150, 5330],
    ),
    { prop: 'scale', sel: '#ic-facebook .dk-tile', keys: [[4600, 1], [4900, 1.08], [5400, 1.08], [5700, 1]] },
  ],
};

const clip02: Clip = {
  id: 'seq02',
  seq: 2,
  title: 'Scrolling',
  durationMs: 13000,
  html: desktop({ windows: [{ app: 'facebook', body: calmFeed, ...WIN }], taskbar: ['facebook'] }),
  tracks: [
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [5800, 420], [7200, 420], [11500, 980]], ease: 'inOut' },
    cursor([
      [0, 980, 520],
      [5800, 1010, 600],
      [13000, 1040, 640],
    ]),
    // The Messenger badge ticking up is the only thing that changes at the end.
    { prop: 'visible', sel: '#fb-badge', from: 9800, to: 13000 },
    ...pop('#fb-badge', 9800),
  ],
};

/**
 * The notification. Filmed before the DM itself, because a message that is
 * simply there when the scene cuts to it gives the audience no reason to
 * believe anybody noticed it arriving.
 */
const clip03a: Clip = {
  id: 'seq03a',
  seq: 3,
  title: 'A message arrives',
  durationMs: 8000,
  html: desktop({
    windows: [
      {
        app: 'facebook',
        body: fbFeedWithToast(CALM.map((k) => fbPost(k, { id: `post-${k}` })), {
          badge: true,
          toast: { from: 'Aisyah Kamal', preview: 'eh… is this about your company or not? 😬' },
        }),
        ...WIN,
      },
    ],
    taskbar: ['facebook'],
  }),
  tracks: [
    // Badge pops on the messenger icon, then the banner slides in from the right.
    { prop: 'opacity', sel: '#fb-badge', keys: [[0, 0], [1200, 0], [1500, 1]], ease: 'out' },
    { prop: 'scale', sel: '#fb-badge', keys: [[1200, 0], [1700, 1]], ease: 'back' },
    { prop: 'opacity', sel: '#fb-toast', keys: [[0, 0], [1500, 0], [1900, 1], [7400, 1], [7900, 0]] },
    { prop: 'x', sel: '#fb-toast', keys: [[1500, 60], [2100, 0]], ease: 'back' },
    { prop: 'scroll', sel: '#feed', keys: [[0, 120], [1400, 200]], ease: 'inOut' },
    // She reaches for the banner and clicks it.
    cursor(
      [
        [0, 900, 700],
        [2200, 900, 700],
        [4600, 1490, 205],
        [8000, 1490, 205],
      ],
      [5400],
    ),
  ],
};

const dmBody = messenger({
  from: 'Aisyah Kamal',
  badge: true,
  messages: [
    {
      text: 'eh… is this about your company or not? 😬',
      id: 'dm-1',
      time: '2m',
      shared: {
        author: 'CNA Local Updates',
        preview: 'AMP confirms financial mismanagement in one community programme following an internal review.',
        photo: PHOTOS.newsBuilding,
      },
    },
    { text: 'the whole feed is talking about it 😳', id: 'dm-2', time: 'now' },
  ],
});

const clip03: Clip = {
  id: 'seq03',
  seq: 3,
  title: 'The message',
  durationMs: 11000,
  html: desktop({ windows: [{ app: 'facebook', body: dmBody, ...WIN }], taskbar: ['facebook'] }),
  tracks: [
    { prop: 'opacity', sel: '#dm-1', keys: [[0, 0], [700, 0]] },
    ...pop('#dm-1', 800),
    { prop: 'opacity', sel: '#dm-2', keys: [[0, 0], [6200, 0]] },
    ...pop('#dm-2', 6300),
    cursor([
      [0, 1490, 205],
      [900, 1300, 300],
      [3200, 820, 520],
      [11000, 840, 560],
    ]),
  ],
};

/** The wire she lands on when the News app opens. */
const NEWS_WIRE = [
  {
    outlet: 'CNA Local Updates',
    headline: 'AMP confirms financial mismanagement in community programme',
    time: '18 min ago',
    photo: PHOTOS.newsBuilding,
    tag: 'BREAKING',
    id: 'nl-amp',
  },
  {
    outlet: 'The Independent Ledger',
    headline: '“Where did the money go?” Families demand answers from AMP',
    time: '34 min ago',
    photo: PHOTOS.crowdOutside,
    id: 'nl-ledger',
  },
  {
    outlet: 'Straits Business',
    headline: 'MAS holds rates as regional growth forecasts soften',
    time: '1 hr ago',
    id: 'nl-mas',
  },
  {
    outlet: 'CNA Local Updates',
    headline: 'Bukit Timah flood barrier works to begin next quarter',
    time: '2 hrs ago',
    id: 'nl-flood',
  },
  {
    outlet: 'Community Wire',
    headline: 'Volunteer numbers hit five-year high across self-help groups',
    time: '3 hrs ago',
    photo: PHOTOS.calmIftar,
    id: 'nl-vol',
  },
];

const newsBody = news({
  outlet: 'CNA Local Updates',
  headline: 'AMP confirms financial mismanagement in community programme',
  sub: 'Self-help group says issue is limited to one initiative; community groups call for full audit',
  photo: PHOTOS.newsBuilding,
  paras: [
    'The Association for Muslim Professionals has confirmed that an internal review identified financial management issues in one of its community programmes. In a statement, AMP said the matter had been formally disclosed and interim controls put in place.',
    'Community leaders have called for the scope of the review to be published. Several donors contacted by this newsroom said they were seeking assurances before renewing pledges.',
    'AMP said beneficiary services, including student bursaries and tuition support, are continuing on their normal schedule.',
  ],
  highlight: 'financial mismanagement',
});

const clip04: Clip = {
  id: 'seq04',
  seq: 4,
  title: 'Back to the desk',
  durationMs: 7000,
  html: desktop({
    windows: [
      { app: 'facebook', body: dmBody, ...WIN },
      { app: 'news', body: newsBody, x: 380, y: 130, w: 1180, h: 820 },
    ],
    taskbar: ['facebook', 'news'],
    minimised: ['facebook'],
  }),
  tracks: [
    ...windowMin('facebook', 900),
    { prop: 'opacity', sel: '#win-news', keys: [[0, 0], [4300, 0]] },
    { prop: 'opacity', sel: '#task-news', keys: [[0, 0], [4300, 0], [4600, 1]] },
    ...windowOpen('news', 4400),
    cursor(
      [
        [0, minBtn[0], minBtn[1]],
        [600, minBtn[0], minBtn[1]],
        [2600, ICON.news[0], ICON.news[1]],
        [7000, ICON.news[0], ICON.news[1]],
      ],
      [800, 3900, 4080],
    ),
    { prop: 'scale', sel: '#ic-news .dk-tile', keys: [[3400, 1], [3700, 1.08], [4200, 1.08], [4400, 1]] },
  ],
};

/** The wire first: scan competing headlines, then choose the one that matters. */
const clip05a: Clip = {
  id: 'seq05a',
  seq: 5,
  title: 'The newswire',
  durationMs: 9000,
  html: desktop({
    windows: [{ app: 'news', body: newsList({ items: NEWS_WIRE }), x: 380, y: 130, w: 1180, h: 820 }],
    taskbar: ['facebook', 'news'],
    minimised: ['facebook'],
  }),
  tracks: [
    { prop: 'scroll', sel: '#news-list', keys: [[0, 0], [2400, 0], [6000, 330], [7600, 60]], ease: 'inOut' },
    cursor(
      [
        [0, 700, 300],
        [1600, 780, 380],
        [4000, 820, 560],
        [6200, 800, 480],
        [7800, 700, 320],
        [9000, 700, 320],
      ],
      [8100],
      true,
    ),
  ],
};

const clip05: Clip = {
  id: 'seq05',
  seq: 5,
  title: 'The article',
  durationMs: 10000,
  html: desktop({
    windows: [{ app: 'news', body: newsBody, x: 380, y: 130, w: 1180, h: 820 }],
    taskbar: ['facebook', 'news'],
    minimised: ['facebook'],
  }),
  tracks: [
    { prop: 'scroll', sel: '#news-scroll', keys: [[0, 0], [3400, 0], [9400, 620]], ease: 'inOut' },
    // The guided read: down the copy with a slight horizontal wander.
    cursor(
      [
        [0, 470, 300],
        [800, 470, 320],
        [2600, 560, 430],
        [4600, 505, 545],
        [6600, 610, 640],
        [8600, 545, 700],
        [10000, 545, 710],
      ],
      [],
      true,
    ),
  ],
};

const crisisFeed = fbFeed(
  [
    fbPost('accusation', { id: 'p-acc', highlight: 'Name the programme. Publish the numbers.' }),
    fbPost('lie-frozen', { id: 'p-frozen' }),
    fbPost('lie-million', { id: 'p-million' }),
    fbPost('lie-luxury', { id: 'p-luxury' }),
    fbPost('crowd', { id: 'p-crowd' }),
    fbPost('media-share', { id: 'p-media' }),
  ],
  { composer: true },
);

const clip06: Clip = {
  id: 'seq06',
  seq: 6,
  title: 'The return',
  durationMs: 18000,
  html: desktop({
    windows: [
      { app: 'news', body: newsBody, x: 380, y: 130, w: 1180, h: 820 },
      { app: 'facebook', body: crisisFeed, ...WIN },
    ],
    taskbar: ['facebook', 'news'],
  }),
  tracks: [
    // Fakebook comes back up over the News window.
    { prop: 'opacity', sel: '#win-facebook', keys: [[0, 0], [1200, 0]] },
    ...windowOpen('facebook', 1300),
    // Posts land while she is reading, each one pushing the feed down.
    { prop: 'opacity', sel: '#p-frozen', keys: [[0, 0], [5600, 0]] },
    ...arrive('#p-frozen', 5700),
    { prop: 'opacity', sel: '#p-million', keys: [[0, 0], [8400, 0]] },
    ...arrive('#p-million', 8500),
    { prop: 'opacity', sel: '#p-luxury', keys: [[0, 0], [12200, 0]] },
    ...arrive('#p-luxury', 12300),
    { prop: 'opacity', sel: '#p-crowd', keys: [[0, 0], [15000, 0]] },
    ...arrive('#p-crowd', 15100),
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [4200, 0], [11000, 300], [17600, 1180]], ease: 'inOut' },
    cursor([
      [0, taskX(0), TASK_Y],
      [900, taskX(0), TASK_Y],
      [2600, 1000, 500],
      [11000, 1030, 560],
      [18000, 1060, 600],
    ], [1000]),
    // Engagement on the accusation climbing through the whole clip.
    { prop: 'number', sel: '#p-acc-likes', keys: [[0, 2140], [18000, 5980]], ease: 'linear' },
    { prop: 'number', sel: '#p-acc-shares', keys: [[0, 1870], [18000, 4410]], ease: 'linear' },
    { prop: 'number', sel: '#p-acc-views', keys: [[0, 184000], [18000, 402000]], ease: 'linear' },
  ],
};

// ---------------------------------------------------------------------------
// ACT II — the question. Filmed on a handset, because that is where she reads.
// ---------------------------------------------------------------------------

const ECHOES = [
  ['Rohana Bte Salleh', 'Sama. Saya apply bulan lepas, sampai sekarang tak dengar apa-apa. Anak saya Sec 3.'],
  ['Zulkarnain', 'Just tell us yes or no lah. We can plan. It is the not knowing that kills.'],
  ['Mdm Kalthom', 'Saya call office tiga kali. Tiada orang angkat.'],
  ['Hakim', 'My sister works there. Even she doesn’t know what to tell people.'],
  ['Nur Ain', 'Sekolah buka minggu depan. Tolonglah jawab satu soalan sahaja.'],
] as const;

const clip07: Clip = {
  id: 'seq07',
  seq: 7,
  title: 'Her question',
  durationMs: 15000,
  html:
    phone(
      fbFeed([
        fbPost('question', {
          id: 'p-q',
          highlight: 'Tolong jawab.',
          comments: ECHOES.map(([name, text], i) => ({ name, text, id: `ec-${i}` })),
        }),
      ]),
      {
        bg: 'crisis-social-feed.jpg',
        stats: {
          gauges: [
            { key: 'trust', label: 'Public Trust', value: 62 },
            { key: 'narrative', label: 'Narrative Control', value: 44 },
            { key: 'risk', label: 'Escalation Risk', value: 51, invert: true },
          ],
          trend: 'falling',
          caption: 'One unanswered question, and every reply under it makes the next one harder.',
        },
      },
    ) + wipe(),
  tracks: [
    shellWipe(15000),
    // Sentiment slides while the replies stack up. Cause on the left of frame,
    // consequence on the right, in the same shot.
    ...sideMove(
      { trust: 62, narrative: 44, risk: 51 },
      { trust: 54, narrative: 36, risk: 62 },
      7600,
      14200,
      15000,
    ),
    { prop: 'opacity', sel: '#side-panel', keys: [[0, 0], [900, 0], [1600, 1]], ease: 'out' },
    { prop: 'x', sel: '#side-panel', keys: [[900, 40], [1700, 0]], ease: 'out' },
    ...ECHOES.flatMap((_, i) => [
      { prop: 'opacity' as const, sel: `#ec-${i}`, keys: [[0, 0], [7600 + i * 1400, 0]] as [number, number][] },
      ...pop(`#ec-${i}`, 7700 + i * 1400),
    ]),
    // Do not move. Her name, her question, the photo and the first replies all
    // fit the frame at rest, and any creep at all clips the post header — which
    // costs the audience the face and handle behind the words. The later
    // comments arriving off the bottom edge is a cheaper loss than that.
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [15000, 0]] },
  ],
};

// ---------------------------------------------------------------------------
// ACT III — the lie outruns the truth
// ---------------------------------------------------------------------------

const pileFeed = fbFeed([
  fbPost('lie-frozen', { id: 'p-frozen', counters: { likes: 3310, shares: 2940, views: 297000 } }),
  fbPost('lie-million', { id: 'p-million' }),
  fbPost('lie-luxury', { id: 'p-luxury' }),
  fbPost('rival', { id: 'p-rival' }),
]);

const clip08: Clip = {
  id: 'seq08',
  seq: 8,
  title: 'The pile-on',
  durationMs: 15000,
  html:
    phone(pileFeed, {
      bg: 'crisis-reputational.jpg',
      stats: {
        gauges: [
          { key: 'trust', label: 'Public Trust', value: 54 },
          { key: 'narrative', label: 'Narrative Control', value: 36 },
          { key: 'risk', label: 'Escalation Risk', value: 62, invert: true },
        ],
        trend: 'falling',
        caption: 'Nobody has said anything yet. The numbers do not wait for you.',
      },
    }) + wipe(),
  tracks: [
    shellWipe(15000),
    ...sideMove(
      { trust: 54, narrative: 36, risk: 62 },
      { trust: 48, narrative: 29, risk: 74 },
      4400,
      12000,
      15000,
    ),
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [3400, 1500], [4200, 1180], [15000, 1180]], ease: 'inOut' },
    // Counters climbing while he looks at it. This is the cost of the pause.
    { prop: 'number', sel: '#p-frozen-likes', keys: [[4400, 3310], [11000, 7940]], ease: 'linear' },
    { prop: 'number', sel: '#p-frozen-shares', keys: [[4400, 2940], [11000, 6213]], ease: 'linear' },
    { prop: 'number', sel: '#p-frozen-views', keys: [[4400, 297000], [11000, 512884]], ease: 'linear' },
    { prop: 'opacity', sel: '#p-rival', keys: [[0, 0], [11600, 0]] },
    ...arrive('#p-rival', 11700),
  ],
};

const PRESSURE = [
  ['Rosli B.', 'And they still ask for donations every Ramadan. Shameless.'],
  ['Accountability Watch SG', 'Still no statement. Silence is an answer too.'],
  ['Jenn Low', 'Cancelled my monthly giro this morning. Enough.'],
  ['Hafizah', 'My mother queued four hours last week. FOUR HOURS.'],
] as const;

const clip09: Clip = {
  id: 'seq09',
  seq: 9,
  title: 'The photograph',
  durationMs: 14000,
  html: desktop({
    windows: [
      {
        app: 'facebook',
        body: fbFeed([
          fbPost('lie-luxury', {
            id: 'p-lux',
            highlight: 'VIP hotel dinners charged to the programme account',
            counters: { likes: 4120, shares: 3380, views: 312000 },
            comments: PRESSURE.map(([name, text], i) => ({ name, text, id: `pr-${i}` })),
          }),
        ]),
        ...WIN,
      },
    ],
    taskbar: ['facebook'],
  }),
  tracks: [
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [3000, 150]], ease: 'inOut' },
    { prop: 'number', sel: '#p-lux-likes', keys: [[5000, 4120], [13000, 9880]], ease: 'linear' },
    { prop: 'number', sel: '#p-lux-shares', keys: [[5000, 3380], [13000, 8104]], ease: 'linear' },
    { prop: 'number', sel: '#p-lux-views', keys: [[5000, 312000], [13000, 411203]], ease: 'linear' },
    ...PRESSURE.flatMap((_, i) => [
      { prop: 'opacity' as const, sel: `#pr-${i}`, keys: [[0, 0], [6800 + i * 1300, 0]] as [number, number][] },
      ...pop(`#pr-${i}`, 6900 + i * 1300),
    ]),
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [3000, 150], [7200, 330], [13600, 880]], ease: 'inOut' },
  ],
};

/** Land on the inbox. The count of unread things is the pressure. */
const clip10a: Clip = {
  id: 'seq10a',
  seq: 10,
  title: 'The inbox',
  durationMs: 9000,
  html: desktop({
    windows: [
      { app: 'email', body: mailInbox({ focus: 'email-press', arrivingId: 'mail-new' }), x: 420, y: 120, w: 1100, h: 840 },
    ],
    taskbar: ['email'],
  }),
  tracks: [
    { prop: 'opacity', sel: '#win-email', keys: [[0, 0], [900, 0]] },
    ...windowOpen('email', 1000),
    // The press deadline drops into the list while she is looking at it.
    { prop: 'opacity', sel: '#mail-new', keys: [[0, 0], [3400, 0]] },
    ...arrive('#mail-new', 3500),
    cursor(
      [
        [0, ICON.email[0], ICON.email[1]],
        [600, ICON.email[0], ICON.email[1]],
        [2600, 700, 320],
        [5200, 720, 300],
        [7600, 700, 300],
        [9000, 700, 300],
      ],
      [700, 880, 7800],
      true,
    ),
  ],
};

const clip10: Clip = {
  id: 'seq10',
  seq: 10,
  title: 'The deadline',
  durationMs: 11000,
  html: desktop({
    windows: [{ app: 'email', body: mailRead('email-press', { highlight: 'Our deadline is 6pm today.' }), x: 420, y: 120, w: 1100, h: 840 }],
    taskbar: ['email'],
  }),
  tracks: [
    { prop: 'scroll', sel: '#mail-scroll', keys: [[0, 0], [2400, 0], [9200, 340]], ease: 'inOut' },
    cursor(
      [
        [0, 640, 300],
        [1800, 640, 360],
        [3800, 720, 470],
        [5800, 660, 580],
        [8000, 760, 660],
        [10200, 700, 700],
        [11000, 700, 705],
      ],
      [],
      true,
    ),
  ],
};

const clip11: Clip = {
  id: 'seq11',
  seq: 11,
  title: 'Outside',
  durationMs: 7000,
  html: desktop({
    windows: [
      {
        app: 'facebook',
        body: fbFeed([
          fbPost('crowd', { id: 'p-crowd', highlight: 'nobody is coming out to talk to them' }),
          fbPost('lie-million', { id: 'p-m2' }),
        ]),
        ...WIN,
      },
    ],
    taskbar: ['facebook'],
  }),
  tracks: [
    { prop: 'opacity', sel: '#p-crowd', keys: [[0, 0], [600, 0]] },
    ...arrive('#p-crowd', 700),
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [6600, 220]], ease: 'inOut' },
  ],
};

const GAUGES_FALL = [
  { key: 'trust', label: 'Public Trust', value: 48 },
  { key: 'safety', label: 'Stakeholder Confidence', value: 61 },
  { key: 'narrative', label: 'Narrative Control', value: 29 },
  { key: 'risk', label: 'Escalation Risk', value: 74, invert: true },
];

/** Gauges easing to new values, with the trend line drawing in behind them. */
const gaugeMove = (
  from: Record<string, number>,
  to: Record<string, number>,
  t0: number,
  t1: number,
): Track[] =>
  Object.keys(to).flatMap((k) => [
    { prop: 'number' as const, sel: `#g-${k}`, keys: [[t0, from[k]], [t1, to[k]]] as [number, number][], ease: 'out' as const },
    { prop: 'widthPct' as const, sel: `#gb-${k}`, keys: [[t0, from[k]], [t1, to[k]]] as [number, number][], ease: 'out' as const },
  ]);

const clip12: Clip = {
  id: 'seq12',
  seq: 12,
  title: 'The drop',
  durationMs: 6000,
  html: dashboard({ gauges: GAUGES_FALL, overall: 48, trend: 'falling', alert: 'ESCALATION RISK HIGH' }),
  tracks: [
    ...gaugeMove(
      { trust: 71, safety: 78, narrative: 64, risk: 22, overall: 71 },
      { trust: 48, safety: 61, narrative: 29, risk: 74, overall: 48 },
      600,
      4200,
    ),
    { prop: 'draw', sel: '#spark-path', keys: [[600, 0], [4400, 1]], ease: 'out' },
    { prop: 'opacity', sel: '#dash-alert', keys: [[0, 0], [3600, 0], [4000, 1]], ease: 'out' },
    { prop: 'scale', sel: '#dash-alert', keys: [[3600, 0.96], [4200, 1]], ease: 'back' },
  ],
};

// ---------------------------------------------------------------------------
// ACT IV — fighting back
// ---------------------------------------------------------------------------

const clip13: Clip = {
  id: 'seq13',
  seq: 13,
  title: 'Reading for the lie',
  durationMs: 9000,
  html: desktop({
    windows: [
      {
        app: 'facebook',
        body: fbFeed([
          fbPost('lie-million', { id: 'p-m' }),
          fbPost('lie-frozen', { id: 'p-f', highlight: 'ALL AMP assistance has been frozen' }),
        ]),
        ...WIN,
      },
    ],
    taskbar: ['facebook'],
  }),
  tracks: [
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [5200, 380], [9000, 380]], ease: 'inOut' },
    cursor(
      [
        [0, 620, 300],
        [1400, 700, 380],
        [2800, 650, 450],
        [4600, 760, 400],
        [6400, 690, 470],
        [9000, 700, 480],
      ],
      [],
      true,
    ),
  ],
};

/**
 * Where the facts come from.
 *
 * Without this, Grace flags a post citing a case reference and a freeze notice
 * she was never shown learning — which makes her look omniscient and makes the
 * product look like it hands you the answers. Checking the brief and asking a
 * colleague first is the actual skill being trained.
 */
const clip13b: Clip = {
  id: 'seq13b',
  seq: 13,
  title: 'Checking before acting',
  durationMs: 16000,
  html: desktop({
    windows: [
      {
        app: 'chat',
        body: chat({
          channel: 'Crisis Cell — Comms + Legal',
          messages: [
            ...CHAT_HISTORY,
            { from: 'Grace (Legal)', text: 'Two claims going round I want to kill. Freeze notice — do we have one?', me: true, id: 'v1' },
            { from: 'Shahrizal (Legal)', text: 'No. Nothing received, nothing issued. I have the Finance confirmation in writing.', id: 'v2' },
            { from: 'Grace (Legal)', text: 'And can I quote the case reference publicly?', me: true, id: 'v3' },
            { from: 'Shahrizal (Legal)', text: 'Yes. AMP-IR-2026-014 is cleared for release. Scope is Community Uplift only.', id: 'v4' },
          ],
        }),
        x: 460,
        y: 110,
        w: 1000,
        h: 860,
      },
    ],
    taskbar: ['facebook', 'chat'],
    minimised: ['facebook'],
  }),
  tracks: [
    { prop: 'opacity', sel: '#win-chat', keys: [[0, 0], [800, 0]] },
    ...windowOpen('chat', 900),
    { prop: 'scroll', sel: '#chat-scroll', keys: [[0, 900], [2400, 1000], [13000, 1400]], ease: 'inOut' },
    ...[
      ['#v1', 2400],
      ['#v2', 5600],
      ['#v3', 9200],
      ['#v4', 12200],
    ].flatMap(([sel, at]) => [
      { prop: 'opacity' as const, sel: sel as string, keys: [[0, 0], [at as number, 0]] as [number, number][] },
      ...pop(sel as string, (at as number) + 100),
    ]),
    cursor([
      [0, ICON.chat[0], ICON.chat[1]],
      [700, ICON.chat[0], ICON.chat[1]],
      [2000, 900, 940],
      [16000, 900, 940],
    ], [800, 980]),
  ],
};

const REPORT_REASON =
  'No account freeze notice has been issued or received. Bursary and tuition disbursements are running on schedule. Review scope published under case reference AMP-IR-2026-014.';

const clip14: Clip = {
  id: 'seq14',
  seq: 14,
  title: 'Report it',
  durationMs: 16000,
  html:
    desktop({
      windows: [{ app: 'facebook', body: fbFeed([fbPost('lie-frozen', { id: 'p-f' })]), ...WIN }],
      taskbar: ['facebook'],
    }) + reportSheet({ selected: 'misinformation', reasonId: 'rp-reason' }),
  tracks: [
    { prop: 'opacity', sel: '#report-sheet', keys: [[0, 0], [1500, 0], [1900, 1]], ease: 'out' },
    { prop: 'scale', sel: '#report-sheet', keys: [[1500, 0.95], [1900, 1]], ease: 'back' },
    { prop: 'classAt', sel: '#opt-misinformation', class: 'on', at: 3900 },
    typeInto('#rp-reason', REPORT_REASON, 5400, 12200),
    // Submit, sheet away, and the post's report icon left amber.
    { prop: 'opacity', sel: '#report-sheet', keys: [[13200, 1], [13600, 0]], ease: 'in' },
    { prop: 'classAt', sel: '#p-f-report', class: 'flagged', at: 13600 },
    { prop: 'scale', sel: '#p-f-report', keys: [[13600, 1], [13900, 1.5], [14400, 1]], ease: 'back' },
    cursor(
      [
        [0, 1240, 300],
        [1300, 1240, 300],
        [3400, 700, 430],
        [5100, 700, 620],
        [12600, 960, 830],
        [16000, 960, 830],
      ],
      [1500, 3700, 13100],
    ),
  ],
};

const DISPUTE_NOTE =
  'The article states all assistance has been frozen. This is false. No freeze notice has been issued or received, and bursary disbursement is running on its normal schedule. Independent review scope is published under AMP-IR-2026-014.';

const ledger = news({
  outlet: 'The Independent Ledger',
  headline: '“Where did the money go?” Families demand answers from AMP',
  sub: 'Claims of frozen assistance spread online as the organisation stays silent',
  paras: [
    'Families who rely on AMP assistance say they have been left in the dark as unverified claims circulate on social media, including assertions that all support has been frozen.',
    '“Next month school opens. I have waited three weeks,” said one caregiver who asked to be identified only as Puan Siti.',
    'AMP had not responded to requests for comment at the time of publication.',
  ],
  highlight: 'all support has been frozen',
});

const clip15: Clip = {
  id: 'seq15',
  seq: 15,
  title: 'Take the article down',
  durationMs: 22000,
  html:
    desktop({
      windows: [{ app: 'news', body: ledger, x: 380, y: 130, w: 1180, h: 820 }],
      taskbar: ['facebook', 'news'],
      minimised: ['facebook'],
    }) + disputeSheet({ noteId: 'dp-note' }),
  tracks: [
    { prop: 'opacity', sel: '#win-news', keys: [[0, 0], [2200, 0]] },
    ...windowOpen('news', 2300),
    { prop: 'scroll', sel: '#news-scroll', keys: [[0, 0], [4200, 0], [7400, 330]], ease: 'inOut' },
    { prop: 'opacity', sel: '#dispute-sheet', keys: [[0, 0], [9200, 0], [9600, 1]], ease: 'out' },
    { prop: 'scale', sel: '#dispute-sheet', keys: [[9200, 0.95], [9600, 1]], ease: 'back' },
    typeInto('#dp-note', DISPUTE_NOTE, 10600, 18400),
    { prop: 'opacity', sel: '#dispute-submit', keys: [[19400, 1], [19700, 0.5], [20000, 1]] },
    cursor(
      [
        [0, 200, 700],
        [900, ICON.news[0], ICON.news[1]],
        [3400, 700, 620],
        [8400, 620, 780],
        [10200, 900, 560],
        [19000, 960, 900],
        [22000, 960, 900],
      ],
      [1700, 1880, 8600, 19400],
    ),
  ],
};

const clip16: Clip = {
  id: 'seq16',
  seq: 16,
  title: 'It works',
  durationMs: 9000,
  html: desktop({
    windows: [
      {
        app: 'news',
        body: news({
          outlet: 'The Independent Ledger',
          headline: '“Where did the money go?” Families demand answers from AMP',
          sub: 'Claims of frozen assistance spread online as the organisation stays silent',
          paras: [
            'Families who rely on AMP assistance say they have been left in the dark as unverified claims circulate on social media.',
          ],
          retracted:
            'Retracted: the claim that all assistance was frozen is not supported. No freeze notice exists.',
        }),
        x: 380,
        y: 130,
        w: 1180,
        h: 820,
      },
    ],
    taskbar: ['facebook', 'news'],
    minimised: ['facebook'],
  }),
  tracks: [
    { prop: 'opacity', sel: '#retract-banner', keys: [[0, 0], [1400, 0], [1900, 1]], ease: 'out' },
    { prop: 'y', sel: '#retract-banner', keys: [[1400, -18], [2000, 0]], ease: 'back' },
    { prop: 'opacity', sel: '.news-h1', keys: [[0, 1], [2200, 1], [3000, 0.6]], ease: 'out' },
  ],
};

// ---------------------------------------------------------------------------
// ACT V — the mistake
// ---------------------------------------------------------------------------

const chatArgument = chat({
  channel: 'Crisis Cell — Comms + Legal',
  messages: [
    ...CHAT_HISTORY,
    { from: 'Nurul Aisyah', text: 'We are 40 minutes into silence. Something has to go out.', me: true, id: 'm1' },
    { from: 'Shahrizal (Legal)', text: 'Not until I have the case reference. We cannot confirm a figure we do not have.', id: 'm2' },
    { from: 'Nurul Aisyah', text: 'Then a holding line. Just put something out now.', me: true, id: 'm3' },
    { from: 'Shahrizal (Legal)', text: 'A holding line that says nothing will be read as a dodge.', id: 'm4' },
  ],
});

const clip17: Clip = {
  id: 'seq17',
  seq: 17,
  title: 'The argument',
  durationMs: 17000,
  html: desktop({
    windows: [{ app: 'chat', body: chatArgument, x: 460, y: 110, w: 1000, h: 860 }],
    taskbar: ['chat'],
  }),
  tracks: [
    { prop: 'opacity', sel: '#win-chat', keys: [[0, 0], [1000, 0]] },
    ...windowOpen('chat', 1100),
    { prop: 'scroll', sel: '#chat-scroll', keys: [[0, 900], [2600, 1000], [14000, 1400]], ease: 'inOut' },
    ...[
      ['#m1', 2600],
      ['#m2', 6400],
      ['#m3', 10000],
      ['#m4', 13600],
    ].flatMap(([sel, at]) => [
      { prop: 'opacity' as const, sel: sel as string, keys: [[0, 0], [at as number, 0]] as [number, number][] },
      ...pop(sel as string, (at as number) + 100),
    ]),
    cursor([
      [0, ICON.chat[0], ICON.chat[1]],
      [800, ICON.chat[0], ICON.chat[1]],
      [2200, 900, 940],
      [17000, 900, 940],
    ], [900, 1080]),
  ],
};

const WEAK =
  'We are aware of the concerns being raised online and we take them seriously. AMP is committed to accountability and we will share more information in due course.';

const clip18: Clip = {
  id: 'seq18',
  seq: 18,
  title: 'Typing it anyway',
  durationMs: 17000,
  html:
    desktop({
      windows: [{ app: 'facebook', body: fbCompose({ pageName: AMP_PAGE, textId: 'cmp-a' }), ...WIN }],
      taskbar: ['facebook', 'chat'],
      minimised: ['chat'],
    }),
  tracks: [
    { prop: 'opacity', sel: '#cmp-aspage', keys: [[0, 0.35], [2400, 0.35], [2800, 1]], ease: 'out' },
    { prop: 'scale', sel: '#cmp-aspage', keys: [[2400, 0.94], [2900, 1]], ease: 'back' },
    typeInto('#cmp-a', WEAK, 3800, 13000),
    { prop: 'scale', sel: '#cmp-post', keys: [[14200, 1], [14400, 0.93], [14700, 1]], ease: 'back' },
    { prop: 'opacity', sel: '.cmp', keys: [[15200, 1], [15700, 0]], ease: 'in' },
    cursor(
      [
        [0, 1300, 260],
        [2000, 1080, 300],
        [3400, 760, 430],
        [13600, 1420, 300],
        [17000, 1420, 300],
      ],
      [2500, 14200],
    ),
  ],
};

const CALLOUTS = [
  ['Accountability Watch SG', 'This is not an answer. Which programme? How much? You had all day.'],
  ['Rosli B.', '“In due course” = we are still deciding what to admit.'],
  ['Jenn Low', 'Zero numbers. Zero names. Zero dates. Try again.'],
  ['Puan Siti Rahimah', 'Saya baca tiga kali. Masih tak tahu anak saya dapat bantuan atau tidak.'],
  ['Hakim', 'A mother asked you one question. Answer the mother.'],
] as const;

const clip19: Clip = {
  id: 'seq19',
  seq: 19,
  title: 'The call-out',
  durationMs: 12000,
  html:
    phone(
      fbFeed([
        fbPost('accusation', {
          id: 'p-weak',
          comments: CALLOUTS.map(([name, text], i) => ({ name, text, id: `co-${i}` })),
        }),
      ]),
      {
        bg: 'crisis-comms-response.jpg',
        stats: {
          gauges: [
            { key: 'trust', label: 'Public Trust', value: 48 },
            { key: 'narrative', label: 'Narrative Control', value: 29 },
            { key: 'risk', label: 'Escalation Risk', value: 74, invert: true },
          ],
          trend: 'falling',
          caption: 'A statement with no specifics costs more than saying nothing.',
        },
      },
    ) + wipe(),
  tracks: [
    shellWipe(12000),
    ...sideMove(
      { trust: 48, narrative: 29, risk: 74 },
      { trust: 41, narrative: 24, risk: 81 },
      3000,
      10800,
      12000,
    ),
    ...CALLOUTS.flatMap((_, i) => [
      { prop: 'opacity' as const, sel: `#co-${i}`, keys: [[0, 0], [2400 + i * 1500, 0]] as [number, number][] },
      ...pop(`#co-${i}`, 2500 + i * 1500),
    ]),
    // Same discipline: keep the statement they are tearing apart on screen, or
    // the replies are just angry text with nothing to be angry at.
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [2600, 120], [11600, 560]], ease: 'inOut' },
  ],
};

const clip20: Clip = {
  id: 'seq20',
  seq: 20,
  title: 'Breach',
  durationMs: 5000,
  html: dashboard({
    gauges: [
      { key: 'trust', label: 'Public Trust', value: 41 },
      { key: 'safety', label: 'Stakeholder Confidence', value: 58 },
      { key: 'narrative', label: 'Narrative Control', value: 24 },
      { key: 'risk', label: 'Escalation Risk', value: 81, invert: true },
    ],
    overall: 41,
    trend: 'falling',
    alert: 'SOP BREACH — statement issued without verification',
  }),
  tracks: [
    ...gaugeMove(
      { trust: 48, safety: 61, narrative: 29, risk: 74, overall: 48 },
      { trust: 41, safety: 58, narrative: 24, risk: 81, overall: 41 },
      300,
      2600,
    ),
    { prop: 'draw', sel: '#spark-path', keys: [[300, 0], [3000, 1]], ease: 'out' },
    { prop: 'opacity', sel: '#dash-alert', keys: [[0, 0], [2400, 0], [2700, 1], [3000, 0.4], [3300, 1]], ease: 'out' },
  ],
};

// ---------------------------------------------------------------------------
// ACT VI — the turn
// ---------------------------------------------------------------------------

const chatCleared = chat({
  channel: 'Crisis Cell — Comms + Legal',
  messages: [
    ...CHAT_HISTORY,
    { from: 'Nurul Aisyah', text: 'Statement is out and it is being taken apart. I need something specific, now.', me: true },
    { from: 'Shahrizal (Legal)', text: 'Case ref AMP-IR-2026-014 cleared for release.', id: 'c1' },
    { from: 'Shahrizal (Legal)', text: 'Scope is the Community Uplift Initiative only. No account freeze notice exists.', id: 'c2' },
    { from: 'Shahrizal (Legal)', text: 'Bursary disbursement schedule unaffected — confirmed with Finance.', id: 'c3' },
    { from: 'Nurul Aisyah', text: 'Good. Rewriting now. Naming the programme and the reference.', me: true, id: 'c4' },
  ],
});

const clip21: Clip = {
  id: 'seq21',
  seq: 21,
  title: 'Cleared',
  durationMs: 11000,
  html: desktop({
    windows: [{ app: 'chat', body: chatCleared, x: 460, y: 110, w: 1000, h: 860 }],
    taskbar: ['facebook', 'chat'],
    minimised: ['facebook'],
  }),
  tracks: [
    // Three facts land fast, then her decision. Act V was an argument; this is
    // a handover, and the tempo is what says so.
    ...[
      ['#c1', 900],
      ['#c2', 2400],
      ['#c3', 3900],
      ['#c4', 6200],
    ].flatMap(([sel, at]) => [
      { prop: 'opacity' as const, sel: sel as string, keys: [[0, 0], [at as number, 0]] as [number, number][] },
      ...pop(sel as string, (at as number) + 100),
    ]),
  ],
};

/**
 * The directive.
 *
 * Nobody improvises a crisis statement. Somebody senior writes the approved
 * lines and the team works from them — and without showing that, the good
 * statement in the next sequence looks like a lucky guess rather than the
 * product of a process the training teaches.
 */
const clip21b: Clip = {
  id: 'seq21b',
  seq: 21,
  title: 'The approved lines',
  durationMs: 15000,
  html: desktop({
    windows: [
      {
        app: 'email',
        body: mailRead('email-directive', { highlight: 'Use these words.' }),
        x: 420,
        y: 110,
        w: 1120,
        h: 860,
      },
    ],
    taskbar: ['email', 'chat'],
    minimised: ['chat'],
  }),
  tracks: [
    { prop: 'opacity', sel: '#win-email', keys: [[0, 0], [800, 0]] },
    ...windowOpen('email', 900),
    // Read down the approved list, then the do-not-say list.
    { prop: 'scroll', sel: '#mail-scroll', keys: [[0, 0], [3400, 0], [9000, 300], [14200, 560]], ease: 'inOut' },
    cursor(
      [
        [0, ICON.email[0], ICON.email[1]],
        [600, ICON.email[0], ICON.email[1]],
        [2600, 620, 330],
        [5000, 700, 450],
        [7400, 640, 560],
        [10200, 730, 630],
        [13000, 660, 690],
        [15000, 660, 700],
      ],
      [700, 880],
      true,
    ),
  ],
};

const STATEMENT =
  'The review concerns one programme: the Community Uplift Initiative. Case reference AMP-IR-2026-014. No assistance has been frozen. Bursary and tuition disbursements are running on schedule — the counter was open this morning. Claims of a $1m shortfall are false and we have asked for them to be corrected.';

const clip22: Clip = {
  id: 'seq22',
  seq: 22,
  title: 'The rewrite',
  durationMs: 18000,
  html: desktop({
    windows: [
      {
        app: 'facebook',
        body: fbCompose({ pageName: AMP_PAGE, textId: 'cmp-b', attachment: PHOTOS.communityHall }),
        ...WIN,
      },
    ],
    taskbar: ['facebook', 'chat'],
    minimised: ['chat'],
  }),
  tracks: [
    typeInto('#cmp-b', STATEMENT, 600, 13000),
    // The photograph that answers the photograph.
    { prop: 'opacity', sel: '#cmp-attach', keys: [[0, 0], [13400, 0], [14000, 1]], ease: 'out' },
    { prop: 'y', sel: '#cmp-attach', keys: [[13400, 18], [14100, 0]], ease: 'back' },
    { prop: 'scale', sel: '#cmp-post', keys: [[15600, 1], [15800, 0.93], [16100, 1]], ease: 'back' },
    cursor([
      [0, 700, 430],
      [13000, 700, 430],
      [15200, 1420, 300],
      [18000, 1420, 300],
    ], [15600]),
  ],
};

/**
 * Working as the organisation.
 *
 * The single clearest way to show what this software actually simulates: the
 * operator is not a person with opinions, they are a page with an inbox, and
 * the public is queueing in it. Notifications first for volume, then the DMs
 * for the fact that these are individuals asking individual questions.
 */
const PAGE_NOTIFS = [
  ['Accountability Watch SG', 'commented on your post: “Still no numbers.”'],
  ['Puan Siti Rahimah', 'sent a message asking about her application'],
  ['Rosli B.', 'shared your post with 2.1k followers'],
  ['Jenn Low', 'commented: “Are donations suspended or not?”'],
  ['Masjid Al-Nur', 'asked whether to continue referrals this week'],
  ['Hafizah', 'commented on your post: “Four hours in that queue.”'],
] as const;

const clip22b: Clip = {
  id: 'seq22b',
  seq: 22,
  title: 'Speaking as the page',
  durationMs: 13000,
  html: desktop({
    windows: [
      {
        app: 'facebook',
        body: pageNotifications(
          PAGE_NOTIFS.map(([who, what], i) => ({ who, what, id: `nt-${i}` })),
        ),
        ...WIN,
      },
    ],
    taskbar: ['facebook'],
  }),
  tracks: [
    ...PAGE_NOTIFS.flatMap((_, i) => [
      { prop: 'opacity' as const, sel: `#nt-${i}`, keys: [[0, 0], [700 + i * 620, 0]] as [number, number][] },
      ...pop(`#nt-${i}`, 800 + i * 620),
    ]),
    cursor([
      [0, 1200, 300],
      [2400, 900, 420],
      [7000, 940, 620],
      [13000, 960, 700],
    ], [], true),
  ],
};

const clip22c: Clip = {
  id: 'seq22c',
  seq: 22,
  title: 'The page inbox',
  durationMs: 12000,
  html: desktop({
    windows: [
      {
        app: 'facebook',
        body: messenger({
          from: 'Puan Siti Rahimah',
          asPage: 'AMP',
          threads: [
            { name: 'Puan Siti Rahimah', preview: 'Anak saya dapat bantuan atau tidak?', unread: true, active: true },
            { name: 'Masjid Al-Nur', preview: 'Should we continue referrals?', unread: true },
            { name: 'StraitBay Foundation', preview: 'Tranche 2 remains on hold', unread: true },
            { name: 'Rohana Bte Salleh', preview: 'Saya apply bulan lepas…', unread: true },
          ],
          messages: [
            { text: 'Assalamualaikum. Saya tanya sekali lagi — anak saya dapat bantuan sekolah atau tidak?', id: 'pm-1', time: '4m' },
            { text: 'Sekolah buka minggu depan. Saya perlu tahu hari ini.', id: 'pm-2', time: '1m' },
          ],
        }),
        ...WIN,
      },
    ],
    taskbar: ['facebook'],
  }),
  tracks: [
    { prop: 'opacity', sel: '#pm-1', keys: [[0, 0], [1400, 0]] },
    ...pop('#pm-1', 1500),
    { prop: 'opacity', sel: '#pm-2', keys: [[0, 0], [6400, 0]] },
    ...pop('#pm-2', 6500),
    cursor([
      [0, 1300, 260],
      [1800, 560, 300],
      [5200, 880, 520],
      [12000, 900, 580],
    ], [2000], true),
  ],
};

/**
 * The organisation's own page.
 *
 * Two things this earns that nothing else in the film does: the operator is
 * demonstrably not posting as themselves, and the page has a history — what
 * AMP has already said is the context every new statement is judged against.
 * Scrolling their own back catalogue before writing is what a real comms lead
 * does, and it is why the next post can be consistent with the last one.
 */
const AMP_PAGE_POSTS = [
  {
    text: 'Our bursary counter is open Tuesday and Thursday, 9am–5pm. Walk-ins welcome — bring your IC and latest payslip if you have one.',
    time: '3 days ago',
    likes: '412',
    comments: '38',
    photo: PHOTOS.communityHall,
    id: 'pp-1',
  },
  {
    text: 'Congratulations to the 240 students who completed the tuition programme this term. To every volunteer who gave up their Saturdays — thank you.',
    time: '1 week ago',
    likes: '1.8K',
    comments: '96',
    id: 'pp-2',
  },
  {
    text: 'AMP has commissioned an independent review of one of our community programmes. We will publish the scope once it is finalised.',
    time: '2 weeks ago',
    likes: '203',
    comments: '311',
    id: 'pp-3',
  },
];

const clip22a: Clip = {
  id: 'seq22a',
  seq: 22,
  title: 'The organisation’s page',
  durationMs: 16000,
  html: desktop({
    windows: [
      {
        app: 'facebook',
        body: orgPage({
          name: 'AMP',
          handle: '@AMPSingapore',
          bio: 'Association for Muslim Professionals · Community development since 1991',
          followers: '48,210',
          posts: AMP_PAGE_POSTS,
          composerId: 'pg-compose',
        }),
        ...WIN,
      },
    ],
    taskbar: ['facebook', 'chat'],
    minimised: ['chat'],
  }),
  tracks: [
    // Down through what the page has already said, then back to the composer.
    { prop: 'scroll', sel: '#page-scroll', keys: [[0, 0], [2200, 0], [6400, 620], [9600, 1180], [12400, 340]], ease: 'inOut' },
    // Then the specific statement, typed as the organisation.
    typeInto('#pg-compose', 'The review concerns one programme: the Community Uplift Initiative. Case reference AMP-IR-2026-014.', 12800, 15600),
    cursor([
      [0, 1200, 260],
      [2400, 980, 500],
      [9600, 1010, 620],
      [12600, 720, 470],
      [16000, 720, 470],
    ], [12700]),
  ],
};

const CORRECTION =
  'This image is not from any AMP programme account. No hospitality has been charged to programme funds. Review scope and case reference AMP-IR-2026-014 are published on our page.';

const clip23: Clip = {
  id: 'seq23',
  seq: 23,
  title: 'The correction',
  durationMs: 11000,
  html: desktop({
    windows: [
      {
        app: 'facebook',
        body: fbFeed([
          fbPost('lie-luxury', { id: 'p-lx', composer: { author: 'AMP', id: 'cm-in' } }),
        ]),
        ...WIN,
      },
    ],
    taskbar: ['facebook'],
  }),
  tracks: [
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [2400, 520]], ease: 'inOut' },
    typeInto('#cm-in', CORRECTION, 3000, 10200),
    cursor([
      [0, 900, 700],
      [2600, 760, 820],
      [11000, 760, 820],
    ], [2700]),
  ],
};

const REPLY_TEXT =
  '1. The Community Uplift Initiative, covering FY2025. Case reference AMP-IR-2026-014.\n2. No. Bursary and tuition assistance are disbursing on the normal schedule.\n3. No figure has been established. The $1m figure circulating online is not ours.';

const clip24: Clip = {
  id: 'seq24',
  seq: 24,
  title: 'In writing',
  durationMs: 14000,
  html: desktop({
    windows: [
      { app: 'email', body: mailRead('email-press', { replyId: 'rp-body' }), x: 420, y: 120, w: 1100, h: 840 },
    ],
    taskbar: ['email'],
  }),
  tracks: [
    typeInto('#rp-body', REPLY_TEXT, 900, 11400),
    { prop: 'scale', sel: '.mail-send', keys: [[12200, 1], [12400, 0.93], [12700, 1]], ease: 'back' },
    cursor([
      [0, 760, 420],
      [11800, 640, 700],
      [14000, 640, 700],
    ], [12200]),
  ],
};

const clip25: Clip = {
  id: 'seq25',
  seq: 25,
  title: 'The curve turns',
  durationMs: 6000,
  html: dashboard({
    gauges: [
      { key: 'trust', label: 'Public Trust', value: 66 },
      { key: 'safety', label: 'Stakeholder Confidence', value: 72 },
      { key: 'narrative', label: 'Narrative Control', value: 58 },
      { key: 'risk', label: 'Escalation Risk', value: 34, invert: true },
    ],
    overall: 66,
    trend: 'rising',
  }),
  tracks: [
    ...gaugeMove(
      { trust: 41, safety: 58, narrative: 24, risk: 81, overall: 41 },
      { trust: 66, safety: 72, narrative: 58, risk: 34, overall: 66 },
      500,
      4400,
    ),
    { prop: 'draw', sel: '#spark-path', keys: [[500, 0], [4600, 1]], ease: 'out' },
  ],
};

// ---------------------------------------------------------------------------
// ACT VII — the answer
// ---------------------------------------------------------------------------

const AMP_ANSWER =
  'Puan Siti — your application is not affected. Bursary disbursement for the new school term is on schedule and the counter is open daily until 5pm. Please quote AMP-IR-2026-014 at the counter and we will trace it the same day.';

const clip26: Clip = {
  id: 'seq26',
  seq: 26,
  title: 'By name',
  durationMs: 9000,
  html:
    phone(
      fbFeed([
        fbPost('question', {
          id: 'p-q2',
          comments: [{ name: AMP_PAGE, text: AMP_ANSWER, id: 'amp-reply' }],
        }),
      ]),
      {
        bg: 'crisis-multi-agency.jpg',
        stats: {
          gauges: [
            { key: 'trust', label: 'Public Trust', value: 58 },
            { key: 'narrative', label: 'Narrative Control', value: 52 },
            { key: 'risk', label: 'Escalation Risk', value: 42, invert: true },
          ],
          trend: 'rising',
          caption: 'Specific, sourced, and addressed to the person who asked.',
        },
      },
    ) + wipe(),
  tracks: [
    shellWipe(9000),
    ...sideMove(
      { trust: 58, narrative: 52, risk: 42 },
      { trust: 66, narrative: 58, risk: 34 },
      3600,
      8400,
      9000,
    ),
    { prop: 'scroll', sel: '#feed', keys: [[0, 0], [2600, 300], [8400, 620]], ease: 'inOut' },
    { prop: 'opacity', sel: '#amp-reply', keys: [[0, 0], [3400, 0]] },
    ...pop('#amp-reply', 3500),
  ],
};

const clip27: Clip = {
  id: 'seq27',
  seq: 27,
  title: 'Alhamdulillah',
  durationMs: 8000,
  // No stats panel here on purpose. The last thing the film should suggest is
  // that a metric is the point of it.
  html:
    phone(
      fbFeed([
        fbPost('question', {
          id: 'p-q3',
          comments: [
            { name: AMP_PAGE, text: AMP_ANSWER, id: 'amp-r2' },
            {
              name: 'Puan Siti Rahimah',
              text: 'Alhamdulillah. Terima kasih sebab jawab. Itu saja yang kami minta.',
              likes: 921,
              id: 'siti-reply',
            },
          ],
        }),
      ]),
      { bg: 'crisis-multi-agency.jpg' },
    ) + wipe(),
  tracks: [
    shellWipe(8000),
    // Framed so her question and her answer are in the same shot. That pairing
    // is the whole film; splitting them across a scroll would waste it.
    { prop: 'scroll', sel: '#feed', keys: [[0, 430], [8000, 500]], ease: 'inOut' },
    { prop: 'opacity', sel: '#siti-reply', keys: [[0, 0], [1600, 0]] },
    ...pop('#siti-reply', 1700),
    // Then nothing moves. The hold is the point.
  ],
};

const clip28: Clip = {
  id: 'seq28',
  seq: 28,
  title: 'The room',
  durationMs: 5000,
  html: mosaic(25),
  tracks: Array.from({ length: 25 }, (_, i) => [
    { prop: 'opacity' as const, sel: `#tile-${i}`, keys: [[0, 0], [i * 90, 0], [i * 90 + 400, 1]] as [number, number][], ease: 'out' as const },
    { prop: 'scale' as const, sel: `#tile-${i}`, keys: [[i * 90, 0.9], [i * 90 + 500, 1]] as [number, number][], ease: 'back' as const },
  ]).flat(),
};

const clip29: Clip = {
  id: 'seq29',
  seq: 29,
  title: 'The claim',
  durationMs: 4500,
  html: card({ kicker: 'Same crisis. Same people.', lines: ['Two days', 'of training.'] }),
  tracks: [
    { prop: 'opacity', sel: '#ec-kicker', keys: [[0, 0], [500, 1]], ease: 'out' },
    { prop: 'y', sel: '#ec-kicker', keys: [[0, 12], [600, 0]], ease: 'out' },
    { prop: 'opacity', sel: '#ec-line-0', keys: [[600, 0], [1100, 1]], ease: 'out' },
    { prop: 'y', sel: '#ec-line-0', keys: [[600, 18], [1200, 0]], ease: 'back' },
    { prop: 'opacity', sel: '#ec-line-1', keys: [[1000, 0], [1500, 1]], ease: 'out' },
    { prop: 'y', sel: '#ec-line-1', keys: [[1000, 18], [1600, 0]], ease: 'back' },
  ],
};

const clip30: Clip = {
  id: 'seq30',
  seq: 29,
  title: 'Logo',
  durationMs: 4000,
  html: card({
    kicker: 'Black Swan Simulations',
    lines: ['Rehearse the crisis.'],
    sub: 'For teams who cannot afford to rehearse in public.',
    logo: true,
  }),
  tracks: [
    { prop: 'opacity', sel: '#ec-logo', keys: [[0, 0], [600, 1]], ease: 'out' },
    { prop: 'scale', sel: '#ec-logo', keys: [[0, 0.86], [700, 1]], ease: 'back' },
    { prop: 'opacity', sel: '#ec-kicker', keys: [[400, 0], [900, 1]], ease: 'out' },
    { prop: 'opacity', sel: '#ec-line-0', keys: [[800, 0], [1400, 1]], ease: 'out' },
    { prop: 'y', sel: '#ec-line-0', keys: [[800, 16], [1500, 0]], ease: 'back' },
    { prop: 'opacity', sel: '#ec-sub', keys: [[1400, 0], [2000, 1]], ease: 'out' },
  ],
};

/**
 * The reel.
 *
 * The two pure gauge-move dashboard clips are deliberately absent: the stats
 * panel beside the handset already carries that information, and a full screen
 * of the same numbers said it twice. The one dashboard clip that survives is
 * the SOP breach, which is a compliance finding rather than a statistic — it is
 * the product telling the trainer a rule was broken, and nothing else in the
 * film shows that.
 */
export const CLIPS: Clip[] = [
  clip01, clip02, clip03a, clip03, clip04, clip05a, clip05, clip06,
  clip07,
  clip08, clip09, clip10a, clip10, clip11,
  clip13, clip13b, clip14, clip15, clip16,
  clip17, clip18, clip19, clip20,
  clip21, clip21b, clip22a, clip22, clip22b, clip22c, clip23, clip24,
  clip26, clip27, clip28, clip29, clip30,
];

// Retired from the reel but kept renderable: full-screen stats duplicated the
// side panel. `npx tsx demo-run/anim/render.ts seq12 seq25` still works.
void [clip12, clip25];

/** Concat order for the reel, in story order. */
export const REEL_ORDER = CLIPS.map((c) => c.id);

void [mailList, GAUGES_FALL];
