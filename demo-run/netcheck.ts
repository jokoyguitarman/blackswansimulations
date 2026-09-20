/**
 * Connectivity sanity check before committing to a capture.
 *
 * A run is only as good as its weakest minute: if Supabase or OpenAI blink, the
 * footage keeps rolling while the simulation quietly stops advancing. Ten quick
 * samples is enough to tell "back online" from "intermittently back online".
 *
 *   npx tsx demo-run/netcheck.ts [samples]
 */

import { admin, sleep } from './lib.js';

const samples = Number(process.argv[2] ?? 10);

let supaOk = 0;
let openaiOk = 0;
const supaMs: number[] = [];

for (let i = 1; i <= samples; i++) {
  const t0 = Date.now();
  let s = false;
  try {
    const { error } = await admin.from('sessions').select('id').limit(1);
    s = !error;
  } catch {
    s = false;
  }
  const dt = Date.now() - t0;
  if (s) {
    supaOk++;
    supaMs.push(dt);
  }

  let o = false;
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    o = res.ok;
  } catch {
    o = false;
  }
  if (o) openaiOk++;

  console.log(
    `  ${String(i).padStart(2)}/${samples}  supabase ${s ? `ok ${dt}ms` : 'FAIL'}   openai ${o ? 'ok' : 'FAIL'}`,
  );
  if (i < samples) await sleep(1500);
}

const median = supaMs.sort((a, b) => a - b)[Math.floor(supaMs.length / 2)] ?? 0;
console.log(
  `\nsupabase ${supaOk}/${samples} (median ${median}ms)   openai ${openaiOk}/${samples}`,
);
const healthy = supaOk === samples && openaiOk === samples;
console.log(
  healthy
    ? 'Stable — safe to start a capture.'
    : 'UNSTABLE — a capture started now would likely stall partway.',
);
process.exit(healthy ? 0 : 1);
