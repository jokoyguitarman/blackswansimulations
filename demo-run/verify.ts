/**
 * Post-run verification: what did the agents actually manage to do?
 *
 *   npx tsx demo-run/verify.ts <sessionId>
 */

import { admin } from './lib.js';

const sessionId = process.argv[2];
if (!sessionId) throw new Error('Usage: verify.ts <sessionId>');

const { count: total } = await admin
  .from('social_posts')
  .select('*', { count: 'exact', head: true })
  .eq('session_id', sessionId);

const { data: byType } = await admin
  .from('social_posts')
  .select('author_type, platform')
  .eq('session_id', sessionId);

const tally = new Map<string, number>();
for (const r of byType ?? []) {
  const k = `${r.author_type} / ${r.platform}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}

console.log(`session ${sessionId}`);
console.log(`total social_posts: ${total}`);
console.log('\nby author_type / platform:');
for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(34)} ${v}`);
}

const { data: playerPosts } = await admin
  .from('social_posts')
  .select('author_display_name, author_type, platform, content, created_at, sop_compliance_score')
  .eq('session_id', sessionId)
  .in('author_type', ['player', 'official_account'])
  .order('created_at', { ascending: true });

console.log(`\nplayer / official posts: ${playerPosts?.length ?? 0}`);
for (const p of playerPosts ?? []) {
  const graded = p.sop_compliance_score ? 'graded' : 'ungraded';
  console.log(
    `  [${p.created_at.slice(11, 19)}] ${p.author_type} ${p.author_display_name} (${p.platform}, ${graded})`,
  );
  console.log(`      ${String(p.content).replace(/\s+/g, ' ').slice(0, 150)}`);
}

const { count: flagged } = await admin
  .from('social_posts')
  .select('*', { count: 'exact', head: true })
  .eq('session_id', sessionId)
  .eq('is_flagged_by_player', true);
console.log(`\nposts flagged by players: ${flagged}`);

const { data: actions } = await admin
  .from('player_actions')
  .select('action_type')
  .eq('session_id', sessionId);
const actionTally = new Map<string, number>();
for (const a of actions ?? []) {
  actionTally.set(a.action_type, (actionTally.get(a.action_type) ?? 0) + 1);
}
console.log(`\nplayer_actions: ${actions?.length ?? 0}`);
for (const [k, v] of [...actionTally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}

const { data: chats } = await admin
  .from('chat_messages')
  .select('id')
  .in(
    'channel_id',
    (
      await admin.from('chat_channels').select('id').eq('session_id', sessionId)
    ).data?.map((c) => c.id) ?? ['00000000-0000-0000-0000-000000000000'],
  );
console.log(`\nchat messages: ${chats?.length ?? 0}`);

const { data: sess } = await admin
  .from('sessions')
  .select('current_state')
  .eq('id', sessionId)
  .single();
const social = (sess?.current_state as { social_state?: Record<string, unknown> })?.social_state;
console.log('\nfinal social_state:', JSON.stringify(social, null, 2)?.slice(0, 900));
