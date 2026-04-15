const STORAGE_KEY = 'bss_rts_saved_maps';

export interface SavedMap {
  id: string;
  name: string;
  lat: string;
  lng: string;
  radius: string;
  savedAt: number;
  grids: Array<{
    buildingIndex: number;
    buildingName: string | null;
    polygon: [number, number][];
    floors: string[];
    spacingM: number;
  }>;
  buildings: Array<{
    name: string | null;
    lat: number;
    lng: number;
    levels: number | null;
    use: string | null;
    polygonPoints: number;
  }>;
}

export function loadSavedMaps(): SavedMap[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedMap[];
  } catch {
    return [];
  }
}

export function saveMap(map: SavedMap): void {
  const existing = loadSavedMaps();
  const idx = existing.findIndex((m) => m.id === map.id);
  if (idx >= 0) {
    existing[idx] = map;
  } else {
    existing.push(map);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
}

export function deleteSavedMap(id: string): void {
  const existing = loadSavedMaps().filter((m) => m.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
}

export function generateMapId(): string {
  return `map-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
