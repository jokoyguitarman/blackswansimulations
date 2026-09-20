/**
 * Folding sections for the detail views (native <details>, so they work without JS state,
 * print correctly and are keyboard-accessible).
 *
 *   <WrSection id="cast" title="Cast · contacts" count={85} icon="target" family="var(--f-intel)" ...>
 *     <WrFold title="Sigma Logistics" count={38} sub="HQ · Singapore" defaultOpen>
 *       <WrSub title="Internal" count={12} hint="site leader, HR">…</WrSub>
 *     </WrFold>
 *   </WrSection>
 *
 * `useSectionIndex(rootRef)` gives expandAll / collapseAll for a side index.
 */
import { useCallback, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { WrIcon, type WrIconName } from './WarRoomIcon';

export const WrSection = ({
  id,
  title,
  count,
  icon,
  family,
  subtitle,
  peek,
  defaultOpen = false,
  children,
  className = '',
}: {
  id: string;
  title: ReactNode;
  count?: number | string;
  icon: WrIconName;
  /** CSS colour for the tile and count pill, e.g. 'var(--f-intel)' */
  family?: string;
  subtitle?: ReactNode;
  /** chips shown on the right of the summary while collapsed */
  peek?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) => (
  <details
    className={`wr-sec ${className}`}
    id={id}
    open={defaultOpen || undefined}
    style={{ '--g': family ?? 'var(--brand)' } as CSSProperties}
  >
    <summary>
      <div className="wr-tile">
        <WrIcon name={icon} size={20} />
      </div>
      <div className="min-w-0">
        <h2>
          {title}
          {count !== undefined && <span className="n">{count}</span>}
        </h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="peek">{peek}</div>
      <div className="chev">
        <WrIcon name="chevron" size={14} />
      </div>
    </summary>
    <div className="body">{children}</div>
  </details>
);

export const WrFold = ({
  title,
  count,
  sub,
  lead,
  defaultOpen = false,
  children,
  className = '',
}: {
  title: ReactNode;
  count?: number | string;
  sub?: ReactNode;
  /** element rendered before the title (country code, icon…) */
  lead?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) => (
  <details className={`wr-fold ${className}`} open={defaultOpen || undefined}>
    <summary>
      {lead}
      <span>{title}</span>
      {count !== undefined && <span className="n">{count}</span>}
      {sub && <span className="sub">{sub}</span>}
      <span className="chev">
        <WrIcon name="chevron" size={14} />
      </span>
    </summary>
    <div className="g">{children}</div>
  </details>
);

export const WrSub = ({
  title,
  count,
  hint,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  count?: number | string;
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) => (
  <details className="wr-sub" open={defaultOpen || undefined}>
    <summary>
      <span>{title}</span>
      {count !== undefined && <span className="n">{count}</span>}
      {hint && <span className="hint">{hint}</span>}
      <span className="chev">
        <WrIcon name="chevron" size={14} />
      </span>
    </summary>
    {children}
  </details>
);

/** Expand / collapse every <details> under a root. */
export function useSectionIndex(rootRef: RefObject<HTMLElement | null>) {
  const setAll = useCallback(
    (open: boolean) => {
      rootRef.current?.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => {
        d.open = open;
      });
    },
    [rootRef],
  );
  const openSection = useCallback(
    (id: string) => {
      const el = rootRef.current?.querySelector<HTMLDetailsElement>(`#${id}`);
      if (!el) return;
      el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [rootRef],
  );
  return { expandAll: () => setAll(true), collapseAll: () => setAll(false), openSection };
}

/** Initials for a monogram avatar. */
export const initialsOf = (name: string | null | undefined): string => {
  if (!name) return '·';
  const words = name
    .replace(/[^A-Za-z\u00C0-\u024F ]/g, '')
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return name.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
};

/** ISO-ish 2-letter country code from a country name or code. */
const COUNTRY_CODES: Record<string, string> = {
  singapore: 'SG',
  malaysia: 'MY',
  indonesia: 'ID',
  thailand: 'TH',
  philippines: 'PH',
  vietnam: 'VN',
  australia: 'AU',
  'new zealand': 'NZ',
  japan: 'JP',
  'south korea': 'KR',
  korea: 'KR',
  china: 'CN',
  'hong kong': 'HK',
  taiwan: 'TW',
  india: 'IN',
  'united kingdom': 'GB',
  uk: 'GB',
  'united states': 'US',
  usa: 'US',
  canada: 'CA',
  germany: 'DE',
  france: 'FR',
  netherlands: 'NL',
  'united arab emirates': 'AE',
  uae: 'AE',
  'saudi arabia': 'SA',
  brunei: 'BN',
  cambodia: 'KH',
  myanmar: 'MM',
  laos: 'LA',
  'sri lanka': 'LK',
  bangladesh: 'BD',
  pakistan: 'PK',
  'south africa': 'ZA',
  brazil: 'BR',
  mexico: 'MX',
};

export const countryCode = (country: string | null | undefined): string => {
  if (!country) return '—';
  const c = country.trim();
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  const known = COUNTRY_CODES[c.toLowerCase()];
  if (known) return known;
  return c
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
};
