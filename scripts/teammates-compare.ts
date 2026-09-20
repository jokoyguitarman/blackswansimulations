import { readFileSync } from 'node:fs';

/**
 * Compare two AI-teammate scorecards (docs/ai-teammate-bots-plan.md Phase 6).
 *
 *   npx tsx scripts/teammates-compare.ts a.json b.json
 *
 * Both files come from scripts/teammates-scorecard.ts --out. Prints side-by-side team
 * composites, first-statement timing, countering rate, gauges and per-bot averages so a
 * brain change or a different intellect setting can be judged on the game's own numbers.
 */

interface Card {
  session_id: string;
  scenario_title: string | null;
  bot_intellect: number | null;
  elapsed_minutes: number | null;
  bots: Array<{
    display_name: string;
    team_name: string | null;
    avg_overall: number | null;
    graded_items: number;
    actions: Record<string, number>;
  }>;
  team_scores: Array<{
    team_name: string;
    composite_score: number | null;
    content_quality: number | null;
    task_completion: number | null;
    role_fit: number | null;
    tasks_done: number;
    tasks_total: number;
  }>;
  time_to_first_statement_minutes: number | null;
  harmful_posts: number;
  harmful_countered_within_5m: number;
  gauges: Record<string, number | null>;
}

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('Usage: npx tsx scripts/teammates-compare.ts a.json b.json');
  process.exit(1);
}
const a = JSON.parse(readFileSync(aPath, 'utf8')) as Card;
const b = JSON.parse(readFileSync(bPath, 'utf8')) as Card;

const f = (v: number | null | undefined): string =>
  v === null || v === undefined ? '-' : String(Math.round(v));
const delta = (x: number | null | undefined, y: number | null | undefined): string =>
  x === null || x === undefined || y === null || y === undefined
    ? ''
    : ` (${y - x >= 0 ? '+' : ''}${Math.round(y - x)})`;
const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((100 * n) / d));

console.log(
  `A: ${a.scenario_title ?? a.session_id} intellect ${f(a.bot_intellect)} T+${f(a.elapsed_minutes)}m`,
);
console.log(
  `B: ${b.scenario_title ?? b.session_id} intellect ${f(b.bot_intellect)} T+${f(b.elapsed_minutes)}m`,
);
console.log('');
console.log('Team composites (A -> B):');
const teams = new Set([
  ...a.team_scores.map((t) => t.team_name),
  ...b.team_scores.map((t) => t.team_name),
]);
for (const name of teams) {
  const ta = a.team_scores.find((t) => t.team_name === name);
  const tb = b.team_scores.find((t) => t.team_name === name);
  console.log(
    `  ${name.padEnd(26)} ${f(ta?.composite_score)} -> ${f(tb?.composite_score)}${delta(ta?.composite_score, tb?.composite_score)}` +
      `   content ${f(ta?.content_quality)} -> ${f(tb?.content_quality)}   tasks ${ta ? `${ta.tasks_done}/${ta.tasks_total}` : '-'} -> ${tb ? `${tb.tasks_done}/${tb.tasks_total}` : '-'}   role-fit ${f(ta?.role_fit)} -> ${f(tb?.role_fit)}`,
  );
}
console.log('');
console.log(
  `First official statement: ${f(a.time_to_first_statement_minutes)}m -> ${f(b.time_to_first_statement_minutes)}m`,
);
console.log(
  `Harmful countered <=5m:   ${f(pct(a.harmful_countered_within_5m, a.harmful_posts))}% (${a.harmful_countered_within_5m}/${a.harmful_posts}) -> ${f(pct(b.harmful_countered_within_5m, b.harmful_posts))}% (${b.harmful_countered_within_5m}/${b.harmful_posts})`,
);
console.log('Gauges:');
for (const k of Object.keys({ ...a.gauges, ...b.gauges })) {
  console.log(
    `  ${k.padEnd(20)} ${f(a.gauges[k])} -> ${f(b.gauges[k])}${delta(a.gauges[k], b.gauges[k])}`,
  );
}
console.log('');
console.log('Bots (avg grade, graded items, actions):');
const avg = (c: Card) => {
  const g = c.bots.filter((x) => x.avg_overall !== null);
  return g.length ? Math.round(g.reduce((s, x) => s + (x.avg_overall ?? 0), 0) / g.length) : null;
};
const totalActions = (c: Card) =>
  c.bots.reduce((s, x) => s + Object.values(x.actions).reduce((p, q) => p + q, 0), 0);
console.log(`  A: avg grade ${f(avg(a))}, ${a.bots.length} bots, ${totalActions(a)} actions`);
console.log(`  B: avg grade ${f(avg(b))}, ${b.bots.length} bots, ${totalActions(b)} actions`);
