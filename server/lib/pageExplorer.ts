/**
 * Page profiles and page inboxes (peace spec §7.6). No Supabase.
 *
 * Display fields are what a player already sees on a page: name, handle, bio,
 * logo, followers. Role, control mode, pressure-engine columns and controller
 * ids stay with staff, and with the participant who controls that page.
 * Platforms are the `sim_org_pages.platform` check from migration 177.
 */

export const PAGE_PLATFORMS = ['facebook', 'x_twitter'] as const;

export type PagePlatform = (typeof PAGE_PLATFORMS)[number];

/** Columns copied onto a page a participant does not control. */
export const ORG_PAGE_DISPLAY_FIELDS = [
  'id',
  'platform',
  'org_key',
  'is_primary',
  'page_name',
  'page_handle',
  'page_bio',
  'page_logo_url',
  'follower_count',
  'verified',
] as const;

const GROUP_DISPLAY_FIELDS = ['org_key', 'display_name', 'is_primary'] as const;
const NESTED_PLATFORMS = ['facebook', 'x_twitter'] as const;

export type PageInboxDecision = 'allow' | 'deny';

/** Controllers of that org, and staff who may spectate the session. */
export function pageInboxDecision(input: {
  spectatingStaff: boolean;
  controlledOrgKey: string | null;
  orgKey: string;
}): PageInboxDecision {
  if (input.spectatingStaff) return 'allow';
  if (input.controlledOrgKey != null && input.controlledOrgKey === input.orgKey) return 'allow';
  return 'deny';
}

export function parsePageInboxQuery(
  orgKey: unknown,
  platform: unknown,
): { orgKey: string; platform: PagePlatform } | null {
  if (typeof orgKey !== 'string' || typeof platform !== 'string') return null;
  const key = orgKey.trim();
  const plat = platform.trim();
  if (!key || !isPagePlatform(plat)) return null;
  return { orgKey: key, platform: plat };
}

export function parsePageThreadOrgKey(orgKey: unknown): string | null {
  if (typeof orgKey !== 'string') return null;
  const key = orgKey.trim();
  return key ? key : null;
}

export function isPagePlatform(value: string): value is PagePlatform {
  return (PAGE_PLATFORMS as readonly string[]).includes(value);
}

/** Every message in the thread has this page as sender or recipient. */
export function threadBelongsToPage(
  pageHandle: string,
  messages: readonly { sender_handle?: string | null; recipient_handle?: string | null }[],
): boolean {
  if (!pageHandle || messages.length === 0) return false;
  return messages.every(
    (message) => message.sender_handle === pageHandle || message.recipient_handle === pageHandle,
  );
}

function ownFields(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function displayRow(row: object): Record<string, unknown> {
  const source = ownFields(row);
  const out: Record<string, unknown> = {};
  for (const key of ORG_PAGE_DISPLAY_FIELDS) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

/**
 * Staff receive the grouped pages unchanged. A participant keeps the full
 * record of the org they control and only display fields for every other org.
 */
export function projectSessionPages<T extends object>(
  pages: T[],
  viewer: { staff: boolean; controlledOrgKey: string | null },
): T[] | object[] {
  if (viewer.staff) return pages;
  return pages.map((page) => {
    const record = ownFields(page);
    if (typeof record.org_key === 'string' && record.org_key === viewer.controlledOrgKey) {
      return page;
    }
    const next: Record<string, unknown> = {};
    for (const key of GROUP_DISPLAY_FIELDS) {
      if (key in record) next[key] = record[key];
    }
    for (const platform of NESTED_PLATFORMS) {
      const row = record[platform];
      if (row && typeof row === 'object') next[platform] = displayRow(row);
      else next[platform] = row ?? null;
    }
    return next;
  });
}
