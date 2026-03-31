export interface AssetCatalogEntry {
  asset_type: string;
  label: string;
}

export const TEAM_ASSET_CATALOG: Record<string, AssetCatalogEntry[]> = {
  evacuation: [
    { asset_type: 'assembly_point', label: 'Assembly Point' },
    { asset_type: 'marshal_post', label: 'Marshal Post' },
    { asset_type: 'ambulance_staging', label: 'Ambulance Staging' },
  ],
  triage: [
    { asset_type: 'triage_tent', label: 'Triage Tent' },
    { asset_type: 'triage_officer', label: 'Triage Officer' },
    { asset_type: 'field_hospital', label: 'Field Hospital' },
    { asset_type: 'ambulance_staging', label: 'Ambulance Staging' },
    { asset_type: 'decon_zone', label: 'Decon Zone' },
  ],
  media: [
    { asset_type: 'press_cordon', label: 'Press Cordon' },
    { asset_type: 'media_liaison', label: 'Media Liaison' },
    { asset_type: 'briefing_point', label: 'Media Briefing Point' },
    { asset_type: 'camera_position', label: 'Camera Position' },
  ],
  fire_hazmat: [
    { asset_type: 'decon_zone', label: 'Decon Zone' },
    { asset_type: 'firefighter_post', label: 'Firefighter Post' },
    { asset_type: 'fire_truck_staging', label: 'Fire Truck Staging' },
    { asset_type: 'water_point', label: 'Water Point' },
  ],
};

export const UNIVERSAL_ASSETS: AssetCatalogEntry[] = [
  { asset_type: 'barrier', label: 'Barrier / Cordon' },
  { asset_type: 'operational_area', label: 'Operational Area' },
  { asset_type: 'hazard_zone', label: 'Hazard Zone' },
  { asset_type: 'command_post', label: 'Command Post' },
  { asset_type: 'radio_relay', label: 'Radio Relay' },
];

/**
 * Resolve the team-specific + universal asset catalog for a given team name.
 * Uses fuzzy matching on the normalized team name, mirroring frontend logic.
 */
export function getTeamCatalogAssets(teamName: string): AssetCatalogEntry[] {
  const key = teamName.toLowerCase().replace(/[\s-]/g, '_');
  let specific = TEAM_ASSET_CATALOG[key];
  if (!specific) {
    for (const [catalogKey, assets] of Object.entries(TEAM_ASSET_CATALOG)) {
      if (key.includes(catalogKey) || catalogKey.includes(key)) {
        specific = assets;
        break;
      }
    }
  }
  return specific ? [...specific, ...UNIVERSAL_ASSETS] : [...UNIVERSAL_ASSETS];
}
