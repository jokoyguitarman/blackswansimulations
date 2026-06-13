/**
 * Extremist Hive — Doctrine module (the "brain").
 *
 * This is a DATA-ONLY behavior model for a DEFENSIVE counter-extremism (CVE)
 * training simulation. It encodes — at the abstract, analytical level used in
 * CVE scholarship — how opportunistic agitators exploit a breaking social
 * crisis to divide the public. It exists so trainees learn to RECOGNIZE and
 * COUNTER manipulation.
 *
 * Containment principles (enforced in buildSystemPrompt):
 *  - Generated posts must read as recognizably divisive bait a responder must
 *    neutralize — NOT as authentic recruitment content, real ideology/theology,
 *    real slogans, named groups, or anything operational.
 *  - The cell are anonymous online agitators who ride existing grievances; the
 *    hidden "frame" drives behavior (division), never literal ideology.
 *
 * Source: docs/extremist-hive-research-synthesis.md (peer-reviewed + institutional
 * CVE literature). The research found that jihadist and far-right actors use
 * nearly identical crisis-exploitation MECHANICS and differ mainly in the
 * grievance NARRATIVE they plug in — hence one engine, two "skins".
 */

// ─── Persona roster (fixed, scenario-agnostic) ───────────────────────────────

export type ExtremistRole =
  | 'ideologue'
  | 'amplifier'
  | 'meme_maker'
  | 'pseudo_news'
  | 'scout'
  | 'provocateur';

export interface ExtremistPersona {
  handle: string;
  name: string;
  /** Maps to social_posts.author_type. */
  author_type: 'npc_public' | 'npc_influencer' | 'npc_media';
  /** Functional role in the agitator ecosystem (research Section C). */
  role: ExtremistRole;
  /** How this account writes (tone/length cue for the generator). */
  voice: string;
  /** Move ids this persona gravitates toward (see EXTREMIST_MOVES). */
  primary_moves: string[];
  follower_count: number;
}

/**
 * The cell. A small, recurring set of behavioral archetypes drawn from the
 * actor-role typology. Handles are deliberately generic "blend-in" accounts —
 * the whole point is that opportunists infiltrate an ordinary feed.
 */
export const EXTREMIST_CELL: ExtremistPersona[] = [
  {
    handle: '@unfiltered_truth',
    name: 'The Unfiltered Truth',
    author_type: 'npc_influencer',
    role: 'ideologue',
    voice:
      'calm, "I told you so" authority; frames the crisis as proof of a bigger pattern; never swears',
    primary_moves: ['news_jack', 'wedge', 'grievance_hijack'],
    follower_count: 48000,
  },
  {
    handle: '@frontline_wire',
    name: 'Frontline Wire',
    author_type: 'npc_media',
    role: 'pseudo_news',
    voice:
      'mimics a neutral "breaking news" account; clipped headlines; implies more than it states',
    primary_moves: ['premature_blame', 'pseudo_evidence', 'fogging'],
    follower_count: 22000,
  },
  {
    handle: '@realtalk_rae',
    name: 'Rae Talks Real',
    author_type: 'npc_public',
    role: 'amplifier',
    voice: 'relatable everyperson; "I\'m just a normal person and I\'m scared/angry"; emotional',
    primary_moves: ['moral_outrage', 'wedge', 'exploit_silence'],
    follower_count: 6400,
  },
  {
    handle: '@clips_that_land',
    name: 'clips that land',
    author_type: 'npc_public',
    role: 'meme_maker',
    voice: 'short, punchy, ironic; deniable humor; built to be screenshotted and reshared',
    primary_moves: ['ridicule', 'wedge', 'moral_outrage'],
    follower_count: 15500,
  },
  {
    handle: '@just_asking_jay',
    name: 'Just Asking Jay',
    author_type: 'npc_public',
    role: 'provocateur',
    voice: 'poses leading "innocent questions"; never asserts directly; baits responders',
    primary_moves: ['jaq', 'fogging', 'exploit_silence'],
    follower_count: 3100,
  },
  {
    handle: '@watching_quietly',
    name: 'watching',
    author_type: 'npc_public',
    role: 'scout',
    voice:
      'low-key, points others at the "real story"; quote-amplifies the most divisive take available',
    primary_moves: ['wedge', 'news_jack', 'grievance_hijack'],
    follower_count: 1800,
  },
];

/** Fast lookup set used by computeSocialState to weight hive posts as designed NPCs (3x). */
export const EXTREMIST_HANDLES: Set<string> = new Set(EXTREMIST_CELL.map((p) => p.handle));

// ─── Move catalog (research Section A: shared crisis-exploitation tactics) ────

export interface ExtremistMove {
  id: string;
  /** One-line behavioral description (the mechanic). */
  description: string;
  /** content_flags this move typically warrants (for the generator + scoring). */
  flags: string[];
}

export const EXTREMIST_MOVES: ExtremistMove[] = [
  {
    id: 'news_jack',
    description: 'reframe the live incident as "proof" of a pre-existing grievance narrative',
    flags: ['is_harmful_narrative', 'is_inflammatory'],
  },
  {
    id: 'premature_blame',
    description: 'assign a culprit by group/identity before any facts are confirmed',
    flags: ['is_misinformation', 'is_harmful_narrative', 'is_inflammatory'],
  },
  {
    id: 'wedge',
    description: 'pit two communities against each other and push an us-vs-them split',
    flags: ['is_harmful_narrative', 'is_inflammatory', 'is_organized_pressure'],
  },
  {
    id: 'exploit_silence',
    description: 'frame the lack of an official response as a deliberate cover-up',
    flags: ['is_harmful_narrative', 'is_inflammatory'],
  },
  {
    id: 'fogging',
    description: 'inject contradiction and doubt to erode trust in any authoritative account',
    flags: ['is_misinformation', 'is_harmful_narrative'],
  },
  {
    id: 'jaq',
    description: '"just asking questions" — smuggle a claim in as an innocent question',
    flags: ['is_harmful_narrative'],
  },
  {
    id: 'moral_outrage',
    description: 'maximize moral-emotional charge to make the divisive take go viral',
    flags: ['is_inflammatory', 'is_harmful_narrative'],
  },
  {
    id: 'pseudo_evidence',
    description:
      'attach a cherry-picked stat or unverifiable "list" to give the claim a veneer of proof',
    flags: ['is_misinformation', 'is_harmful_narrative'],
  },
  {
    id: 'grievance_hijack',
    description: 'attach a real local grievance to the broader divisive narrative',
    flags: ['is_harmful_narrative', 'is_organized_pressure'],
  },
  {
    id: 'ridicule',
    description:
      'use deniable mockery/irony to dehumanize an out-group while claiming it is "just a joke"',
    flags: ['is_harmful_narrative', 'is_inflammatory'],
  },
];

const MOVE_BY_ID = new Map(EXTREMIST_MOVES.map((m) => [m.id, m]));

export function getMove(id: string): ExtremistMove | undefined {
  return MOVE_BY_ID.get(id);
}

// ─── Grievance frames (research Section B: the two "skins") ──────────────────
//
// Abstracted division narratives. These describe the SHAPE of the grievance an
// opportunist plugs in — never a real ideology, group, or theology.

export interface GrievanceFrame {
  id: string;
  label: string;
  /** Abstract description of the wedge the agitator exploits. */
  wedge: string;
  /** Keywords that hint this frame fits a given crisis (best-effort selection). */
  cues: string[];
}

export const GRIEVANCE_FRAMES: GrievanceFrame[] = [
  {
    id: 'communal_blame',
    label: 'Communal blame / collective scapegoating',
    wedge:
      'blame an entire religious, ethnic, or migrant community for the crisis and frame coexistence itself as naive or dangerous, pushing each side toward a hardened "them vs us" stance',
    cues: [
      'migrant',
      'immigrant',
      'religio',
      'ethnic',
      'race',
      'racial',
      'community',
      'mosque',
      'temple',
      'refugee',
      'foreign',
    ],
  },
  {
    id: 'institutional_betrayal',
    label: 'Institutional betrayal / elite cover-up',
    wedge:
      'frame authorities, the company, and the media as a corrupt in-group that is hiding the truth and sacrificing ordinary people, positioning the agitator as the only honest voice',
    cues: [
      'recall',
      'cover',
      'official',
      'government',
      'corporate',
      'company',
      'regulator',
      'data',
      'safety',
      'leak',
      'scandal',
    ],
  },
];

/** Pick the grievance frame whose cues best match the crisis; deterministic fallback by hash. */
export function selectGrievanceFrame(crisisText: string, sessionId: string): GrievanceFrame {
  const text = (crisisText || '').toLowerCase();
  let best: { frame: GrievanceFrame; score: number } | null = null;
  for (const frame of GRIEVANCE_FRAMES) {
    const score = frame.cues.reduce((s, cue) => (text.includes(cue) ? s + 1 : s), 0);
    if (!best || score > best.score) best = { frame, score };
  }
  if (best && best.score > 0) return best.frame;
  // Deterministic fallback so a session is stable across ticks.
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = (hash << 5) - hash + sessionId.charCodeAt(i);
  return GRIEVANCE_FRAMES[Math.abs(hash) % GRIEVANCE_FRAMES.length];
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

export interface BattlefieldContext {
  persona: ExtremistPersona;
  move: ExtremistMove;
  frame: GrievanceFrame;
  platform: 'x_twitter' | 'facebook';
  crisisDescription: string;
  orgName: string;
  country: string;
  socialStateSummary: string;
  recentFeed: string;
  /** Optional human-readable description of the detected opening. */
  openingNote: string;
}

/**
 * Builds the in-character system prompt for one post. Heavy guardrails keep the
 * output recognizable-but-not-operational.
 */
export function buildSystemPrompt(ctx: BattlefieldContext): string {
  const platformStyle =
    ctx.platform === 'facebook'
      ? 'Facebook (2-4 sentences, personal and emotional, no hashtags)'
      : 'X/Twitter (1-2 short punchy sentences, may use 1-2 hashtags)';

  return `You are role-playing a single ANONYMOUS ONLINE AGITATOR inside a CRISIS-RESPONSE TRAINING SIMULATION. Your posts exist so trainees learn to spot and counter divisive manipulation. You are NOT a real organization and you never claim to be one.

YOUR PERSONA: "${ctx.persona.name}" (${ctx.persona.handle}) — role: ${ctx.persona.role}. Voice: ${ctx.persona.voice}.

YOUR TACTIC THIS POST — ${ctx.move.id}: ${ctx.move.description}.

THE WEDGE YOU EXPLOIT (abstract): ${ctx.frame.wedge}.

THE CRISIS: ${ctx.crisisDescription.substring(0, 400)}${ctx.orgName ? `\nOrganization in the crosshairs: ${ctx.orgName}` : ''}${ctx.country ? `\nCountry: ${ctx.country}` : ''}

LIVE SITUATION: ${ctx.socialStateSummary}
THE OPENING YOU ARE EXPLOITING: ${ctx.openingNote}

RECENT FEED (react to it; pounce on a fresh post or on silence):
${ctx.recentFeed || '(quiet so far)'}

WRITE ONE ${platformStyle} post that executes your tactic to widen division around this specific crisis.

HARD RULES (a training tool — stay within them):
- Be RECOGNIZABLY divisive bait that a sharp responder should flag — cunning but not subtle to the point of invisibility.
- DO NOT name, quote, praise, or reference any real terrorist organization, real extremist movement, real ideology, religious scripture, or real political figure.
- DO NOT include slogans, theology, recruitment language, calls to join anything, instructions, addresses, targets, or any operational/violent how-to.
- Ride EXISTING grievances and emotions; imply rather than declare; keep plausible deniability.
- No explicit calls to violence. Provocation works through insinuation, blame, and outrage, not instructions.
- Write in the language/register an ordinary user in ${ctx.country || 'the country'} would use.

Return ONLY valid JSON:
{ "content": "the post text", "content_flags": { "is_harmful_narrative": true, "is_inflammatory": false, "is_misinformation": false, "is_organized_pressure": false, "incites_violence": false } }
Set the flags honestly to reflect what you actually wrote. "incites_violence" must remain false.`;
}

// ─── In-thread reply behavior ─────────────────────────────────────────────────

/** Moves best suited to baiting inside an existing comment thread (vs. broadcasting). */
export const REPLY_MOVES: string[] = [
  'jaq',
  'wedge',
  'fogging',
  'ridicule',
  'exploit_silence',
  'grievance_hijack',
];

/**
 * Builds the in-character system prompt for a single IN-THREAD reply. Same
 * containment guardrails as buildSystemPrompt, but the agitator reacts to the
 * specific exchange rather than broadcasting.
 */
export function buildReplyPrompt(ctx: BattlefieldContext, threadContext: string): string {
  return `You are role-playing a single ANONYMOUS ONLINE AGITATOR inside a CRISIS-RESPONSE TRAINING SIMULATION. Your replies exist so trainees learn to spot and counter divisive manipulation. You are NOT a real organization and never claim to be one.

YOUR PERSONA: "${ctx.persona.name}" (${ctx.persona.handle}) — role: ${ctx.persona.role}. Voice: ${ctx.persona.voice}.

YOUR TACTIC THIS REPLY — ${ctx.move.id}: ${ctx.move.description}.
THE WEDGE YOU EXPLOIT (abstract): ${ctx.frame.wedge}.

THE CRISIS: ${ctx.crisisDescription.substring(0, 300)}${ctx.orgName ? `\nOrganization in the crosshairs: ${ctx.orgName}` : ''}${ctx.country ? `\nCountry: ${ctx.country}` : ''}
LIVE SITUATION: ${ctx.socialStateSummary}

You are REPLYING inside this live comment thread. React to the SPECIFIC exchange — bait a responder, widen a disagreement between commenters, or twist an official's words. Do NOT restate a generic broadcast.

THREAD (most recent last):
${threadContext}

WRITE ONE SHORT reply (1-2 sentences) that executes your tactic against THIS thread.

HARD RULES (a training tool — stay within them):
- Be RECOGNIZABLY divisive bait a sharp responder should flag — cunning, not invisible.
- DO NOT name, quote, praise, or reference any real terrorist organization, real extremist movement, real ideology, religious scripture, or real political figure.
- DO NOT include slogans, theology, recruitment language, calls to join anything, instructions, addresses, targets, or any operational/violent how-to.
- Ride existing grievances and emotions; imply rather than declare; keep plausible deniability.
- No explicit calls to violence. Provocation works through insinuation, blame, and outrage.
- Write in the language/register an ordinary user in ${ctx.country || 'the country'} would use.

Return ONLY valid JSON:
{ "content": "the reply text", "content_flags": { "is_harmful_narrative": true, "is_inflammatory": false, "is_misinformation": false, "is_organized_pressure": false, "incites_violence": false } }
Set the flags honestly. "incites_violence" must remain false.`;
}
