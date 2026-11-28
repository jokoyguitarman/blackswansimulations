/** Headers a staff page explorer adds on top of `getAuthHeaders`. */
export function spectatorRequestHeaders(sessionId: string): Record<string, string> {
  return {
    'X-Sim-Session': sessionId,
    'X-Sim-Spectator': '1',
  };
}

/**
 * Whether the trainer console shows the Pages explorer.
 * 404 is ENABLE_STAFF_PAGE_EXPLORER off. A 400 from the page-inbox probe
 * (missing org_key) means the route is on.
 */
export function pageExplorerVisible(status: number | null): boolean {
  return status != null && status !== 404;
}

export interface ExplorerPage {
  orgKey: string;
  displayName: string;
  platform: 'facebook' | 'x_twitter';
  pageHandle: string;
  pageName: string;
  role: string;
  controlMode: string;
}

/** Page groups from `GET /social/pages/session/:id`. Anything else is an empty list. */
export function explorerPageGroups(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== 'object' || !('data' in body)) return [];
  const data = body.data;
  if (!Array.isArray(data)) return [];
  const groups: Record<string, unknown>[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    groups.push(Object.fromEntries(Object.entries(row)));
  }
  return groups;
}

/** One row per org × platform that has a page handle. */
export function explorerPages(groups: readonly Record<string, unknown>[]): ExplorerPage[] {
  const pages: ExplorerPage[] = [];
  for (const group of groups) {
    for (const platform of ['facebook', 'x_twitter'] as const) {
      const row = group[platform];
      if (!row || typeof row !== 'object') continue;
      const page = Object.fromEntries(Object.entries(row));
      const pageHandle = typeof page.page_handle === 'string' ? page.page_handle : '';
      if (!pageHandle) continue;
      const pageName =
        typeof page.page_name === 'string'
          ? page.page_name
          : typeof group.display_name === 'string'
            ? group.display_name
            : pageHandle;
      pages.push({
        orgKey: typeof group.org_key === 'string' ? group.org_key : '',
        displayName: typeof group.display_name === 'string' ? group.display_name : pageName,
        platform,
        pageHandle,
        pageName,
        role: typeof group.role === 'string' ? group.role : '',
        controlMode: typeof group.control_mode === 'string' ? group.control_mode : '',
      });
    }
  }
  return pages;
}
