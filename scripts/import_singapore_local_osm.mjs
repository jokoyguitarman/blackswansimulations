import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: path.resolve(process.cwd(), '.env') });
loadEnv({ path: path.resolve(process.cwd(), 'frontend/.env.local'), override: false });

const args = process.argv.slice(2);

const readArgValue = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
};

const hasFlag = (flag) => args.includes(flag);

const showUsage = () => {
  console.log(`
Usage:
  npm run import:sg-osm -- --roads <roads.ndjson> --buildings <buildings.ndjson> [--truncate] [--batch-size 500]

Accepted input formats:
  - JSON array
  - NDJSON (one JSON object per line)

Road row shape:
  {
    "osm_id": "way/123",
    "name": "Sims Avenue",
    "highway_type": "primary",
    "oneway": false,
    "center_lat": 1.31,
    "center_lng": 103.88,
    "min_lat": 1.30,
    "max_lat": 1.32,
    "min_lng": 103.87,
    "max_lng": 103.89,
    "coordinates_json": [[1.31, 103.88], [1.311, 103.881]],
    "source_updated_at": "2026-07-12T00:00:00.000Z"
  }

Building row shape:
  {
    "osm_id": "way/456",
    "name": "Paya Lebar Square",
    "building_type": "commercial",
    "building_levels": 8,
    "building_levels_underground": 2,
    "height_m": 48,
    "center_lat": 1.317,
    "center_lng": 103.892,
    "min_lat": 1.316,
    "max_lat": 1.318,
    "min_lng": 103.891,
    "max_lng": 103.893,
    "footprint_polygon_json": [[1.317, 103.892], [1.3171, 103.8923], [1.3168, 103.8926]],
    "source_updated_at": "2026-07-12T00:00:00.000Z"
  }
`);
};

if (hasFlag('--help')) {
  showUsage();
  process.exit(0);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const roadsPath = readArgValue('--roads');
const buildingsPath = readArgValue('--buildings');
const shouldTruncate = hasFlag('--truncate');
const batchSize = Number(readArgValue('--batch-size') ?? 500);

if (!roadsPath && !buildingsPath) {
  showUsage();
  process.exit(1);
}

if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 5000) {
  console.error('Invalid --batch-size. Use a value between 1 and 5000.');
  process.exit(1);
}

const db = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const parseJsonLines = (raw) =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid NDJSON at line ${index + 1}: ${error.message}`);
      }
    });

const readRecords = async (filePath) => {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const raw = await fs.readFile(absolutePath, 'utf8');
  const trimmed = raw.trim();

  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`${filePath} must contain a JSON array`);
    }
    return parsed;
  }

  return parseJsonLines(trimmed);
};

const importNdjsonFile = async ({ table, filePath, normalize, batchSize, db }) => {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const stream = createReadStream(absolutePath, 'utf8');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let batch = [];
  let lineNumber = 0;
  let inserted = 0;

  for await (const line of rl) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `[${table}] invalid NDJSON at line ${lineNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    batch.push(normalize(parsed, lineNumber - 1));
    if (batch.length >= batchSize) {
      const { error } = await db.from(table).upsert(batch, { onConflict: 'osm_id' });
      if (error) throw new Error(`[${table}] batch upsert failed: ${error.message}`);
      inserted += batch.length;
      console.log(`[${table}] Upserted ${inserted} row(s)`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    const { error } = await db.from(table).upsert(batch, { onConflict: 'osm_id' });
    if (error) throw new Error(`[${table}] final batch upsert failed: ${error.message}`);
    inserted += batch.length;
    console.log(`[${table}] Upserted ${inserted} row(s)`);
  }

  return inserted;
};

const asNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asBoolean = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
    if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  }
  return null;
};

const parseCoordinatePairs = (value, label) => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of [lat, lng] pairs`);
  }

  const pairs = value
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const lat = asNumber(entry[0]);
      const lng = asNumber(entry[1]);
      if (lat === null || lng === null) return null;
      return [lat, lng];
    })
    .filter(Boolean);

  return pairs;
};

const deriveBounds = (pairs) => {
  const lats = pairs.map(([lat]) => lat);
  const lngs = pairs.map(([, lng]) => lng);
  return {
    min_lat: Math.min(...lats),
    max_lat: Math.max(...lats),
    min_lng: Math.min(...lngs),
    max_lng: Math.max(...lngs),
  };
};

const deriveCenter = (pairs) => {
  const latSum = pairs.reduce((sum, [lat]) => sum + lat, 0);
  const lngSum = pairs.reduce((sum, [, lng]) => sum + lng, 0);
  return {
    center_lat: latSum / pairs.length,
    center_lng: lngSum / pairs.length,
  };
};

const normalizeRoad = (row, index) => {
  const osmId = String(row.osm_id ?? row.osmId ?? '').trim();
  if (!osmId) throw new Error(`Road row ${index + 1} is missing osm_id`);

  const coordinates = parseCoordinatePairs(row.coordinates_json ?? row.coordinates ?? row.geometry, `Road ${osmId} coordinates`);
  if (coordinates.length < 2) {
    throw new Error(`Road ${osmId} must have at least 2 coordinates`);
  }

  const bounds = {
    ...deriveBounds(coordinates),
    min_lat: asNumber(row.min_lat ?? row.minLat) ?? deriveBounds(coordinates).min_lat,
    max_lat: asNumber(row.max_lat ?? row.maxLat) ?? deriveBounds(coordinates).max_lat,
    min_lng: asNumber(row.min_lng ?? row.minLng) ?? deriveBounds(coordinates).min_lng,
    max_lng: asNumber(row.max_lng ?? row.maxLng) ?? deriveBounds(coordinates).max_lng,
  };
  const center = {
    ...deriveCenter(coordinates),
    center_lat: asNumber(row.center_lat ?? row.centerLat) ?? deriveCenter(coordinates).center_lat,
    center_lng: asNumber(row.center_lng ?? row.centerLng) ?? deriveCenter(coordinates).center_lng,
  };

  return {
    osm_id: osmId,
    name: row.name ? String(row.name) : null,
    highway_type: row.highway_type ? String(row.highway_type) : row.highwayType ? String(row.highwayType) : null,
    oneway: asBoolean(row.oneway),
    ...center,
    ...bounds,
    coordinates_json: coordinates,
    source_updated_at: row.source_updated_at ?? row.sourceUpdatedAt ?? null,
  };
};

const normalizeBuilding = (row, index) => {
  const osmId = String(row.osm_id ?? row.osmId ?? '').trim();
  if (!osmId) throw new Error(`Building row ${index + 1} is missing osm_id`);

  const polygon = parseCoordinatePairs(
    row.footprint_polygon_json ?? row.footprintPolygon ?? row.polygon ?? row.geometry,
    `Building ${osmId} polygon`,
  );
  if (polygon.length < 3) {
    throw new Error(`Building ${osmId} must have at least 3 polygon coordinates`);
  }

  const bounds = {
    ...deriveBounds(polygon),
    min_lat: asNumber(row.min_lat ?? row.minLat) ?? deriveBounds(polygon).min_lat,
    max_lat: asNumber(row.max_lat ?? row.maxLat) ?? deriveBounds(polygon).max_lat,
    min_lng: asNumber(row.min_lng ?? row.minLng) ?? deriveBounds(polygon).min_lng,
    max_lng: asNumber(row.max_lng ?? row.maxLng) ?? deriveBounds(polygon).max_lng,
  };
  const center = {
    ...deriveCenter(polygon),
    center_lat: asNumber(row.center_lat ?? row.centerLat) ?? deriveCenter(polygon).center_lat,
    center_lng: asNumber(row.center_lng ?? row.centerLng) ?? deriveCenter(polygon).center_lng,
  };

  return {
    osm_id: osmId,
    name: row.name ? String(row.name) : null,
    building_type: row.building_type
      ? String(row.building_type)
      : row.buildingType
        ? String(row.buildingType)
        : null,
    building_levels: asNumber(row.building_levels ?? row.buildingLevels),
    building_levels_underground: asNumber(
      row.building_levels_underground ?? row.buildingLevelsUnderground,
    ),
    height_m: asNumber(row.height_m ?? row.heightM),
    ...center,
    ...bounds,
    footprint_polygon_json: polygon,
    source_updated_at: row.source_updated_at ?? row.sourceUpdatedAt ?? null,
  };
};

const chunk = (items, size) => {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
};

const importTable = async ({ table, filePath, normalize }) => {
  if (!filePath) return { inserted: 0, skipped: true };

  if (shouldTruncate) {
    console.log(`[${table}] Truncating existing rows`);
    const { error } = await db.from(table).delete().neq('id', 0);
    if (error) throw new Error(`[${table}] truncate failed: ${error.message}`);
  }

  if (filePath.toLowerCase().endsWith('.ndjson')) {
    console.log(`\n[${table}] Streaming NDJSON from ${filePath}`);
    const inserted = await importNdjsonFile({ table, filePath, normalize, batchSize, db });
    return { inserted, skipped: false };
  }

  const rawRows = await readRecords(filePath);
  const normalizedRows = rawRows.map(normalize);

  console.log(`\n[${table}] Read ${normalizedRows.length} row(s) from ${filePath}`);

  let inserted = 0;
  for (const [index, batch] of chunk(normalizedRows, batchSize).entries()) {
    const { error } = await db.from(table).upsert(batch, { onConflict: 'osm_id' });
    if (error) {
      throw new Error(`[${table}] batch ${index + 1} failed: ${error.message}`);
    }
    inserted += batch.length;
    console.log(`[${table}] Upserted batch ${index + 1} (${inserted}/${normalizedRows.length})`);
  }

  return { inserted, skipped: false };
};

try {
  const roadResult = await importTable({
    table: 'osm_sg_roads',
    filePath: roadsPath,
    normalize: normalizeRoad,
  });
  const buildingResult = await importTable({
    table: 'osm_sg_buildings',
    filePath: buildingsPath,
    normalize: normalizeBuilding,
  });

  console.log('\nImport complete');
  if (!roadResult.skipped) console.log(`  Roads: ${roadResult.inserted}`);
  if (!buildingResult.skipped) console.log(`  Buildings: ${buildingResult.inserted}`);
} catch (error) {
  console.error('\nImport failed');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
