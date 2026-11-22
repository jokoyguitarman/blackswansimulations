import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { isBoothJoinToken } from '../lib/boothLink.js';
import { normalizeOrgPages } from './socialCrisisGeneratorService.js';
import { seedOrgPages } from './ambientContentService.js';
import {
  computePageCoverage,
  isPlayerRunPage,
  type CoveragePageInput,
  type PageCoverage,
} from '../../shared/sessionPageCoverage.js';

export interface SessionPageCoverage extends PageCoverage {
  /** False when the gate does not apply (not a social sim, booth world, or already started). */
  applies: boolean;
}

const NOT_APPLICABLE: SessionPageCoverage = {
  applies: false,
  covered: true,
  pages: [],
  uncovered: [],
};

export async function getSessionPageCoverage(sessionId: string): Promise<SessionPageCoverage> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('id, trainer_id, scenario_id, sim_mode, status, start_time, join_token')
    .eq('id', sessionId)
    .maybeSingle();
  // Applies until the session has actually started. A scheduled → paused detour
  // leaves start_time null, so it must still be gated. A real pause/resume
  // already has start_time and is not gated, and must not be re-seeded.
  if (!session || session.start_time) return NOT_APPLICABLE;
  if (isBoothJoinToken(session.join_token as string | null)) return NOT_APPLICABLE;

  const { data: scenario } = session.scenario_id
    ? await supabaseAdmin
        .from('scenarios')
        .select('initial_state, category')
        .eq('id', session.scenario_id)
        .maybeSingle()
    : { data: null };
  const social =
    session.sim_mode === 'social_media' || scenario?.category === 'social_media_crisis';
  if (!social) return NOT_APPLICABLE;

  const initialState = (scenario?.initial_state ?? null) as Record<string, unknown> | null;
  const scenarioOrgs = normalizeOrgPages(
    (initialState?.org_page ?? null) as Record<string, unknown> | null,
  );

  // Pages added to the scenario while the lobby is open must exist before they can be assigned.
  if (initialState && scenarioOrgs.length > 0) {
    try {
      await seedOrgPages(sessionId, initialState);
    } catch (err) {
      logger.warn({ err, sessionId }, 'page coverage: seedOrgPages failed');
    }
  }

  const [{ data: rows }, { data: controllers }, { data: participants }] = await Promise.all([
    supabaseAdmin
      .from('sim_org_pages')
      .select('org_key, page_name, is_primary, role, control_mode, operation')
      .eq('session_id', sessionId),
    supabaseAdmin
      .from('session_page_controllers')
      .select('user_id, org_key')
      .eq('session_id', sessionId),
    supabaseAdmin
      .from('session_participants')
      .select('user_id, role, user:user_profiles(full_name, is_bot)')
      .eq('session_id', sessionId),
  ]);

  const scenarioByKey = new Map(scenarioOrgs.map((o) => [o.org_key, o]));
  const rowKeys = new Set(
    ((rows ?? []) as Array<{ org_key?: string }>).map((r) => String(r.org_key ?? '')),
  );
  const missing = scenarioOrgs
    .filter((o) => isPlayerRunPage(o) && !rowKeys.has(o.org_key))
    .map((o) => o.org_key);
  if (missing.length > 0) {
    logger.warn(
      { sessionId, missing },
      'page coverage: player-run orgs have no sim_org_pages row after seeding',
    );
  }

  const pages: CoveragePageInput[] = [];
  for (const r of (rows ?? []) as CoveragePageInput[]) {
    // Rows for orgs since removed from the scenario are ignored (seedOrgPages never deletes them).
    if (scenarioOrgs.length > 0 && !scenarioByKey.has(r.org_key)) continue;
    const cfg = scenarioByKey.get(r.org_key);
    pages.push({
      ...r,
      display_name: cfg?.display_name ?? null,
      // The scenario decides who drives a page in the lobby; runtime flips only happen after start.
      role: cfg?.role ?? r.role,
      control_mode: cfg?.control_mode ?? r.control_mode,
      operation: cfg?.operation ?? r.operation,
    });
  }

  const flatParticipants = (participants ?? []).map((p) => {
    const row = p as {
      user_id: string;
      role: string | null;
      user?:
        | { full_name: string; is_bot: boolean }
        | Array<{ full_name: string; is_bot: boolean }>
        | null;
    };
    const u = Array.isArray(row.user) ? row.user[0] : row.user;
    return {
      user_id: row.user_id,
      role: row.role,
      full_name: u?.full_name ?? null,
      is_bot: u?.is_bot ?? false,
    };
  });

  const coverage = computePageCoverage({
    pages,
    controllers: (controllers ?? []) as Array<{ user_id: string; org_key: string }>,
    participants: flatParticipants,
    trainerId: session.trainer_id as string | null,
  });
  return { applies: true, ...coverage };
}
