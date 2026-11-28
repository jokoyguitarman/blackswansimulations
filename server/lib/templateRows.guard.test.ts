import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

const PERSISTENCE = 'server/services/socialCrisisPersistenceService.ts';

function statementAround(source: string, index: number): string {
  let start = source.lastIndexOf(';', index);
  if (start < 0 || index - start > 2500) start = Math.max(0, index - 2500);
  let end = source.indexOf(';', index);
  if (end < 0 || end - index > 2500) end = Math.min(source.length, index + 2500);
  return source.slice(start + 1, end);
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Static check from WP5 §5.3. Writers that insert new rows are allowlisted. */
export function violationsInFile(relPath: string, source: string): string[] {
  if (relPath.endsWith('.test.ts') || relPath === 'server/lib/templateRows.ts') return [];
  const failures: string[] = [];

  const teamRe = /from\(\s*['"]scenario_teams['"]\s*\)/g;
  for (const match of source.matchAll(teamRe)) {
    const index = match.index ?? 0;
    const statement = statementAround(source, index);
    if (/activeTeams\s*\(|teamsValidAt\s*\(/.test(statement)) continue;
    if (relPath === PERSISTENCE) continue;
    if (/\.insert\s*\(/.test(statement) || /templateRows-allow:/.test(statement)) continue;
    failures.push(
      `${relPath}:${lineOf(source, index)} scenario_teams read does not go through templateRows.ts`,
    );
  }

  const objectiveRe = /from\(\s*['"]scenario_objectives['"]\s*\)/g;
  for (const match of source.matchAll(objectiveRe)) {
    const index = match.index ?? 0;
    const statement = statementAround(source, index);
    if (/activeObjectives\s*\(/.test(statement)) continue;
    if (/\.insert\s*\(|\.update\s*\(/.test(statement) || /templateRows-allow:/.test(statement)) continue;
    failures.push(
      `${relPath}:${lineOf(source, index)} scenario_objectives read does not go through templateRows.ts`,
    );
  }

  const injectRe = /from\(\s*['"]scenario_injects['"]\s*\)/g;
  for (const match of source.matchAll(injectRe)) {
    const index = match.index ?? 0;
    const statement = statementAround(source, index);
    const templateRead =
      /\.is\(\s*['"]session_id['"]\s*,\s*null\s*\)/.test(statement) ||
      /session_id\.is\.null/.test(statement);
    if (!templateRead) continue;
    if (/activeTemplateInjects\s*\(|templateInjectsValidAt\s*\(/.test(statement)) continue;
    if (relPath === PERSISTENCE || /templateRows-allow:/.test(statement)) continue;
    failures.push(
      `${relPath}:${lineOf(source, index)} template inject read does not go through templateRows.ts`,
    );
  }

  if (/^server\/services\/aar[^/]*\.ts$/.test(relPath) || relPath === 'server/routes/aar.ts') {
    if (/initial_state(?:\?\.)?\.orgs|initial_state\[\s*['"]orgs['"]\s*\]/.test(source)) {
      failures.push(`${relPath} reads initial_state.orgs; history must use orgsForSession`);
    }
    if (/getOrgRegistry\s*\(/.test(source)) {
      failures.push(`${relPath} labels organisations from the live registry; use orgsForSession`);
    }
  }

  return failures;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (entry.endsWith('.ts')) files.push(path);
  }
  return files;
}

export function violationsInTree(serverRoot = SERVER_ROOT): string[] {
  const failures: string[] = [];
  for (const path of walk(serverRoot)) {
    const relPath = `server/${relative(serverRoot, path)}`;
    failures.push(...violationsInFile(relPath, readFileSync(path, 'utf8')));
  }
  return failures;
}

describe('template reader guard', () => {
  test('flags a raw team read and a raw template inject read', () => {
    const team = `const { data } = await supabase.from('scenario_teams').select('*').eq('id', id);`;
    assert.match(violationsInFile('server/services/example.ts', team)[0], /scenario_teams/);
    const inject = `await supabase.from('scenario_injects').select('id').is('session_id', null);`;
    assert.match(violationsInFile('server/routes/scenarios.ts', inject)[0], /template inject/);
  });

  test('accepts helpers, inserts, and non-inject session filters', () => {
    assert.deepEqual(
      violationsInFile(
        'server/services/example.ts',
        `const { data } = await activeTeams(supabase.from('scenario_teams').select('*'));`,
      ),
      [],
    );
    assert.deepEqual(
      violationsInFile(
        'server/routes/teams.ts',
        `await supabase.from('scenario_teams').insert({ team_name: 'A' }).select().single();`,
      ),
      [],
    );
    assert.deepEqual(
      violationsInFile(
        'server/routes/scenarios.ts',
        `await supabase.from('scenario_hazards').select('*').is('session_id', null);`,
      ),
      [],
    );
    assert.deepEqual(
      violationsInFile(
        'server/services/aarExample.ts',
        `const name = initial.org_name;`,
      ),
      [],
    );
    assert.match(
      violationsInFile(
        'server/services/aarExample.ts',
        `const orgs = scenario.initial_state.orgs;`,
      )[0],
      /orgsForSession/,
    );
  });

  test('every server reader goes through templateRows.ts', () => {
    assert.deepEqual(violationsInTree(), []);
  });
});
