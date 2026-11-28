/** Historical per-country crowd. Casts small enough to fit under the total stay here. */
export const PERSONA_PER_COUNTRY_CAP = 200;
export const PERSONA_PER_COUNTRY_FLOOR = 40;
export const PERSONA_TOTAL_MAX_DEFAULT = 800;
/** Key voices requested in the first call of `generatePersonasForCountry`. */
export const KEY_PERSONAS_PER_COUNTRY = 14;
export const PERSONA_BACKGROUND_BATCH = 40;

/**
 * Personas generated for each protagonist country.
 * The total is split into equal counts, never above the old per-country cap and
 * never below the floor. A remainder that does not divide evenly is left unused
 * so every country gets the same count.
 */
export function personasForCountryCount(
  countryCount: number,
  totalMax = PERSONA_TOTAL_MAX_DEFAULT,
  floor = PERSONA_PER_COUNTRY_FLOOR,
  cap = PERSONA_PER_COUNTRY_CAP,
): number {
  const countries = Math.floor(countryCount);
  if (!Number.isFinite(countries) || countries <= 0) return 0;
  const total = Number.isFinite(totalMax) && totalMax > 0 ? Math.floor(totalMax) : 0;
  const even = Math.floor(total / countries);
  const low = Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : 0;
  const high = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : even;
  return Math.min(high, Math.max(low, even));
}

/**
 * AI calls for one country's crowd, assuming the key-voice call returns
 * `KEY_PERSONAS_PER_COUNTRY` personas (the number the prompt asks for).
 */
export function personaAiCalls(target: number): number {
  if (!Number.isFinite(target) || target <= 0) return 0;
  const background = Math.max(
    0,
    Math.ceil((target - KEY_PERSONAS_PER_COUNTRY) / PERSONA_BACKGROUND_BATCH),
  );
  return 1 + background;
}
