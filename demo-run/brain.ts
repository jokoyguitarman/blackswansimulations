/**
 * The player brain: decides what each agent does next.
 *
 * Hybrid by design. Scripted "beats" fire on a schedule so the novice/expert
 * contrast is guaranteed to land on camera regardless of what the LLM does, and
 * everything between beats is LLM-chosen from the live feed so the run reacts to
 * all 172 injects instead of replaying a fixed timeline.
 */

import { admin } from './lib.js';
import { PLAYERS_PER_TEAM, SCENARIO_ID, type RunProfile, type TeamName } from './config.js';

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.5';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ---------------------------------------------------------------------------
// Scenario truth
// ---------------------------------------------------------------------------

export interface FactSheet {
  confirmed: string[];
  falseClaims: string[];
  orgName: string;
}

export async function loadFactSheet(): Promise<FactSheet> {
  const { data } = await admin
    .from('scenarios')
    .select('initial_state')
    .eq('id', SCENARIO_ID)
    .single();

  const state = (data?.initial_state ?? {}) as {
    org_name?: string;
    fact_sheet?: { confirmed_facts?: unknown[]; unconfirmed_claims?: unknown[] };
  };

  const flatten = (items: unknown[] | undefined): string[] =>
    (items ?? [])
      .map((i) =>
        typeof i === 'string'
          ? i
          : typeof i === 'object' && i !== null
            ? String(
                (i as Record<string, unknown>).claim ??
                  (i as Record<string, unknown>).fact ??
                  (i as Record<string, unknown>).text ??
                  JSON.stringify(i),
              )
            : String(i),
      )
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    orgName: state.org_name ?? 'AMP',
    confirmed: flatten(state.fact_sheet?.confirmed_facts).slice(0, 18),
    falseClaims: flatten(state.fact_sheet?.unconfirmed_claims).slice(0, 18),
  };
}

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

export type ActionKind =
  | 'statement' // post on Z as the AMP org page (official voice)
  | 'post' // post on Z as yourself
  | 'reply' // reply to a specific Z post
  | 'flag' // flag a Z post as harmful/false
  | 'like'
  | 'repost'
  | 'fb_dispute' // Facebook: dispute a post with facts
  | 'fb_report' // Facebook: report a post
  | 'fb_comment'
  | 'chat' // internal team coordination
  | 'read_email'
  | 'read_news'
  | 'idle';

export interface Action {
  kind: ActionKind;
  /** Target post for reply/flag/like/repost/fb_*. */
  postId?: string;
  /** Copy for statement/post/reply/chat/fb_comment. */
  text?: string;
  /** Why the brain chose this; logged, never shown in the UI. */
  reason?: string;
}

export interface FeedPost {
  id: string;
  author_display_name: string;
  author_handle: string;
  author_type: string;
  content: string;
  platform: string;
  created_at: string;
  virality_score?: number;
  content_flags?: Record<string, unknown> | null;
  requires_response?: boolean;
  responded_at?: string | null;
}

const isMisinfo = (p: FeedPost): boolean => {
  const f = p.content_flags ?? {};
  return Boolean(f.is_misinformation || f.is_false_claim || f.misinformation);
};
const isHate = (p: FeedPost): boolean => {
  const f = p.content_flags ?? {};
  return Boolean(f.is_hate_speech || f.hate_speech || f.is_incitement);
};

export const harmful = (p: FeedPost): boolean => isMisinfo(p) || isHate(p);

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface ProfileTuning {
  /** Seconds between actions, before jitter. */
  cadenceSec: [number, number];
  /** Probability a harmful post gets countered at all. */
  counterRate: number;
  /** Fraction of turns spent idling / scrolling instead of acting. */
  idleRate: number;
}

export const TUNING: Record<RunProfile, ProfileTuning> = {
  // Untrained: slow, distracted, rarely counters anything.
  novice: { cadenceSec: [110, 240], counterRate: 0.08, idleRate: 0.42 },
  // Post-training: tight loop, counters nearly everything it sees.
  expert: { cadenceSec: [35, 80], counterRate: 0.95, idleRate: 0.08 },
};

const TEAM_LANE: Record<TeamName, string> = {
  Communications:
    'You own AMP\'s public voice: holding statements, platform replies, correcting false claims, and tone. You are the ONLY team allowed to publish as the official AMP page.',
  Legal:
    'You own verification, defamation exposure, regulatory duties and disclosure. You do NOT post publicly. You clear language for Communications and log takedown/correction requests via internal chat.',
  'Stakeholder Management':
    'You own the board, MPs, regulators and senior leadership. You brief internally and prepare escalations. You do NOT post publicly; you coordinate via internal chat and email.',
  'Partnerships and Engagement':
    'You own mosque partners, NGO partners and beneficiary service continuity. You reassure partners directly and feed ground truth to Communications. Public posting is rare and only about service continuity.',
  Fundraising:
    'You own donors, funders, restricted funds and the donation platform. You answer donor and funder queries and protect donation confidence. You do NOT make public statements about the allegations.',
};

const NOVICE_RULES = `
BEHAVE LIKE AN UNTRAINED TEAM UNDER PRESSURE. Specifically:
- Do not fact-check. Never flag or dispute false claims, even obvious ones.
- Prefer vague corporate reassurance with no numbers, no case references, no timelines.
- Be defensive or dismissive when accused. It is fine to sound irritated.
- Step outside your lane: comment publicly on things another team owns.
- Ignore internal coordination; act alone.
- Never cite a confirmed fact even when one is available.
Keep copy short and hollow, e.g. "We take all feedback seriously and are looking into it."`;

const EXPERT_RULES = `
BEHAVE LIKE A WELL-DRILLED CRISIS COMMS TEAM. Specifically:
- Counter every false claim fast, quoting a CONFIRMED FACT and a case reference where one exists.
- Lead with what is verified, name what is still unverified, and state the next update time.
- Be victim-centred: address beneficiary and donor anxiety before defending the organisation.
- Stay strictly in your lane; escalate via internal chat instead of posting out of lane.
- Be specific: numbers, scope, dates, who is reviewing what.
- Never speculate and never repeat a false claim without labelling it false.
Keep copy tight, calm, and concrete.`;

// ---------------------------------------------------------------------------
// Mandatory beats
// ---------------------------------------------------------------------------

export interface Beat {
  /** Fire once at or after this elapsed minute. */
  atMinute: number;
  kind: ActionKind;
  /** Copy, or a marker resolved at execution time. */
  text?: string;
  /** Restrict to one team; omit to apply to the agent's own team. */
  team?: TeamName;
  id: string;
}

/** Beat times below are authored against this arc and scaled to the real run. */
const BEAT_REFERENCE_MINUTES = 60;

/**
 * Beats guarantee the story arc. The expert run must publish an official
 * statement inside the window the engine rewards (it penalises "no statement"
 * at T+20 and T+35), and must visibly clear misinformation. The novice run must
 * visibly miss both.
 *
 * `runMinutes` compresses the schedule proportionally so a shorter capture still
 * contains the whole arc. Without it a 30-minute run would drop every beat timed
 * past the halfway mark — including the novice team's single late statement,
 * leaving them implausibly silent for the entire session.
 */
export function beatsFor(
  profile: RunProfile,
  team: TeamName,
  playerIndex: number,
  runMinutes = BEAT_REFERENCE_MINUTES,
): Beat[] {
  const scale = Math.min(1, runMinutes / BEAT_REFERENCE_MINUTES);
  // playerIndex is the position in the whole roster, not within the team. Beats
  // are authored per seat ("the team lead publishes"), so derive that: the roster
  // lays teams out as contiguous blocks of PLAYERS_PER_TEAM.
  const seat = ((playerIndex - 1) % PLAYERS_PER_TEAM) + 1;
  // Spreads seats within a team across a few minutes. Without it all twenty
  // non-Communications players fire the same beat on the same minute and hammer
  // the same top-of-feed post, which reads as scripted on camera.
  const stagger = seat - 1;
  // Seat-based staggering still puts one player from every team on the same
  // minute — five simultaneous chat posts, which is enough to make the chat
  // input re-render under everyone and time out their keystrokes. Beats that
  // every team shares use a wider spread keyed off the whole roster instead.
  const wide = (playerIndex - 1) % 9;
  // Floor at 2 minutes: a statement that lands before the crisis is even visible
  // on the feed reads as precognition rather than competence.
  const at = (minute: number, offset = stagger): number =>
    Math.max(2, Math.round(minute * scale) + offset);
  if (profile === 'expert') {
    const beats: Beat[] = [];
    if (team === 'Communications') {
      // The team lead publishes; the rest amplify and correct.
      if (seat === 1) {
        beats.push({
          id: 'holding-statement',
          // No stagger: the whole point is that this lands fast.
          atMinute: at(3, 0),
          kind: 'statement',
          text:
            'We are aware of allegations circulating about one AMP-led initiative. Here is what we can confirm now: an internal review has identified a financial mismanagement issue in ONE initiative, it has been formally disclosed, and interim controls are in place. All other AMP programmes and beneficiary disbursements continue as scheduled. We have seen claims that assistance is frozen and that funds are missing. Those are not accurate. We will publish a verified update within the hour.',
        });
        beats.push({
          id: 'second-update',
          atMinute: at(24),
          kind: 'statement',
          text:
            'Verified update. An independent review has been commissioned and its scope is published. No account freeze notice has been received and no services have been suspended. Claims of related-party vendor payments and of missing funds above one million dollars remain unsupported by evidence. Beneficiaries: your scheduled support is unchanged. Donors: restricted funds remain ring-fenced. Next update in one hour.',
        });
      }
      if (seat === 2) {
        // Deputy publishes the service-continuity follow-up. Also insurance:
        // if the lead's statement fails, an official voice still lands early.
        beats.push({
          id: 'continuity-statement',
          atMinute: at(9),
          kind: 'statement',
          text:
            'For beneficiaries and partners, specifically: no AMP service has been suspended. Bursary disbursements, tuition programmes, employability clinics and case support all run on their normal schedule this week. If you have been told otherwise by any third party, please check with us directly before acting on it. Referral partners: your existing referrals stand.',
        });
      }
      beats.push({ id: 'counter-misinfo-early', atMinute: at(7), kind: 'reply' });
      beats.push({ id: 'flag-misinfo', atMinute: at(10), kind: 'flag' });
      beats.push({ id: 'counter-misinfo-mid', atMinute: at(20), kind: 'fb_dispute' });
      beats.push({ id: 'flag-misinfo-late', atMinute: at(34), kind: 'flag' });
    } else {
      beats.push({
        id: 'lane-coordination',
        atMinute: at(5, wide),
        kind: 'chat',
        text: 'Logging what I own and escalating rather than posting. Sending verified points to Comms now.',
      });
      beats.push({ id: 'flag-misinfo', atMinute: at(12, wide), kind: 'flag' });
      beats.push({ id: 'report-hate', atMinute: at(26, wide), kind: 'fb_report' });
      beats.push({ id: 'flag-misinfo-late', atMinute: at(40, wide), kind: 'flag' });
    }
    return beats;
  }

  // Novice: the only public statement arrives far too late and says nothing.
  const beats: Beat[] = [];
  if (team === 'Communications' && seat === 1) {
    beats.push({
      id: 'late-empty-statement',
      atMinute: at(41),
      kind: 'statement',
      text:
        'We are aware of recent online discussion and we take all feedback seriously. AMP has always acted with integrity. We ask the public not to speculate while we look into the matter internally.',
    });
  }
  if (team !== 'Communications' && seat === 2) {
    // Out-of-lane public posting, which the engine penalises.
    beats.push({
      id: 'out-of-lane',
      atMinute: at(17),
      kind: 'post',
      text: 'Speaking personally, a lot of what is being said online right now is simply unfair to the people who work here.',
    });
  }
  return beats;
}

// ---------------------------------------------------------------------------
// LLM decision
// ---------------------------------------------------------------------------

export interface BrainContext {
  name: string;
  persona: string;
  team: TeamName;
  profile: RunProfile;
  elapsedMinutes: number;
  posts: FeedPost[];
  facts: FactSheet;
  /** Post ids this agent has already acted on, so it does not loop. */
  handled: Set<string>;
}

const allowedActions = (team: TeamName, profile: RunProfile): ActionKind[] => {
  const base: ActionKind[] = ['reply', 'chat', 'read_email', 'read_news', 'like', 'idle'];
  if (team === 'Communications') base.push('statement', 'post', 'fb_comment');
  if (profile === 'expert') base.push('flag', 'fb_dispute', 'fb_report');
  else base.push('repost', 'post');
  return base;
};

function systemPrompt(ctx: BrainContext): string {
  return [
    `You are ${ctx.name}. ${ctx.persona}`,
    `You work at ${ctx.facts.orgName} in Singapore. Your team is "${ctx.team}".`,
    TEAM_LANE[ctx.team],
    ctx.profile === 'expert' ? EXPERT_RULES : NOVICE_RULES,
    '',
    'CONFIRMED FACTS (only these are verified):',
    ...ctx.facts.confirmed.map((f) => `- ${f}`),
    '',
    'CLAIMS CIRCULATING THAT ARE NOT SUPPORTED BY EVIDENCE:',
    ...ctx.facts.falseClaims.map((f) => `- ${f}`),
    '',
    'You are in a live crisis-response exercise. Write like a real Singaporean',
    'professional on a phone: plain English, no emoji, no hashtags unless natural.',
    'Never mention that this is a simulation.',
  ].join('\n');
}

function userPrompt(ctx: BrainContext): string {
  const feed = ctx.posts
    .slice(0, 14)
    .map((p) => {
      const tags = [
        isMisinfo(p) ? 'FALSE-CLAIM' : null,
        isHate(p) ? 'HATE' : null,
        p.requires_response && !p.responded_at ? 'NEEDS-RESPONSE' : null,
        ctx.handled.has(p.id) ? 'ALREADY-HANDLED-BY-YOU' : null,
      ]
        .filter(Boolean)
        .join(',');
      return `[${p.id}] (${p.platform}) @${p.author_handle}${tags ? ` <${tags}>` : ''}: ${p.content.replace(/\s+/g, ' ').slice(0, 240)}`;
    })
    .join('\n');

  return [
    `Elapsed: T+${ctx.elapsedMinutes} minutes.`,
    '',
    'What you can see right now:',
    feed || '(feed is quiet)',
    '',
    `Choose exactly ONE action from: ${allowedActions(ctx.team, ctx.profile).join(', ')}`,
    'Rules: use post_id only for reply/flag/like/repost/fb_dispute/fb_report/fb_comment.',
    'Do not pick a post tagged ALREADY-HANDLED-BY-YOU.',
    'Keep text under 400 characters.',
    '',
    'Reply with JSON only: {"action":"...","post_id":"...","text":"...","reason":"..."}',
  ].join('\n');
}

/** Deterministic fallback so a brain outage never stalls an agent mid-run. */
function heuristicAction(ctx: BrainContext): Action {
  const tuning = TUNING[ctx.profile];
  const target = ctx.posts.find((p) => harmful(p) && !ctx.handled.has(p.id));

  if (target && Math.random() < tuning.counterRate) {
    if (ctx.profile === 'expert') {
      return {
        kind: Math.random() < 0.5 ? 'flag' : 'reply',
        postId: target.id,
        text:
          'This claim is not accurate. What is confirmed: the issue is limited to one initiative, it has been formally disclosed, and services continue as scheduled. We will keep publishing verified updates.',
        reason: 'heuristic: counter harmful post',
      };
    }
    return { kind: 'like', postId: target.id, reason: 'heuristic: novice engages without countering' };
  }

  if (Math.random() < tuning.idleRate) {
    return { kind: 'idle', reason: 'heuristic: idle' };
  }
  return {
    kind: 'chat',
    text: ctx.profile === 'expert'
      ? 'Monitoring my lane. Nothing new that needs escalation this minute.'
      : 'Anyone know what we are supposed to be saying about this?',
    reason: 'heuristic: chat filler',
  };
}

/**
 * Fallbacks used to be invisible, which is how a rejected `temperature` managed
 * to route every agent through the heuristic without anyone noticing.
 */
export const brainStats = { calls: 0, fallbacks: 0, lastError: '' };

function fallback(ctx: BrainContext, why: string): Action {
  brainStats.fallbacks++;
  brainStats.lastError = why;
  return heuristicAction(ctx);
}

export async function decide(ctx: BrainContext): Promise<Action> {
  if (!OPENAI_KEY) return fallback(ctx, 'no OPENAI_API_KEY');
  brainStats.calls++;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        // No temperature: gpt-5.5 only accepts the default and 400s otherwise,
        // which would silently drop every agent onto the heuristic fallback.
        // Novice/expert divergence comes from the system prompt instead.
        model: OPENAI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt(ctx) },
          { role: 'user', content: userPrompt(ctx) },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return fallback(ctx, `HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = body.choices?.[0]?.message?.content;
    if (!raw) return fallback(ctx, 'empty completion');

    const parsed = JSON.parse(raw) as {
      action?: string;
      post_id?: string;
      text?: string;
      reason?: string;
    };

    const kind = parsed.action as ActionKind;
    if (!allowedActions(ctx.team, ctx.profile).includes(kind)) {
      return fallback(ctx, `disallowed action "${parsed.action}"`);
    }

    // Only trust a post id the agent can actually see.
    const postId =
      parsed.post_id && ctx.posts.some((p) => p.id === parsed.post_id)
        ? parsed.post_id
        : undefined;

    return { kind, postId, text: parsed.text?.slice(0, 480), reason: parsed.reason };
  } catch (err) {
    return fallback(ctx, err instanceof Error ? err.message.slice(0, 200) : String(err));
  }
}

/** Copy for a beat that did not ship its own text (e.g. a reply to whatever is live). */
export async function beatCopy(ctx: BrainContext, beat: Beat): Promise<Action> {
  const target =
    ctx.posts.find((p) => harmful(p) && !ctx.handled.has(p.id)) ??
    ctx.posts.find((p) => !ctx.handled.has(p.id));

  if (beat.text) return { kind: beat.kind, text: beat.text, postId: target?.id, reason: beat.id };
  if (!target) return { kind: 'idle', reason: `${beat.id}: nothing to act on` };

  // Flag/report need no copy at all.
  const needsText = beat.kind === 'reply' || beat.kind === 'fb_comment' || beat.kind === 'chat';
  if (!needsText) return { kind: beat.kind, postId: target.id, reason: beat.id };

  // Ask the LLM to write copy aimed at this specific post. Only adopt the text
  // if it came back for the same kind of action; a heuristic chat filler read as
  // a public reply is worse than the fixed rebuttal below.
  const decided = await decide({
    ...ctx,
    posts: [target, ...ctx.posts.filter((p) => p.id !== target.id)],
  });
  const usable = decided.kind === beat.kind && decided.text ? decided.text : null;

  return {
    kind: beat.kind,
    postId: target.id,
    text:
      usable ??
      'To be clear: that claim is not supported by evidence. What is confirmed is that the issue is limited to one initiative, it has been formally disclosed, interim controls are in place, and beneficiary support continues as scheduled. We will publish a verified update within the hour.',
    reason: beat.id,
  };
}
