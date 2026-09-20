/**
 * One-time preparation for the demo capture:
 *   1. raise the scenario's team caps so 25 players fit
 *   2. create / reuse the admin + 25 player accounts and cache their sessions
 *
 * Safe to re-run; everything is idempotent.
 *
 *   npx tsx demo-run/prepare.ts [playerCount]
 */

import { ROSTER, SCENARIO_TITLE, TEAMS } from './config.js';
import { ensureTeamCapacity, provisionCohort } from './lib.js';

const playerCount = Number(process.argv[2] ?? ROSTER.length);

console.log(`Scenario: ${SCENARIO_TITLE}`);
console.log(`Teams: ${TEAMS.join(', ')}\n`);

console.log('Raising team capacity...');
await ensureTeamCapacity();

console.log('');
const { adminAgent, players } = await provisionCohort(playerCount);

console.log(`\nAdmin: ${adminAgent.name} <${adminAgent.email}> (${adminAgent.userId})`);
console.log(`Players: ${players.length}`);
for (const t of TEAMS) {
  const members = players.filter((p) => p.spec.team === t);
  console.log(`  ${t.padEnd(30)} ${members.length}  ${members.map((m) => m.name).join(', ')}`);
}
console.log('\nPrepare complete.');
