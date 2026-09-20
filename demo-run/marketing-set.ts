/**
 * Set dressing for the marketing capture.
 *
 * Deliberately separate from stage.ts. That file dresses the trailer and is
 * written in a Singaporean register on a real named organisation, which is
 * exactly what cannot appear on a public marketing page. This one is the same
 * story on an invented organisation, in a register that could be anywhere.
 *
 * Nothing here is imported by the trailer pipeline, so the two can diverge
 * without either breaking the other. Only the row-writing helpers are shared,
 * and those are generic.
 */

import { admin } from './lib.js';
import { rampEngagement, seedComments } from './stage.js';
import type {
  Platform,
  StagedArticle,
  StagedComment,
  StagedEmail,
  StagedPost,
} from './stage.js';

export { rampEngagement, seedComments };

/** The organisation under pressure. Invented; see clone-scenario.ts. */
export const ORG = {
  name: 'Meridian Community Trust',
  short: 'MCT',
  handle: '@meridiantrust',
  caseRef: 'MCT-IR-2026-014',
  programme: 'Community Uplift Initiative',
  domain: 'meridiantrust.example.org',
} as const;

/**
 * The cast that appears on camera.
 *
 * Three players and a trainer, rather than the trailer's 25: every screen the
 * marketing page needs is one of these three, and each extra browser context is
 * a context that can fail mid-capture.
 */
export interface CaptureRole {
  /** Index into the demo account pool, so prepare.ts's cached logins are reused. */
  index: number;
  name: string;
  team: string;
  title: string;
}

export const CAST: CaptureRole[] = [
  { index: 1, name: 'Claire Bennett', team: 'Communications', title: 'Head of Communications' },
  { index: 6, name: 'Adam Reyes', team: 'Legal', title: 'Corporate Counsel' },
  { index: 4, name: 'Nadia Okafor', team: 'Communications', title: 'Media Relations Manager' },
];

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/**
 * Keys match the storyboard on the marketing page, so a beat on the page and the
 * post it was cut from are findable from each other.
 *
 * No media_urls anywhere: the staged photographs are only reachable over the
 * capture server's /staged mount, and a marketing asset that depends on a local
 * mount being up is an asset that silently ships a broken image box.
 */
export const POSTS: StagedPost[] = [
  // --- an ordinary afternoon ------------------------------------------------
  {
    key: 'calm-supper',
    platform: 'facebook',
    handle: '@westside_together',
    displayName: 'Westside Together',
    authorType: 'npc_public',
    content:
      'Two hundred and forty neighbours at the community supper last night. Thank you to everyone who cooked, served and stayed back to clear up. Same time next week.',
    sentiment: 'positive',
    virality: 22,
    likes: 486,
    reposts: 61,
    replies: 44,
    views: 9_800,
    ageSec: 7200,
  },
  {
    key: 'calm-tuition',
    platform: 'facebook',
    handle: '@lena_ortiz',
    displayName: 'Lena Ortiz',
    authorType: 'npc_public',
    content:
      'My eldest got her exam results today. Two years of the free tuition programme and she did it. To the volunteers who gave up their Saturdays — thank you, genuinely.',
    sentiment: 'positive',
    virality: 19,
    likes: 731,
    reposts: 54,
    replies: 88,
    views: 12_600,
    ageSec: 4200,
  },
  {
    key: 'calm-centre',
    platform: 'facebook',
    handle: '@westsidecentre',
    displayName: 'Westside Community Centre',
    authorType: 'official_account',
    content:
      'Reminder: the family assistance counter is open Tuesday and Thursday, 9am–5pm. Walk-ins welcome, no appointment needed. Bring photo ID and a recent payslip if you have one.',
    sentiment: 'neutral',
    virality: 14,
    likes: 158,
    reposts: 92,
    replies: 11,
    views: 6_100,
    ageSec: 3000,
  },

  // --- it breaks -----------------------------------------------------------
  {
    key: 'media-share',
    platform: 'facebook',
    handle: '@thecivicrecord',
    displayName: 'The Civic Record',
    authorType: 'npc_media',
    content: `${ORG.short} confirms financial mismanagement in one community programme following an internal review. The trust says beneficiary services are continuing. Community groups are calling for the review scope to be published.`,
    sentiment: 'neutral',
    virality: 88,
    likes: 1180,
    reposts: 1640,
    replies: 372,
    views: 210_000,
    ageSec: 280,
  },
  {
    key: 'accusation',
    platform: 'facebook',
    handle: '@accountnow',
    displayName: 'Accountability Now',
    authorType: 'npc_influencer',
    content: `So ${ORG.short} had "mismanagement" in one initiative but still found the budget for a donor gala? Community money, community answers. Name the programme. Publish the numbers.`,
    sentiment: 'inflammatory',
    flags: { is_harmful_narrative: true },
    virality: 96,
    likes: 2140,
    reposts: 1870,
    replies: 431,
    views: 184_000,
    requiresResponse: true,
    ageSec: 300,
  },

  // --- the question the whole page has to earn ------------------------------
  {
    key: 'question',
    platform: 'facebook',
    handle: '@deborah_cole',
    displayName: 'Deborah Cole',
    authorType: 'npc_public',
    content: `If one of the ${ORG.short} programmes really did lose track of the money, what happens to the children still waiting on their school grant?\n\nSchool starts next month. I have been waiting three weeks. Please just answer me.`,
    sentiment: 'negative',
    virality: 74,
    likes: 1890,
    reposts: 940,
    replies: 356,
    views: 96_000,
    requiresResponse: true,
    ageSec: 260,
  },

  // --- the lie outruns the truth -------------------------------------------
  // Seeded adjacent with descending virality so one scroll passes all three and
  // the reader feels the volume rather than being told about it.
  {
    key: 'lie-frozen',
    platform: 'facebook',
    handle: '@insidertip',
    displayName: 'Insider Tip',
    authorType: 'npc_influencer',
    content: `CONFIRMED from inside: ALL ${ORG.short} assistance has been frozen. Grants, tuition, everything. Families have already been told to stop coming. Share this before they delete it.`,
    sentiment: 'inflammatory',
    flags: { is_misinformation: true, is_harmful_narrative: true },
    virality: 94,
    likes: 3310,
    reposts: 2940,
    replies: 612,
    views: 297_000,
    requiresResponse: true,
    ageSec: 220,
  },
  {
    key: 'lie-million',
    platform: 'facebook',
    handle: '@frontline_wire',
    displayName: 'Frontline Wire',
    authorType: 'npc_media',
    content: `Sources put the shortfall at over $1 MILLION across ${ORG.short} programmes. Related-party vendors. The same names on multiple contracts. Where is the board?`,
    sentiment: 'inflammatory',
    flags: { is_misinformation: true },
    virality: 92,
    likes: 2780,
    reposts: 2510,
    replies: 508,
    views: 251_000,
    requiresResponse: true,
    ageSec: 190,
  },
  {
    key: 'lie-luxury',
    platform: 'facebook',
    handle: '@clips_that_land',
    displayName: 'Clips That Land',
    authorType: 'npc_influencer',
    content:
      'Screenshot going around: VIP hotel dinners charged to the programme account while families queue for rent help. So much for putting the community first.',
    sentiment: 'inflammatory',
    flags: { is_misinformation: true, is_harmful_narrative: true },
    virality: 90,
    likes: 4120,
    reposts: 3380,
    replies: 887,
    views: 312_000,
    requiresResponse: true,
    ageSec: 160,
  },

  // --- the pressure closes in ----------------------------------------------
  {
    key: 'rival',
    platform: 'facebook',
    handle: '@northgatefdn',
    displayName: 'Northgate Foundation',
    authorType: 'official_account',
    content:
      'Donors and families deserve clarity, not "we are looking into it". Transparency means naming the programme, disclosing the sums, and publishing the audit. Our reporting has always been open.',
    sentiment: 'negative',
    flags: { is_harmful_narrative: true },
    virality: 86,
    likes: 1620,
    reposts: 780,
    replies: 214,
    views: 143_000,
    ageSec: 130,
  },
  {
    key: 'crowd',
    platform: 'facebook',
    handle: '@localvoices',
    displayName: 'Local Voices',
    authorType: 'npc_influencer',
    content:
      'Happening now outside the centre. People turning up to ask about their applications and nobody is coming out to talk to them. This is what silence does.',
    sentiment: 'negative',
    flags: { is_organized_pressure: true },
    virality: 89,
    likes: 2460,
    reposts: 1910,
    replies: 543,
    views: 178_000,
    requiresResponse: true,
    ageSec: 100,
  },

  // --- the turn ------------------------------------------------------------
  {
    key: 'reassured',
    platform: 'facebook',
    handle: '@localresident',
    displayName: 'Marcus Bell',
    authorType: 'npc_public',
    content:
      'Credit where it is due — they named the programme, gave a case reference, and confirmed the school grant visits are still going ahead. That is what we were asking for. Keep it coming.',
    sentiment: 'supportive',
    virality: 68,
    likes: 1240,
    reposts: 520,
    replies: 96,
    views: 71_000,
    ageSec: 20,
  },
];

export const postByKey = (key: string): StagedPost => {
  const found = POSTS.find((p) => p.key === key);
  if (!found) throw new Error(`No marketing post with key "${key}"`);
  return found;
};

/** Parents echoing the question, so it reads as a community and not one person. */
export const QUESTION_ECHOES: StagedComment[] = [
  {
    key: 'echo-1',
    handle: '@lena_ortiz',
    displayName: 'Lena Ortiz',
    authorType: 'npc_public',
    content:
      'Same here. I applied last month and still have not heard anything. My son starts Year 9.',
    sentiment: 'negative',
    likes: 412,
    ageSec: 210,
  },
  {
    key: 'echo-2',
    handle: '@dan_reyes_local',
    displayName: 'Dan Whitcombe',
    authorType: 'npc_public',
    content: 'Just tell us yes or no. We can plan around either. It is the not knowing that hurts.',
    sentiment: 'negative',
    likes: 688,
    ageSec: 170,
  },
  {
    key: 'echo-3',
    handle: '@k_mensah',
    displayName: 'Kwame Mensah',
    authorType: 'npc_public',
    content: 'I called the office three times this week. Nobody picks up.',
    sentiment: 'negative',
    likes: 233,
    ageSec: 140,
  },
];

/** Dropped on the premature holding statement, seconds after it publishes. */
export const CALLOUTS: StagedComment[] = [
  {
    key: 'callout-1',
    handle: '@accountnow',
    displayName: 'Accountability Now',
    authorType: 'npc_influencer',
    content: 'This is not an answer. Which programme? How much? You had all day.',
    sentiment: 'inflammatory',
    likes: 306,
    ageSec: 0,
  },
  {
    key: 'callout-2',
    handle: '@deborah_cole',
    displayName: 'Deborah Cole',
    authorType: 'npc_public',
    content: 'I read it three times. I still do not know whether my son gets his grant.',
    sentiment: 'negative',
    likes: 174,
    ageSec: 0,
  },
  {
    key: 'callout-3',
    handle: '@k_mensah',
    displayName: 'Kwame Mensah',
    authorType: 'npc_public',
    content: 'Zero numbers. Zero names. Zero dates. Try again.',
    sentiment: 'inflammatory',
    likes: 421,
    ageSec: 0,
  },
];

/** The reply once the team answers her by name. The last beat on the page. */
export const RESOLUTION: StagedComment[] = [
  {
    key: 'thanks',
    handle: '@deborah_cole',
    displayName: 'Deborah Cole',
    authorType: 'npc_public',
    content: 'Thank you for answering. That is all we were asking for.',
    sentiment: 'supportive',
    likes: 921,
    ageSec: 0,
  },
];

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export const NEWS: StagedArticle[] = [
  {
    key: 'news-breaking',
    outlet: 'The Civic Record',
    headline: `${ORG.short} confirms financial mismanagement in community programme`,
    subheadline:
      'Trust says the issue is limited to one initiative; community groups call for a full audit',
    body: `${ORG.name} has confirmed that an internal review identified financial management issues in one of its community programmes. In a statement, ${ORG.short} said the matter had been formally disclosed and interim controls put in place.\n\nCommunity leaders have called for the scope of the review to be published. Several donors contacted by this newsroom said they were seeking assurances before renewing pledges.\n\n${ORG.short} said beneficiary services, including student grants and tuition support, are continuing on their normal schedule.`,
    category: 'breaking',
    factual: true,
    ageSec: 300,
  },
  {
    key: 'news-pressure',
    outlet: 'The Independent Ledger',
    headline: `“Where did the money go?” Families demand answers from ${ORG.short}`,
    subheadline: 'Claims of frozen assistance spread online as the organisation stays silent',
    body: `Families who rely on ${ORG.short} assistance say they have been left in the dark as unverified claims circulate on social media, including assertions that all support has been frozen.\n\n“School starts next month. I have been waiting three weeks,” said one parent who asked to be identified only by her first name.\n\n${ORG.short} had not responded to requests for comment at the time of publication.`,
    category: 'analysis',
    factual: false,
    ageSec: 180,
  },
  {
    key: 'news-turn',
    outlet: 'The Civic Record',
    headline: `${ORG.short} publishes case reference and review scope after online backlash`,
    subheadline: 'Organisation names the programme and rejects claims of missing millions',
    body: `${ORG.short} has published the case reference and scope of an independent review into one of its community initiatives, and rejected claims circulating online that more than one million dollars is unaccounted for.\n\nThe organisation confirmed that no account freeze notice has been received and that grant disbursements continue as scheduled.`,
    category: 'breaking',
    factual: true,
    ageSec: 30,
  },
];

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export const EMAILS: StagedEmail[] = [
  {
    key: 'email-press',
    fromName: 'Dana Whitfield, The Civic Record',
    fromAddress: 'dana.whitfield@civicrecord.example.org',
    subject: `URGENT: Request for comment — ${ORG.short} programme mismanagement (deadline 6pm)`,
    body: `Hello,\n\nWe are running a piece this evening on the financial management issues identified in a ${ORG.short}-led initiative.\n\nWe would like ${ORG.short}'s response to three specific points:\n\n1. Which programme is affected, and over what period?\n2. Is there any truth to claims that beneficiary assistance has been frozen?\n3. Has any figure been established for the amount involved?\n\nOur deadline is 6pm today. We will note if ${ORG.short} declines to comment.\n\nRegards,\nDana Whitfield\nThe Civic Record`,
    priority: 'urgent',
    ageSec: 240,
  },
  {
    key: 'email-funder',
    fromName: 'Halden Trust — Grants',
    fromAddress: 'grants@haldentrust.example.org',
    subject: 'Tranche 2 disbursement placed on hold pending clarification',
    body: `Dear ${ORG.short},\n\nFollowing reports circulating today, Halden Trust is placing the Tranche 2 disbursement for the ${ORG.programme} on temporary hold.\n\nTo release the tranche we require written confirmation of the scope of the internal review, whether restricted funds are affected, and the governance steps taken.\n\nWe would appreciate a response within 24 hours.\n\nRegards,\nGrants Team`,
    priority: 'high',
    ageSec: 150,
  },
  {
    // Nobody improvises a crisis statement. Somebody senior sends the approved
    // line and the team works from it, which is what makes the Act V override a
    // decision rather than an accident.
    key: 'email-directive',
    fromName: 'Claire Bennett — Head of Communications',
    fromAddress: `claire.bennett@${ORG.domain}`,
    subject: `APPROVED LINES — ${ORG.programme} (use verbatim, do not improvise)`,
    body: `Team,\n\nLegal has cleared the following. Use these words. Do not add to them, and do not answer anything outside this list — route it to me.\n\nAPPROVED:\n1. The review concerns one programme: the ${ORG.programme}. Case reference ${ORG.caseRef}.\n2. No assistance has been frozen. Grant and tuition disbursements are running on schedule.\n3. Claims of a $1m shortfall are false. We have requested corrections.\n\nDO NOT SAY:\n– Any figure for the amount involved. None has been established.\n– Anything about individual staff or vendors.\n– "No comment", or "in due course".\n\nEvery public reply must include the case reference. If a family asks about their own application, give them the reference and tell them the counter is open until 5pm.\n\nClaire`,
    priority: 'urgent',
    ageSec: 60,
  },
];

// ---------------------------------------------------------------------------
// Writing the rows
//
// Direct inserts, because every screen in the capture is loaded after its
// dressing is in place. Content that has to ARRIVE on an already-open page has
// to go through an inject instead; the capture does that separately for the one
// beat that needs it.
// ---------------------------------------------------------------------------

/**
 * @param platform Overrides each post's own platform.
 *
 * The two feed apps filter on it: the short-post app renders only x_twitter rows
 * and Fakebook only facebook ones. The capture needs the same crisis on both
 * surfaces — the report sheet is shot on Fakebook, the feed on the short-post app
 * — so it stages the set twice rather than picking one and leaving the other
 * empty. A claim spreading across both platforms is also what actually happens.
 */
export async function dressFeed(
  sessionId: string,
  keys: string[] = POSTS.map((p) => p.key),
  log: (m: string) => void = console.log,
  platform?: Platform,
): Promise<Map<string, string>> {
  const wanted = keys.map(postByKey);
  const now = Date.now();

  const rows = wanted.map((p) => ({
    session_id: sessionId,
    platform: platform ?? p.platform,
    author_handle: p.handle,
    author_display_name: p.displayName,
    author_type: p.authorType,
    content: p.content,
    sentiment: p.sentiment,
    content_flags: p.flags ?? {},
    virality_score: p.virality ?? 80,
    like_count: p.likes ?? 0,
    repost_count: p.reposts ?? 0,
    reply_count: p.replies ?? 0,
    view_count: p.views ?? 0,
    requires_response: p.requiresResponse ?? false,
    response_deadline_minutes: p.requiresResponse ? 10 : null,
    media_urls: [],
    hashtags: [],
    created_at: new Date(now - (p.ageSec ?? 60) * 1000).toISOString(),
  }));

  const { data, error } = await admin
    .from('social_posts')
    .insert(rows)
    .select('id, author_handle, content');
  if (error) throw new Error(`Feed dressing failed: ${error.message}`);

  const ids = new Map<string, string>();
  for (const p of wanted) {
    // Handle alone is not unique across the set; match on a content prefix too.
    const row = (data ?? []).find(
      (r) => r.author_handle === p.handle && String(r.content).startsWith(p.content.slice(0, 40)),
    );
    if (row) ids.set(p.key, row.id as string);
  }

  log(`Feed dressed: ${ids.size}/${wanted.length} posts on ${platform ?? 'their own platform'}`);
  return ids;
}

/**
 * Deletes every post in the session except the ones passed in.
 *
 * The server starts three content generators unconditionally — AI injects, chat
 * surveillance and the statement watchdog — and none of them respect
 * ENABLE_AUTO_INJECTS. Left alone they post over the staged set within a couple
 * of minutes, in a voice inherited from the original scenario, which is how a
 * regional name ends up back on a marketing page. Rather than reach into server
 * startup for a capture, prune immediately before each shot.
 *
 * Keyed on ids, not handles. Handles do not discriminate: the scenario clone's
 * scrub renamed its own NPCs onto the same invented handles this file uses, so a
 * handle allowlist kept generated posts and put one at the top of the feed.
 */
export async function pruneFeed(
  sessionId: string,
  keepIds: Iterable<string>,
  log: (m: string) => void = console.log,
): Promise<number> {
  const keep = new Set(keepIds);

  const { data, error } = await admin
    .from('social_posts')
    .select('id')
    .eq('session_id', sessionId);
  if (error) throw new Error(`Prune read failed: ${error.message}`);

  const doomed = (data ?? []).map((r) => r.id as string).filter((id) => !keep.has(id));

  // Small chunks: a single delete with a couple of hundred ids in an IN clause hit
  // Postgres's statement timeout once the generators had built up a backlog.
  for (let i = 0; i < doomed.length; i += 50) {
    const { error: delErr } = await admin
      .from('social_posts')
      .delete()
      .in('id', doomed.slice(i, i + 50));
    if (delErr) throw new Error(`Prune delete failed: ${delErr.message}`);
  }

  if (doomed.length > 0) log(`    pruned ${doomed.length} unstaged posts`);
  return doomed.length;
}

export async function dressNews(
  sessionId: string,
  keys: string[] = NEWS.map((n) => n.key),
  log: (m: string) => void = console.log,
): Promise<void> {
  const now = Date.now();
  const rows = NEWS.filter((n) => keys.includes(n.key)).map((n) => ({
    session_id: sessionId,
    outlet_name: n.outlet,
    headline: n.headline,
    subheadline: n.subheadline,
    body: n.body,
    category: n.category,
    is_factual: n.factual,
    published_at: new Date(now - (n.ageSec ?? 120) * 1000).toISOString(),
  }));
  const { error } = await admin.from('sim_news_articles').insert(rows);
  if (error) throw new Error(`News dressing failed: ${error.message}`);
  log(`News dressed: ${rows.length} articles`);
}

export async function dressInbox(
  sessionId: string,
  keys: string[] = EMAILS.map((e) => e.key),
  log: (m: string) => void = console.log,
): Promise<void> {
  const now = Date.now();
  const rows = EMAILS.filter((e) => keys.includes(e.key)).map((e) => ({
    session_id: sessionId,
    direction: 'inbound' as const,
    from_address: e.fromAddress,
    from_name: e.fromName,
    to_addresses: [`comms@${ORG.domain}`],
    subject: e.subject,
    body_text: e.body,
    body_html: `<p>${e.body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`,
    priority: e.priority,
    is_read: false,
    created_at: new Date(now - (e.ageSec ?? 120) * 1000).toISOString(),
  }));
  const { error } = await admin.from('sim_emails').insert(rows);
  if (error) throw new Error(`Inbox dressing failed: ${error.message}`);
  log(`Inbox dressed: ${rows.length} emails`);
}

/** Messages already in the crisis-cell channel when the window is opened. */
export const CHAT: { from: string; text: string }[] = [
  {
    from: 'Claire Bennett',
    text: 'We are forty minutes into silence. Something has to go out.',
  },
  {
    from: 'Adam Reyes',
    text: 'Not until I have the case reference. We cannot confirm a figure we do not have.',
  },
  {
    from: 'Claire Bennett',
    text: 'Then a holding line. Just put something out now.',
  },
  {
    from: 'Adam Reyes',
    text: 'A holding line that says nothing will be read as a dodge.',
  },
];
