/**
 * Side-by-side comparison of two completed runs, straight from the DB.
 *
 *   npx tsx demo-run/compare.ts <noviceSessionId> <expertSessionId>
 */

import { admin } from './lib.js';

const [noviceId, expertId] = process.argv.slice(2);
if (!noviceId || !expertId) throw new Error('Usage: compare.ts <noviceSessionId> <expertSessionId>');

interface Row {
  label: string;
  novice: string | number;
  expert: string | number;
}

async function snapshot(sessionId: string) {
  const { data: sess } = await admin
    .from('sessions')
    .select('current_state, start_time, end_time')
    .eq('id', sessionId)
    .single();
  const st = ((sess?.current_state as Record<string, unknown>)?.social_state ?? {}) as Record<
    string,
    number | boolean | undefined
  >;

  const count = async (build: (q: ReturnType<typeof baseQuery>) => unknown): Promise<number> => {
    const q = baseQuery();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: c } = (await (build(q) as any)) as { count: number | null };
    return c ?? 0;
  };
  const baseQuery = () =>
    admin.from('social_posts').select('*', { count: 'exact', head: true }).eq('session_id', sessionId);

  // Rival pages post as 'official_account' too, so an unfiltered count reports
  // the antagonist's attacks as our own official statements.
  const { data: pages } = await admin
    .from('sim_org_pages')
    .select('page_handle, role')
    .eq('session_id', sessionId)
    .neq('role', 'antagonist');
  const ourHandles = (pages ?? []).map((p) => String(p.page_handle ?? '')).filter(Boolean);

  const [playerPosts, flagged, statements] = await Promise.all([
    count((q) => q.eq('author_type', 'player')),
    count((q) => q.eq('is_flagged_by_player', true)),
    ourHandles.length
      ? count((q) =>
          q
            .eq('author_type', 'official_account')
            .in('author_handle', ourHandles)
            .gt('created_at', sess?.start_time ?? ''),
        )
      : Promise.resolve(0),
  ]);

  const { data: actions } = await admin
    .from('player_actions')
    .select('action_type')
    .eq('session_id', sessionId);
  const tally = new Map<string, number>();
  for (const a of actions ?? []) tally.set(a.action_type, (tally.get(a.action_type) ?? 0) + 1);

  const { data: channels } = await admin
    .from('chat_channels')
    .select('id')
    .eq('session_id', sessionId);
  const { count: chats } = await admin
    .from('chat_messages')
    .select('*', { count: 'exact', head: true })
    .in('channel_id', channels?.map((c) => c.id) ?? ['00000000-0000-0000-0000-000000000000']);

  return { st, playerPosts, flagged, statements, tally, chats: chats ?? 0 };
}

const [n, e] = await Promise.all([snapshot(noviceId), snapshot(expertId)]);

const num = (v: unknown): string => (v === undefined || v === null ? '—' : String(v));

const rows: Row[] = [
  { label: 'Amanah & Public Confidence (trust)', novice: num(n.st.public_trust), expert: num(e.st.public_trust) },
  { label: 'Overall sentiment', novice: num(n.st.sentiment_score), expert: num(e.st.sentiment_score) },
  { label: 'Beneficiary reassurance', novice: num(n.st.community_safety), expert: num(e.st.community_safety) },
  { label: 'Information narrative control', novice: num(n.st.narrative_control), expert: num(e.st.narrative_control) },
  { label: 'Boycott / regulatory escalation risk', novice: num(n.st.escalation_risk), expert: num(e.st.escalation_risk) },
  { label: '— crisis-comms standards —', novice: '', expert: '' },
  { label: 'RDAP score', novice: `${num(n.st.rdap_score)} (${num(n.st.rdap_level)})`, expert: `${num(e.st.rdap_score)} (${num(e.st.rdap_level)})` },
  { label: 'Transparency', novice: num(n.st.transparency_score), expert: num(e.st.transparency_score) },
  { label: 'Consistency', novice: num(n.st.consistency_score), expert: num(e.st.consistency_score) },
  { label: 'Strategic ratio', novice: num(n.st.strategic_ratio), expert: num(e.st.strategic_ratio) },
  { label: '— what the team did —', novice: '', expert: '' },
  { label: 'Official statements published', novice: n.statements, expert: e.statements },
  { label: 'Player posts', novice: n.playerPosts, expert: e.playerPosts },
  { label: 'Posts flagged as misinformation', novice: n.flagged, expert: e.flagged },
  { label: 'Internal coordination messages', novice: n.chats, expert: e.chats },
  { label: '— pressure faced —', novice: '', expert: '' },
  { label: 'NPC hate posts', novice: num(n.st.npc_hate_post_count), expert: num(e.st.npc_hate_post_count) },
  { label: 'Rally call active at end', novice: String(n.st.rally_call_active), expert: String(e.st.rally_call_active) },
];

const w1 = Math.max(...rows.map((r) => r.label.length));
const w2 = Math.max(6, ...rows.map((r) => String(r.novice).length));
console.log(`\n${'metric'.padEnd(w1)}  ${'BEFORE'.padStart(w2)}  AFTER`);
console.log('-'.repeat(w1 + w2 + 12));
for (const r of rows) {
  if (r.novice === '' && r.expert === '') {
    console.log(`\n${r.label}`);
    continue;
  }
  console.log(`${r.label.padEnd(w1)}  ${String(r.novice).padStart(w2)}  ${r.expert}`);
}

const kinds = new Set([...n.tally.keys(), ...e.tally.keys()]);
console.log('\nplayer_actions by type');
for (const k of [...kinds].sort()) {
  console.log(`  ${k.padEnd(26)} ${String(n.tally.get(k) ?? 0).padStart(4)}  ${e.tally.get(k) ?? 0}`);
}
