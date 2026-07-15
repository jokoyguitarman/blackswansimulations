import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

const readArgValue = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
};

const hasFlag = (flag) => args.includes(flag);

const ROAD_TYPES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'service',
  'living_street',
];

const DEFAULT_INPUT = 'server/data/Singapore.osm.pbf';
const DEFAULT_OUT_DIR = 'server/data/generated';
const DEFAULT_FORMAT = 'ndjson';

const showUsage = () => {
  console.log(`
Usage:
  npm run generate:sg-osm -- [--input server/data/Singapore.osm.pbf] [--out-dir server/data/generated] [--format ndjson]

Outputs:
  <out-dir>/osm-sg-roads.<format>
  <out-dir>/osm-sg-buildings.<format>

Requirements:
  - osmium-tool installed
  - Singapore OSM extract available locally
`);
};

if (hasFlag('--help')) {
  showUsage();
  process.exit(0);
}

const inputPath = path.resolve(process.cwd(), readArgValue('--input') ?? DEFAULT_INPUT);
const outDir = path.resolve(process.cwd(), readArgValue('--out-dir') ?? DEFAULT_OUT_DIR);
const outputFormat = (readArgValue('--format') ?? DEFAULT_FORMAT).trim().toLowerCase();

if (!['json', 'ndjson'].includes(outputFormat)) {
  console.error('Invalid --format. Supported values: json, ndjson');
  process.exit(1);
}

const ensureFile = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`Input file not found: ${filePath}`);
  }
};

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed with code ${result.status}\n${result.stderr || result.stdout}`,
    );
  }

  return result.stdout;
};

const checkOsmium = () => {
  try {
    run('osmium', ['--version']);
  } catch {
    throw new Error('osmium-tool is required. Install it with `brew install osmium-tool`.');
  }
};

const parseGeoJsonSeq = async (filePath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\u001e/, '').trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Failed to parse GeoJSON sequence at ${path.basename(filePath)} line ${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
};

const toLatLngPairs = (coordinates) =>
  coordinates
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const lng = Number(entry[0]);
      const lat = Number(entry[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return [lat, lng];
    })
    .filter(Boolean);

const polygonArea = (ring) => {
  if (ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [lat1, lng1] = ring[i];
    const [lat2, lng2] = ring[(i + 1) % ring.length];
    total += lng1 * lat2 - lng2 * lat1;
  }
  return Math.abs(total / 2);
};

const dedupeClosingPoint = (pairs) => {
  if (pairs.length < 2) return pairs;
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return pairs.slice(0, -1);
  }
  return pairs;
};

const selectBestPolygonRing = (geometry) => {
  if (!geometry || typeof geometry !== 'object') return [];

  if (geometry.type === 'Polygon') {
    return dedupeClosingPoint(toLatLngPairs(geometry.coordinates?.[0] ?? []));
  }

  if (geometry.type === 'MultiPolygon') {
    const rings = (geometry.coordinates ?? [])
      .map((polygon) => dedupeClosingPoint(toLatLngPairs(polygon?.[0] ?? [])))
      .filter((ring) => ring.length >= 3);
    rings.sort((a, b) => polygonArea(b) - polygonArea(a));
    return rings[0] ?? [];
  }

  return [];
};

const buildBounds = (pairs) => {
  const lats = pairs.map(([lat]) => lat);
  const lngs = pairs.map(([, lng]) => lng);
  return {
    min_lat: Math.min(...lats),
    max_lat: Math.max(...lats),
    min_lng: Math.min(...lngs),
    max_lng: Math.max(...lngs),
  };
};

const buildCenter = (pairs) => ({
  center_lat: pairs.reduce((sum, [lat]) => sum + lat, 0) / pairs.length,
  center_lng: pairs.reduce((sum, [, lng]) => sum + lng, 0) / pairs.length,
});

const parseNumeric = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase().replace(/m$/, '').trim();
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeRoadFeatures = (features) => {
  const byId = new Map();

  for (const feature of features) {
    if (feature?.geometry?.type !== 'LineString') continue;

    const props = feature.properties ?? {};
    const highwayType = typeof props.highway === 'string' ? props.highway : null;
    if (!highwayType || !ROAD_TYPES.includes(highwayType)) continue;

    const coordinates = dedupeClosingPoint(toLatLngPairs(feature.geometry.coordinates ?? []));
    if (coordinates.length < 2) continue;

    const id = props['@id'];
    const osmType = props['@type'] ?? 'way';
    if (id === null || id === undefined) continue;

    const bounds = buildBounds(coordinates);
    const center = buildCenter(coordinates);
    const osmId = `${osmType}/${id}`;

    byId.set(osmId, {
      osm_id: osmId,
      name: props.name ? String(props.name) : props.ref ? String(props.ref) : null,
      highway_type: highwayType,
      oneway: props.oneway === 'yes' || props.oneway === true,
      ...center,
      ...bounds,
      coordinates_json: coordinates,
      source_updated_at: null,
    });
  }

  return [...byId.values()].sort((a, b) => a.osm_id.localeCompare(b.osm_id));
};

const normalizeBuildingFeatures = (features) => {
  const byId = new Map();

  for (const feature of features) {
    const props = feature.properties ?? {};
    const polygon = selectBestPolygonRing(feature.geometry);
    if (polygon.length < 3) continue;

    const id = props['@id'];
    const osmType = props['@type'] ?? 'way';
    if (id === null || id === undefined) continue;

    const bounds = buildBounds(polygon);
    const center = buildCenter(polygon);
    const osmId = `${osmType}/${id}`;

    byId.set(osmId, {
      osm_id: osmId,
      name: props.name ? String(props.name) : null,
      building_type: props.building ? String(props.building) : null,
      building_levels: parseNumeric(props['building:levels']),
      building_levels_underground: parseNumeric(props['building:levels:underground']),
      height_m: parseNumeric(props.height),
      ...center,
      ...bounds,
      footprint_polygon_json: polygon,
      source_updated_at: null,
    });
  }

  return [...byId.values()].sort((a, b) => a.osm_id.localeCompare(b.osm_id));
};

const writeJsonArray = async (filePath, data) => {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
};

const writeNdjson = async (filePath, data) => {
  const body = data.map((row) => JSON.stringify(row)).join('\n');
  await fs.writeFile(filePath, body ? body + '\n' : '', 'utf8');
};

const createTempDir = async () =>
  fs.mkdtemp(path.join(os.tmpdir(), 'sg-osm-generate-'));

const main = async () => {
  await ensureFile(inputPath);
  checkOsmium();
  await fs.mkdir(outDir, { recursive: true });

  const tempDir = await createTempDir();
  const roadsFilteredPath = path.join(tempDir, 'roads.osm.pbf');
  const buildingsFilteredPath = path.join(tempDir, 'buildings.osm.pbf');
  const roadsGeoJsonSeqPath = path.join(tempDir, 'roads.geojsonseq');
  const buildingsGeoJsonSeqPath = path.join(tempDir, 'buildings.geojsonseq');
  const roadExpression = `w/highway=${ROAD_TYPES.join(',')}`;

  console.log(`Using input: ${inputPath}`);
  console.log(`Writing output to: ${outDir}`);

  try {
    console.log('Filtering road ways from Singapore extract...');
    run('osmium', [
      'tags-filter',
      '-O',
      '-o',
      roadsFilteredPath,
      inputPath,
      roadExpression,
    ]);

    console.log('Exporting road geometry...');
    run('osmium', [
      'export',
      '-O',
      '-o',
      roadsGeoJsonSeqPath,
      '-f',
      'geojsonseq',
      '--geometry-types=linestring',
      '-a',
      'type,id',
      roadsFilteredPath,
    ]);

    console.log('Filtering building areas from Singapore extract...');
    run('osmium', [
      'tags-filter',
      '-O',
      '-o',
      buildingsFilteredPath,
      inputPath,
      'a/building',
    ]);

    console.log('Exporting building geometry...');
    run('osmium', [
      'export',
      '-O',
      '-o',
      buildingsGeoJsonSeqPath,
      '-f',
      'geojsonseq',
      '--geometry-types=polygon',
      '-a',
      'type,id',
      buildingsFilteredPath,
    ]);

    const roadFeatures = await parseGeoJsonSeq(roadsGeoJsonSeqPath);
    const buildingFeatures = await parseGeoJsonSeq(buildingsGeoJsonSeqPath);

    const roads = normalizeRoadFeatures(roadFeatures);
    const buildings = normalizeBuildingFeatures(buildingFeatures);

    const roadsOutPath = path.join(outDir, `osm-sg-roads.${outputFormat}`);
    const buildingsOutPath = path.join(outDir, `osm-sg-buildings.${outputFormat}`);

    if (outputFormat === 'ndjson') {
      await writeNdjson(roadsOutPath, roads);
      await writeNdjson(buildingsOutPath, buildings);
    } else {
      await writeJsonArray(roadsOutPath, roads);
      await writeJsonArray(buildingsOutPath, buildings);
    }

    console.log(`Generated ${roads.length} roads -> ${roadsOutPath}`);
    console.log(`Generated ${buildings.length} buildings -> ${buildingsOutPath}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
