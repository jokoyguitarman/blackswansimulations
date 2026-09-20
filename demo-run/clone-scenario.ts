/**
 * Clones the demo scenario onto a fictional organisation.
 *
 *   npx tsx demo-run/clone-scenario.ts
 *
 * The marketing site shows recordings of the product running, which means the
 * organisation on screen ends up on a public page next to a fabricated
 * mismanagement scandal. The delivered scenario is built on a real named client,
 * so it cannot be the one that gets filmed.
 *
 * This makes a copy on an invented organisation and leaves the original
 * untouched. Two things make that safe:
 *
 *   is_active: false   Session creation reads only initial_state and category
 *                      (server/routes/sessions.ts), so the clone is fully
 *                      usable while staying out of the scenario library.
 *   logos nulled       Every page_logo_url render site has a monogram fallback,
 *                      and the generated logo has the real wordmark in it.
 *
 * Fields that actually render on camera — the gauge labels and the org pages —
 * are written by hand below. Everything else goes through a bulk string
 * replacement, so a crop that moves later cannot expose a name we missed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { admin } from './lib.js';
import { SCENARIO_ID } from './config.js';

/** Where the new id is left for marketing-capture.ts to pick up. */
const HANDOFF = path.join('demo-run', '.marketing-scenario.json');

const TITLE = 'Programme Mismanagement Allegations — Meridian Community Trust (marketing capture)';

const ORG = {
  name: 'Meridian Community Trust',
  short: 'MCT',
  handle: '@meridiantrust',
  bio: 'Meridian Community Trust funds education grants, tuition support and family assistance. We work with schools, local partners and volunteers so that families can plan with certainty.',
} as const;

const RIVAL = {
  name: 'Northgate Foundation',
  handle: '@northgatefdn',
  bio: 'Northgate Foundation invests in education and family services, and publishes its funding decisions in full.',
} as const;

/**
 * Longest first: "Association for Muslim Professionals (AMP)" has to be spent
 * before the bare "AMP" rule can reach it.
 */
const REPLACEMENTS: [from: string, to: string][] = [
  ['Association for Muslim Professionals (AMP) Singapore', ORG.name],
  ['Association of Muslim Professionals (AMP)', `${ORG.name} (${ORG.short})`],
  ['Association for Muslim Professionals (AMP)', `${ORG.name} (${ORG.short})`],
  ['Association of Muslim Professionals', ORG.name],
  ['Association for Muslim Professionals', ORG.name],

  ['Yayasan MENDAKI', RIVAL.name],
  ['yayasan_mendaki', 'northgate_foundation'],
  ['YayasanMENDAKI', 'NorthgateFdn'],
  ['MENDakiSG', 'NorthgateFdn'],
  ['MENDAKI', 'Northgate'],
  ['MENDaki', 'Northgate'],
  ['mendaki', 'northgate'],
  ['Yayasan', 'Foundation'],

  ['@AMP.sg', ORG.handle],
  ['@AMP_SG', '@MeridianTrust'],
  ['auditAMPnow', 'auditMCTnow'],
  ['amp.example.sg', 'meridiantrust.example.org'],
  ['AMP-IR-', `${ORG.short}-IR-`],
  ['AMP', ORG.short],

  ['Amanah', 'Public Trust'],
  ['amanah', 'public trust'],

  // Regional and religious specifics, so the clone reads as anywhere.
  ['Singapore-based Muslim community organisation', 'community services organisation'],
  ['Singaporean', 'local'],
  ['Singapore', 'Northbridge'],
  ['Muslim community', 'community'],
  ['Malays/Muslims', 'families'],
  ['Malays/Muslim', 'families'],
  ['Malay/Muslim', 'local'],
  ['Malays', 'families'],
  ['Muslims', 'families'],
  ['Malay', 'local'],
  ['Muslim', 'community'],
  ['Masjid Al-Nur', 'Westside Community Centre'],
  ['Masjid', 'Community Centre'],
  ['mosque', 'community centre'],
  ['Mosque', 'Community centre'],
  ['iftar', 'community supper'],
  ['Ramadan', 'the festive season'],
  ['insyaAllah', 'hopefully'],
  ['Alhamdulillah', 'Thank goodness'],
];

const scrub = (value: string): string =>
  REPLACEMENTS.reduce((acc, [from, to]) => acc.split(from).join(to), value);

/** Bulk-rewrite every string in a JSON-serialisable value. */
const scrubDeep = <T>(value: T): T => JSON.parse(scrub(JSON.stringify(value))) as T;

// ---------------------------------------------------------------------------

const { data: original, error: readErr } = await admin
  .from('scenarios')
  .select('*')
  .eq('id', SCENARIO_ID)
  .single();
if (readErr || !original) throw new Error(`Could not read scenario: ${readErr?.message}`);

const src = original as Record<string, unknown>;

// Re-runnable: drop any previous clone first. Sessions cascade off the scenario,
// so this also clears the sessions of earlier capture attempts.
const { data: existing } = await admin.from('scenarios').select('id').eq('title', TITLE);
for (const row of (existing ?? []) as { id: string }[]) {
  await admin.from('scenarios').delete().eq('id', row.id);
  console.log(`  removed previous clone ${row.id}`);
}

const initialState = scrubDeep(src.initial_state ?? {}) as Record<string, unknown>;

// Hand-written, because these two are the ones that reach the camera: the gauge
// labels in the trainer dashboard, and the "Posting as" chip in the composer.
initialState.org_name = `${ORG.name} (${ORG.short})`;
initialState.dimension_labels = {
  public_trust: `Public Confidence in ${ORG.short}`,
  community_safety: 'Beneficiary Reassurance & Service Continuity',
  narrative_control: 'Information Narrative Control',
  escalation_risk: 'Funding & Regulatory Escalation Risk',
};

const orgPage = initialState.org_page as { orgs?: Record<string, unknown>[] } | undefined;
for (const org of orgPage?.orgs ?? []) {
  const isProtagonist = org.role === 'protagonist';
  const identity = isProtagonist ? ORG : RIVAL;
  for (const platform of ['facebook', 'x_twitter'] as const) {
    const page = org[platform] as Record<string, unknown> | undefined;
    if (!page) continue;
    page.page_name = identity.name;
    page.page_handle = identity.handle;
    page.page_bio = identity.bio;
    // The generated logo is a wordmark of the real organisation.
    page.page_logo_url = null;
  }
  console.log(`  org page: ${String(org.role).padEnd(12)} -> ${identity.name} ${identity.handle}`);
}

const { data: created, error: insErr } = await admin
  .from('scenarios')
  .insert({
    title: TITLE,
    description: scrub(String(src.description ?? '')),
    category: src.category,
    difficulty: src.difficulty,
    duration_minutes: src.duration_minutes,
    objectives: scrubDeep(src.objectives ?? []),
    initial_state: initialState,
    briefing: scrub(String(src.briefing ?? '')),
    role_specific_briefs: scrubDeep(src.role_specific_briefs ?? {}),
    created_by: src.created_by,
    // Keeps it out of the scenario library while staying usable for a session.
    is_active: false,
    sweep_device_pool: src.sweep_device_pool ?? [],
  })
  .select('id')
  .single();
if (insErr || !created) throw new Error(`Clone insert failed: ${insErr?.message}`);

const cloneId = (created as { id: string }).id;
console.log(`\nCloned ${SCENARIO_ID}\n     -> ${cloneId}`);

// ---------------------------------------------------------------------------
// Children. Copied so the clone is a valid scenario; the capture runs with the
// inject scheduler off, so none of the inject content reaches the camera.
// ---------------------------------------------------------------------------

for (const table of ['scenario_teams', 'scenario_objectives', 'sop_definitions', 'scenario_injects']) {
  const { data: rows, error } = await admin.from(table).select('*').eq('scenario_id', SCENARIO_ID);
  if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
  if (!rows || rows.length === 0) {
    console.log(`  ${table.padEnd(22)} 0`);
    continue;
  }

  const copies = (rows as Record<string, unknown>[]).map((row) => {
    const next = scrubDeep(row);
    delete next.id;
    delete next.created_at;
    delete next.updated_at;
    next.scenario_id = cloneId;
    return next;
  });

  const { error: wErr } = await admin.from(table).insert(copies);
  if (wErr) throw new Error(`Copying ${table} failed: ${wErr.message}`);
  console.log(`  ${table.padEnd(22)} ${copies.length}`);
}

// ---------------------------------------------------------------------------

// Verify nothing came through. Cheaper and more honest than trusting the map.
const { data: check } = await admin.from('scenarios').select('*').eq('id', cloneId).single();
const { data: injects } = await admin
  .from('scenario_injects')
  .select('title, content, delivery_config')
  .eq('scenario_id', cloneId);
const haystack = JSON.stringify({ check, injects });
const NEVER = ['AMP', 'MENDAKI', 'MENDaki', 'Muslim', 'Amanah', 'amanah', 'Singapore', 'Masjid'];
const found = NEVER.filter((n) => haystack.includes(n));

console.log(
  found.length === 0
    ? '\nScrub clean: none of the real names survive in the clone.'
    : `\nWARNING: still present in the clone: ${found.join(', ')}`,
);

fs.writeFileSync(
  HANDOFF,
  `${JSON.stringify({ scenarioId: cloneId, title: TITLE, org: ORG.name, clonedAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`Wrote ${HANDOFF}`);
