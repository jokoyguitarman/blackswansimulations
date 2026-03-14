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

interface NominatimResult {
  lat?: string;
  lon?: string;
  display_name?: string;
}

async function nominatimSearch(query: string, limit: number): Promise<NominatimResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: String(limit),
  });

  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': 'BlackSwanSimulations/1.0 (warroom-geocoding)',
    },
  });

  if (!res.ok) {
    logger.warn({ status: res.status, query }, 'Nominatim geocoding request failed');
    return [];
  }

  const data = await res.json();
  return Array.isArray(data) ? (data as NominatimResult[]) : [];
}

function parseResult(item: NominatimResult, fallbackName: string): GeocodeResult | null {
  const lat = parseFloat(item.lat ?? '');
  const lng = parseFloat(item.lon ?? '');
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng, display_name: item.display_name ?? fallbackName };
}

function displayNameMatchScore(displayName: string, hint: string): number {
  const dn = displayName.toLowerCase();
  const words = hint
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((w) => w.length > 2);
  let matched = 0;
  for (const w of words) {
    if (dn.includes(w)) matched++;
  }
  return words.length > 0 ? matched / words.length : 0;
}

/**
 * Geocode a place name to coordinates using Nominatim.
 * Returns null if geocoding fails or no results found.
 */
export async function geocode(query: string): Promise<GeocodeResult | null> {
  if (!query || typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (!trimmed) return null;

  try {
    const results = await nominatimSearch(trimmed, 3);
    if (results.length === 0) return null;
    return parseResult(results[0], trimmed);
  } catch (err) {
    logger.error({ err, query: trimmed }, 'Geocoding error');
    return null;
  }
}

/**
 * Geocode with multiple query attempts and pick the result whose display_name
 * best matches a hint string (typically the venue name or original prompt).
 * Tries the primary query first, then alternateQueries, and returns the best match.
 */
export async function geocodeBest(
  primaryQuery: string,
  alternateQueries: string[],
  matchHint: string,
): Promise<GeocodeResult | null> {
  if (!primaryQuery && alternateQueries.length === 0) return null;

  try {
    const queries = [primaryQuery, ...alternateQueries].filter((q) => q && q.trim());
    const allResults: GeocodeResult[] = [];

    for (const q of queries) {
      const results = await nominatimSearch(q.trim(), 3);
      for (const r of results) {
        const parsed = parseResult(r, q.trim());
        if (parsed) allResults.push(parsed);
      }
      if (allResults.length > 0 && queries.indexOf(q) < queries.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
    }

    if (allResults.length === 0) return null;
    if (!matchHint) return allResults[0];

    let best = allResults[0];
    let bestScore = displayNameMatchScore(best.display_name, matchHint);
    for (let i = 1; i < allResults.length; i++) {
      const score = displayNameMatchScore(allResults[i].display_name, matchHint);
      if (score > bestScore) {
        best = allResults[i];
        bestScore = score;
      }
    }

    logger.info(
      { best: best.display_name, score: bestScore, candidates: allResults.length },
      'geocodeBest selected result',
    );
    return best;
  } catch (err) {
    logger.error({ err, primaryQuery }, 'geocodeBest error');
    return null;
  }
}
