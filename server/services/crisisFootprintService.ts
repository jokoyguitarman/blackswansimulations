import { logger } from '../lib/logger.js';
import { callSocialCrisisAI } from './socialCrisisGeneratorService.js';
import { isKnownCountry, findCountry } from '../../shared/countries.js';
import type { NormalisedOrg, PressureKind, PressureRegister } from './scenarioOrgModel.js';
import { defaultRegisterFor } from './scenarioOrgModel.js';
import { detectLabourSignal, detectProductSafetySignal } from './castCompletenessService.js';

/**
 * Crisis footprint inference (pressure plan §11): one AI call that reads the crisis
 * text and proposes the countries involved (with roles), the protagonist-side
 * entities the text implies (an office, a regional hub) and the pressure
 * organisations (regulators, unions, NGOs, community groups, political actors).
 * Nothing is persisted; the wizard shows the result as pre-ticked proposals.
 * `guardRailFootprint` is pure and unit-tested.
 */

export type CountryRole =
  | 'decision_centre'
  | 'incident_location'
  | 'spillover_market'
  | 'regulatory';

export interface FootprintCountry {
  name: string;
  role: CountryRole;
  reason: string;
}

export interface ImpliedOrganisation {
  display_name: string;
  kind: 'office' | 'company' | 'agency' | 'ngo' | 'other';
  country: string;
  city?: string;
  reason: string;
  suggested_roster: string[];
}

export interface PressureProposal {
  display_name: string;
  kind: PressureKind;
  country: string;
  city?: string;
  register: PressureRegister;
  reason: string;
  wants?: string;
}

export interface CrisisFootprint {
  countries: FootprintCountry[];
  implied_organisations: ImpliedOrganisation[];
  pressure_organisations: PressureProposal[];
  labour_signal: boolean;
  product_safety_signal: boolean;
}

const MAX_IMPLIED = 3;
const MAX_PRESSURE = 6;
const PRESSURE_KINDS: readonly PressureKind[] = [
  'union',
  'regulator',
  'ngo',
  'community_group',
  'political',
];
// "ministry" is a regulator signal, not a political one; "minister" (the person) is.
const POLITICAL_RE =
  /\b(minister|parliament|mp|senator|opposition|election|policy ?makers?|lawmakers?)\b/i;

/** Deterministic clean-up of the model's proposal (also used when the AI is unavailable). */
export function guardRailFootprint(
  raw: Partial<CrisisFootprint> | null | undefined,
  crisisText: string,
  existingOrgs: Array<{ display_name: string; country: string }>,
): CrisisFootprint {
  const labour = detectLabourSignal(crisisText);
  const productSafety = detectProductSafetySignal(crisisText);
  const political = POLITICAL_RE.test(crisisText);
  const existingCountries = new Set(existingOrgs.map((o) => o.country));
  const existingNames = new Set(existingOrgs.map((o) => o.display_name.toLowerCase()));

  const countries: FootprintCountry[] = [];
  const seenC = new Set<string>();
  for (const c of raw?.countries || []) {
    const name = findCountry(String(c?.name || ''))?.name;
    if (!name || seenC.has(name)) continue;
    const role = (
      ['decision_centre', 'incident_location', 'spillover_market', 'regulatory'] as CountryRole[]
    ).includes(c.role as CountryRole)
      ? (c.role as CountryRole)
      : 'spillover_market';
    seenC.add(name);
    countries.push({ name, role, reason: String(c.reason || '').slice(0, 200) });
  }
  // Every existing organisation country is at least present.
  for (const c of existingCountries) {
    if (isKnownCountry(c) && !seenC.has(c)) {
      seenC.add(c);
      countries.push({
        name: c,
        role: 'decision_centre',
        reason: 'Organisation entered by the trainer',
      });
    }
  }

  const implied: ImpliedOrganisation[] = [];
  for (const o of raw?.implied_organisations || []) {
    if (implied.length >= MAX_IMPLIED) break;
    const name = String(o?.display_name || '').trim();
    const country = findCountry(String(o?.country || ''))?.name;
    if (name.length < 2 || !country || existingNames.has(name.toLowerCase())) continue;
    const kind = (['office', 'company', 'agency', 'ngo', 'other'] as const).includes(
      o.kind as 'office',
    )
      ? (o.kind as ImpliedOrganisation['kind'])
      : 'office';
    implied.push({
      display_name: name.slice(0, 120),
      kind,
      country,
      city: o.city ? String(o.city).slice(0, 80) : undefined,
      reason: String(o.reason || '').slice(0, 200),
      suggested_roster: Array.isArray(o.suggested_roster)
        ? (o.suggested_roster as unknown[]).map(String).filter(Boolean).slice(0, 4)
        : [],
    });
    existingNames.add(name.toLowerCase());
  }

  const pressure: PressureProposal[] = [];
  const regulatorsByCountry = new Map<string, number>();
  for (const p of raw?.pressure_organisations || []) {
    if (pressure.length >= MAX_PRESSURE) break;
    const name = String(p?.display_name || '').trim();
    const country = findCountry(String(p?.country || ''))?.name;
    const kind = p?.kind as PressureKind;
    if (name.length < 2 || !country || !PRESSURE_KINDS.includes(kind)) continue;
    if (existingNames.has(name.toLowerCase())) continue;
    if (kind === 'union' && !labour) continue;
    if (kind === 'political' && !political) continue;
    if (kind === 'regulator') {
      const n = regulatorsByCountry.get(country) || 0;
      const allowed = labour && productSafety ? 2 : 1;
      if (n >= allowed) continue;
      regulatorsByCountry.set(country, n + 1);
    }
    existingNames.add(name.toLowerCase());
    pressure.push({
      display_name: name.slice(0, 120),
      kind,
      country,
      city: p.city ? String(p.city).slice(0, 80) : undefined,
      register: (
        ['statutory', 'advocacy', 'grassroots', 'political'] as PressureRegister[]
      ).includes(p.register as PressureRegister)
        ? (p.register as PressureRegister)
        : defaultRegisterFor(kind),
      reason: String(p.reason || '').slice(0, 200),
      wants: p.wants ? String(p.wants).slice(0, 300) : undefined,
    });
  }

  return {
    countries,
    implied_organisations: implied,
    pressure_organisations: pressure,
    labour_signal: labour,
    product_safety_signal: productSafety,
  };
}

export async function inferCrisisFootprint(
  crisisText: string,
  orgs: NormalisedOrg[],
): Promise<CrisisFootprint> {
  const existing = orgs.map((o) => ({ display_name: o.display_name, country: o.country }));
  const raw = await callSocialCrisisAI(
    `You are mapping the FOOTPRINT of a crisis for a training simulation: which countries it touches and in what role, which organisation-side entities the text implies but the trainer has not entered, and which third parties will apply pressure.

Return ONLY valid JSON:
{
  "countries": [ { "name": "<country name>", "role": "decision_centre|incident_location|spillover_market|regulatory", "reason": "..." } ],
  "implied_organisations": [ { "display_name": "...", "kind": "office|company|agency|ngo|other", "country": "...", "city": "...", "reason": "...", "suggested_roster": ["Communications", "Operations", ...] } ],
  "pressure_organisations": [ { "display_name": "...", "kind": "union|regulator|ngo|community_group|political", "country": "...", "city": "...", "register": "statutory|advocacy|grassroots|political", "reason": "...", "wants": "one sentence: what they demand" } ]
}

Rules:
- decision_centre = where the decisions are taken (HQ); incident_location = where the harm / event is; spillover_market = where the public conversation spreads; regulatory = a country whose authority acts.
- implied_organisations are ONLY protagonist-side entities of the organisation under crisis (a country office, a factory's operating company, a regional hub) that the text names or clearly implies and that the trainer has NOT entered. Never list suppliers, partners, customers, media or authorities here. At most 3.
- pressure_organisations: the specific regulator / ministry per involved country (real names where possible), the union or labour NGO when workers are affected, a community group when a community is named, a political actor only when politics is in the text. At most 6. Use full official names.
- Countries must be real country names.`,
    `Crisis: ${crisisText.slice(0, 2500)}\nOrganisations already entered: ${existing.map((o) => `${o.display_name} (${o.country})`).join('; ') || 'none'}`,
    3000,
    0.4,
  );
  const footprint = guardRailFootprint(
    raw as Partial<CrisisFootprint> | null,
    crisisText,
    existing,
  );
  logger.info(
    {
      countries: footprint.countries.map((c) => `${c.name}:${c.role}`),
      implied: footprint.implied_organisations.map((o) => o.display_name),
      pressure: footprint.pressure_organisations.map((p) => `${p.kind}:${p.display_name}`),
      labour: footprint.labour_signal,
    },
    'crisis_footprint_inferred',
  );
  return footprint;
}
