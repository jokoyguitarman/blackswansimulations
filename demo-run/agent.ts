/**
 * The UI driver for one player.
 *
 * Reads state through the REST API (structured and reliable) and performs every
 * action through the real UI (so the recording shows a person working, not a
 * script POSTing JSON). The loop never throws: a single misbehaving agent must
 * not be able to end a 60-minute capture for the other 24.
 */

import type { Page } from 'playwright';
import { APP_BASE, type PlayerSpec, type RunProfile } from './config.js';
import {
  humanClick,
  humanDoubleClick,
  humanScroll,
  humanType,
  rectOf,
  tryClick,
} from './browser.js';
import { Timeline } from './timeline.js';
import { apiFetch, sleep, type Agent } from './lib.js';
import {
  beatCopy,
  beatsFor,
  decide,
  harmful,
  TUNING,
  type Action,
  type Beat,
  type FactSheet,
  type FeedPost,
} from './brain.js';

const Z = {
  composeOpen: '[data-testid="compose-open"]',
  composeText: '[data-testid="compose-text"]',
  composeSubmit: '[data-testid="compose-submit"]',
  composeCancel: '[data-testid="compose-cancel"]',
  asPage: '[data-testid="compose-as-page"]',
  formatStatement: '[data-testid="compose-format-official_statement"]',
  reply: (id: string) => `[data-testid="post-reply-${id}"]`,
  flag: (id: string) => `[data-testid="post-flag-${id}"]`,
  like: (id: string) => `[data-testid="post-like-${id}"]`,
  repost: (id: string) => `[data-testid="post-repost-${id}"]`,
  post: (id: string) => `[data-testid="feed-post-${id}"]`,
};

const FB = {
  dispute: 'button[title="Dispute with facts"]',
  report: 'button[title="Report post"]',
  comment: 'input[placeholder="Write a comment..."]',
};

const CHAT_INPUT = 'input[placeholder="Type a message"]';

/** Demographic chips, chosen to be unique strings on the onboarding modal. */
const DEMOGRAPHICS = [
  ['26-35', '36-50', '18-25', '51+'],
  ['Male', 'Female'],
  ['Islam', 'Buddhism', 'Christianity', 'Hinduism'],
  ['Malay', 'Chinese', 'Indian', 'Eurasian'],
];

export interface AgentStats {
  actions: number;
  failures: number;
  byKind: Record<string, number>;
  beatsFired: string[];
}

export class PlayerAgent {
  readonly name: string;
  readonly spec: PlayerSpec;
  private readonly page: Page;
  private readonly auth: Agent;
  private readonly sessionId: string;
  private readonly profile: RunProfile;
  private readonly facts: FactSheet;
  private readonly log: (m: string) => void;

  private readonly handled = new Set<string>();
  private readonly beats: Beat[];
  private readonly firedBeats = new Set<string>();

  readonly stats: AgentStats = { actions: 0, failures: 0, byKind: {}, beatsFired: [] };

  /** Optional shot recorder; supplied for captures destined for the trailer. */
  readonly timeline?: Timeline;

  constructor(opts: {
    auth: Agent;
    spec: PlayerSpec;
    page: Page;
    sessionId: string;
    profile: RunProfile;
    facts: FactSheet;
    /** Total run length, so the beat schedule compresses to fit it. */
    runMinutes: number;
    timeline?: Timeline;
    log?: (m: string) => void;
  }) {
    this.timeline = opts.timeline;
    this.auth = opts.auth;
    this.spec = opts.spec;
    this.name = opts.spec.name;
    this.page = opts.page;
    this.sessionId = opts.sessionId;
    this.profile = opts.profile;
    this.facts = opts.facts;
    this.log = opts.log ?? (() => undefined);
    // Beat order matters: fire the earliest due beat first.
    this.beats = beatsFor(opts.profile, opts.spec.team, opts.spec.index, opts.runMinutes)
      .slice()
      .sort((a, b) => a.atMinute - b.atMinute);
  }

  private get isPhone(): boolean {
    return this.spec.view === 'phone';
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private deviceUrl(app: string): string {
    return `${APP_BASE}/sim/${this.sessionId}/device/${app}`;
  }

  /**
   * Bring an app to the front. The phone shell is a plain route; the desktop
   * shell opens windows from a launcher, so click the icon and fall back to the
   * route if the window does not appear.
   */
  private async openApp(app: 'social' | 'facebook' | 'chat' | 'email' | 'news' | 'drafts'): Promise<void> {
    if (this.isPhone) {
      if (!this.page.url().endsWith(`/device/${app}`)) {
        await this.page.goto(this.deviceUrl(app), { waitUntil: 'domcontentloaded' });
        await sleep(1800);
      }
      return;
    }

    const launcher: Record<string, string> = {
      social: 'Z',
      facebook: 'Fakebook',
      chat: 'TeamChat',
      email: 'Mail',
      news: 'News',
      drafts: 'Docs',
    };
    const label = launcher[app];

    if (!this.page.url().includes('/desktop')) {
      await this.page.goto(`${APP_BASE}/sim/${this.sessionId}/desktop`, {
        waitUntil: 'domcontentloaded',
      });
      await sleep(2500);
    }

    // Already open and in front? Nothing to do.
    const windowOpen = await this.page
      .locator(`text=${label}`)
      .first()
      .isVisible()
      .catch(() => false);

    // Desktop icons fire on double-click; the taskbar fires on single click.
    await humanDoubleClick(this.page, `button:has-text("${label}")`, 8000).catch(
      () => undefined,
    );
    await sleep(2200);

    const appeared = await this.desktopWindowReady(app);
    if (!appeared) {
      // Taskbar entry is the last button carrying this label.
      await tryClick(this.page, `button:has-text("${label}") >> nth=-1`, 4000);
      await sleep(2200);
    }
    if (!windowOpen && !(await this.desktopWindowReady(app))) {
      // Last resort so the agent is never stuck on an empty desktop.
      await this.page.goto(this.deviceUrl(app), { waitUntil: 'domcontentloaded' });
      await sleep(1800);
    }
  }

  /** Cheap check that an app window actually rendered content on the desktop. */
  private async desktopWindowReady(app: string): Promise<boolean> {
    const probe: Record<string, string> = {
      social: '[data-testid^="feed-post-"]',
      facebook: 'button[title="Report post"]',
      chat: `input[placeholder="Type a message"]`,
      email: 'button:has-text("Inbox")',
      news: 'button:has-text("Home")',
      drafts: '[aria-label="New document"]',
    };
    return this.page
      .locator(probe[app] ?? 'body')
      .first()
      .isVisible({ timeout: 6000 })
      .catch(() => false);
  }

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------

  async onboard(): Promise<void> {
    // The device shell lands on the home screen with two blocking modals.
    if (!this.page.url().includes(`/sim/${this.sessionId}`)) {
      await this.page.goto(`${APP_BASE}/sim/${this.sessionId}/device`, {
        waitUntil: 'domcontentloaded',
      });
    }
    await sleep(4000);

    for (const group of DEMOGRAPHICS) {
      for (const option of group) {
        if (await tryClick(this.page, `button:text-is("${option}")`, 2500)) break;
      }
    }
    await tryClick(this.page, 'button:text-is("Continue")', 8000);
    await sleep(2000);
    // Team briefing: read it, then dismiss.
    await sleep(1500);
    await tryClick(this.page, 'button:text-is("Got it")', 6000);
    await sleep(1200);

    if (!this.isPhone) {
      await this.page.goto(`${APP_BASE}/sim/${this.sessionId}/desktop`, {
        waitUntil: 'domcontentloaded',
      });
      await sleep(2500);
    }
    this.log(`${this.name}: onboarded (${this.spec.team}, ${this.spec.view})`);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /**
   * The feed re-sorts on every poll and grows fast — over 1100 posts in a
   * 30-minute run — so a target chosen a few seconds ago may already be off
   * screen. Re-resolve at click time and substitute a still-visible post rather
   * than burning the turn on a selector that can no longer match.
   */
  private async resolveTarget(preferredId: string): Promise<string | null> {
    const rendered = await this.renderedPostIds();
    if (rendered.has(preferredId)) return preferredId;
    for (const id of rendered) {
      if (!this.handled.has(id)) return id;
    }
    return null;
  }

  /** Post ids actually rendered in the Z feed right now. */
  private async renderedPostIds(): Promise<Set<string>> {
    try {
      const ids = (await this.page.evaluate(
        `Array.prototype.map.call(
           document.querySelectorAll('[data-testid^="feed-post-"]'),
           function (el) { return el.getAttribute('data-testid').slice('feed-post-'.length); }
         )`,
      )) as string[];
      return new Set(ids);
    } catch {
      return new Set();
    }
  }

  /**
   * The API returns every post in the session (hundreds, across platforms) but
   * the Z feed only renders a recent slice of x_twitter. Offering the brain a
   * post it cannot click is what produced most of the smoke-run failures, so the
   * candidate list is intersected with what is on screen.
   */
  private async fetchFeed(): Promise<FeedPost[]> {
    let posts: FeedPost[] = [];
    try {
      const raw = await apiFetch<FeedPost[]>(
        this.auth,
        `/api/social/posts/session/${this.sessionId}`,
      );
      if (Array.isArray(raw)) posts = raw;
    } catch {
      return [];
    }

    const rendered = await this.renderedPostIds();
    const actionable = rendered.size > 0 ? posts.filter((p) => rendered.has(p.id)) : [];

    // If nothing is rendered yet, fall back to the newest x_twitter posts so the
    // brain still has context; the executor scrolls to find them.
    const pool = actionable.length > 0 ? actionable : posts.filter((p) => p.platform === 'x_twitter');

    return pool
      .slice()
      .sort((a, b) => {
        const pri = (p: FeedPost) =>
          (harmful(p) ? 2 : 0) + (p.requires_response && !p.responded_at ? 1 : 0);
        const d = pri(b) - pri(a);
        if (d !== 0) return d;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })
      .slice(0, 20);
  }

  // -------------------------------------------------------------------------
  // Action execution
  // -------------------------------------------------------------------------

  /** Mentions open an autocomplete overlay that can swallow the submit click. */
  private clean(text: string): string {
    return text.replace(/@(\w+)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 480);
  }

  private async composeAndSend(text: string, asOrgPage: boolean, statement: boolean): Promise<void> {
    await this.openApp('social');

    const opened = await tryClick(this.page, Z.composeOpen, 6000);
    if (!opened) {
      // The desktop Z layout uses a nav button instead of a floating action button.
      await humanClick(this.page, 'button:text-is("Post")');
    }
    await sleep(900);

    if (statement) await tryClick(this.page, Z.formatStatement, 3000);
    if (asOrgPage) {
      const rect = await rectOf(this.page, Z.asPage, 4000);
      await tryClick(this.page, Z.asPage, 3000);
      // Flipping the identity to the org page is a hero beat: this is the
      // moment a player starts speaking as AMP rather than as themselves.
      this.timeline?.mark('as_page', { rect: rect ?? undefined, label: 'Posting as AMP' });
    }

    const body = this.clean(text);
    const startedAt = Date.now();
    const typed = await humanType(this.page, Z.composeText, body);
    this.timeline?.markSpan('type', startedAt, {
      rect: typed.rect ?? undefined,
      label: statement ? 'Official statement' : 'Public post',
      text: body,
      typed: typed.typed,
    });

    await sleep(600);
    const sendRect = await humanClick(this.page, Z.composeSubmit, 12_000);
    this.timeline?.mark('send', { rect: sendRect ?? undefined, label: 'Published' });
    await sleep(2500);
  }

  private async replyToPost(postId: string, text: string): Promise<void> {
    // Capture the post being answered — that's the "zoom on the comment" shot.
    const targetRect = await rectOf(this.page, Z.post(postId), 6000);
    this.timeline?.mark('read', { rect: targetRect ?? undefined, label: 'The claim' });

    await humanClick(this.page, Z.reply(postId), 12_000);
    await sleep(900);

    const body = this.clean(text);
    const startedAt = Date.now();
    const typed = await humanType(this.page, Z.composeText, body);
    this.timeline?.markSpan('type', startedAt, {
      rect: typed.rect ?? undefined,
      label: 'Rebuttal',
      text: body,
      typed: typed.typed,
    });

    await sleep(500);
    const sendRect = await humanClick(this.page, Z.composeSubmit, 12_000);
    this.timeline?.mark('send', { rect: sendRect ?? undefined, label: 'Reply sent' });
    await sleep(2200);
  }

  private async execute(action: Action): Promise<void> {
    switch (action.kind) {
      case 'statement':
        await this.composeAndSend(action.text ?? '', true, true);
        break;

      case 'post':
        await this.composeAndSend(action.text ?? '', false, false);
        break;

      case 'reply': {
        if (!action.postId || !action.text) return;
        await this.openApp('social');
        const target = await this.resolveTarget(action.postId);
        if (!target) return;
        await this.replyToPost(target, action.text);
        break;
      }

      case 'flag': {
        if (!action.postId) return;
        await this.openApp('social');
        const target = await this.resolveTarget(action.postId);
        if (!target) return;
        const postRect = await rectOf(this.page, Z.post(target), 5000);
        this.timeline?.mark('read', { rect: postRect ?? undefined, label: 'Flagged as false' });
        const rect = await humanClick(this.page, Z.flag(target), 12_000);
        this.timeline?.mark('flag', { rect: rect ?? undefined, label: 'Misinformation flagged' });
        await sleep(1200);
        break;
      }

      case 'like': {
        if (!action.postId) return;
        await this.openApp('social');
        const target = await this.resolveTarget(action.postId);
        if (!target) return;
        await humanClick(this.page, Z.like(target), 12_000);
        await sleep(900);
        break;
      }

      case 'repost': {
        if (!action.postId) return;
        await this.openApp('social');
        const target = await this.resolveTarget(action.postId);
        if (!target) return;
        await humanClick(this.page, Z.repost(target), 12_000);
        await sleep(900);
        break;
      }

      case 'fb_dispute': {
        await this.openApp('facebook');
        await humanScroll(this.page, 200);
        const rect = await humanClick(this.page, FB.dispute, 12_000);
        this.timeline?.mark('dispute', { rect: rect ?? undefined, label: 'Disputed with facts' });
        await sleep(1500);
        // The dispute modal wants supporting text; reuse the brain's copy.
        if (action.text) {
          const box = this.page.locator('textarea').first();
          if (await box.isVisible().catch(() => false)) {
            const body = this.clean(action.text);
            const startedAt = Date.now();
            await box.pressSequentially(body, { delay: 12 });
            const bb = await box.boundingBox();
            this.timeline?.markSpan('type', startedAt, {
              rect: bb ? { x: bb.x, y: bb.y, w: bb.width, h: bb.height } : undefined,
              label: 'Fact-check',
              text: body,
            });
            await sleep(500);
            await tryClick(this.page, 'button:has-text("Submit")', 4000);
            await tryClick(this.page, 'button:has-text("Dispute")', 3000);
          }
        }
        await sleep(1200);
        break;
      }

      case 'fb_report': {
        await this.openApp('facebook');
        const rect = await humanClick(this.page, FB.report, 12_000);
        this.timeline?.mark('report', { rect: rect ?? undefined, label: 'Reported to platform' });
        await sleep(1500);
        await tryClick(this.page, 'button:has-text("Submit")', 4000);
        await tryClick(this.page, 'button:has-text("Report")', 3000);
        await sleep(1000);
        break;
      }

      case 'fb_comment': {
        if (!action.text) return;
        await this.openApp('facebook');
        const body = this.clean(action.text);
        const startedAt = Date.now();
        const typed = await humanType(this.page, FB.comment, body);
        this.timeline?.markSpan('type', startedAt, {
          rect: typed.rect ?? undefined,
          label: 'Comment',
          text: body,
          typed: typed.typed,
        });
        await this.page.keyboard.press('Enter');
        this.timeline?.mark('send', { rect: typed.rect ?? undefined, label: 'Comment posted' });
        await sleep(1500);
        break;
      }

      case 'chat': {
        if (!action.text) return;
        await this.openApp('chat');
        const body = this.clean(action.text);
        const startedAt = Date.now();
        const typed = await humanType(this.page, CHAT_INPUT, body);
        this.timeline?.markSpan('chat', startedAt, {
          rect: typed.rect ?? undefined,
          label: `${this.spec.team} \u2192 team`,
          text: body,
          typed: typed.typed,
        });
        await sleep(400);
        if (!(await tryClick(this.page, 'button[type="submit"]', 4000))) {
          await this.page.keyboard.press('Enter');
        }
        await sleep(1400);
        break;
      }

      case 'read_email':
        await this.openApp('email');
        this.timeline?.mark('email', { label: 'Inbox' });
        await humanScroll(this.page, 300);
        await sleep(2500);
        break;

      case 'read_news':
        await this.openApp('news');
        await humanScroll(this.page, 350);
        await sleep(2500);
        break;

      case 'idle':
      default:
        await this.openApp('social');
        await humanScroll(this.page, 320);
        await sleep(1800);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  private dueBeat(elapsedMinutes: number): Beat | null {
    for (const beat of this.beats) {
      if (this.firedBeats.has(beat.id)) continue;
      if (elapsedMinutes >= beat.atMinute) return beat;
    }
    return null;
  }

  /**
   * Runs until `shouldStop` returns true. `elapsedMinutes` is supplied by the
   * orchestrator so every agent shares one authoritative clock.
   */
  async run(
    elapsedMinutes: () => number,
    shouldStop: () => boolean,
    paused: () => boolean,
  ): Promise<void> {
    const tuning = TUNING[this.profile];

    while (!shouldStop()) {
      if (paused()) {
        await sleep(5000);
        continue;
      }

      try {
        const minutes = elapsedMinutes();
        // Be on the feed before reading it: candidate posts are drawn from what
        // is actually rendered so every offered target is clickable.
        await this.openApp('social');
        await this.page
          .locator('[data-testid^="feed-post-"]')
          .first()
          .waitFor({ state: 'visible', timeout: 20_000 })
          .catch(() => undefined);

        const posts = await this.fetchFeed();
        const ctx = {
          name: this.name,
          persona: this.spec.persona,
          team: this.spec.team,
          profile: this.profile,
          elapsedMinutes: minutes,
          posts,
          facts: this.facts,
          handled: this.handled,
        };

        const beat = this.dueBeat(minutes);
        const action = beat ? await beatCopy(ctx, beat) : await decide(ctx);

        if (beat) {
          this.firedBeats.add(beat.id);
          this.stats.beatsFired.push(beat.id);
          this.log(`${this.name}: beat "${beat.id}" -> ${action.kind}`);
        }

        await this.execute(action);

        if (action.postId) this.handled.add(action.postId);
        this.stats.actions++;
        this.stats.byKind[action.kind] = (this.stats.byKind[action.kind] ?? 0) + 1;
      } catch (err) {
        this.stats.failures++;
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        this.log(`${this.name}: action failed — ${msg}`);
        // Clear any half-open modal so the next turn starts from a clean feed.
        await tryClick(this.page, Z.composeCancel, 2000);
        await this.page
          .keyboard.press('Escape')
          .catch(() => undefined);
      }

      const [lo, hi] = tuning.cadenceSec;
      const wait = (lo + Math.random() * (hi - lo)) * 1000;
      const deadline = Date.now() + wait;
      // Sleep in slices so a stop or pause is honoured promptly.
      while (Date.now() < deadline && !shouldStop()) await sleep(1500);
    }
  }
}
