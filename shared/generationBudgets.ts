/**
 * Counts shared by the social-crisis build and `estimateBuildCalls`.
 * The pipeline imports these so the pre-build estimate cannot drift from the
 * calls it is describing.
 */

/** Personas for a footprint country that has no protagonist organisation. */
export const SPILLOVER_PERSONAS = 40;

/** At most this many spillover countries get a crowd (`runNpcsPipeline`). */
export const MAX_SPILLOVER_COUNTRIES = 2;

/** Stakeholders per mood-ladder model call (`generateMoodLadders`). */
export const MOOD_LADDER_BATCH = 6;

/**
 * First stakeholder attempt asks for this many contacts per team ("6-8").
 * The estimate uses the low end and assumes that attempt succeeds.
 */
export const STAKEHOLDERS_PER_TEAM_MIN = 6;
export const STAKEHOLDERS_PER_TEAM_MAX = 8;

/** The retry ask, used only when the first stakeholder response is empty. */
export const STAKEHOLDERS_PER_TEAM_RETRY_MIN = 4;
export const STAKEHOLDERS_PER_TEAM_RETRY_MAX = 5;

/** Common-stakeholder attempt ("3-6"). The estimate uses the low end. */
export const COMMON_STAKEHOLDERS_MIN = 3;
export const COMMON_STAKEHOLDERS_MAX = 6;

export interface SpilloverCountry {
  name: string;
  role: string;
}

/**
 * Footprint countries that receive a spillover crowd, in footprint order.
 * Incident and regulatory countries with no protagonist organisation, capped
 * at {@link MAX_SPILLOVER_COUNTRIES}. Same filter as `runNpcsPipeline`.
 */
export function spilloverCountryNames(
  footprintCountries: readonly SpilloverCountry[],
  protagonistCountries: readonly string[],
  max = MAX_SPILLOVER_COUNTRIES,
): string[] {
  const protagonists = new Set(protagonistCountries);
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (cap === 0) return [];
  const names: string[] = [];
  for (const country of footprintCountries) {
    if (country.role !== 'incident_location' && country.role !== 'regulatory') continue;
    if (protagonists.has(country.name)) continue;
    names.push(country.name);
    if (names.length >= cap) break;
  }
  return names;
}
