/**
 * Set dressing.
 *
 * The first trailer failed because the actions were not significant: the team
 * was flagging *a* post rather than *the* post, so the audience had no idea what
 * was at stake in any given shot. Fix that by putting the exact content on
 * screen before the camera rolls.
 *
 * Two things make this controllable:
 *   1. Run the shoot with the inject scheduler OFF, so the feed contains only
 *      what is seeded here and nothing drifts between takes.
 *   2. Seed with high virality and a recent timestamp so the post lands at the
 *      top of the feed ranking, which sorts NPC posts by virality.
 *
 * Everything is staged on Fakebook. One platform means one visual language for
 * the whole trailer, and Fakebook is the surface that carries photos, threaded
 * comments and reactions — the three things that make a feed read as a real
 * place with real people in it rather than as sample data.
 *
 * Handles and voices are taken from the scenario's own 99 NPC personas, so the
 * dressing is the scenario's material, not invented.
 */

import { admin } from './lib.js';
import { APP_BASE } from './config.js';

export type Platform = 'x_twitter' | 'facebook';

/**
 * Photos live under demo-run/assets and are mounted by demo-run/serve.ts at
 * /staged. They are deliberately not copied into frontend/dist: nothing
 * fictional should ever end up inside a shipped product build.
 */
const photo = (name: string): string => `${APP_BASE}/staged/${name}`;

export const PHOTOS = {
  /** Bursary distribution day: queue tickets, application counter, families. */
  communityHall: photo('staged-community-hall.jpg'),
  /** The "evidence" that is not evidence. Grainy, covert, proves nothing. */
  hotelDinner: photo('staged-hotel-dinner.jpg'),
  /** Newsroom-style establishing shot for the outlet's own share. */
  newsBuilding: photo('staged-news-building.jpg'),
  /** People gathering outside with phones up. Escalation made physical. */
  crowdOutside: photo('staged-crowd-outside.jpg'),
  /** Void-deck iftar. Ordinary community life, before any of this. */
  calmIftar: photo('staged-calm-iftar.jpg'),
} as const;

export interface StagedPost {
  /** Storyboard reference, e.g. 'accusation'. */
  key: string;
  platform: Platform;
  handle: string;
  displayName: string;
  authorType: 'npc_public' | 'npc_media' | 'npc_politician' | 'npc_influencer' | 'official_account';
  content: string;
  sentiment: 'negative' | 'inflammatory' | 'hateful' | 'neutral' | 'supportive' | 'positive';
  flags?: Record<string, boolean>;
  /** Higher floats to the top of the feed ranking. */
  virality?: number;
  likes?: number;
  reposts?: number;
  replies?: number;
  views?: number;
  requiresResponse?: boolean;
  /** Seconds to backdate, so a staged thread reads in a sensible order. */
  ageSec?: number;
  mediaUrls?: string[];
}

/**
 * The dressing, in storyboard order. Copy is written in the register the
 * scenario's own personas use — Singlish and Malay code-switching included,
 * because that is what makes it read as real rather than as sample data.
 */
export const STAGED: StagedPost[] = [
  // --- The ordinary feed, before any of it ---------------------------------
  //
  // The film opens on a normal afternoon, and the crisis only lands because the
  // audience felt what it displaced. These four are inserted directly rather
  // than published as injects: the page loads after them, so they are simply
  // there on first paint, which is exactly what "nothing is wrong" looks like.
  //
  // Low virality keeps them below the crisis content once that starts arriving,
  // so the feed visibly reorders itself around the emergency.

  {
    key: 'calm-iftar',
    platform: 'facebook',
    handle: '@kampungspirit',
    displayName: 'Kampung Spirit SG',
    authorType: 'npc_public',
    content:
      'Alhamdulillah, 240 neighbours at the void deck iftar last night. Thank you to everyone who cooked, served and stayed back to clear up. Same time next week, insyaAllah 🤍',
    sentiment: 'positive',
    virality: 22,
    likes: 486,
    reposts: 61,
    replies: 44,
    views: 9_800,
    ageSec: 7200,
    mediaUrls: [PHOTOS.calmIftar],
  },
  {
    key: 'calm-anniversary',
    platform: 'facebook',
    handle: '@hafizosman_sg',
    displayName: 'Hafiz Osman',
    authorType: 'npc_public',
    content:
      '8 months at AMP today. Still the only job I have had where people say thank you and actually mean it. Grateful 🙏',
    sentiment: 'positive',
    virality: 16,
    likes: 212,
    reposts: 8,
    replies: 37,
    views: 3_400,
    ageSec: 5400,
  },
  {
    key: 'calm-tuition',
    platform: 'facebook',
    handle: '@ibu_dua_anak',
    displayName: 'Rohana Bte Salleh',
    authorType: 'npc_public',
    content:
      'My eldest got her O-level results today. Two years of the free tuition programme and she did it. To the volunteers who gave up their Saturdays — terima kasih banyak banyak.',
    sentiment: 'positive',
    virality: 19,
    likes: 731,
    reposts: 54,
    replies: 88,
    views: 12_600,
    ageSec: 4200,
  },
  {
    key: 'calm-mosque',
    platform: 'facebook',
    handle: '@masjidalnur',
    displayName: 'Masjid Al-Nur',
    authorType: 'official_account',
    content:
      'Reminder: the community assistance counter is open Tuesday and Thursday, 9am–5pm. Walk-ins welcome, no appointment needed. Bring your IC and latest payslip if you have one.',
    sentiment: 'neutral',
    virality: 14,
    likes: 158,
    reposts: 92,
    replies: 11,
    views: 6_100,
    ageSec: 3000,
  },

  // --- ACT I: the break -----------------------------------------------------

  {
    key: 'accusation',
    platform: 'facebook',
    handle: '@auditAMPnow',
    displayName: 'Accountability Watch SG',
    authorType: 'npc_influencer',
    content:
      'So AMP got "mismanagement" in one initiative but still got time to mingle with the elites? Community money, community answers. Name the programme. Publish the numbers. #Amanah #AMP',
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
  {
    key: 'media-share',
    platform: 'facebook',
    handle: '@CNALocalUpdates',
    displayName: 'CNA Local Updates',
    authorType: 'npc_media',
    content:
      'AMP confirms financial mismanagement in one community programme following an internal review. The self-help group says beneficiary services are continuing. Community leaders are calling for the review scope to be published.',
    sentiment: 'neutral',
    virality: 88,
    likes: 1180,
    reposts: 1640,
    replies: 372,
    views: 210_000,
    ageSec: 280,
    mediaUrls: [PHOTOS.newsBuilding],
  },

  // --- ACT II: the question that the whole trailer has to earn --------------
  //
  // This is the spine. It goes up early, stays unanswered through the middle,
  // and the payoff of the film is the team finally answering it by name.

  {
    key: 'question',
    platform: 'facebook',
    handle: '@makcik_marah',
    displayName: 'Puan Siti Rahimah',
    authorType: 'npc_public',
    content:
      'Kalau betul ada program AMP yang salah urus duit, habis macam mana dengan anak-anak kami yang tunggu bantuan sekolah?\n\nBulan depan sekolah buka. Saya sudah tunggu tiga minggu. Tolong jawab.',
    sentiment: 'negative',
    virality: 74,
    likes: 1890,
    reposts: 940,
    replies: 356,
    views: 96_000,
    requiresResponse: true,
    ageSec: 260,
    mediaUrls: [PHOTOS.communityHall],
  },

  // --- ACT III: the lie outruns the truth ----------------------------------
  //
  // Three false claims seeded adjacent in the feed so a single scroll passes
  // all three, and the audience feels the volume rather than being told about
  // it. Virality descends in seeded order to keep them in that order.

  {
    key: 'lie-frozen',
    platform: 'facebook',
    handle: '@whistle_sg',
    displayName: 'SG Whistle',
    authorType: 'npc_influencer',
    content:
      'CONFIRMED from inside: ALL AMP assistance has been frozen. Bursaries, tuition, everything. Families already got told to stop coming. Share this before they delete it.',
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
    content:
      'Sources put the shortfall at over $1 MILLION across AMP programmes. Related-party vendors. Same names on multiple contracts. Where is the board?',
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
      'Screenshot going around: VIP hotel dinners charged to the programme account while families queue for rental help. If this is amanah then what is not.',
    sentiment: 'inflammatory',
    flags: { is_misinformation: true, is_harmful_narrative: true },
    virality: 90,
    likes: 4120,
    reposts: 3380,
    replies: 887,
    views: 312_000,
    requiresResponse: true,
    ageSec: 160,
    mediaUrls: [PHOTOS.hotelDinner],
  },

  // --- the pressure closes in ----------------------------------------------

  {
    key: 'rival',
    platform: 'facebook',
    handle: '@YayasanMENDAKI',
    displayName: 'Yayasan MENDAKI',
    authorType: 'official_account',
    content:
      'Donors and families deserve clarity, not "we are looking into it". Transparency means naming the programme, disclosing the sums, and publishing the audit. Our reporting is open and always has been.',
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
    handle: '@sgvoices_now',
    displayName: 'SG Voices Now',
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
    mediaUrls: [PHOTOS.crowdOutside],
  },

  // --- ACT VI: the payoff voice, seeded so the resolution is visible --------

  {
    key: 'reassured',
    platform: 'facebook',
    handle: '@anaksetempat',
    displayName: 'Farhan | anak setempat',
    authorType: 'npc_public',
    content:
      'Credit where due — they named the programme, gave a case reference, and confirmed the school bursary visits are still on. That is what we were asking for. Keep it coming.',
    sentiment: 'supportive',
    virality: 68,
    likes: 1240,
    reposts: 520,
    replies: 96,
    views: 71_000,
    ageSec: 20,
  },
];

export const stagedByKey = (key: string): StagedPost => {
  const found = STAGED.find((s) => s.key === key);
  if (!found) throw new Error(`No staged post with key "${key}"`);
  return found;
};

// ---------------------------------------------------------------------------
// Comments
//
// Comments are social_posts rows with reply_to_post_id set. Two uses:
//
//   1. Pre-seeded under staged posts, so a thread has weight the moment it is
//      opened rather than showing a lone post with "356 comments" and nothing
//      under it.
//   2. Dropped live, seconds after a player posts, to stage the call-out. That
//      beat cannot be pre-seeded because the parent post does not exist until
//      the agent types it on camera.
// ---------------------------------------------------------------------------

export interface StagedComment {
  key: string;
  handle: string;
  displayName: string;
  authorType: StagedPost['authorType'];
  content: string;
  sentiment: StagedPost['sentiment'];
  likes?: number;
  ageSec?: number;
}

/** Parents echoing the question, so it reads as a community and not one woman. */
export const QUESTION_ECHOES: StagedComment[] = [
  {
    key: 'echo-1',
    handle: '@ibu_dua_anak',
    displayName: 'Rohana Bte Salleh',
    authorType: 'npc_public',
    content: 'Sama. Saya apply bulan lepas, sampai sekarang tak dengar apa-apa. Anak saya Sec 3.',
    sentiment: 'negative',
    likes: 412,
    ageSec: 210,
  },
  {
    key: 'echo-2',
    handle: '@abg_zul',
    displayName: 'Zulkarnain',
    authorType: 'npc_public',
    content: 'Just tell us yes or no lah. We can plan. It is the not knowing that kills.',
    sentiment: 'negative',
    likes: 688,
    ageSec: 170,
  },
];

/** Dropped on the player's premature holding statement, ~4s after it posts. */
export const CALLOUTS: StagedComment[] = [
  {
    key: 'callout-1',
    handle: '@auditAMPnow',
    displayName: 'Accountability Watch SG',
    authorType: 'npc_influencer',
    content: 'This is not an answer. Which programme? How much? You had all day.',
    sentiment: 'inflammatory',
    likes: 306,
    ageSec: 0,
  },
  {
    key: 'callout-2',
    handle: '@makcik_marah',
    displayName: 'Puan Siti Rahimah',
    authorType: 'npc_public',
    content: 'Saya baca tiga kali. Masih tak tahu anak saya dapat bantuan atau tidak.',
    sentiment: 'negative',
    likes: 174,
    ageSec: 0,
  },
];

/** Siti's reply once the team answers her by name. The last line of the film. */
export const RESOLUTION: StagedComment[] = [
  {
    key: 'siti-thanks',
    handle: '@makcik_marah',
    displayName: 'Puan Siti Rahimah',
    authorType: 'npc_public',
    content: 'Alhamdulillah. Terima kasih sebab jawab. Itu saja yang kami minta.',
    sentiment: 'supportive',
    likes: 921,
    ageSec: 0,
  },
];

/**
 * Attach comments to a post. Returns the created ids in the order given, so a
 * shot can frame one specific comment rather than "the thread".
 */
export async function seedComments(
  sessionId: string,
  parentPostId: string,
  comments: StagedComment[],
  log: (m: string) => void = console.log,
): Promise<string[]> {
  const now = Date.now();
  const rows = comments.map((c) => ({
    session_id: sessionId,
    platform: 'facebook',
    author_handle: c.handle,
    author_display_name: c.displayName,
    author_type: c.authorType,
    content: c.content,
    sentiment: c.sentiment,
    reply_to_post_id: parentPostId,
    like_count: c.likes ?? 0,
    virality_score: 40,
    hashtags: [],
    created_at: new Date(now - (c.ageSec ?? 0) * 1000).toISOString(),
  }));

  const { data, error } = await admin.from('social_posts').insert(rows).select('id, content');
  if (error) throw new Error(`Comment staging failed: ${error.message}`);

  // Preserve caller order; the insert does not guarantee it.
  const ids = comments.map(
    (c) => (data ?? []).find((r) => String(r.content) === c.content)?.id as string,
  );
  log(`Comments seeded: ${ids.filter(Boolean).length}/${comments.length} on ${parentPostId}`);
  return ids.filter(Boolean);
}

// ---------------------------------------------------------------------------
// News
//
// The News app is a whole visual surface the trailer never used. A masthead and
// a headline reads as "this is real news" far faster than a social post does,
// which makes it the strongest way to open on an incident.
// ---------------------------------------------------------------------------

export interface StagedArticle {
  key: string;
  outlet: string;
  headline: string;
  subheadline: string;
  body: string;
  category: string;
  factual: boolean;
  ageSec?: number;
}

export const NEWS: StagedArticle[] = [
  {
    key: 'news-breaking',
    outlet: 'CNA Local Updates',
    headline: 'AMP confirms financial mismanagement in community programme',
    subheadline:
      'Self-help group says issue is limited to one initiative; community groups call for full audit',
    body: 'The Association for Muslim Professionals has confirmed that an internal review identified financial management issues in one of its community programmes. In a statement, AMP said the matter had been formally disclosed and interim controls put in place.\n\nCommunity leaders have called for the scope of the review to be published. Several donors contacted by this newsroom said they were seeking assurances before renewing pledges.\n\nAMP said beneficiary services, including student bursaries and tuition support, are continuing on their normal schedule.',
    category: 'breaking',
    factual: true,
    ageSec: 300,
  },
  {
    key: 'news-pressure',
    outlet: 'The Independent Ledger',
    headline: '“Where did the money go?” Families demand answers from AMP',
    subheadline: 'Claims of frozen assistance spread online as the organisation stays silent',
    body: 'Families who rely on AMP assistance say they have been left in the dark as unverified claims circulate on social media, including assertions that all support has been frozen.\n\n“Next month school opens. I have waited three weeks,” said one caregiver who asked to be identified only as Puan Siti.\n\nAMP had not responded to requests for comment at the time of publication.',
    category: 'analysis',
    factual: false,
    ageSec: 180,
  },
  {
    key: 'news-turn',
    outlet: 'CNA Local Updates',
    headline: 'AMP publishes case reference and review scope after online backlash',
    subheadline: 'Organisation names the programme, rejects claims of missing millions',
    body: 'AMP has published the case reference and scope of an independent review into one of its community initiatives, and rejected claims circulating online that more than one million dollars is unaccounted for.\n\nThe organisation confirmed no account freeze notice has been received and that bursary disbursements continue as scheduled.',
    category: 'breaking',
    factual: true,
    ageSec: 30,
  },
];

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface StagedEmail {
  key: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  body: string;
  priority: 'normal' | 'high' | 'urgent';
  ageSec?: number;
}

export const EMAILS: StagedEmail[] = [
  {
    key: 'email-press',
    fromName: 'Nadia Rahman, CNA Local Updates',
    fromAddress: 'nadia.rahman@cna.example.sg',
    subject: 'URGENT: Request for comment — AMP programme mismanagement (deadline 6pm)',
    body: 'Hello,\n\nWe are running a piece this evening on the financial management issues identified in an AMP-led initiative.\n\nWe would like AMP\u2019s response to three specific points:\n\n1. Which programme is affected, and over what period?\n2. Is there any truth to claims that beneficiary assistance has been frozen?\n3. Has any figure been established for the amount involved?\n\nOur deadline is 6pm today. We will note if AMP declines to comment.\n\nRegards,\nNadia Rahman\nCNA Local Updates',
    priority: 'urgent',
    ageSec: 240,
  },
  {
    key: 'email-funder',
    fromName: 'StraitBay Foundation — Grants',
    fromAddress: 'grants@straitbay.example.org',
    subject: 'Tranche 2 disbursement placed on hold pending clarification',
    body: 'Dear AMP,\n\nFollowing reports circulating today, StraitBay Foundation is placing the Tranche 2 disbursement for the Community Uplift Initiative on temporary hold.\n\nTo release the tranche we require written confirmation of the scope of the internal review, whether restricted funds are affected, and the governance steps taken.\n\nWe would appreciate a response within 24 hours.\n\nRegards,\nGrants Team',
    priority: 'high',
    ageSec: 150,
  },
  {
    // The piece the trailer was missing: nobody improvises a crisis statement.
    // Somebody senior sends the approved line, and the team works from it.
    key: 'email-directive',
    fromName: 'Nurul Aisyah Rahim — Head of Communications',
    fromAddress: 'nurul.rahim@amp.example.sg',
    subject: 'APPROVED LINES — Community Uplift Initiative (use verbatim, do not improvise)',
    body: 'Team,\n\nLegal has cleared the following. Use these words. Do not add to them, and do not answer anything outside this list — route it to me.\n\nAPPROVED:\n1. The review concerns one programme: the Community Uplift Initiative. Case reference AMP-IR-2026-014.\n2. No assistance has been frozen. Bursary and tuition disbursements are running on schedule.\n3. Claims of a $1m shortfall are false. We have requested corrections.\n\nDO NOT SAY:\n– Any figure for the amount involved. None has been established.\n– Anything about individual staff or vendors.\n– "No comment", or "in due course".\n\nEvery public reply must include the case reference. If a family asks about their own application, give them the reference and tell them the counter is open until 5pm.\n\nNurul',
    priority: 'urgent',
    ageSec: 60,
  },
  {
    key: 'email-mosque',
    fromName: 'Masjid Al-Nur — Community Office',
    fromAddress: 'office@alnur.example.sg',
    subject: 'Referrals this week — should we continue sending families?',
    body: 'Assalamualaikum,\n\nWe have families asking whether AMP assistance is still available. Two have already been told by others not to bother applying.\n\nPlease advise urgently whether we should continue referrals this week. We do not want to send people who will be turned away.\n\nJazakumullahu khairan.',
    priority: 'high',
    ageSec: 90,
  },
];

/**
 * Insert the dressing and return the created post ids by storyboard key, so the
 * shot runner can target an exact post rather than "whatever is on top".
 */
export async function dressSet(
  sessionId: string,
  keys: string[] = STAGED.map((s) => s.key),
  log: (m: string) => void = console.log,
): Promise<Map<string, string>> {
  const wanted = keys.map(stagedByKey);
  const now = Date.now();

  const rows = wanted.map((p) => ({
    session_id: sessionId,
    platform: p.platform,
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
    media_urls: p.mediaUrls ?? [],
    hashtags: [],
    created_at: new Date(now - (p.ageSec ?? 60) * 1000).toISOString(),
  }));

  const { data, error } = await admin
    .from('social_posts')
    .insert(rows)
    .select('id, author_handle, content');
  if (error) throw new Error(`Set dressing failed: ${error.message}`);

  const ids = new Map<string, string>();
  for (const p of wanted) {
    // Match back by handle plus a content prefix: handles repeat across shots.
    const row = (data ?? []).find(
      (r) => r.author_handle === p.handle && String(r.content).startsWith(p.content.slice(0, 40)),
    );
    if (row) ids.set(p.key, row.id as string);
  }

  log(`Set dressed: ${ids.size}/${wanted.length} posts placed`);
  for (const [key, id] of ids) log(`  ${key.padEnd(26)} ${id}`);
  return ids;
}

/** Remove staged posts, so a re-shoot starts from a clean set. */
export async function stripSet(sessionId: string): Promise<void> {
  const handles = [
    ...new Set([
      ...STAGED.map((s) => s.handle),
      ...QUESTION_ECHOES.map((c) => c.handle),
      ...CALLOUTS.map((c) => c.handle),
      ...RESOLUTION.map((c) => c.handle),
    ]),
  ];
  await admin.from('social_posts').delete().eq('session_id', sessionId).in('author_handle', handles);
}

/** Place the news articles. */
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
  if (error) throw new Error(`News staging failed: ${error.message}`);
  log(`News dressed: ${rows.length} articles`);
}

/** Place the inbound emails. */
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
    to_addresses: ['comms@amp.example.sg'],
    subject: e.subject,
    body_text: e.body,
    body_html: `<p>${e.body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`,
    priority: e.priority,
    is_read: false,
    created_at: new Date(now - (e.ageSec ?? 120) * 1000).toISOString(),
  }));
  const { error } = await admin.from('sim_emails').insert(rows);
  if (error) throw new Error(`Inbox staging failed: ${error.message}`);
  log(`Inbox dressed: ${rows.length} emails`);
}

// ---------------------------------------------------------------------------
// Live delivery
//
// The device apps have no polling and no Supabase realtime. They update only
// when the server broadcasts over Socket.IO from inside an API route, so a
// direct insert into social_posts shows nothing on an already-open page — it
// appears on the next reload and never on camera.
//
// The product's own answer to "content arrives during a session" is an inject.
// Publishing one runs routeInjectToApp(), which inserts the post AND emits
// social_post.created, so it prepends into an open feed exactly the way it
// would in a real exercise.
//
// Creation is a direct insert because nothing needs to be live at that point,
// and because the API's createInjectSchema strips delivery_config — which is
// the whole payload we care about. Injects are session-scoped, so they cascade
// away with the session and never touch the scenario template.
// ---------------------------------------------------------------------------

/** Posts that must ARRIVE on camera rather than being there when the page loads. */
export const LIVE_KEYS = [
  'accusation',
  'lie-frozen',
  'lie-million',
  'lie-luxury',
  'rival',
  'crowd',
] as const;

/** Fakebook posts that are already there when the feed first paints. */
export const PRELOAD_KEYS = [
  'calm-iftar',
  'calm-anniversary',
  'calm-tuition',
  'calm-mosque',
  'media-share',
  'question',
] as const;

interface InjectRow {
  id: string;
  title: string;
}

/**
 * Build one session-scoped inject per live post and return their ids by key.
 *
 * Nothing is delivered yet — these sit dormant until the shot runner publishes
 * them on cue, which is what lets a post land at the exact moment the camera is
 * pointed at the feed.
 */
export async function armLiveInjects(
  sessionId: string,
  scenarioId: string,
  keys: readonly string[] = LIVE_KEYS,
  log: (m: string) => void = console.log,
): Promise<Map<string, string>> {
  const rows = keys.map(stagedByKey).map((p) => ({
    scenario_id: scenarioId,
    session_id: sessionId,
    trigger_time_minutes: null,
    type: 'media_report',
    title: `SHOOT ${p.key}`,
    content: p.content,
    affected_roles: [],
    severity: p.flags?.is_misinformation ? 'high' : 'medium',
    requires_response: p.requiresResponse ?? false,
    inject_scope: 'universal',
    generation_source: 'trainer',
    ai_generated: false,
    delivery_config: {
      app: 'social_feed',
      platform: p.platform,
      author_handle: p.handle,
      author_display_name: p.displayName,
      author_type: p.authorType,
      virality_score: p.virality ?? 80,
      content_flags: p.flags ?? {},
      engagement_seed: {
        likes: p.likes ?? 0,
        reposts: p.reposts ?? 0,
        replies: p.replies ?? 0,
      },
      media_urls: p.mediaUrls ?? [],
      // No spawn_replies: LLM-written replies are good, but they are not the
      // lines the storyboard needs, and a shoot cannot afford a surprise.
    },
  }));

  const { data, error } = await admin
    .from('scenario_injects')
    .insert(rows)
    .select('id, title');
  if (error) throw new Error(`Arming live injects failed: ${error.message}`);

  const byKey = new Map<string, string>();
  for (const key of keys) {
    const row = (data as InjectRow[] | null)?.find((r) => r.title === `SHOOT ${key}`);
    if (row) byKey.set(key, row.id);
  }
  log(`Armed ${byKey.size}/${keys.length} live injects`);
  return byKey;
}

/**
 * The newest post an agent just made on camera.
 *
 * The shot runner needs the id of a post that did not exist until the actor
 * typed it, so the call-out comments can be hung off it seconds later.
 */
export async function newestPost(
  sessionId: string,
  authorType: 'player' | 'official_account',
): Promise<string | null> {
  const { data } = await admin
    .from('social_posts')
    .select('id')
    .eq('session_id', sessionId)
    .eq('author_type', authorType)
    .is('reply_to_post_id', null)
    .order('created_at', { ascending: false })
    .limit(1);
  return (data?.[0]?.id as string | undefined) ?? null;
}

/**
 * Hang a photo on a post after the fact.
 *
 * Attaching an image through the composer would route through live image
 * generation, which is slow and returns something different every take. The
 * storyboard needs one specific photograph — the bursary counter answering the
 * hotel table — so it is attached as set dressing like everything else.
 */
export async function attachPhoto(postId: string, url: string): Promise<void> {
  const { error } = await admin.from('social_posts').update({ media_urls: [url] }).eq('id', postId);
  if (error) throw new Error(`Photo attach failed: ${error.message}`);
}

/**
 * Drive a post's engagement counters upward while the camera is rolling.
 *
 * The feed polls rather than streaming counter updates, so a single jump is all
 * you would normally see. Stepping the numbers repeatedly across a longer take
 * gives a series of jumps that reads as a climbing counter once the clip is
 * speed-ramped in the edit — which is the "watch it go viral" shot.
 */
export async function rampEngagement(
  postId: string,
  opts: { steps?: number; everyMs?: number; startViews?: number; growth?: number } = {},
  log: (m: string) => void = console.log,
): Promise<void> {
  const steps = opts.steps ?? 10;
  const everyMs = opts.everyMs ?? 3000;
  let views = opts.startViews ?? 42_000;
  let likes = Math.round(views * 0.012);
  let reposts = Math.round(views * 0.009);
  let replies = Math.round(views * 0.002);
  const growth = opts.growth ?? 1.32;

  for (let i = 0; i < steps; i++) {
    await admin
      .from('social_posts')
      .update({
        view_count: views,
        like_count: likes,
        repost_count: reposts,
        reply_count: replies,
        virality_score: Math.min(99, 70 + i * 3),
      })
      .eq('id', postId);

    views = Math.round(views * growth);
    likes = Math.round(likes * growth);
    reposts = Math.round(reposts * growth);
    replies = Math.round(replies * (growth * 0.9));
    await new Promise((r) => setTimeout(r, everyMs));
  }
  log(`Engagement ramped to ${views.toLocaleString()} views over ${steps} steps`);
}
