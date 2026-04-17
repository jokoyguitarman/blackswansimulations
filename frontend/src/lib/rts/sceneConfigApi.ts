import { supabase } from '../supabase';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

async function getHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: session ? `Bearer ${session.access_token}` : '',
  };
}

export interface SceneConfigSummary {
  id: string;
  name: string;
  building_name: string | null;
  center_lat: number | null;
  center_lng: number | null;
  pedestrian_count: number;
  created_at: string;
  updated_at: string;
}

export interface SceneConfigFull {
  id: string;
  scenario_id: string | null;
  name: string;
  building_polygon: [number, number][];
  building_name: string | null;
  center_lat: number | null;
  center_lng: number | null;
  exits: unknown[];
  interior_walls: unknown[];
  hazard_zones: unknown[];
  stairwells: unknown[];
  blast_site: { x: number; y: number } | null;
  casualty_clusters: unknown[];
  planted_items: unknown[];
  wall_inspection_points: unknown[];
  wall_photo_urls: Record<string, string>;
  casualty_image_urls: Record<string, string>;
  pedestrian_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function createSceneConfig(config: {
  scenarioId?: string;
  name: string;
  buildingPolygon: [number, number][];
  buildingName?: string;
  centerLat?: number;
  centerLng?: number;
  exits?: unknown[];
  interiorWalls?: unknown[];
  hazardZones?: unknown[];
  stairwells?: unknown[];
  blastSite?: { x: number; y: number } | null;
  casualtyClusters?: unknown[];
  plantedItems?: unknown[];
  wallInspectionPoints?: unknown[];
  pedestrianCount?: number;
}): Promise<{ id: string }> {
  const headers = await getHeaders();
  const resp = await fetch(apiUrl('/api/rts-scenes'), {
    method: 'POST',
    headers,
    body: JSON.stringify(config),
  });
  if (!resp.ok) throw new Error(`Create failed: ${resp.status}`);
  const { data } = await resp.json();
  return data;
}

export async function loadSceneConfig(id: string): Promise<SceneConfigFull> {
  const headers = await getHeaders();
  const resp = await fetch(apiUrl(`/api/rts-scenes/${id}`), { headers });
  if (!resp.ok) throw new Error(`Load failed: ${resp.status}`);
  const { data } = await resp.json();
  return data;
}

export async function listSceneConfigs(params?: {
  scenarioId?: string;
  createdBy?: string;
}): Promise<SceneConfigSummary[]> {
  const headers = await getHeaders();
  const qs = new URLSearchParams();
  if (params?.scenarioId) qs.set('scenario_id', params.scenarioId);
  if (params?.createdBy) qs.set('created_by', params.createdBy);
  const resp = await fetch(apiUrl(`/api/rts-scenes?${qs}`), { headers });
  if (!resp.ok) throw new Error(`List failed: ${resp.status}`);
  const { data } = await resp.json();
  return data;
}

export async function updateSceneConfig(
  id: string,
  updates: Record<string, unknown>,
): Promise<{ id: string; updated_at: string }> {
  const headers = await getHeaders();
  const resp = await fetch(apiUrl(`/api/rts-scenes/${id}`), {
    method: 'PATCH',
    headers,
    body: JSON.stringify(updates),
  });
  if (!resp.ok) throw new Error(`Update failed: ${resp.status}`);
  const { data } = await resp.json();
  return data;
}

export async function uploadSceneImage(
  sceneId: string,
  key: string,
  imageData: string,
  imageType: 'wall' | 'casualty' = 'wall',
): Promise<string> {
  const headers = await getHeaders();
  const resp = await fetch(apiUrl(`/api/rts-scenes/${sceneId}/upload-image`), {
    method: 'POST',
    headers,
    body: JSON.stringify({ imageData, key, imageType }),
  });
  if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
  const { data } = await resp.json();
  return data.url;
}

export async function deleteSceneConfig(id: string): Promise<void> {
  const headers = await getHeaders();
  const resp = await fetch(apiUrl(`/api/rts-scenes/${id}`), {
    method: 'DELETE',
    headers,
  });
  if (!resp.ok) throw new Error(`Delete failed: ${resp.status}`);
}
