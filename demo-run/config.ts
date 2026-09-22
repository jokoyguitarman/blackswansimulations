/**
 * Configuration for the 26-agent "Amanah Under Fire" demo capture.
 *
 * One admin agent creates and runs the session; 25 player agents each get their
 * own browser context, auth session, socket and recorded video file. The same 25
 * identities are reused across both runs so the finished video can honestly say
 * "same team, before and after training".
 */

export const SCENARIO_ID = '6b1ece6a-ab78-4df1-b71f-a67e695e4032';
export const SCENARIO_TITLE =
  'Amanah Under Fire: AMP, Mismanagement Allegations & a Community Trust Spiral';

/** Teams as defined on the scenario. Order matters only for reporting. */
export const TEAMS = [
  'Communications',
  'Legal',
  'Stakeholder Management',
  'Partnerships and Engagement',
  'Fundraising',
] as const;

export type TeamName = (typeof TEAMS)[number];

/** Players per team. 5 x 5 = 25. */
export const PLAYERS_PER_TEAM = 5;

/**
 * `novice` = untrained baseline: slow, vague, off-lane, ignores misinformation.
 * `expert` = post-training: fast holding statement, every false claim countered.
 */
export type RunProfile = 'novice' | 'expert';

/** Which shell the player's screen shows. Mixed, like a real room. */
export type ViewMode = 'phone' | 'desktop';

export interface PlayerSpec {
  /** 1-25, stable across runs; drives the account email. */
  index: number;
  name: string;
  team: TeamName;
  view: ViewMode;
  /** Free-text colour for the LLM brain, e.g. seniority and habits. */
  persona: string;
}

const p = (
  index: number,
  name: string,
  team: TeamName,
  view: ViewMode,
  persona: string,
): PlayerSpec => ({ index, name, team, view, persona });

/**
 * Roster. Names are Singaporean and weighted Malay/Muslim to match AMP's
 * actual staff profile, with the mixed-ethnicity spread a real Singapore
 * organisation would have.
 */
export const ROSTER: PlayerSpec[] = [
  // Communications — owns public voice, statements, platform response
  p(
    1,
    'Nurul Aisyah Rahim',
    'Communications',
    'desktop',
    'Head of Communications. 12 years in public affairs, decisive, writes the holding statement herself.',
  ),
  p(
    2,
    'Daniel Tan Wei Ming',
    'Communications',
    'phone',
    'Social media executive, 2 years in. Fast on platforms, watches trending threads.',
  ),
  p(
    3,
    'Farah Iskandar',
    'Communications',
    'phone',
    'Community content lead. Writes in Malay and English, strong instinct for tone.',
  ),
  p(
    4,
    'Priya Raman',
    'Communications',
    'desktop',
    'Media relations manager. Handles reporters, guards against speculation.',
  ),
  p(
    5,
    'Hafiz Osman',
    'Communications',
    'phone',
    'Junior comms associate, 8 months in. Eager but unsure what he is allowed to say.',
  ),

  // Legal — verification gatekeeper, defamation and regulatory exposure
  p(
    6,
    'Shahrizal Kamaruddin',
    'Legal',
    'desktop',
    'General Counsel. Cautious, insists nothing goes out unverified.',
  ),
  p(
    7,
    'Grace Lim Hui Ling',
    'Legal',
    'desktop',
    'Corporate counsel. Focused on regulatory duties and disclosure obligations.',
  ),
  p(
    8,
    'Imran Yusof',
    'Legal',
    'phone',
    'Legal associate tracking defamation risk in named-individual posts.',
  ),
  p(
    9,
    'Devi Krishnan',
    'Legal',
    'desktop',
    'Compliance officer. Owns the audit trail and case references.',
  ),
  p(10, 'Marcus Chua', 'Legal', 'phone', 'Paralegal. Logs takedown and correction requests.'),

  // Stakeholder Management — board, MPs, regulators, senior leadership
  p(
    11,
    'Zainab Mokhtar',
    'Stakeholder Management',
    'desktop',
    'Director of Stakeholder Relations. Manages board and MP expectations.',
  ),
  p(
    12,
    'Alvin Goh',
    'Stakeholder Management',
    'desktop',
    'Government relations manager. Briefs policymakers, avoids surprises.',
  ),
  p(
    13,
    'Sharifah Nadia',
    'Stakeholder Management',
    'phone',
    'Community leaders liaison. Trusted by mosque committees.',
  ),
  p(
    14,
    'Rajesh Pillai',
    'Stakeholder Management',
    'phone',
    'Board secretariat. Prepares decision items and escalations.',
  ),
  p(
    15,
    'Nadia Halim',
    'Stakeholder Management',
    'phone',
    'Stakeholder analyst, 1 year in. Still learning who to escalate to.',
  ),

  // Partnerships and Engagement — mosques, partner NGOs, service continuity
  p(
    16,
    'Faizal Rahman',
    'Partnerships and Engagement',
    'desktop',
    'Head of Partnerships. Protects mosque and NGO relationships.',
  ),
  p(
    17,
    'Cheryl Ong',
    'Partnerships and Engagement',
    'desktop',
    'Corporate partnerships manager. Handles CSR partners considering a pause.',
  ),
  p(
    18,
    'Amirah Zulkifli',
    'Partnerships and Engagement',
    'phone',
    'Programme engagement lead. Closest to beneficiaries on the ground.',
  ),
  p(
    19,
    'Sanjay Menon',
    'Partnerships and Engagement',
    'phone',
    'Volunteer network coordinator. Fields frontline anxiety.',
  ),
  p(
    20,
    'Khairul Anwar',
    'Partnerships and Engagement',
    'phone',
    'Partnerships associate, 6 months in. Nervous about speaking for AMP.',
  ),

  // Fundraising — donors, funders, restricted funds, donation infrastructure
  p(
    21,
    'Siti Nurhaliza Aziz',
    'Fundraising',
    'desktop',
    'Director of Development. Owns donor confidence and funder assurance.',
  ),
  p(
    22,
    'Jonathan Lee',
    'Fundraising',
    'desktop',
    'Major gifts manager. Handles refund requests and pledge renewals.',
  ),
  p(
    23,
    'Rizwan Mahmood',
    'Fundraising',
    'phone',
    'Donor care lead. Watches the hotline and donation platform health.',
  ),
  p(
    24,
    'Anitha Selvam',
    'Fundraising',
    'phone',
    'Grants manager. Tracks restricted fund conditions and tranche holds.',
  ),
  p(
    25,
    'Norhayati Ismail',
    'Fundraising',
    'phone',
    'Fundraising associate, 1 year in. Unsure which numbers are public.',
  ),
];

/**
 * Roster subset for the hero capture — the shoot that exists purely to get
 * close-ups, not to produce metrics.
 *
 * Deliberately picked rather than "first N": seats 1 and 2 of Communications own
 * the official statements, seat 3 does the public rebuttals, and one seat from
 * each remaining team gives cross-team chat and the flag/report actions. Beat
 * assignment keys off seat-within-team, so these indices land the right roles.
 */
export const HERO_ROSTER_INDICES = [1, 2, 3, 6, 7, 11, 16, 21];

export const ADMIN = {
  email: 'demo-admin@demo.example.com',
  name: 'Demo Trainer (Prophyion)',
};

export const PLAYER_EMAIL_DOMAIN = 'demo.example.com';
export const playerEmail = (index: number): string =>
  `demo-player-${String(index).padStart(2, '0')}@${PLAYER_EMAIL_DOMAIN}`;

/** Shared password for the demo cohort. Override with DEMO_RUN_PASSWORD. */
export const DEMO_PASSWORD = process.env.DEMO_RUN_PASSWORD ?? 'BlackSwanDemo#2026!';

// ---------------------------------------------------------------------------
// Capture settings
// ---------------------------------------------------------------------------

/** Player screens. 1280x800 shows the phone shell centred with room to breathe. */
export const PLAYER_VIEWPORT = { width: 1280, height: 800 };
/** Trainer dashboard wants the extra width for the gauge row. */
export const TRAINER_VIEWPORT = { width: 1920, height: 1080 };

/** How many Chromium processes to spread the 25 player contexts across. */
export const BROWSER_POOL_SIZE = 5;

export const OUTPUT_ROOT = 'demo-run/output';

// ---------------------------------------------------------------------------
// Local environment
// ---------------------------------------------------------------------------

export const API_BASE = process.env.DEMO_RUN_API ?? 'http://localhost:3001';
export const APP_BASE = process.env.DEMO_RUN_APP ?? 'http://localhost:3002';
