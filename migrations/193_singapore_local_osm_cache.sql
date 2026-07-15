-- Singapore-local OSM cache tables for Supabase-backed road/building queries.
-- This is a lightweight schema that stores normalized geometry as JSON plus
-- bounding-box columns for fast prefiltering without requiring PostGIS.

create table if not exists public.osm_sg_roads (
  id bigint generated always as identity primary key,
  osm_id text not null unique,
  name text,
  highway_type text not null,
  oneway boolean default false,
  center_lat double precision,
  center_lng double precision,
  min_lat double precision not null,
  max_lat double precision not null,
  min_lng double precision not null,
  max_lng double precision not null,
  coordinates_json jsonb not null,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.osm_sg_buildings (
  id bigint generated always as identity primary key,
  osm_id text not null unique,
  name text,
  building_type text,
  building_levels double precision,
  building_levels_underground double precision,
  height_m double precision,
  center_lat double precision,
  center_lng double precision,
  min_lat double precision not null,
  max_lat double precision not null,
  min_lng double precision not null,
  max_lng double precision not null,
  footprint_polygon_json jsonb not null,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_osm_sg_roads_bbox
  on public.osm_sg_roads (min_lat, max_lat, min_lng, max_lng);

create index if not exists idx_osm_sg_roads_highway_type
  on public.osm_sg_roads (highway_type);

create index if not exists idx_osm_sg_buildings_bbox
  on public.osm_sg_buildings (min_lat, max_lat, min_lng, max_lng);

create index if not exists idx_osm_sg_buildings_name
  on public.osm_sg_buildings (name);

alter table public.osm_sg_roads enable row level security;
alter table public.osm_sg_buildings enable row level security;

drop policy if exists "Service role manages Singapore OSM roads" on public.osm_sg_roads;
create policy "Service role manages Singapore OSM roads"
  on public.osm_sg_roads
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "Service role manages Singapore OSM buildings" on public.osm_sg_buildings;
create policy "Service role manages Singapore OSM buildings"
  on public.osm_sg_buildings
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
