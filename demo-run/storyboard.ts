/**
 * The storyboard, as data.
 *
 * v4 — live action, in the simulated environment.
 *
 * v1 was harvested footage: random zooms over actions nobody had a reason to
 * care about. v2 fixed the story but was still a shot list of stills with
 * camera moves applied on top. v3 made it continuous. This version puts it all
 * inside the desktop the product actually ships: windows open from icons, apps
 * minimise back to a taskbar, and every switch between surfaces passes through
 * the desk rather than cutting. The environment is a large part of what is
 * being sold, so the film has to let you see it.
 *
 * The unit is a SEQUENCE, not a shot. A sequence is one unbroken take on one
 * person's screen, and it contains BEATS — the moments inside it worth cutting
 * on. Everything in a beat has to be genuinely moving: a scroll, a message
 * landing, characters appearing, a window opening, a counter climbing.
 * If a beat cannot answer "what moves here", it does not belong in the film.
 *
 * THE SPINE
 *
 * One woman asks one question: my child's bursary, is it still coming? It sits
 * unanswered while the lie machine runs and the team gets it wrong once. The
 * film is over when they earn the right to answer her by name.
 *
 * HOW THE MOTION IS REAL
 *
 * The device apps have no polling and no Supabase realtime — they update only
 * when the server broadcasts over Socket.IO from inside an API route. So a
 * direct database insert shows nothing on an open page. Anything that has to
 * ARRIVE on camera is therefore published through the product's own path:
 *
 *   new NPC posts   -> POST /api/injects/:id/publish   (delivery_config.app = social_feed)
 *   new emails      -> the same, app = email
 *   incoming DMs    -> POST /api/social/messenger/send
 *   live comments   -> POST /api/social/posts with reply_to_post_id
 *   counter ticks   -> POST /api/social/posts/:id/like, and the 30s engine tick
 *
 * Only the pre-crisis dressing is inserted directly, because the page loads
 * after it and therefore reads it on first paint.
 */

import { PHOTOS, stagedByKey } from './stage.js';

export type App =
  | 'desktop'
  | 'fakebook'
  | 'messenger'
  | 'news'
  | 'email'
  | 'chat'
  | 'dashboard'
  | 'mosaic'
  | 'card';

/**
 * Which shell the sequence is filmed in.
 *
 * The desktop is not set dressing — it is the product. A windowed environment
 * with a taskbar, minimise and a wallpaper is what makes the audience read this
 * as somebody's actual working day rather than a web app demo, so app switches
 * go back through it rather than cutting straight from one surface to the next.
 */
export type Shell = 'desktop' | 'phone';

/** What is physically moving in a beat. Every beat must have one. */
export type Motion =
  | 'scroll'
  | 'arrive'
  | 'type'
  | 'navigate'
  | 'count'
  | 'cursor'
  | 'press'
  | 'react'
  | 'hold';

export interface Beat {
  label: string;
  what: string;
  motion: Motion;
  sec: number;
  panel: Panel;
  /** How this is made to happen on the day. */
  how?: string;
}

export interface Sequence {
  n: number;
  act: number;
  title: string;
  screen: string;
  shell: Shell;
  app: App;
  purpose: string;
  beats: Beat[];
  audio?: string;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export type Panel =
  | {
      kind: 'desktop';
      open?: string[];
      minimised?: string[];
      /** Icon the pointer is about to double-click. */
      launching?: string;
      /** Panel drawn inside the front window, if one is open. */
      inWindow?: Panel;
      /** Window title for the front window. */
      windowTitle?: string;
    }
  | {
      kind: 'news';
      outlet: string;
      headline: string;
      sub: string;
      body: string;
      highlight?: string;
    }
  | {
      kind: 'fbPost';
      postKey: string;
      highlight?: string;
      comments?: { name: string; text: string; likes?: number; highlight?: boolean }[];
      counters?: { views: string; likes: string; shares: string };
      arriving?: boolean;
      /** Draw the report icon as already flagged. */
      flagged?: boolean;
    }
  | { kind: 'fbFeed'; postKeys: string[]; arrivingKeys?: string[]; calm?: boolean }
  | {
      kind: 'fbCompose';
      asPage: boolean;
      pageName?: string;
      author: string;
      text: string;
      typedChars?: number;
      attachment?: string;
    }
  | {
      kind: 'dm';
      from: string;
      messages: { from: string; text: string; me?: boolean }[];
      sharedPost?: { author: string; preview: string };
      arriving?: boolean;
    }
  | {
      kind: 'reportModal';
      category: string;
      reason: string;
      typedChars?: number;
    }
  | {
      kind: 'disputeModal';
      target: 'post' | 'article';
      heading: string;
      note: string;
      typedChars?: number;
      status?: string;
    }
  | { kind: 'retracted'; headline: string; note: string }
  | { kind: 'emailList'; focusKey?: string; arriving?: boolean }
  | { kind: 'emailRead'; emailKey: string; highlight?: string }
  | { kind: 'emailReply'; to: string; subject: string; text: string; typedChars?: number }
  | {
      kind: 'chat';
      channel: string;
      messages: { from: string; text: string; me?: boolean; highlight?: boolean }[];
      live?: boolean;
    }
  | {
      kind: 'dashboard';
      trust: number;
      safety: number;
      narrative: number;
      risk: number;
      trend: 'flat' | 'falling' | 'rising';
      alert?: string;
    }
  | { kind: 'mosaic'; tiles: number }
  | {
      kind: 'card';
      lines: string[];
      sub?: string;
      /** JetBrains Mono, uppercase, amber. The brand's recurring label motif. */
      kicker?: string;
      light?: boolean;
      logo?: boolean;
    };

// ---------------------------------------------------------------------------

export const ACTS = [
  {
    n: 1,
    title: 'An ordinary afternoon',
    note: 'A desk, a wallpaper, a normal feed. Then someone sends you a link.',
  },
  { n: 2, title: 'The question', note: 'One mother asks the thing the whole film has to answer.' },
  { n: 3, title: 'The lie outruns the truth', note: 'Volume, not argument. Nobody is answering.' },
  { n: 4, title: 'Fighting back', note: 'Read it, prove it false, report it, get it retracted.' },
  { n: 5, title: 'The mistake', note: 'They speak too early and get called out for it.' },
  { n: 6, title: 'The turn', note: 'Verify, then say the specific thing. Craft, on camera.' },
  { n: 7, title: 'The answer', note: 'She gets a reply with her name on it.' },
];

/** Ordinary, pre-crisis feed. The baseline the audience needs to feel the change. */
export const CALM_KEYS = ['calm-iftar', 'calm-anniversary', 'calm-tuition', 'calm-mosque'];

const AMP_PAGE = 'AMP (Association for Muslim Professionals)';

export const SEQUENCES: Sequence[] = [
  // =========================================================================
  // ACT I — AN ORDINARY AFTERNOON
  // =========================================================================
  {
    n: 1,
    act: 1,
    title: 'The workstation',
    screen: 'Farah Iskandar',
    shell: 'desktop',
    app: 'desktop',
    purpose:
      'Open on the environment itself. A wallpaper, app icons, a taskbar, a clock — this establishes in three seconds that the simulated world is a place you work in, not a screen you are shown.',
    audio: 'Room tone only. No music yet.',
    beats: [
      {
        label: 'The desktop',
        what: 'Wallpaper, a column of app icons, an empty taskbar. Nothing open, nothing wrong.',
        motion: 'hold',
        sec: 3,
        how: 'Land on /sim/:id/desktop with no windows open.',
        panel: { kind: 'desktop' },
      },
      {
        label: 'Reach for Fakebook',
        what: 'The arrow glides across the desktop and settles on the Fakebook icon.',
        motion: 'cursor',
        sec: 3,
        how: 'Real pointer motion, arrow cursor in its normal style.',
        panel: { kind: 'desktop', launching: 'facebook' },
      },
      {
        label: 'Double-click',
        what: 'The window opens with the shell’s own scale-and-fade, and can be dragged.',
        motion: 'navigate',
        sec: 3,
        how: 'humanDoubleClick on [data-testid="desktop-icon-facebook"].',
        panel: {
          kind: 'desktop',
          open: ['facebook'],
          windowTitle: 'Fakebook',
          inWindow: { kind: 'fbFeed', postKeys: CALM_KEYS, calm: true },
        },
      },
    ],
  },
  {
    n: 2,
    act: 1,
    title: 'Scrolling',
    screen: 'Farah Iskandar — Fakebook window',
    shell: 'desktop',
    app: 'fakebook',
    purpose:
      'Establish normal. Every second of the crisis later is measured against how ordinary this felt.',
    audio: 'A single sustained note, barely there.',
    beats: [
      {
        label: 'An ordinary feed',
        what: 'Community iftar photos, a colleague’s work anniversary, a mother thanking tutors.',
        motion: 'scroll',
        sec: 6,
        how: 'Calm posts inserted before the page loads, so they are there on first paint.',
        panel: { kind: 'fbFeed', postKeys: CALM_KEYS, calm: true },
      },
      {
        label: 'Unhurried',
        what: 'She scrolls on. A mosque notice about assistance counter opening hours.',
        motion: 'scroll',
        sec: 4,
        panel: { kind: 'fbPost', postKey: 'calm-mosque' },
      },
      {
        label: 'Badge',
        what: 'A Messenger badge ticks up. Small. She notices it.',
        motion: 'arrive',
        sec: 3,
        how: 'Notification row inserted; the badge poll picks it up within 15s.',
        panel: { kind: 'fbFeed', postKeys: CALM_KEYS, calm: true },
      },
    ],
  },
  {
    n: 3,
    act: 1,
    title: 'The message',
    screen: 'Farah Iskandar — Messenger',
    shell: 'desktop',
    app: 'messenger',
    purpose:
      'How almost everyone actually finds out their organisation is in trouble: not from a press office, from a friend.',
    audio: 'The note bends. First hint something is off.',
    beats: [
      {
        label: 'Open Messenger',
        what: 'She opens the messenger panel inside the Fakebook window.',
        motion: 'press',
        sec: 2,
        panel: { kind: 'dm', from: 'Aisyah Kamal', messages: [] },
      },
      {
        label: 'The DM lands',
        what: '“eh… is this about your company or not? 😬” and a shared post from CNA.',
        motion: 'arrive',
        sec: 5,
        how: 'Sent live from a friend account via POST /api/social/messenger/send with shared_post_id.',
        panel: {
          kind: 'dm',
          from: 'Aisyah Kamal',
          arriving: true,
          messages: [{ from: 'Aisyah Kamal', text: 'eh… is this about your company or not? 😬' }],
          sharedPost: {
            author: 'CNA Local Updates',
            preview: 'AMP confirms financial mismanagement in one community programme…',
          },
        },
      },
      {
        label: 'She opens the card',
        what: 'Tap the shared post. The feed jumps to it, and it carries a link preview.',
        motion: 'press',
        sec: 3,
        panel: { kind: 'fbPost', postKey: 'media-share' },
      },
    ],
  },
  {
    n: 4,
    act: 1,
    title: 'Back to the desk',
    screen: 'Farah Iskandar',
    shell: 'desktop',
    app: 'desktop',
    purpose:
      'The switch is the shot. Minimise, see the desk again, open a different tool — this is what makes it read as a real workstation rather than a set of screens edited together.',
    beats: [
      {
        label: 'Minimise Fakebook',
        what: 'The window collapses to the taskbar. The wallpaper is back.',
        motion: 'press',
        sec: 3,
        how: 'Click [data-testid="window-minimize-facebook"].',
        panel: { kind: 'desktop', minimised: ['facebook'] },
      },
      {
        label: 'Open the News app',
        what: 'The arrow crosses to the News icon and double-clicks. A second window opens.',
        motion: 'navigate',
        sec: 4,
        how: 'humanDoubleClick on [data-testid="desktop-icon-news"].',
        panel: {
          kind: 'desktop',
          minimised: ['facebook'],
          open: ['news'],
          windowTitle: 'News',
          launching: 'news',
        },
      },
    ],
  },
  {
    n: 5,
    act: 1,
    title: 'The article',
    screen: 'Farah Iskandar — News window',
    shell: 'desktop',
    app: 'news',
    purpose:
      'The confirmation. A masthead makes it real in a way a social post never can — this is not a rumour, it is published.',
    audio: 'Music proper starts here, on the headline.',
    beats: [
      {
        label: 'The headline',
        what: '“AMP confirms financial mismanagement in community programme.”',
        motion: 'hold',
        sec: 3,
        panel: {
          kind: 'news',
          outlet: 'CNA Local Updates',
          headline: 'AMP confirms financial mismanagement in community programme',
          sub: 'Self-help group says issue is limited to one initiative; community groups call for full audit',
          body: 'The Association for Muslim Professionals has confirmed that an internal review identified financial management issues in one of its community programmes…',
          highlight: 'financial mismanagement',
        },
      },
      {
        label: 'Reading down',
        what: 'The pointer walks the copy and she scrolls with it.',
        motion: 'cursor',
        sec: 6,
        how: 'readAlong() in its subtle style, paired with a real scroll.',
        panel: {
          kind: 'news',
          outlet: 'CNA Local Updates',
          headline: 'AMP confirms financial mismanagement in community programme',
          sub: 'Self-help group says issue is limited to one initiative; community groups call for full audit',
          body: 'Community leaders have called for the scope of the review to be published. Several donors said they were seeking assurances before renewing pledges…',
        },
      },
    ],
  },
  {
    n: 6,
    act: 1,
    title: 'The return',
    screen: 'Farah Iskandar — Fakebook window',
    shell: 'desktop',
    app: 'fakebook',
    purpose:
      'The turn of the whole first act. She was gone ninety seconds. The feed is not the same place, and it keeps changing while she watches.',
    audio: 'Percussion enters. Tempo doubles and does not come down.',
    beats: [
      {
        label: 'Restore from the taskbar',
        what: 'She clicks Fakebook in the taskbar. The window comes back up over the News window.',
        motion: 'navigate',
        sec: 3,
        how: 'Click [data-testid="taskbar-facebook"] — restores rather than reopening.',
        panel: {
          kind: 'desktop',
          minimised: ['news'],
          open: ['facebook'],
          windowTitle: 'Fakebook',
          inWindow: { kind: 'fbFeed', postKeys: ['accusation', 'media-share'] },
        },
      },
      {
        label: 'The accusation',
        what: '“Name the programme. Publish the numbers.” Already thousands of shares.',
        motion: 'scroll',
        sec: 4,
        panel: {
          kind: 'fbPost',
          postKey: 'accusation',
          highlight: 'Name the programme. Publish the numbers.',
        },
      },
      {
        label: 'Posts start landing',
        what: 'While she is still reading, new posts drop into the top of the feed. Then another.',
        motion: 'arrive',
        sec: 6,
        how: 'Injects published on cue — each fires social_post.created and prepends live.',
        panel: {
          kind: 'fbFeed',
          postKeys: ['accusation', 'lie-frozen', 'lie-million'],
          arrivingKeys: ['lie-frozen', 'lie-million'],
        },
      },
      {
        label: 'And they keep coming',
        what: 'She scrolls down; the feed grows faster than she can read it.',
        motion: 'arrive',
        sec: 5,
        panel: {
          kind: 'fbFeed',
          postKeys: ['lie-frozen', 'lie-million', 'lie-luxury', 'crowd'],
          arrivingKeys: ['lie-luxury', 'crowd'],
        },
      },
    ],
  },

  // =========================================================================
  // ACT II — THE QUESTION
  // =========================================================================
  {
    n: 7,
    act: 2,
    title: 'Her question',
    screen: 'Amirah Zulkifli — phone',
    shell: 'phone',
    app: 'fakebook',
    purpose:
      'The spine goes up. Everything after this is the audience waiting for someone to answer her. Filmed on a phone, because that is where she would be reading it.',
    audio: 'Music thins to the single note again. Let the line breathe.',
    beats: [
      {
        label: 'Scroll onto it',
        what: 'Past the noise, a photo of a bursary counter and a mother asking a plain question.',
        motion: 'scroll',
        sec: 4,
        panel: { kind: 'fbPost', postKey: 'question' },
      },
      {
        label: 'The line',
        what: '“Bulan depan sekolah buka. Saya sudah tunggu tiga minggu. Tolong jawab.”',
        motion: 'hold',
        sec: 4,
        how: 'The one earned hold in the first half. Camera does not move.',
        panel: { kind: 'fbPost', postKey: 'question', highlight: 'Tolong jawab.' },
      },
      {
        label: 'Parents pile in',
        what: 'Five comments arrive underneath, one after another. She is not the only one.',
        motion: 'arrive',
        sec: 7,
        how: 'Posted live as replies by NPC-voiced participant accounts, ~1.4s apart.',
        panel: {
          kind: 'fbPost',
          postKey: 'question',
          comments: [
            {
              name: 'Rohana Bte Salleh',
              text: 'Sama. Saya apply bulan lepas, sampai sekarang tak dengar apa-apa. Anak saya Sec 3.',
            },
            {
              name: 'Zulkarnain',
              text: 'Just tell us yes or no lah. We can plan. It is the not knowing that kills.',
            },
            { name: 'Mdm Kalthom', text: 'Saya call office tiga kali. Tiada orang angkat.' },
            {
              name: 'Hakim',
              text: 'My sister works there. Even she doesn’t know what to tell people.',
            },
            {
              name: 'Nur Ain',
              text: 'Sekolah buka minggu depan. Tolonglah jawab satu soalan sahaja.',
              highlight: true,
            },
          ],
        },
      },
    ],
  },

  // =========================================================================
  // ACT III — THE LIE OUTRUNS THE TRUTH
  // =========================================================================
  {
    n: 8,
    act: 3,
    title: 'The pile-on',
    screen: 'Daniel Tan Wei Ming — phone',
    shell: 'phone',
    app: 'fakebook',
    purpose: 'Volume as a force. Not an argument to rebut — a tide to stand in.',
    audio: 'Ticking underneath, rising with the counters.',
    beats: [
      {
        label: 'Whip down',
        what: 'One fast continuous scroll. FROZEN. $1 MILLION. A photograph.',
        motion: 'scroll',
        sec: 4,
        panel: { kind: 'fbFeed', postKeys: ['lie-frozen', 'lie-million', 'lie-luxury'] },
      },
      {
        label: 'Counters climbing',
        what: 'He stops on one. Likes and shares roll upward digit by digit while he looks at it.',
        motion: 'count',
        sec: 7,
        how: 'Repeated likes through the API plus the engine tick; the new count-up animation eases each figure rather than snapping.',
        panel: {
          kind: 'fbPost',
          postKey: 'lie-frozen',
          counters: { views: '512,884', likes: '7,940', shares: '6,213' },
        },
      },
      {
        label: 'Another lands',
        what: 'A new post drops in above it before he has finished reading.',
        motion: 'arrive',
        sec: 4,
        panel: { kind: 'fbFeed', postKeys: ['rival', 'lie-frozen'], arrivingKeys: ['rival'] },
      },
    ],
  },
  {
    n: 9,
    act: 3,
    title: 'The photograph',
    screen: 'Farah Iskandar — Fakebook window',
    shell: 'desktop',
    app: 'fakebook',
    purpose:
      'The single most persuasive thing in the film is a picture that proves nothing. This is what teams are actually up against.',
    audio: 'Low sub-bass as the caption resolves.',
    beats: [
      {
        label: 'The image',
        what: 'A dark restaurant table, shot on a phone from across the room.',
        motion: 'scroll',
        sec: 4,
        panel: { kind: 'fbPost', postKey: 'lie-luxury' },
      },
      {
        label: 'The caption',
        what: '“VIP hotel dinners charged to the programme account.” It proves nothing. It works.',
        motion: 'hold',
        sec: 3,
        panel: {
          kind: 'fbPost',
          postKey: 'lie-luxury',
          highlight: 'VIP hotel dinners charged to the programme account',
        },
      },
      {
        label: 'The pressure builds',
        what: 'Angry reactions spike and four hostile comments land in a row underneath.',
        motion: 'arrive',
        sec: 7,
        how: 'Counters driven via the like route; comments posted live ~1.3s apart.',
        panel: {
          kind: 'fbPost',
          postKey: 'lie-luxury',
          counters: { views: '411,203', likes: '9,880', shares: '8,104' },
          comments: [
            {
              name: 'Rosli B.',
              text: 'And they still ask for donations every Ramadan. Shameless.',
            },
            {
              name: 'Accountability Watch SG',
              text: 'Still no statement. Silence is an answer too.',
            },
            { name: 'Jenn Low', text: 'Cancelled my monthly giro this morning. Enough.' },
            {
              name: 'Hafizah',
              text: 'My mother queued four hours last week. FOUR HOURS.',
              highlight: true,
            },
          ],
        },
      },
    ],
  },
  {
    n: 10,
    act: 3,
    title: 'The inbox',
    screen: 'Priya Raman — desktop',
    shell: 'desktop',
    app: 'email',
    purpose: 'It is not only the feed. People are demanding answers in writing, with deadlines.',
    audio: 'Clock motif enters and runs until the turn.',
    beats: [
      {
        label: 'Open Mail from the desk',
        what: 'Her desktop, then a double-click on the Mail icon. The window opens.',
        motion: 'navigate',
        sec: 3,
        how: 'humanDoubleClick on [data-testid="desktop-icon-email"].',
        panel: { kind: 'desktop', launching: 'email', open: ['email'], windowTitle: 'Mail' },
      },
      {
        label: 'Mail arriving',
        what: 'The inbox is open and a new urgent email drops into the list.',
        motion: 'arrive',
        sec: 4,
        how: 'Published as an inject with delivery_config.app = email, which broadcasts on arrival.',
        panel: { kind: 'emailList', focusKey: 'email-press', arriving: true },
      },
      {
        label: 'Read to the deadline',
        what: 'She opens the journalist. The pointer walks the three questions and rests on 6pm.',
        motion: 'cursor',
        sec: 6,
        how: 'readAlong(), subtle style. Cut on the pointer arriving.',
        panel: {
          kind: 'emailRead',
          emailKey: 'email-press',
          highlight: 'Our deadline is 6pm today.',
        },
      },
    ],
  },
  {
    n: 11,
    act: 3,
    title: 'Outside',
    screen: 'Faizal Rahman — desktop',
    shell: 'desktop',
    app: 'fakebook',
    purpose: 'The crisis stops being online. It is now people standing outside a building.',
    beats: [
      {
        label: 'It lands',
        what: 'A post arrives: a crowd outside the centre, phones up, nobody coming out.',
        motion: 'arrive',
        sec: 4,
        panel: { kind: 'fbPost', postKey: 'crowd', arriving: true },
      },
      {
        label: 'The line',
        what: '“Nobody is coming out to talk to them. This is what silence does.”',
        motion: 'hold',
        sec: 3,
        panel: {
          kind: 'fbPost',
          postKey: 'crowd',
          highlight: 'nobody is coming out to talk to them',
        },
      },
    ],
  },
  {
    n: 12,
    act: 3,
    title: 'The drop',
    screen: 'Trainer dashboard',
    shell: 'desktop',
    app: 'dashboard',
    purpose: 'The cost of the pause, measured — and now visibly moving rather than snapping.',
    audio: 'Everything falls away except the clock.',
    beats: [
      {
        label: 'Gauges move',
        what: 'Trust counts down digit by digit, the bar slides, and the trend line redraws downward.',
        motion: 'count',
        sec: 6,
        how: 'The new count-up and live sparkline. The real scored value, not a target.',
        panel: {
          kind: 'dashboard',
          trust: 48,
          safety: 61,
          narrative: 29,
          risk: 74,
          trend: 'falling',
          alert: 'ESCALATION RISK HIGH',
        },
      },
    ],
  },

  // =========================================================================
  // ACT IV — FIGHTING BACK
  // =========================================================================
  {
    n: 13,
    act: 4,
    title: 'Reading for the lie',
    screen: 'Grace Lim Hui Ling — desktop',
    shell: 'desktop',
    app: 'fakebook',
    purpose:
      'Countering misinformation is not a button, it is reading. Show the work: someone going through the feed line by line, deciding what is merely angry and what is actually false.',
    audio: 'Clock only. Tight, procedural.',
    beats: [
      {
        label: 'Working the feed',
        what: 'She scrolls slowly, pointer tracking the claims one at a time.',
        motion: 'cursor',
        sec: 6,
        how: 'readAlong() across each post body, paired with a slow scroll.',
        panel: { kind: 'fbFeed', postKeys: ['lie-frozen', 'lie-million', 'lie-luxury'] },
      },
      {
        label: 'That one is false',
        what: 'She stops on the frozen-assistance claim. It is not opinion, it is a checkable fact.',
        motion: 'hold',
        sec: 3,
        panel: {
          kind: 'fbPost',
          postKey: 'lie-frozen',
          highlight: 'ALL AMP assistance has been frozen',
        },
      },
    ],
  },
  {
    n: 14,
    act: 4,
    title: 'Report it',
    screen: 'Grace Lim Hui Ling — desktop',
    shell: 'desktop',
    app: 'fakebook',
    purpose:
      'The platform-moderation lever, used properly: the right category, and a reason that cites what is actually false.',
    beats: [
      {
        label: 'Open the report',
        what: 'The three-dot menu on the post. The report sheet slides in.',
        motion: 'press',
        sec: 3,
        how: 'Click button[title="Report post"] scoped inside the post.',
        panel: { kind: 'reportModal', category: '', reason: '', typedChars: 0 },
      },
      {
        label: 'Misinformation',
        what: 'She picks the category. The option lights blue.',
        motion: 'press',
        sec: 3,
        how: 'Click [data-testid="report-option-misinformation"].',
        panel: { kind: 'reportModal', category: 'misinformation', reason: '', typedChars: 0 },
      },
      {
        label: 'Cite the fact',
        what: 'She types the reason live — no freeze notice exists, and here is the reference.',
        motion: 'type',
        sec: 7,
        panel: {
          kind: 'reportModal',
          category: 'misinformation',
          reason:
            'No account freeze notice has been issued or received. Bursary and tuition disbursements are running on schedule. Review scope published under case reference AMP-IR-2026-014.',
          typedChars: 112,
        },
      },
      {
        label: 'Submit',
        what: 'The sheet closes and the post’s report icon turns amber. It is on record.',
        motion: 'react',
        sec: 3,
        how: 'Click [data-testid="report-submit"], then frame the amber icon on the post.',
        panel: { kind: 'fbPost', postKey: 'lie-frozen', flagged: true },
      },
    ],
  },
  {
    n: 15,
    act: 4,
    title: 'Take the article down',
    screen: 'Grace Lim Hui Ling — News window',
    shell: 'desktop',
    app: 'news',
    purpose:
      'The bigger lever. A social post is noise; a published article is the thing everyone else cites. Filing a formal correction request against it is the most consequential action in the film.',
    beats: [
      {
        label: 'Minimise, open News',
        what: 'Fakebook collapses to the taskbar; she double-clicks News on the desktop.',
        motion: 'navigate',
        sec: 4,
        how: 'window-minimize-facebook, then desktop-icon-news.',
        panel: {
          kind: 'desktop',
          minimised: ['facebook'],
          open: ['news'],
          windowTitle: 'News',
          launching: 'news',
        },
      },
      {
        label: 'The false article',
        what: 'The Independent Ledger piece repeating the frozen-assistance claim.',
        motion: 'scroll',
        sec: 4,
        panel: {
          kind: 'news',
          outlet: 'The Independent Ledger',
          headline: '“Where did the money go?” Families demand answers from AMP',
          sub: 'Claims of frozen assistance spread online as the organisation stays silent',
          body: 'Families who rely on AMP assistance say they have been left in the dark as unverified claims circulate on social media, including assertions that all support has been frozen…',
          highlight: 'all support has been frozen',
        },
      },
      {
        label: 'Request correction',
        what: 'The “Dispute / Request Correction” button. A takedown sheet opens.',
        motion: 'press',
        sec: 3,
        how: 'Click [data-testid="news-dispute-open"].',
        panel: {
          kind: 'disputeModal',
          target: 'article',
          heading: 'Request Correction / Takedown',
          note: '',
          typedChars: 0,
        },
      },
      {
        label: 'File the claim',
        what: 'She types the false claim and the verified facts that counter it.',
        motion: 'type',
        sec: 8,
        panel: {
          kind: 'disputeModal',
          target: 'article',
          heading: 'Request Correction / Takedown',
          note: 'The article states all assistance has been frozen. This is false. No freeze notice has been issued or received, and bursary disbursement is running on its normal schedule. Independent review scope is published under AMP-IR-2026-014.',
          typedChars: 148,
        },
      },
      {
        label: 'Filed',
        what: '“Dispute filed — under review.” It goes to adjudication against the fact sheet.',
        motion: 'react',
        sec: 3,
        how: 'Click [data-testid="dispute-submit"]; frame the green status line.',
        panel: {
          kind: 'disputeModal',
          target: 'article',
          heading: 'Request Correction / Takedown',
          note: 'The article states all assistance has been frozen. This is false…',
          status: 'Dispute filed — under review',
        },
      },
    ],
  },
  {
    n: 16,
    act: 4,
    title: 'It works',
    screen: 'Grace Lim Hui Ling — News window',
    shell: 'desktop',
    app: 'news',
    purpose:
      'Payoff for the procedure. Doing it properly actually removes the lie from the world — which is the argument for training people to do it properly.',
    audio: 'One clean resolving chord.',
    beats: [
      {
        label: 'Retracted',
        what: 'The article reloads with a red banner across it. The claim is gone.',
        motion: 'arrive',
        sec: 5,
        how: 'The adjudicator upholds it and broadcasts news_article.updated; the open window swaps live.',
        panel: {
          kind: 'retracted',
          headline: '“Where did the money go?” Families demand answers from AMP',
          note: 'Retracted: the claim that all assistance was frozen is not supported. No freeze notice exists.',
        },
      },
      {
        label: 'And it propagates',
        what: 'Back on Fakebook, the posts that shared that article have vanished from the feed.',
        motion: 'react',
        sec: 4,
        how: 'Retraction sets platform_removed on shared posts and broadcasts social_post.removed.',
        panel: { kind: 'fbFeed', postKeys: ['lie-million', 'crowd'] },
      },
    ],
  },

  // =========================================================================
  // ACT V — THE MISTAKE
  // =========================================================================
  {
    n: 17,
    act: 5,
    title: 'The argument',
    screen: 'Nurul Aisyah Rahim — Chat window',
    shell: 'desktop',
    app: 'chat',
    purpose:
      'Speed against accuracy — the argument every real comms team has, and the reason the next sequence goes wrong.',
    beats: [
      {
        label: 'Open Chat from the desk',
        what: 'Her desktop, a double-click on the Chat icon, the window opens on the crisis cell.',
        motion: 'navigate',
        sec: 3,
        how: 'humanDoubleClick on [data-testid="desktop-icon-chat"].',
        panel: { kind: 'desktop', launching: 'chat', open: ['chat'], windowTitle: 'Team Chat' },
      },
      {
        label: 'She pushes',
        what: '“We are 40 minutes into silence. Something has to go out.” Typed, on camera.',
        motion: 'type',
        sec: 4,
        panel: {
          kind: 'chat',
          live: true,
          channel: 'Crisis Cell — Comms + Legal',
          messages: [
            {
              from: 'Nurul Aisyah',
              text: 'We are 40 minutes into silence. Something has to go out.',
              me: true,
            },
          ],
        },
      },
      {
        label: 'Legal pushes back',
        what: 'A pause, then his reply lands. He will not confirm a figure he does not have.',
        motion: 'arrive',
        sec: 5,
        how: 'Typed live on a second browser, with a think-pause first so it reads as a person.',
        panel: {
          kind: 'chat',
          live: true,
          channel: 'Crisis Cell — Comms + Legal',
          messages: [
            {
              from: 'Nurul Aisyah',
              text: 'We are 40 minutes into silence. Something has to go out.',
              me: true,
            },
            {
              from: 'Shahrizal (Legal)',
              text: 'Not until I have the case reference. We cannot confirm a figure we do not have.',
            },
          ],
        },
      },
      {
        label: 'She overrides',
        what: '“Then a holding line. Just put something out now.”',
        motion: 'type',
        sec: 5,
        panel: {
          kind: 'chat',
          live: true,
          channel: 'Crisis Cell — Comms + Legal',
          messages: [
            {
              from: 'Shahrizal (Legal)',
              text: 'Not until I have the case reference. We cannot confirm a figure we do not have.',
            },
            {
              from: 'Nurul Aisyah',
              text: 'Then a holding line. Just put something out now.',
              me: true,
              highlight: true,
            },
            {
              from: 'Shahrizal (Legal)',
              text: 'A holding line that says nothing will be read as a dodge.',
            },
          ],
        },
      },
    ],
  },
  {
    n: 18,
    act: 5,
    title: 'Typing it anyway',
    screen: 'Nurul Aisyah Rahim — Fakebook window',
    shell: 'desktop',
    app: 'fakebook',
    purpose:
      'The audience watches a mistake being made in real time, and can see it is a mistake before she can.',
    audio: 'Keyboard on top of the mix.',
    beats: [
      {
        label: 'Switch windows',
        what: 'Chat minimises, Fakebook restores from the taskbar.',
        motion: 'navigate',
        sec: 3,
        panel: {
          kind: 'desktop',
          minimised: ['chat'],
          open: ['facebook'],
          windowTitle: 'Fakebook',
        },
      },
      {
        label: 'Become the org',
        what: 'She opens the composer and flips identity. “Posting as: AMP” lights up.',
        motion: 'press',
        sec: 3,
        panel: {
          kind: 'fbCompose',
          asPage: true,
          pageName: AMP_PAGE,
          author: 'Nurul Aisyah Rahim',
          text: '',
          typedChars: 0,
        },
      },
      {
        label: 'Real keystrokes',
        what: 'Characters appear under the caret. No autofill. Corporate nothing, written fast.',
        motion: 'type',
        sec: 8,
        how: 'humanType at full speed, camera on the text.',
        panel: {
          kind: 'fbCompose',
          asPage: true,
          pageName: AMP_PAGE,
          author: 'Nurul Aisyah Rahim',
          text: 'We are aware of the concerns being raised online and we take them seriously. AMP is committed to accountability and we will share more information in due course.',
          typedChars: 118,
        },
      },
      {
        label: 'Post',
        what: 'The button. It is irreversible the instant it lands.',
        motion: 'press',
        sec: 3,
        panel: {
          kind: 'fbCompose',
          asPage: true,
          pageName: AMP_PAGE,
          author: 'Nurul Aisyah Rahim',
          text: 'We are aware of the concerns being raised online and we take them seriously. AMP is committed to accountability and we will share more information in due course.',
        },
      },
    ],
  },
  {
    n: 19,
    act: 5,
    title: 'The call-out',
    screen: 'Daniel Tan Wei Ming — phone',
    shell: 'phone',
    app: 'fakebook',
    purpose: 'The verdict, delivered by the public, in seconds.',
    beats: [
      {
        label: 'It appears',
        what: 'The AMP statement arrives in his feed.',
        motion: 'arrive',
        sec: 3,
        panel: { kind: 'fbPost', postKey: 'accusation', arriving: true },
      },
      {
        label: 'They tear it apart',
        what: 'Five replies land in eight seconds, each one harder than the last.',
        motion: 'arrive',
        sec: 9,
        how: 'Posted live as replies by NPC-voiced participant accounts, ~1.4s apart.',
        panel: {
          kind: 'fbPost',
          postKey: 'accusation',
          comments: [
            {
              name: 'Accountability Watch SG',
              text: 'This is not an answer. Which programme? How much? You had all day.',
            },
            { name: 'Rosli B.', text: '“In due course” = we are still deciding what to admit.' },
            { name: 'Jenn Low', text: 'Zero numbers. Zero names. Zero dates. Try again.' },
            {
              name: 'Puan Siti Rahimah',
              text: 'Saya baca tiga kali. Masih tak tahu anak saya dapat bantuan atau tidak.',
              highlight: true,
            },
            { name: 'Hakim', text: 'A mother asked you one question. Answer the mother.' },
          ],
        },
      },
    ],
  },
  {
    n: 20,
    act: 5,
    title: 'Breach',
    screen: 'Trainer dashboard',
    shell: 'desktop',
    app: 'dashboard',
    purpose: 'The scoreboard punishes it. This is the product making the lesson legible.',
    beats: [
      {
        label: 'Trust falls again',
        what: 'The figure counts down, the trend line extends downward, and a breach chip lights red.',
        motion: 'count',
        sec: 5,
        panel: {
          kind: 'dashboard',
          trust: 41,
          safety: 58,
          narrative: 24,
          risk: 81,
          trend: 'falling',
          alert: 'SOP BREACH — statement issued without verification',
        },
      },
    ],
  },

  // =========================================================================
  // ACT VI — THE TURN
  // =========================================================================
  {
    n: 21,
    act: 6,
    title: 'Cleared',
    screen: 'Nurul Aisyah Rahim — Chat window',
    shell: 'desktop',
    app: 'chat',
    purpose: 'The missing ingredient arrives: a verified, specific fact.',
    audio: 'Clock stops. One beat of space.',
    beats: [
      {
        label: 'Three facts land',
        what: 'Case reference. Scope. Bursaries unaffected. One after another, fast.',
        motion: 'arrive',
        sec: 7,
        how: 'Tempo is the point — Act V was an argument, this is a handover.',
        panel: {
          kind: 'chat',
          live: true,
          channel: 'Crisis Cell — Comms + Legal',
          messages: [
            {
              from: 'Shahrizal (Legal)',
              text: 'Case ref AMP-IR-2026-014 cleared for release.',
              highlight: true,
            },
            {
              from: 'Shahrizal (Legal)',
              text: 'Scope is the Community Uplift Initiative only. No account freeze notice exists.',
            },
            {
              from: 'Shahrizal (Legal)',
              text: 'Bursary disbursement schedule unaffected — confirmed with Finance.',
            },
          ],
        },
      },
      {
        label: 'She decides',
        what: '“Good. Rewriting now. Naming the programme and the reference.”',
        motion: 'type',
        sec: 4,
        panel: {
          kind: 'chat',
          live: true,
          channel: 'Crisis Cell — Comms + Legal',
          messages: [
            {
              from: 'Shahrizal (Legal)',
              text: 'Bursary disbursement schedule unaffected — confirmed with Finance.',
            },
            {
              from: 'Nurul Aisyah',
              text: 'Good. Rewriting now. Naming the programme and the reference.',
              me: true,
              highlight: true,
            },
          ],
        },
      },
    ],
  },
  {
    n: 22,
    act: 6,
    title: 'The rewrite',
    screen: 'Nurul Aisyah Rahim — Fakebook window',
    shell: 'desktop',
    app: 'fakebook',
    purpose:
      'The thesis of the entire film. Same person, same platform, same pressure — and a completely different piece of writing. This is what the training buys.',
    audio: 'Keyboard again, but the mix has opened up. Confidence, not panic.',
    beats: [
      {
        label: 'The specific version',
        what: 'She names the programme. Then the case reference, character by character.',
        motion: 'type',
        sec: 10,
        how: 'Longest continuous typing take in the film. No cutaway.',
        panel: {
          kind: 'fbCompose',
          asPage: true,
          pageName: AMP_PAGE,
          author: 'Nurul Aisyah Rahim',
          text: 'The review concerns one programme: the Community Uplift Initiative. Case reference AMP-IR-2026-014. No assistance has been frozen. Bursary and tuition disbursements are running on schedule — the counter was open this morning. Claims of a $1m shortfall are false and we have asked for them to be corrected.',
          typedChars: 196,
        },
      },
      {
        label: 'Proof attached',
        what: 'This morning’s bursary counter, open. The photograph that answers the photograph.',
        motion: 'react',
        sec: 4,
        how: 'Attached as set dressing so it is the same image every take.',
        panel: {
          kind: 'fbCompose',
          asPage: true,
          pageName: AMP_PAGE,
          author: 'Nurul Aisyah Rahim',
          text: 'The review concerns one programme: the Community Uplift Initiative. Case reference AMP-IR-2026-014…',
          attachment: PHOTOS.communityHall,
        },
      },
      {
        label: 'It lands',
        what: 'The post appears in the feed with the case reference and the photo.',
        motion: 'arrive',
        sec: 4,
        panel: {
          kind: 'fbPost',
          postKey: 'accusation',
          highlight: 'Case reference AMP-IR-2026-014',
        },
      },
    ],
  },
  {
    n: 23,
    act: 6,
    title: 'The correction',
    screen: 'Farah Iskandar — Fakebook window',
    shell: 'desktop',
    app: 'fakebook',
    purpose:
      'Correcting where the lie lives, not on your own page where only your supporters will see it.',
    beats: [
      {
        label: 'Under the lie',
        what: 'She opens the comment box on the hotel-dinner post.',
        motion: 'press',
        sec: 3,
        panel: { kind: 'fbPost', postKey: 'lie-luxury' },
      },
      {
        label: 'Typed in place',
        what: 'The rebuttal appears character by character directly beneath the photograph.',
        motion: 'type',
        sec: 8,
        panel: {
          kind: 'fbPost',
          postKey: 'lie-luxury',
          comments: [
            {
              name: AMP_PAGE,
              text: 'This image is not from any AMP programme account. No hospitality has been charged to programme funds. Review scope and case reference AMP-IR-2026-014 are published on our page.',
              highlight: true,
            },
          ],
        },
      },
    ],
  },
  {
    n: 24,
    act: 6,
    title: 'In writing',
    screen: 'Priya Raman — Mail window',
    shell: 'desktop',
    app: 'email',
    purpose: 'The journalist gets three answers before the deadline. Beat the clock, on camera.',
    beats: [
      {
        label: 'Reply',
        what: 'The reply composer opens under the original.',
        motion: 'press',
        sec: 2,
        panel: { kind: 'emailRead', emailKey: 'email-press' },
      },
      {
        label: 'Three answers',
        what: 'Numbered, specific, typed live. No hedging.',
        motion: 'type',
        sec: 9,
        panel: {
          kind: 'emailReply',
          to: 'nadia.rahman@cna.example.sg',
          subject: 'RE: URGENT: Request for comment — AMP programme mismanagement',
          text: '1. The Community Uplift Initiative, covering FY2025. Case reference AMP-IR-2026-014.\n2. No. Bursary and tuition assistance are disbursing on the normal schedule.\n3. No figure has been established. The $1m figure circulating online is not ours.',
          typedChars: 168,
        },
      },
      {
        label: 'Send',
        what: 'Sent.',
        motion: 'press',
        sec: 3,
        panel: {
          kind: 'emailReply',
          to: 'nadia.rahman@cna.example.sg',
          subject: 'RE: URGENT: Request for comment — AMP programme mismanagement',
          text: '1. The Community Uplift Initiative, covering FY2025. Case reference AMP-IR-2026-014.\n2. No. Bursary and tuition assistance are disbursing on the normal schedule.\n3. No figure has been established. The $1m figure circulating online is not ours.',
        },
      },
    ],
  },
  {
    n: 25,
    act: 6,
    title: 'The curve turns',
    screen: 'Trainer dashboard',
    shell: 'desktop',
    app: 'dashboard',
    purpose: 'Not a rescue. A recovery they worked for, and the audience watched them earn.',
    audio: 'Full arrangement returns on the upturn.',
    beats: [
      {
        label: 'Rising',
        what: 'The figure counts up and the trend line changes direction on screen.',
        motion: 'count',
        sec: 6,
        panel: {
          kind: 'dashboard',
          trust: 66,
          safety: 72,
          narrative: 58,
          risk: 34,
          trend: 'rising',
        },
      },
    ],
  },

  // =========================================================================
  // ACT VII — THE ANSWER
  // =========================================================================
  {
    n: 26,
    act: 7,
    title: 'By name',
    screen: 'Amirah Zulkifli — phone',
    shell: 'phone',
    app: 'fakebook',
    purpose: 'Back to the exact frame from Act II, so the audience recognises where they are.',
    audio: 'MUSIC OUT. Hard silence.',
    beats: [
      {
        label: 'Her post again',
        what: 'The same photo, the same question, still sitting there.',
        motion: 'scroll',
        sec: 3,
        panel: { kind: 'fbPost', postKey: 'question' },
      },
      {
        label: 'The reply arrives',
        what: 'AMP’s answer lands underneath, addressed to her by name, with a case reference.',
        motion: 'arrive',
        sec: 6,
        how: 'Typed live by the comms lead on her own screen; filmed arriving on Amirah’s.',
        panel: {
          kind: 'fbPost',
          postKey: 'question',
          comments: [
            {
              name: AMP_PAGE,
              text: 'Puan Siti — your application is not affected. Bursary disbursement for the new school term is on schedule and the counter is open daily until 5pm. Please quote AMP-IR-2026-014 at the counter and we will trace it the same day.',
              highlight: true,
            },
          ],
        },
      },
    ],
  },
  {
    n: 27,
    act: 7,
    title: 'Alhamdulillah',
    screen: 'Amirah Zulkifli — phone',
    shell: 'phone',
    app: 'fakebook',
    purpose: 'The only sequence in the film that matters. Everything else exists to earn it.',
    audio: 'Still silent. Hold a full beat after the line lands.',
    beats: [
      {
        label: 'She answers',
        what: '“Alhamdulillah. Terima kasih sebab jawab. Itu saja yang kami minta.”',
        motion: 'arrive',
        sec: 5,
        how: 'Posted live by her account. Camera does not move. Do not cut early.',
        panel: {
          kind: 'fbPost',
          postKey: 'question',
          comments: [
            {
              name: 'Puan Siti Rahimah',
              text: 'Alhamdulillah. Terima kasih sebab jawab. Itu saja yang kami minta.',
              likes: 921,
              highlight: true,
            },
          ],
        },
      },
      {
        label: 'Hold',
        what: 'Nothing moves. Let it sit.',
        motion: 'hold',
        sec: 3,
        panel: {
          kind: 'fbPost',
          postKey: 'question',
          comments: [
            {
              name: 'Puan Siti Rahimah',
              text: 'Alhamdulillah. Terima kasih sebab jawab. Itu saja yang kami minta.',
              likes: 921,
            },
          ],
        },
      },
    ],
  },
  {
    n: 28,
    act: 7,
    title: 'The room',
    screen: 'All screens',
    shell: 'desktop',
    app: 'mosaic',
    purpose: 'Reveal the scale. Twenty-five people were doing this at once.',
    audio: 'Music returns, full.',
    beats: [
      {
        label: 'Pull back',
        what: 'A 5×5 mosaic of every player screen, all of them moving.',
        motion: 'react',
        sec: 5,
        panel: { kind: 'mosaic', tiles: 25 },
      },
    ],
  },
  {
    n: 29,
    act: 7,
    title: 'The claim',
    screen: '',
    shell: 'desktop',
    app: 'card',
    purpose:
      'Earned by everything above it. Styled to the brand — deep navy, Inter extrabold, the mono amber kicker the website uses above every heading.',
    beats: [
      {
        label: 'Card',
        what: 'Kicker fades up, then the three lines land one at a time.',
        motion: 'react',
        sec: 4,
        panel: {
          kind: 'card',
          kicker: 'Same crisis. Same people.',
          lines: ['Two days', 'of training.'],
        },
      },
      {
        label: 'Logo',
        what: 'The swan mark on its white disc, wordmark beneath.',
        motion: 'hold',
        sec: 3,
        panel: {
          kind: 'card',
          kicker: 'Prophyion',
          lines: ['Rehearse the crisis.'],
          sub: 'For teams who cannot afford to rehearse in public.',
          logo: true,
        },
      },
    ],
  },
];

export const TOTAL_SEC = SEQUENCES.reduce((t, s) => t + s.beats.reduce((b, x) => b + x.sec, 0), 0);

export const seqSec = (s: Sequence): number => s.beats.reduce((t, b) => t + b.sec, 0);

export const BEAT_COUNT = SEQUENCES.reduce((t, s) => t + s.beats.length, 0);

/** Beats where something genuinely arrives from the server while recording. */
export const LIVE_BEATS = SEQUENCES.flatMap((s) =>
  s.beats.filter((b) => b.motion === 'arrive').map((b) => `${s.n}. ${s.title} — ${b.label}`),
);

/** Beats of genuine keystrokes. */
export const TYPING_BEATS = SEQUENCES.flatMap((s) =>
  s.beats.filter((b) => b.motion === 'type').map((b) => `${s.n}. ${s.title} — ${b.label}`),
);

/** The only beats allowed to be still. Everything else has to move. */
export const HOLD_BEATS = SEQUENCES.flatMap((s) =>
  s.beats.filter((b) => b.motion === 'hold').map((b) => `${s.n}. ${s.title} — ${b.label}`),
);

/** Sequences filmed in the windowed desktop rather than the phone shell. */
export const DESKTOP_SEQUENCES = SEQUENCES.filter((s) => s.shell === 'desktop').length;

export const sequencesByAct = (act: number): Sequence[] => SEQUENCES.filter((s) => s.act === act);

export const panelPostBody = (key: string): string => stagedByKey(key).content;
