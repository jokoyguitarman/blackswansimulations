# Singapore Local OSM In Supabase

This branch adds a Supabase-first path for Singapore OSM roads/buildings while
keeping Overpass as the automatic fallback.

## What The App Uses

- `public.osm_sg_roads`
- `public.osm_sg_buildings`

Both tables store:

- bounding-box columns for coarse prefiltering
- JSON geometry payloads for exact filtering in Node
- minimal road/building metadata used by `server/services/osmVicinityService.ts`

## Runtime Toggle

Set:

```bash
ENABLE_LOCAL_OSM_SINGAPORE=true
```

When enabled:

- road queries inside Singapore try Supabase first
- building queries inside Singapore try Supabase first
- if tables are empty or query fails, the code falls back to Overpass

## Table Shape

### `osm_sg_roads`

- `osm_id`
- `name`
- `highway_type`
- `oneway`
- `center_lat`, `center_lng`
- `min_lat`, `max_lat`, `min_lng`, `max_lng`
- `coordinates_json`

### `osm_sg_buildings`

- `osm_id`
- `name`
- `building_type`
- `building_levels`
- `building_levels_underground`
- `height_m`
- `center_lat`, `center_lng`
- `min_lat`, `max_lat`, `min_lng`, `max_lng`
- `footprint_polygon_json`

## Suggested Import Pipeline

1. Download a Singapore-scoped `.osm.pbf` extract.
2. Convert drivable roads and building polygons into normalized JSON rows.
3. Upsert rows into Supabase with the service role key.
4. Enable `ENABLE_LOCAL_OSM_SINGAPORE=true`.

## Import Script

This repo now includes:

```bash
npm run generate:sg-osm -- --input server/data/Singapore.osm.pbf --out-dir server/data/generated --format ndjson
```

That generator produces:

- `server/data/generated/osm-sg-roads.ndjson`
- `server/data/generated/osm-sg-buildings.ndjson`

Then import them with:

```bash
npm run import:sg-osm -- \
  --roads server/data/generated/osm-sg-roads.ndjson \
  --buildings server/data/generated/osm-sg-buildings.ndjson
```

Optional flags:

- `--truncate` clears the target table before upserting
- `--batch-size 500` changes the Supabase upsert batch size

Accepted input formats:

- JSON array
- NDJSON, one object per line

For large Singapore-wide extracts, NDJSON is recommended because the importer
can stream it in batches instead of loading the whole file into memory at once.

Expected normalized fields:

- roads: `osm_id`, `name`, `highway_type`, `oneway`, bbox fields, and `coordinates_json`
- buildings: `osm_id`, `name`, `building_type`, levels/height fields, bbox fields, and `footprint_polygon_json`

The script also accepts common camelCase aliases such as `osmId`, `highwayType`,
`footprintPolygon`, `centerLat`, and `centerLng`.

## Notes

- This is not fully offline; it replaces live OSM APIs with Supabase-backed cached data.
- Geometry querying is bbox-first, then exact radius filtering in Node.
- PostGIS can be added later, but this schema does not require it.
