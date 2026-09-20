/**
 * Housekeeping between captures.
 *
 * A run that dies mid-flight (an interrupted process, a dropped connection)
 * leaves its session sitting at in_progress, which keeps the server's inject
 * scheduler working on it forever and pollutes the next run's telemetry. It can
 * also strand Chromium processes.
 *
 *   npx tsx demo-run/tidy.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { admin } from './lib.js';

const run = promisify(execFile);

/**
 * Kill stranded Playwright browsers ONLY.
 *
 * Playwright's Chromium runs as chrome.exe, exactly like the user's own
 * browser, so filtering by process name closes their real tabs too. Match on
 * the ms-playwright install path instead.
 */
async function killPlaywrightBrowsers(): Promise<void> {
  const script = `
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
      Where-Object { $_.ExecutablePath -like '*ms-playwright*' }
    if (-not $procs) { 'none'; exit 0 }
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    "killed $($procs.Count)"
  `;
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], {
      maxBuffer: 1 << 22,
    });
    const out = stdout.trim();
    console.log(
      out === 'none'
        ? 'No stranded Playwright browsers.'
        : `Playwright browsers: ${out} (your own Chrome untouched).`,
    );
  } catch (err) {
    console.log(`Browser cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await killPlaywrightBrowsers();
console.log('');

const { data: live, error } = await admin
  .from('sessions')
  .select('id, status, start_time, scenario_id')
  .eq('status', 'in_progress');

if (error) throw new Error(`Could not list sessions: ${error.message}`);

if (!live?.length) {
  console.log('No sessions left in progress.');
} else {
  console.log(`Found ${live.length} session(s) still in progress:`);
  for (const s of live) {
    const age = s.start_time
      ? Math.round((Date.now() - new Date(s.start_time).getTime()) / 60_000)
      : null;
    console.log(`  ${s.id}  started ${age === null ? 'unknown' : `${age}m ago`}`);
    const { error: upErr } = await admin
      .from('sessions')
      .update({ status: 'cancelled', end_time: new Date().toISOString() })
      .eq('id', s.id);
    console.log(upErr ? `    failed: ${upErr.message}` : '    cancelled');
  }
}

const { count: scheduled } = await admin
  .from('sessions')
  .select('*', { count: 'exact', head: true })
  .eq('status', 'scheduled');
console.log(`\n${scheduled ?? 0} session(s) still in 'scheduled' (harmless, never started).`);
