/**
 * The single "bot intellect" slider (0-100) mapped to a concrete behaviour set
 * (docs/ai-teammate-bots-plan.md §9.1).
 *
 * Pure and deterministic: numbers interpolate linearly between anchors, booleans
 * switch on at the first anchor where they are true. Unit-tested in
 * intellect.test.ts so the slider semantics cannot drift silently.
 */

export interface BotParams {
  /** Seconds between self-initiated turns [min, max]. */
  cadenceSec: [number, number];
  /** Seconds a bot waits after a wake-up event before acting [min, max]. */
  reactionDelaySec: [number, number];
  /** Probability a harmful post the bot notices gets countered at all. */
  counterRate: number;
  /** Fraction of turns deliberately spent monitoring / idling. */
  idleRate: number;
  /** 0 = will repeat rumours as fact; 1 = only cites the fact sheet. */
  factDiscipline: number;
  /** 0 = posts out of lane freely; 1 = never acts outside the charter. */
  laneDiscipline: number;
  /** 0 = acts alone; 1 = claims work on the blackboard, relays intel, uses the publish gate. */
  coordination: number;
  /** Whether the prompt includes the grading dimensions, watchdog ladder and hidden timings. */
  knowsRubric: boolean;
  /** Whether high-stakes artefacts get a critique-and-revise pass. */
  critiquePass: boolean;
  /** Which model writes statements / legal replies. */
  modelTier: 'fast' | 'strong';
}

export type IntellectBand = 'Novice' | 'Competent' | 'Proficient' | 'Expert';

interface Anchor {
  at: number;
  params: BotParams;
}

const ANCHORS: Anchor[] = [
  {
    at: 0,
    params: {
      cadenceSec: [150, 300],
      reactionDelaySec: [180, 360],
      counterRate: 0.05,
      idleRate: 0.5,
      factDiscipline: 0.1,
      laneDiscipline: 0.2,
      coordination: 0.05,
      knowsRubric: false,
      critiquePass: false,
      modelTier: 'fast',
    },
  },
  {
    at: 30,
    params: {
      cadenceSec: [110, 240],
      reactionDelaySec: [120, 300],
      counterRate: 0.25,
      idleRate: 0.35,
      factDiscipline: 0.4,
      laneDiscipline: 0.5,
      coordination: 0.3,
      knowsRubric: false,
      critiquePass: false,
      modelTier: 'fast',
    },
  },
  {
    at: 60,
    params: {
      cadenceSec: [60, 120],
      reactionDelaySec: [60, 150],
      counterRate: 0.7,
      idleRate: 0.15,
      factDiscipline: 0.8,
      laneDiscipline: 0.9,
      coordination: 0.7,
      knowsRubric: true,
      critiquePass: false,
      modelTier: 'strong',
    },
  },
  {
    at: 85,
    params: {
      cadenceSec: [35, 80],
      reactionDelaySec: [30, 90],
      counterRate: 0.95,
      idleRate: 0.08,
      factDiscipline: 1,
      laneDiscipline: 1,
      coordination: 0.95,
      knowsRubric: true,
      critiquePass: true,
      modelTier: 'strong',
    },
  },
  {
    at: 100,
    params: {
      cadenceSec: [30, 60],
      reactionDelaySec: [20, 60],
      counterRate: 1,
      idleRate: 0.04,
      factDiscipline: 1,
      laneDiscipline: 1,
      coordination: 1,
      knowsRubric: true,
      critiquePass: true,
      modelTier: 'strong',
    },
  },
];

export const DEFAULT_INTELLECT = 70;

export function clampIntellect(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INTELLECT;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function intellectToParams(intellect: number): BotParams {
  const n = clampIntellect(intellect);
  let lo = ANCHORS[0];
  let hi = ANCHORS[ANCHORS.length - 1];
  for (let i = 0; i < ANCHORS.length - 1; i++) {
    if (n >= ANCHORS[i].at && n <= ANCHORS[i + 1].at) {
      lo = ANCHORS[i];
      hi = ANCHORS[i + 1];
      break;
    }
  }
  const span = hi.at - lo.at;
  const t = span === 0 ? 0 : (n - lo.at) / span;
  const a = lo.params;
  const b = hi.params;
  // Booleans / tiers: a value switches on at the first anchor where it is true,
  // i.e. once the slider reaches that anchor.
  const reached = n >= hi.at ? b : a;
  return {
    cadenceSec: [
      Math.round(lerp(a.cadenceSec[0], b.cadenceSec[0], t)),
      Math.round(lerp(a.cadenceSec[1], b.cadenceSec[1], t)),
    ],
    reactionDelaySec: [
      Math.round(lerp(a.reactionDelaySec[0], b.reactionDelaySec[0], t)),
      Math.round(lerp(a.reactionDelaySec[1], b.reactionDelaySec[1], t)),
    ],
    counterRate: round3(lerp(a.counterRate, b.counterRate, t)),
    idleRate: round3(lerp(a.idleRate, b.idleRate, t)),
    factDiscipline: round3(lerp(a.factDiscipline, b.factDiscipline, t)),
    laneDiscipline: round3(lerp(a.laneDiscipline, b.laneDiscipline, t)),
    coordination: round3(lerp(a.coordination, b.coordination, t)),
    knowsRubric: reached.knowsRubric,
    critiquePass: reached.critiquePass,
    modelTier: reached.modelTier,
  };
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export function intellectBand(intellect: number): IntellectBand {
  const n = clampIntellect(intellect);
  if (n < 25) return 'Novice';
  if (n < 50) return 'Competent';
  if (n < 75) return 'Proficient';
  return 'Expert';
}

export const BAND_DESCRIPTIONS: Record<IntellectBand, string> = {
  Novice: 'Slow, vague, drifts out of lane, ignores misinformation and deadlines.',
  Competent: 'Answers what lands on its desk, mostly in lane, patchy on facts and timing.',
  Proficient: 'Fact-led and in lane, counters misinformation, coordinates through chat.',
  Expert: 'Fast, precise, reviews before publishing, relays intel, plays to the rubric.',
};

/** Human-readable band rules injected into the system prompt. */
export function bandRules(params: BotParams): string {
  if (params.laneDiscipline < 0.4) {
    return [
      'BEHAVE LIKE AN UNTRAINED TEAM MEMBER UNDER PRESSURE:',
      '- Do not fact-check. Do not flag or dispute false claims, even obvious ones.',
      '- Prefer vague reassurance with no numbers, no case references, no timelines.',
      '- Be defensive or dismissive when accused; sounding irritated is fine.',
      '- Step outside your lane sometimes: comment publicly on things another team owns.',
      '- Act alone; do not coordinate.',
      'Keep copy short and hollow, e.g. "We take all feedback seriously and are looking into it."',
    ].join('\n');
  }
  if (params.laneDiscipline < 0.85) {
    return [
      'BEHAVE LIKE A REASONABLE BUT UNDRILLED PROFESSIONAL:',
      '- Deal with what is in front of you; you may miss deadlines and slower-burning threads.',
      '- Stay mostly in lane; occasionally answer something another team owns if it looks urgent.',
      '- Cite a confirmed fact when you remember one; do not invent numbers.',
      '- Coordinate in chat when it is obvious, not systematically.',
      'Keep copy plain and human.',
    ].join('\n');
  }
  return [
    'BEHAVE LIKE A WELL-DRILLED CRISIS TEAM MEMBER:',
    '- Counter every false claim fast, quoting a CONFIRMED FACT and a reference where one exists.',
    '- Lead with what is verified, name what is still unverified, and state the next update time.',
    '- Be victim-centred: address the people affected before defending the organisation.',
    '- Stay strictly in your lane; escalate via team chat or email instead of acting out of lane.',
    '- Be specific: numbers, scope, dates, who is reviewing what.',
    '- Never speculate and never repeat a false claim without labelling it false.',
    '- Honour every commitment you have already made publicly; never contradict a prior statement.',
    'Keep copy tight, calm and concrete.',
  ].join('\n');
}

export function pickSeconds(range: [number, number]): number {
  const [lo, hi] = range;
  return lo + Math.random() * Math.max(0, hi - lo);
}
