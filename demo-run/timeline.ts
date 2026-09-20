/**
 * Shot timeline.
 *
 * The trailer needs to zoom onto the exact comment being read, the exact
 * textarea being typed into, the exact flag icon lighting up. Guessing those
 * rectangles after the fact is hopeless, but the agent knows them at the moment
 * it acts — so it records the timestamp (relative to its own video) together
 * with the element's on-screen box, and the trailer builder crops straight to it.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ShotKind =
  | 'read' // looking at a post/comment worth zooming on
  | 'type' // characters going into a field
  | 'send' // the click that publishes
  | 'flag'
  | 'dispute'
  | 'report'
  | 'chat'
  | 'email'
  | 'dm'
  | 'as_page' // switching the compose identity to the org page
  | 'called_out' // someone publicly answered this player
  | 'mistake';

export interface ShotEvent {
  /** Milliseconds into this agent's own video file. */
  atMs: number;
  /** Duration of the moment, where known (e.g. how long the typing took). */
  durMs?: number;
  kind: ShotKind;
  rect?: Rect;
  /** Short human label, used for on-screen callouts. */
  label?: string;
  /** The copy involved, trimmed. Useful for choosing which shot to feature. */
  text?: string;
  /** Beat id when this came from the scripted schedule. */
  beat?: string;
  /**
   * Only meaningful on 'type' shots. False means the value was set directly
   * after keystrokes kept being interrupted, so it must not be used for a
   * typing close-up — it would look like autofill on camera.
   */
  typed?: boolean;
}

export class Timeline {
  readonly events: ShotEvent[] = [];

  constructor(
    /** Wall clock when the video started recording, i.e. context creation. */
    private readonly videoStartMs: number,
    readonly agentLabel: string,
    /** CSS viewport, as the page sees it. */
    private readonly cssViewport: { width: number; height: number },
    /**
     * Device pixel ratio the context recorded at. Bounding boxes come back in
     * CSS pixels but the video file is scaled, so rects are converted here —
     * otherwise every crop in the trailer would be offset and undersized.
     */
    private readonly scale = 1,
  ) {}

  /** Video-space dimensions, which is the coordinate system crops must use. */
  get viewport(): { width: number; height: number } {
    return {
      width: this.cssViewport.width * this.scale,
      height: this.cssViewport.height * this.scale,
    };
  }

  private toVideoSpace(rect?: Rect): Rect | undefined {
    if (!rect) return undefined;
    if (this.scale === 1) return rect;
    return {
      x: rect.x * this.scale,
      y: rect.y * this.scale,
      w: rect.w * this.scale,
      h: rect.h * this.scale,
    };
  }

  mark(kind: ShotKind, opts: Omit<ShotEvent, 'atMs' | 'kind'> = {}): void {
    this.events.push({
      atMs: Math.max(0, Date.now() - this.videoStartMs),
      kind,
      ...opts,
      rect: this.toVideoSpace(opts.rect),
      text: opts.text ? opts.text.replace(/\s+/g, ' ').slice(0, 220) : undefined,
    });
  }

  /** Marks a moment that spans time, e.g. the whole typing burst. */
  markSpan(kind: ShotKind, startedAtMs: number, opts: Omit<ShotEvent, 'atMs' | 'kind'> = {}): void {
    const atMs = Math.max(0, startedAtMs - this.videoStartMs);
    this.events.push({
      atMs,
      durMs: Math.max(0, Date.now() - startedAtMs),
      kind,
      ...opts,
      rect: this.toVideoSpace(opts.rect),
      text: opts.text ? opts.text.replace(/\s+/g, ' ').slice(0, 220) : undefined,
    });
  }

  toJSON(): unknown {
    return {
      agent: this.agentLabel,
      viewport: this.viewport,
      scale: this.scale,
      events: this.events,
    };
  }
}

export function writeTimelines(dir: string, timelines: Timeline[]): string {
  const out = path.join(dir, 'shots.json');
  fs.writeFileSync(
    out,
    JSON.stringify(
      { agents: timelines.map((t) => t.toJSON()) },
      null,
      2,
    ),
  );
  return out;
}
