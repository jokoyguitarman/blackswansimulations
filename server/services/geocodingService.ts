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

let lastNominatimCallMs = 0;
const NOMINATIM_MIN_GAP_MS = 1200;
const NOMINATIM_429_RETRIES = 3;
const NOMINATIM_429_BACKOFF_MS = 2000;

async function nominatimSearch(query: string, limit: number): Promise<NominatimResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: String(limit),
  });

  for (let attempt = 0; attempt <= NOMINATIM_429_RETRIES; attempt++) {
    // Enforce minimum gap between Nominatim calls to respect rate limits
    const elapsed = Date.now() - lastNominatimCallMs;
    if (elapsed < NOMINATIM_MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, NOMINATIM_MIN_GAP_MS - elapsed));
    }
    lastNominatimCallMs = Date.now();

    const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: {
        'User-Agent': 'BlackSwanSimulations/1.0 (warroom-geocoding)',
      },
    });

    if (res.status === 429) {
      const wait = NOMINATIM_429_BACKOFF_MS * (attempt + 1);
      logger.warn(
        { query, attempt: attempt + 1, waitMs: wait },
        'Nominatim rate-limited (429), backing off',
      );
      if (attempt < NOMINATIM_429_RETRIES) {
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return [];
    }

    if (!res.ok) {
      logger.warn({ status: res.status, query }, 'Nominatim geocoding request failed');
      return [];
    }

    const data = await res.json();
    return Array.isArray(data) ? (data as NominatimResult[]) : [];
  }

  return [];
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
      if (allResults.length >= 3) break;
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
