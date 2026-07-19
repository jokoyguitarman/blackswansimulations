alter table public.osm_sg_buildings
  alter column building_levels type double precision using building_levels::double precision,
  alter column building_levels_underground type double precision using building_levels_underground::double precision;
