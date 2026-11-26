/**
 * Join an FDS device file to the zone-model series and print the deltas.
 *
 *   node --import tsx frontend/tests/fixtures/fireValidation/fds/reduce.ts two-room <fdsDir> <engineCsv> <outCsv>
 *   node --import tsx frontend/tests/fixtures/fireValidation/fds/reduce.ts harbour <fdsDir> <engineCsv> <outCsv>
 *
 * FDS upper temperature is °C. Rise is that minus the 20 °C ambient.
 * MASS FLOW + is the positive coordinate direction, MASS FLOW - the other.
 * On the shop/fire door, +x leaves the fire room.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Table {
  header: string[];
  rows: Map<number, number[]>;
}

function readCsv(path: string, timeName = 't_s'): Table {
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const headerLine = lines.findIndex((line) => line.split(',')[0]?.trim() === timeName || line.startsWith('Time'));
  if (headerLine < 0) throw new Error(`no header in ${path}`);
  const header = lines[headerLine]!.split(',').map((cell) => cell.trim());
  const rows = new Map<number, number[]>();
  for (const line of lines.slice(headerLine + 1)) {
    const cells = line.split(',').map((cell) => Number(cell.trim()));
    const t = cells[0];
    if (t == null || !Number.isFinite(t)) continue;
    const key = Math.round(t);
    if (Math.abs(t - key) > 0.05) continue;
    rows.set(key, cells);
  }
  return { header, rows };
}

function col(table: Table, name: string, t: number): number {
  const index = table.header.indexOf(name);
  if (index < 0) throw new Error(`column ${name} missing (${table.header.join(', ')})`);
  const row = table.rows.get(t);
  if (!row) return Number.NaN;
  return row[index] ?? Number.NaN;
}

function mean(values: number[]): number {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return Number.NaN;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function fmt(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(digits);
}

interface Pair {
  name: string;
  engine: string;
  fds: string;
  digits: number;
  /** FDS temperature columns are °C. Rise subtracts the ambient. */
  rise?: boolean;
  /** MASS FLOW - is negative when gas moves in the negative coordinate direction. */
  negate?: boolean;
}

function reduceCase(
  pairs: Pair[],
  engine: Table,
  fdsDev: Table,
  fdsHrr: Table,
  fromS: number,
  toS: number,
): { csv: string; report: string } {
  const header = ['t_s'];
  for (const pair of pairs) {
    header.push(`engine_${pair.name}`, `fds_${pair.name}`, `delta_${pair.name}`);
  }
  const lines = [header.join(',')];
  const deltas = new Map<string, number[]>();
  const engineMeans = new Map<string, number[]>();
  const fdsMeans = new Map<string, number[]>();
  for (let t = 0; t <= toS; t++) {
    if (!engine.rows.has(t) || !fdsDev.rows.has(t)) continue;
    const cells = [String(t)];
    for (const pair of pairs) {
      const left =
        pair.engine === 'HRR' ? col(engine, 'hrr_kW', t) : pair.engine === 'AMBIENT' ? 0 : col(engine, pair.engine, t);
      let fdsValue = pair.fds === 'HRR' ? col(fdsHrr, 'HRR', t) : col(fdsDev, pair.fds, t);
      if (pair.rise) fdsValue -= 20;
      if (pair.negate) fdsValue = -fdsValue;
      const delta = fdsValue - left;
      cells.push(fmt(left, pair.digits), fmt(fdsValue, pair.digits), fmt(delta, pair.digits));
      if (t >= fromS && t <= toS) {
        const bucket = deltas.get(pair.name) ?? [];
        bucket.push(delta);
        deltas.set(pair.name, bucket);
        const e = engineMeans.get(pair.name) ?? [];
        e.push(left);
        engineMeans.set(pair.name, e);
        const f = fdsMeans.get(pair.name) ?? [];
        f.push(fdsValue);
        fdsMeans.set(pair.name, f);
      }
    }
    lines.push(cells.join(','));
  }
  const report = pairs
    .map((pair) => {
      const d = deltas.get(pair.name) ?? [];
      return [
        pair.name,
        `engine ${fmt(mean(engineMeans.get(pair.name) ?? []), pair.digits)}`,
        `FDS ${fmt(mean(fdsMeans.get(pair.name) ?? []), pair.digits)}`,
        `delta ${fmt(mean(d), pair.digits)}`,
        `n ${d.length}`,
      ].join(' | ');
    })
    .join('\n');
  return { csv: lines.join('\n') + '\n', report };
}

const kind = process.argv[2];
const fdsDir = process.argv[3];
const enginePath = process.argv[4];
const outPath = process.argv[5];
if (!kind || !fdsDir || !enginePath || !outPath) {
  throw new Error('usage: reduce.ts <two-room|harbour> <fdsDir> <engineCsv> <outCsv>');
}

const engine = readCsv(enginePath, 't_s');
const chid = kind === 'harbour' ? 'harbour' : 'two_room';
const fdsDev = readCsv(join(fdsDir, `${chid}_devc.csv`), 'Time');
const fdsHrr = readCsv(join(fdsDir, `${chid}_hrr.csv`), 'Time');

const pairs: Pair[] =
  kind === 'harbour'
    ? [
        { name: 'shop_z_m', engine: 'shop_z_m', fds: 'shop-z', digits: 3 },
        { name: 'shop_rise_K', engine: 'shop_rise_K', fds: 'shop-Tu', digits: 2, rise: true },
        { name: 'shop_lower_rise_K', engine: 'AMBIENT', fds: 'shop-Tl', digits: 2, rise: true },
        { name: 'mall_z_m', engine: 'mall_z_m', fds: 'mall-z', digits: 3 },
        { name: 'mall_rise_K', engine: 'mall_rise_K', fds: 'mall-Tu', digits: 2, rise: true },
        { name: 'mall_lower_rise_K', engine: 'AMBIENT', fds: 'mall-Tl', digits: 2, rise: true },
        { name: 'hrr_kW', engine: 'HRR', fds: 'HRR', digits: 1 },
        { name: 'door_plus_kg_s', engine: 'door_out_kg_s', fds: 'door-plus', digits: 3 },
        { name: 'door_minus_kg_s', engine: 'return_out_kg_s', fds: 'door-minus', digits: 3, negate: true },
        { name: 'near_z_m', engine: 'mall_z_m', fds: 'near-z', digits: 3 },
        { name: 'near_rise_K', engine: 'mall_rise_K', fds: 'near-Tu', digits: 2, rise: true },
        { name: 'west_out_kg_s', engine: 'west_out_kg_s', fds: 'west-minus', digits: 3, negate: true },
        { name: 'north_out_kg_s', engine: 'north_out_kg_s', fds: 'north-plus', digits: 3 },
      ]
    : [
        { name: 'fire_z_m', engine: 'fire_z_m', fds: 'fire-z', digits: 3 },
        { name: 'fire_rise_K', engine: 'fire_rise_K', fds: 'fire-Tu', digits: 2, rise: true },
        { name: 'fire_lower_rise_K', engine: 'AMBIENT', fds: 'fire-Tl', digits: 2, rise: true },
        { name: 'entry_z_m', engine: 'entry_z_m', fds: 'entry-z', digits: 3 },
        { name: 'entry_rise_K', engine: 'entry_rise_K', fds: 'entry-Tu', digits: 2, rise: true },
        { name: 'entry_lower_rise_K', engine: 'AMBIENT', fds: 'entry-Tl', digits: 2, rise: true },
        { name: 'hrr_kW', engine: 'HRR', fds: 'HRR', digits: 2 },
        { name: 'door_plus_kg_s', engine: 'door_out_kg_s', fds: 'door-plus', digits: 4 },
        { name: 'door_minus_kg_s', engine: 'door_in_kg_s', fds: 'door-minus', digits: 4, negate: true },
        { name: 'far_plus_kg_s', engine: 'far_out_kg_s', fds: 'far-plus', digits: 4 },
        { name: 'return_vs_minus_kg_s', engine: 'return_out_kg_s', fds: 'door-minus', digits: 4, negate: true },
      ];

const fromS = kind === 'harbour' ? 60 : 60;
const toS = kind === 'harbour' ? 120 : 180;
const reduced = reduceCase(pairs, engine, fdsDev, fdsHrr, fromS, toS);
writeFileSync(outPath, reduced.csv);
console.log(`window ${fromS}–${toS} s`);
console.log(reduced.report);
console.log(`wrote ${outPath}`);
