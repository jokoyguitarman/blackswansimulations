/**
 * Canonical country list shared by the War Room wizard (picker) and the server
 * (validation, slugs, dial codes). Country identity everywhere in a scenario is
 * the exact `name` string from this list (contract §5.1), so both sides must use
 * the same spelling — hence one file.
 */

export interface CountryInfo {
  /** Display name — the identity string used in orgs[], countries[], delivery_config.country, personas. */
  name: string;
  /** ISO 3166-1 alpha-2. */
  code: string;
  /** International dialling prefix without '+'. */
  dial: string;
}

export const COUNTRIES: readonly CountryInfo[] = [
  { name: 'Afghanistan', code: 'AF', dial: '93' },
  { name: 'Albania', code: 'AL', dial: '355' },
  { name: 'Algeria', code: 'DZ', dial: '213' },
  { name: 'Argentina', code: 'AR', dial: '54' },
  { name: 'Armenia', code: 'AM', dial: '374' },
  { name: 'Australia', code: 'AU', dial: '61' },
  { name: 'Austria', code: 'AT', dial: '43' },
  { name: 'Azerbaijan', code: 'AZ', dial: '994' },
  { name: 'Bahrain', code: 'BH', dial: '973' },
  { name: 'Bangladesh', code: 'BD', dial: '880' },
  { name: 'Belgium', code: 'BE', dial: '32' },
  { name: 'Bhutan', code: 'BT', dial: '975' },
  { name: 'Bolivia', code: 'BO', dial: '591' },
  { name: 'Bosnia and Herzegovina', code: 'BA', dial: '387' },
  { name: 'Botswana', code: 'BW', dial: '267' },
  { name: 'Brazil', code: 'BR', dial: '55' },
  { name: 'Brunei', code: 'BN', dial: '673' },
  { name: 'Bulgaria', code: 'BG', dial: '359' },
  { name: 'Cambodia', code: 'KH', dial: '855' },
  { name: 'Cameroon', code: 'CM', dial: '237' },
  { name: 'Canada', code: 'CA', dial: '1' },
  { name: 'Chile', code: 'CL', dial: '56' },
  { name: 'China', code: 'CN', dial: '86' },
  { name: 'Colombia', code: 'CO', dial: '57' },
  { name: 'Costa Rica', code: 'CR', dial: '506' },
  { name: 'Croatia', code: 'HR', dial: '385' },
  { name: 'Cyprus', code: 'CY', dial: '357' },
  { name: 'Czech Republic', code: 'CZ', dial: '420' },
  { name: 'Denmark', code: 'DK', dial: '45' },
  { name: 'Dominican Republic', code: 'DO', dial: '1' },
  { name: 'Ecuador', code: 'EC', dial: '593' },
  { name: 'Egypt', code: 'EG', dial: '20' },
  { name: 'Estonia', code: 'EE', dial: '372' },
  { name: 'Ethiopia', code: 'ET', dial: '251' },
  { name: 'Fiji', code: 'FJ', dial: '679' },
  { name: 'Finland', code: 'FI', dial: '358' },
  { name: 'France', code: 'FR', dial: '33' },
  { name: 'Georgia', code: 'GE', dial: '995' },
  { name: 'Germany', code: 'DE', dial: '49' },
  { name: 'Ghana', code: 'GH', dial: '233' },
  { name: 'Greece', code: 'GR', dial: '30' },
  { name: 'Guatemala', code: 'GT', dial: '502' },
  { name: 'Hong Kong', code: 'HK', dial: '852' },
  { name: 'Hungary', code: 'HU', dial: '36' },
  { name: 'Iceland', code: 'IS', dial: '354' },
  { name: 'India', code: 'IN', dial: '91' },
  { name: 'Indonesia', code: 'ID', dial: '62' },
  { name: 'Iran', code: 'IR', dial: '98' },
  { name: 'Iraq', code: 'IQ', dial: '964' },
  { name: 'Ireland', code: 'IE', dial: '353' },
  { name: 'Israel', code: 'IL', dial: '972' },
  { name: 'Italy', code: 'IT', dial: '39' },
  { name: 'Jamaica', code: 'JM', dial: '1' },
  { name: 'Japan', code: 'JP', dial: '81' },
  { name: 'Jordan', code: 'JO', dial: '962' },
  { name: 'Kazakhstan', code: 'KZ', dial: '7' },
  { name: 'Kenya', code: 'KE', dial: '254' },
  { name: 'Kuwait', code: 'KW', dial: '965' },
  { name: 'Laos', code: 'LA', dial: '856' },
  { name: 'Latvia', code: 'LV', dial: '371' },
  { name: 'Lebanon', code: 'LB', dial: '961' },
  { name: 'Lithuania', code: 'LT', dial: '370' },
  { name: 'Luxembourg', code: 'LU', dial: '352' },
  { name: 'Macau', code: 'MO', dial: '853' },
  { name: 'Malaysia', code: 'MY', dial: '60' },
  { name: 'Maldives', code: 'MV', dial: '960' },
  { name: 'Malta', code: 'MT', dial: '356' },
  { name: 'Mauritius', code: 'MU', dial: '230' },
  { name: 'Mexico', code: 'MX', dial: '52' },
  { name: 'Mongolia', code: 'MN', dial: '976' },
  { name: 'Morocco', code: 'MA', dial: '212' },
  { name: 'Mozambique', code: 'MZ', dial: '258' },
  { name: 'Myanmar', code: 'MM', dial: '95' },
  { name: 'Namibia', code: 'NA', dial: '264' },
  { name: 'Nepal', code: 'NP', dial: '977' },
  { name: 'Netherlands', code: 'NL', dial: '31' },
  { name: 'New Zealand', code: 'NZ', dial: '64' },
  { name: 'Nigeria', code: 'NG', dial: '234' },
  { name: 'North Macedonia', code: 'MK', dial: '389' },
  { name: 'Norway', code: 'NO', dial: '47' },
  { name: 'Oman', code: 'OM', dial: '968' },
  { name: 'Pakistan', code: 'PK', dial: '92' },
  { name: 'Panama', code: 'PA', dial: '507' },
  { name: 'Papua New Guinea', code: 'PG', dial: '675' },
  { name: 'Paraguay', code: 'PY', dial: '595' },
  { name: 'Peru', code: 'PE', dial: '51' },
  { name: 'Philippines', code: 'PH', dial: '63' },
  { name: 'Poland', code: 'PL', dial: '48' },
  { name: 'Portugal', code: 'PT', dial: '351' },
  { name: 'Qatar', code: 'QA', dial: '974' },
  { name: 'Romania', code: 'RO', dial: '40' },
  { name: 'Russia', code: 'RU', dial: '7' },
  { name: 'Rwanda', code: 'RW', dial: '250' },
  { name: 'Saudi Arabia', code: 'SA', dial: '966' },
  { name: 'Senegal', code: 'SN', dial: '221' },
  { name: 'Serbia', code: 'RS', dial: '381' },
  { name: 'Singapore', code: 'SG', dial: '65' },
  { name: 'Slovakia', code: 'SK', dial: '421' },
  { name: 'Slovenia', code: 'SI', dial: '386' },
  { name: 'South Africa', code: 'ZA', dial: '27' },
  { name: 'South Korea', code: 'KR', dial: '82' },
  { name: 'Spain', code: 'ES', dial: '34' },
  { name: 'Sri Lanka', code: 'LK', dial: '94' },
  { name: 'Sweden', code: 'SE', dial: '46' },
  { name: 'Switzerland', code: 'CH', dial: '41' },
  { name: 'Taiwan', code: 'TW', dial: '886' },
  { name: 'Tanzania', code: 'TZ', dial: '255' },
  { name: 'Thailand', code: 'TH', dial: '66' },
  { name: 'Timor-Leste', code: 'TL', dial: '670' },
  { name: 'Tunisia', code: 'TN', dial: '216' },
  { name: 'Turkey', code: 'TR', dial: '90' },
  { name: 'Uganda', code: 'UG', dial: '256' },
  { name: 'Ukraine', code: 'UA', dial: '380' },
  { name: 'United Arab Emirates', code: 'AE', dial: '971' },
  { name: 'United Kingdom', code: 'GB', dial: '44' },
  { name: 'United States', code: 'US', dial: '1' },
  { name: 'Uruguay', code: 'UY', dial: '598' },
  { name: 'Uzbekistan', code: 'UZ', dial: '998' },
  { name: 'Vietnam', code: 'VN', dial: '84' },
  { name: 'Zambia', code: 'ZM', dial: '260' },
  { name: 'Zimbabwe', code: 'ZW', dial: '263' },
];

const BY_NAME = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c]));

export function findCountry(name: string | null | undefined): CountryInfo | undefined {
  if (!name) return undefined;
  return BY_NAME.get(name.trim().toLowerCase());
}

export function isKnownCountry(name: string | null | undefined): boolean {
  return findCountry(name) !== undefined;
}

/** Lowercase ASCII slug, `_`-separated, max 24 chars ("Philippines" -> "philippines"). */
export function countrySlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
}

/** Lowercase alpha-2 code when known, else the slug's first two letters. */
export function countryCode(name: string): string {
  const c = findCountry(name);
  return (c?.code ?? countrySlug(name).slice(0, 2)).toLowerCase();
}

export function countryDialPrefix(name: string): string {
  const c = findCountry(name);
  return c ? `+${c.dial}` : '+65';
}
