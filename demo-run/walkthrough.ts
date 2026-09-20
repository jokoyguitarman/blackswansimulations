/**
 * Walkthrough narration.
 *
 * Generates the voiceover with OpenAI TTS, one file per beat, and reports the
 * real duration of each. Those durations then drive how much footage each beat
 * gets, so picture is cut to the narration rather than narration being squeezed
 * to fit picture.
 *
 *   npx tsx demo-run/walkthrough.ts            # generate audio + timing report
 *   npx tsx demo-run/walkthrough.ts --script   # print the script only
 */

import 'dotenv/config';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const MODEL = 'gpt-4o-mini-tts';
const VOICE = process.env.DEMO_TTS_VOICE ?? 'onyx';

/** Delivery direction. gpt-4o-mini-tts honours this; older tts-1 ignores it. */
const DELIVERY =
  'Measured, calm, documentary narrator. Low warm register with quiet authority. ' +
  'Unhurried pace, clear consonants, a real pause at each full stop. ' +
  'Serious but not melodramatic — this is a briefing, not a movie trailer.';

export interface Beat {
  id: string;
  /** What the viewer is looking at while this is read. */
  visual: string;
  line: string;
}

export const SCRIPT: Beat[] = [
  {
    id: '01-open',
    visual: 'Cold open: hostile posts scrolling on the Z feed',
    line: 'A community organisation wakes up to an allegation it did not expect. Within minutes it is trending, and most of what is spreading is not true.',
  },
  {
    id: '02-problem',
    visual: 'Mosaic of 25 screens, people scrolling',
    line: 'Most teams have never rehearsed this. They have a communications policy, and they have good intentions, and neither survives the first twenty minutes.',
  },
  {
    id: '03-product',
    visual: 'Trainer dashboard, gauges live',
    line: 'Black Swan Simulations puts a real team inside a real crisis. This one is called Amanah Under Fire. Twenty five people, five departments, one organisation under investigation.',
  },
  {
    id: '04-world',
    visual: 'Phone shell: Z feed, Fakebook, chat, mail, news apps',
    line: 'Each person works from their own device, on a live social platform, a second network, an inbox, a team chat, and a newsroom. Ninety nine characters populate that world, and they react to what your people actually say.',
  },
  {
    id: '05-adversary',
    visual: 'Antagonist org page posting an attack',
    line: 'A rival organisation is in there too, driven by AI, looking for the gap in your messaging. Miss a false claim and it compounds. Stay silent, and silence becomes the story.',
  },
  {
    id: '06-teams',
    visual: 'Team panels on the trainer dashboard',
    line: 'Communications owns the public voice. Legal verifies before anyone speaks. Stakeholder Management holds the board and the regulator. Partnerships protects service continuity. Fundraising protects donor confidence. Stray outside your lane and the simulation notices.',
  },
  {
    id: '07-trainer',
    visual: 'Trainer dashboard: strategic actions checklist, unattended posts',
    line: 'The trainer watches all of it from one screen. Public confidence, narrative control, escalation risk, and a checklist of the things a competent response would have done by now.',
  },
  {
    id: '08-before',
    visual: 'Novice run: four teams at zero, overdue warnings',
    line: 'Here is an untrained team, thirty minutes in. Four of five departments have completed nothing. No misinformation flagged. No verified statement published. Public confidence has fallen to twenty nine.',
  },
  {
    id: '09-after',
    visual: 'Expert run: statement being typed, flags landing, chat flowing',
    line: 'And here is the same twenty five people after training. A verified holding statement inside three minutes. Sixteen false claims flagged and countered. Two hundred and twenty five internal messages instead of thirty.',
  },
  {
    id: '10-result',
    visual: 'Comparison chart, RDAP stat callout',
    line: 'Their crisis posture moved from defensive to accommodative. The volume of hostile content the crisis generated was cut in half. Same people, same scenario, one round of training between them.',
  },
  {
    id: '11-close',
    visual: 'End card',
    line: 'Black Swan Simulations. Rehearse the crisis before it arrives.',
  },
];

// ---------------------------------------------------------------------------

if (process.argv.includes('--script')) {
  let words = 0;
  for (const b of SCRIPT) {
    words += b.line.split(/\s+/).length;
    console.log(`\n[${b.id}]  ${b.visual}`);
    console.log(`  ${b.line}`);
  }
  console.log(`\n${SCRIPT.length} beats, ${words} words (~${Math.round((words / 150) * 60)}s at 150 wpm)`);
  process.exit(0);
}

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY missing');

const outDir = path.join('demo-run', 'output', 'walkthrough', 'vo');
fs.mkdirSync(outDir, { recursive: true });

const durations: { id: string; file: string; sec: number; words: number }[] = [];

for (const beat of SCRIPT) {
  const file = path.join(outDir, `${beat.id}.mp3`);
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      input: beat.line,
      instructions: DELIVERY,
    }),
  });
  if (!res.ok) {
    throw new Error(`TTS failed for ${beat.id}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));

  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ]);
  const sec = Number(stdout.trim());
  durations.push({ id: beat.id, file, sec, words: beat.line.split(/\s+/).length });
  console.log(`  ${beat.id.padEnd(12)} ${sec.toFixed(2)}s  (${beat.line.split(/\s+/).length} words)`);
}

const total = durations.reduce((n, d) => n + d.sec, 0);
// A beat of air between lines keeps it from sounding rushed.
const GAP = 0.55;
const withGaps = total + GAP * (durations.length - 1);

fs.writeFileSync(
  path.join('demo-run', 'output', 'walkthrough', 'vo-timing.json'),
  JSON.stringify({ voice: VOICE, model: MODEL, gapSec: GAP, beats: durations, totalSec: withGaps }, null, 2),
);

console.log(`\nvoice     ${VOICE} (${MODEL})`);
console.log(`narration ${total.toFixed(1)}s + ${GAP}s gaps = ${withGaps.toFixed(1)}s (${Math.floor(withGaps / 60)}:${String(Math.round(withGaps % 60)).padStart(2, '0')})`);
console.log(`wrote     ${outDir}`);
