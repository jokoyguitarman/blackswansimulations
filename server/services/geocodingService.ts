/**
 * Geocoding Service
 * Uses Nominatim (OpenStreetMap) to resolve place names to coordinates.
 */

import { logger } from '../lib/logger.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export interface GeocodeResult {
  lat: number;
  lng: number;
  display_name: string;
}

/**
 * Geocode a place name to coordinates using Nominatim.
 * Returns null if geocoding fails or no results found.
 */
export async function geocode(query: string): Promise<GeocodeResult | null> {
  if (!query || typeof query !== 'string') {
    return null;
  }

  const trimmed = query.trim();
  if (!trimmed) return null;

  try {
    const params = new URLSearchParams({
      q: trimmed,
      format: 'json',
      limit: '1',
    });

    const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: {
        'User-Agent': 'BlackSwanSimulations/1.0 (warroom-geocoding)',
      },
    });

    if (!res.ok) {
      logger.warn({ status: res.status, query: trimmed }, 'Nominatim geocoding request failed');
      return null;
    }

    const data = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>;
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const first = data[0];
    const lat = parseFloat(first.lat ?? '');
    const lng = parseFloat(first.lon ?? '');

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return null;
    }

    return {
      lat,
      lng,
      display_name: first.display_name ?? trimmed,
    };
  } catch (err) {
    logger.error({ err, query: trimmed }, 'Geocoding error');
    return null;
  }
}
