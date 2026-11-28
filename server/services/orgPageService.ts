import { supabaseAdmin } from '../lib/supabaseAdmin.js';

/**
 * Organisations whose page the AI runs in a session: AI-operated in the scenario, or flipped to AI at
 * start for want of players (pressureEngineService.flipUnstaffedOrgsToAi).
 */
export async function aiOperatedOrgKeys(sessionId: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from('sim_org_pages')
    .select('org_key')
    .eq('session_id', sessionId)
    .eq('role', 'protagonist')
    .eq('control_mode', 'ai');
  return new Set((data ?? []).map((r) => String((r as { org_key: string }).org_key)));
}

/** True when the session has a player-run page for the organisation. */
export async function hasPlayerRunPage(sessionId: string, orgKey: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('sim_org_pages')
    .select('org_key')
    .eq('session_id', sessionId)
    .eq('org_key', orgKey)
    .eq('role', 'protagonist')
    .neq('control_mode', 'ai')
    .limit(1);
  return (data ?? []).length > 0;
}

/** The org_key of the page a player controls in a session, or null if none. */
export async function getControlledOrgKey(
  sessionId: string,
  userId: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('session_page_controllers')
    .select('org_key')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.org_key as string) ?? null;
}

export interface OrgPageRef {
  page_name: string;
  page_handle: string;
  org_key: string;
}

/** One org's page on a platform, or null when that row does not exist. */
export async function getOrgPage(
  sessionId: string,
  orgKey: string,
  platform: string,
): Promise<OrgPageRef | null> {
  const { data } = await supabaseAdmin
    .from('sim_org_pages')
    .select('page_name, page_handle, org_key')
    .eq('session_id', sessionId)
    .eq('org_key', orgKey)
    .eq('platform', platform)
    .maybeSingle();
  if (!data?.page_handle || !data.org_key) return null;
  return {
    page_name: data.page_name ?? '',
    page_handle: data.page_handle,
    org_key: data.org_key,
  };
}

/** The org page row (for a platform) that a player controls, or null if none. */
export async function getControlledOrgPage(
  sessionId: string,
  userId: string,
  platform: string,
): Promise<OrgPageRef | null> {
  const orgKey = await getControlledOrgKey(sessionId, userId);
  if (!orgKey) return null;
  return getOrgPage(sessionId, orgKey, platform);
}

/** All user_ids who control the page that owns a given page handle in a session. */
export async function getPageControllerIdsByHandle(
  sessionId: string,
  handle: string,
): Promise<string[]> {
  const { data: page } = await supabaseAdmin
    .from('sim_org_pages')
    .select('org_key')
    .eq('session_id', sessionId)
    .eq('page_handle', handle)
    .limit(1)
    .maybeSingle();
  if (!page?.org_key) return [];

  const { data: controllers } = await supabaseAdmin
    .from('session_page_controllers')
    .select('user_id')
    .eq('session_id', sessionId)
    .eq('org_key', page.org_key as string);

  return (controllers || []).map((c) => c.user_id as string);
}
