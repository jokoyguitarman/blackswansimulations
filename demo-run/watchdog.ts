/**
 * Run watchdog.
 *
 * An internet outage does not crash this capture, it corrupts it silently: the
 * browsers keep recording, but Supabase writes fail, the inject scheduler stops
 * advancing, and OpenAI grading falls back to a flat 50 for every response,
 * which erases the whole novice-versus-expert contrast. So the outage has to be
 * detected explicitly.
 *
 * On an outage the agents are paused. On recovery, `sessions.start_time` is
 * pushed forward by exactly the outage duration: elapsed time is derived from
 * start_time, so this hands back the lost minutes and the timeline resumes where
 * it stalled. Injects already published stay published.
 */

import { admin, getSocialState, sleep, type Authed } from './lib.js';

export interface Sample {
  at: string;
  elapsedMinutes: number;
  sentiment: number | null;
  publicTrust: number | null;
  narrativeControl: number | null;
  communitySafety: number | null;
  escalationRisk: number | null;
  posts: number;
  playerPosts: number;
  flaggedByPlayers: number;
  injectsPublished: number;
  healthy: boolean;
}

export interface WatchdogOptions {
  sessionId: string;
  trainer: Authed;
  /** Console line printer. */
  log: (m: string) => void;
  intervalMs?: number;
}

export class Watchdog {
  private readonly sessionId: string;
  private readonly trainer: Authed;
  private readonly log: (m: string) => void;
  private readonly intervalMs: number;

  readonly samples: Sample[] = [];

  private startTimeMs = 0;
  private stopped = false;
  private isPaused = false;
  private outageStartedAt: number | null = null;
  private totalOutageMs = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: WatchdogOptions) {
    this.sessionId = opts.sessionId;
    this.trainer = opts.trainer;
    this.log = opts.log;
    this.intervalMs = opts.intervalMs ?? 30_000;
  }

  /**
   * Reads the authoritative start_time the server uses for elapsed time.
   *
   * This must not fail quietly. Everything downstream — when beats fire, when
   * the run ends — is derived from it, and leaving startTimeMs at zero pins
   * elapsed at T+0 forever, so the run never terminates. A single dropped read
   * once cost a capture that ran twelve minutes past its target with the clock
   * frozen at zero.
   */
  async syncStartTime(attempts = 6): Promise<void> {
    let lastError = 'no start_time on the session row';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const { data, error } = await admin
          .from('sessions')
          .select('id, status, start_time')
          .eq('id', this.sessionId)
          .maybeSingle();
        if (error) {
          lastError = `query error: ${error.message}`;
        } else if (!data) {
          lastError = `no row matched id ${this.sessionId}`;
        } else if (!data.start_time) {
          lastError = `row found (status=${data.status}) but start_time is ${JSON.stringify(data.start_time)}`;
        } else {
          this.startTimeMs = new Date(data.start_time).getTime();
          this.log(`Clock synced: T+0 at ${new Date(this.startTimeMs).toISOString()}`);
          return;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      this.log(`  clock sync attempt ${attempt}/${attempts}: ${lastError}`);
      await sleep(2500);
    }
    throw new Error(
      `Could not establish the session clock after ${attempts} attempts: ${lastError}. ` +
        'Refusing to start — elapsed time would be stuck at zero.',
    );
  }

  elapsedMinutes = (): number =>
    this.startTimeMs === 0 ? 0 : Math.floor((Date.now() - this.startTimeMs) / 60_000);

  paused = (): boolean => this.isPaused;

  get outageMs(): number {
    return this.totalOutageMs;
  }

  // -------------------------------------------------------------------------
  // Probes
  // -------------------------------------------------------------------------

  private async supabaseUp(): Promise<boolean> {
    try {
      const { error } = await admin.from('sessions').select('id').eq('id', this.sessionId).single();
      return !error;
    } catch {
      return false;
    }
  }

  private async openAiUp(): Promise<boolean> {
    if (!process.env.OPENAI_API_KEY) return false;
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(12_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Protagonist page handles, cached: org pages do not change mid-session. */
  private protagonistHandlesCache: string[] | null = null;

  private async protagonistHandles(): Promise<string[]> {
    if (this.protagonistHandlesCache) return this.protagonistHandlesCache;
    const { data } = await admin
      .from('sim_org_pages')
      .select('page_handle, role')
      .eq('session_id', this.sessionId)
      .neq('role', 'antagonist');
    this.protagonistHandlesCache = (data ?? [])
      .map((r) => String(r.page_handle ?? ''))
      .filter((h) => h.length > 0);
    return this.protagonistHandlesCache;
  }

  private async counts(): Promise<{
    posts: number;
    playerPosts: number;
    flagged: number;
    injects: number;
  }> {
    // social_posts has no player_id; authorship is carried by author_type.
    // 'official_account' is not a usable proxy for player output here: every org
    // page is seeded with pre-crisis branded history under that same author_type,
    // so counting it wholesale reports ~28 "player posts" before anyone has
    // touched a keyboard. Personal posts are counted directly, and page posts
    // only when they were written after the session started.
    const startedAt = new Date(this.startTimeMs || Date.now()).toISOString();
    // Rival pages also write as 'official_account', so restrict to our own.
    const ourHandles = await this.protagonistHandles();
    const [all, personal, pagePosts, flagged, injects] = await Promise.all([
      admin
        .from('social_posts')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', this.sessionId),
      admin
        .from('social_posts')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', this.sessionId)
        .eq('author_type', 'player'),
      ourHandles.length > 0
        ? admin
            .from('social_posts')
            .select('*', { count: 'exact', head: true })
            .eq('session_id', this.sessionId)
            .eq('author_type', 'official_account')
            .in('author_handle', ourHandles)
            .gt('created_at', startedAt)
        : Promise.resolve({ count: 0 }),
      admin
        .from('social_posts')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', this.sessionId)
        .eq('is_flagged_by_player', true),
      admin
        .from('session_events')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', this.sessionId)
        .eq('event_type', 'inject'),
    ]);
    return {
      posts: all.count ?? 0,
      playerPosts: (personal.count ?? 0) + (pagePosts.count ?? 0),
      flagged: flagged.count ?? 0,
      injects: injects.count ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Outage handling
  // -------------------------------------------------------------------------

  private async beginOutage(reason: string): Promise<void> {
    if (this.outageStartedAt !== null) return;
    this.outageStartedAt = Date.now();
    this.isPaused = true;
    this.log(`!! OUTAGE (${reason}) — agents paused, holding the clock`);
  }

  private async endOutage(): Promise<void> {
    if (this.outageStartedAt === null) return;
    const outage = Date.now() - this.outageStartedAt;
    this.outageStartedAt = null;
    this.totalOutageMs += outage;

    // Give back the lost minutes by moving start_time forward.
    const repaired = new Date(this.startTimeMs + outage).toISOString();
    const { error } = await admin
      .from('sessions')
      .update({ start_time: repaired })
      .eq('id', this.sessionId);

    if (error) {
      this.log(`!! recovered after ${Math.round(outage / 1000)}s but could not repair start_time: ${error.message}`);
    } else {
      this.startTimeMs += outage;
      this.log(
        `>> recovered after ${Math.round(outage / 1000)}s — start_time pushed forward, resuming at T+${this.elapsedMinutes()}m`,
      );
    }
    this.isPaused = false;
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start(): void {
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const [supabase, openai] = await Promise.all([this.supabaseUp(), this.openAiUp()]);
        const healthy = supabase && openai;

        if (!healthy) {
          await this.beginOutage(!supabase ? 'supabase unreachable' : 'openai unreachable');
        } else if (this.outageStartedAt !== null) {
          await this.endOutage();
        }

        if (healthy) {
          const [{ posts, playerPosts, flagged, injects }, state] = await Promise.all([
            this.counts(),
            getSocialState(this.trainer, this.sessionId).catch(() => ({})),
          ]);

          const s = state as Record<string, number | undefined>;
          const sample: Sample = {
            at: new Date().toISOString(),
            elapsedMinutes: this.elapsedMinutes(),
            sentiment: s.sentiment_score ?? null,
            publicTrust: s.public_trust ?? null,
            narrativeControl: s.narrative_control ?? null,
            communitySafety: s.community_safety ?? null,
            escalationRisk: s.escalation_risk ?? null,
            posts,
            playerPosts,
            flaggedByPlayers: flagged,
            injectsPublished: injects,
            healthy,
          };
          // A transient read can come back all-zero even mid-run. Recording it
          // puts a spike down to zero in the trust chart, so drop samples that
          // regress impossibly instead of trusting them.
          const prev = this.samples.at(-1);
          const bogus =
            prev !== undefined &&
            prev.posts > 0 &&
            sample.posts === 0 &&
            sample.injectsPublished === 0;
          if (bogus) {
            this.log('  (discarded an all-zero sample — transient read failure)');
          } else {
            this.samples.push(sample);
          }

          const n = (v: number | null): string => (v === null ? ' --' : String(Math.round(v)).padStart(3));
          this.log(
            `T+${String(sample.elapsedMinutes).padStart(2)}m  ` +
              `sent${n(sample.sentiment)}  trust${n(sample.publicTrust)}  ` +
              `narr${n(sample.narrativeControl)}  esc${n(sample.escalationRisk)}  ` +
              `posts ${String(posts).padStart(4)} (players ${String(playerPosts).padStart(2)})  ` +
              `flagged ${String(flagged).padStart(2)}  injects ${String(injects).padStart(3)}`,
          );
        }
      } catch (err) {
        this.log(`watchdog tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
    };

    this.timer = setTimeout(tick, 3000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Never leave a run paused on the way out.
    if (this.outageStartedAt !== null) await this.endOutage();
    await sleep(200);
  }
}
