/**
 * Pursuit Response Tracker — correlates team actions with adversary sighting tips.
 *
 * Called from the inject scheduler tick loop.  For each sighting with an expired
 * response window (default 4 min), it queries decisions, placements, and chat
 * within the window period and classifies the team's response.
 *
 * Only investigative teams (is_investigative=true on scenario_teams) are tracked.
 * After each evaluation, pursuit_metrics in current_state is updated and broadcast.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { updateTeamHeatMeter } from './heatMeterService.js';
import { getWebSocketService } from './websocketService.js';

const RESPONSE_WINDOW_MS = 4 * 60 * 1000; // 4 minutes
const PROXIMITY_THRESHOLD_DEG = 300 / 111_320; // ~300 meters

export interface TeamPursuitMetrics {
  tips_received: number;
  tips_committed: number;
  tips_cautious: number;
  tips_ignored: number;
  true_leads_committed: number;
  false_leads_committed: number;
  true_leads_ignored: number;
  false_leads_avoided: number;
  accuracy_pct: number;
  avg_response_time_sec: number;
  resources_deployed: number;
  containment_actions: number;
  time_wasted_sec: number;
  intel_quality_score: number;
}

function emptyMetrics(): TeamPursuitMetrics {
  return {
    tips_received: 0,
    tips_committed: 0,
    tips_cautious: 0,
    tips_ignored: 0,
    true_leads_committed: 0,
    false_leads_committed: 0,
    true_leads_ignored: 0,
    false_leads_avoided: 0,
    accuracy_pct: 0,
    avg_response_time_sec: 0,
    resources_deployed: 0,
    containment_actions: 0,
    time_wasted_sec: 0,
    intel_quality_score: 0,
  };
}

async function recalculateMetrics(
  sessionId: string,
  teamName: string,
): Promise<TeamPursuitMetrics> {
  const { data: allRows } = await supabaseAdmin
    .from('session_pursuit_responses')
    .select('*')
    .eq('session_id', sessionId)
    .eq('team_name', teamName);

  const rows = allRows ?? [];
  const m = emptyMetrics();
  m.tips_received = rows.length;

  let totalResponseTime = 0;
  let responseTimeCount = 0;

  for (const r of rows) {
    const rt = (r as Record<string, unknown>).response_type as string;
    const si = (r as Record<string, unknown>).score_impact as string | null;
    const isFalse = (r as Record<string, unknown>).is_false_lead as boolean;
    const tw = ((r as Record<string, unknown>).time_wasted_seconds as number) || 0;
    const assets = ((r as Record<string, unknown>).assets_deployed as string[]) || [];
    const decisions = ((r as Record<string, unknown>).decisions_committed as string[]) || [];

    if (rt === 'committed' || rt === 'split') {
      m.tips_committed++;
      m.resources_deployed += assets.length;
      m.containment_actions += assets.length;
      if (isFalse) m.false_leads_committed++;
      else m.true_leads_committed++;
    } else if (rt === 'cautious') {
      m.tips_cautious++;
      if (isFalse) m.false_leads_avoided++;
    } else if (rt === 'ignored') {
      m.tips_ignored++;
      if (isFalse) m.false_leads_avoided++;
      else m.true_leads_ignored++;
    }

    m.time_wasted_sec += tw;

    // Calculate response time from window start to first action
    if (rt !== 'pending' && rt !== 'ignored' && decisions.length > 0) {
      const windowStart = new Date(
        (r as Record<string, unknown>).response_window_start as string,
      ).getTime();
      const windowEnd = new Date(
        (r as Record<string, unknown>).response_window_end as string,
      ).getTime();
      if (windowEnd > windowStart) {
        totalResponseTime += (windowEnd - windowStart) / 1000;
        responseTimeCount++;
      }
    }

    // Intel quality: bonus for correct assessments
    if (si === 'good_commit' || si === 'good_caution') {
      // Positive contribution
    }
  }

  const evaluated = rows.filter((r) => (r as Record<string, unknown>).response_type !== 'pending');
  const correct = evaluated.filter((r) => {
    const si = (r as Record<string, unknown>).score_impact as string;
    return si === 'good_commit' || si === 'good_caution' || si === 'good_recovery';
  });
  m.accuracy_pct = evaluated.length > 0 ? Math.round((correct.length / evaluated.length) * 100) : 0;
  m.avg_response_time_sec =
    responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : 0;
  m.intel_quality_score = m.accuracy_pct; // Simplified: accuracy is the quality score

  return m;
}

export async function runPursuitResponseCheck(sessionId: string): Promise<void> {
  // Load session to get scenario_id
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, current_state')
    .eq('id', sessionId)
    .single();
  if (!session) return;

  // Load investigative teams
  const { data: allTeams } = await supabaseAdmin
    .from('scenario_teams')
    .select('team_name, is_investigative')
    .eq('scenario_id', session.scenario_id);

  const investigativeTeamNames = new Set(
    (allTeams ?? [])
      .filter((t) => (t as Record<string, unknown>).is_investigative === true)
      .map((t) => (t as Record<string, unknown>).team_name as string),
  );

  const { data: pendingRows, error } = await supabaseAdmin
    .from('session_pursuit_responses')
    .select('id, sighting_pin_id, team_name, response_window_start, adversary_id, is_false_lead')
    .eq('session_id', sessionId)
    .eq('response_type', 'pending');

  if (error || !pendingRows?.length) return;

  const now = Date.now();
  const teamsUpdated = new Set<string>();

  for (const row of pendingRows) {
    const teamName = row.team_name as string;

    // Skip non-investigative teams (unless no teams are marked investigative)
    if (investigativeTeamNames.size > 0 && !investigativeTeamNames.has(teamName)) continue;

    const windowStart = new Date(row.response_window_start as string).getTime();
    if (now - windowStart < RESPONSE_WINDOW_MS) continue; // window still open

    const windowEnd = new Date(windowStart + RESPONSE_WINDOW_MS).toISOString();
    const windowStartIso = row.response_window_start as string;

    // Get sighting pin coordinates
    const { data: pin } = await supabaseAdmin
      .from('scenario_locations')
      .select('coordinates, conditions')
      .eq('id', row.sighting_pin_id)
      .single();

    if (!pin) continue;

    const pinCoords = pin.coordinates as { lat: number; lng: number };
    const zoneLabel = ((pin.conditions as Record<string, unknown>)?.zone_label as string) || '';

    // Query decisions by this team within the window
    const { data: decisions } = await supabaseAdmin
      .from('decisions')
      .select('id, description, title')
      .eq('session_id', sessionId)
      .eq('team_name', teamName)
      .gte('created_at', windowStartIso)
      .lte('created_at', windowEnd);

    // Query placements by this team within the window
    const { data: placements } = await supabaseAdmin
      .from('placed_assets')
      .select('id, geometry, label')
      .eq('session_id', sessionId)
      .eq('team_name', teamName)
      .gte('created_at', windowStartIso)
      .lte('created_at', windowEnd);

    // Check for proximity-based and text-based matches
    const pursuitKeywords = [
      'deploy',
      'send',
      'dispatch',
      'intercept',
      'pursue',
      'search',
      'cordon',
      'redirect',
      'mobilise',
      'mobilize',
      'respond',
      'investigate',
      zoneLabel.toLowerCase(),
    ].filter(Boolean);

    const matchedDecisionIds: string[] = [];
    const matchedAssetIds: string[] = [];

    for (const dec of decisions ?? []) {
      const text =
        `${(dec as Record<string, unknown>).title || ''} ${(dec as Record<string, unknown>).description || ''}`.toLowerCase();
      const hasKeyword = pursuitKeywords.some((kw) => text.includes(kw));
      if (hasKeyword) {
        matchedDecisionIds.push((dec as Record<string, unknown>).id as string);
      }
    }

    for (const asset of placements ?? []) {
      const geom = (asset as Record<string, unknown>).geometry as Record<string, unknown> | null;
      if (!geom) continue;

      let coords: Array<{ lat: number; lng: number }> = [];
      if (geom.type === 'Point') {
        const c = geom.coordinates as [number, number];
        if (c?.length === 2) coords = [{ lat: c[1], lng: c[0] }];
      } else if (geom.type === 'Polygon') {
        const ring = (geom.coordinates as [number, number][][])?.[0];
        if (ring) coords = ring.map((c) => ({ lat: c[1], lng: c[0] }));
      } else if (geom.type === 'LineString') {
        const pts = geom.coordinates as [number, number][];
        if (pts) coords = pts.map((c) => ({ lat: c[1], lng: c[0] }));
      }

      const isNear = coords.some((c) => {
        const dLat = c.lat - pinCoords.lat;
        const dLng = c.lng - pinCoords.lng;
        return Math.sqrt(dLat * dLat + dLng * dLng) <= PROXIMITY_THRESHOLD_DEG;
      });

      if (isNear) {
        matchedAssetIds.push((asset as Record<string, unknown>).id as string);
      }
    }

    // Check chat messages for intel analysis keywords
    let discussedInChat = false;
    try {
      const { data: messages } = await supabaseAdmin
        .from('team_chat_messages')
        .select('content')
        .eq('session_id', sessionId)
        .eq('team_name', teamName)
        .gte('created_at', windowStartIso)
        .lte('created_at', windowEnd);

      const chatKeywords = [
        'sighting',
        'suspect',
        'false',
        'reliable',
        'confidence',
        'source',
        'corroborate',
        'verify',
        'confirm',
        zoneLabel.toLowerCase(),
      ].filter(Boolean);
      for (const msg of messages ?? []) {
        const text = (((msg as Record<string, unknown>).content as string) || '').toLowerCase();
        if (chatKeywords.some((kw) => text.includes(kw))) {
          discussedInChat = true;
          break;
        }
      }
    } catch {
      // Chat table may not exist in all deployments
    }

    // Classify response
    const heavyCommit = matchedDecisionIds.length >= 2 || matchedAssetIds.length >= 1;
    const lightCommit = matchedDecisionIds.length === 1;

    let responseType: string;
    if (heavyCommit) {
      responseType = 'committed';
    } else if (lightCommit && matchedAssetIds.length === 0) {
      responseType = 'split';
    } else if (discussedInChat || lightCommit) {
      responseType = 'cautious';
    } else {
      responseType = 'ignored';
    }

    // Score against ground truth
    const isFalseLead = row.is_false_lead as boolean;
    let scoreImpact: string;

    if (isFalseLead) {
      scoreImpact =
        responseType === 'committed' || responseType === 'split'
          ? 'wasted_resources'
          : 'good_caution';
    } else {
      scoreImpact =
        responseType === 'committed' || responseType === 'split' ? 'good_commit' : 'missed_lead';
    }

    const timeWasted =
      isFalseLead && (responseType === 'committed' || responseType === 'split')
        ? Math.round(RESPONSE_WINDOW_MS / 1000)
        : 0;

    await supabaseAdmin
      .from('session_pursuit_responses')
      .update({
        response_window_end: windowEnd,
        response_type: responseType,
        decisions_committed: matchedDecisionIds,
        assets_deployed: matchedAssetIds,
        score_impact: scoreImpact,
        time_wasted_seconds: timeWasted,
      })
      .eq('id', row.id);

    // Apply heat penalties only to investigative teams
    if (scoreImpact === 'wasted_resources' || scoreImpact === 'missed_lead') {
      try {
        await updateTeamHeatMeter(sessionId, teamName, 'rejected');
      } catch {
        // Non-blocking
      }
    }

    teamsUpdated.add(teamName);

    logger.info(
      {
        sessionId,
        sightingPinId: row.sighting_pin_id,
        team: teamName,
        responseType,
        scoreImpact,
        matchedDecisions: matchedDecisionIds.length,
        matchedAssets: matchedAssetIds.length,
        isFalseLead,
      },
      'Pursuit response window evaluated',
    );
  }

  // Update pursuit_metrics in current_state and broadcast
  if (teamsUpdated.size > 0) {
    try {
      const currentState = (session.current_state as Record<string, unknown>) || {};
      const pursuitMetrics: Record<string, TeamPursuitMetrics> =
        (currentState.pursuit_metrics as Record<string, TeamPursuitMetrics>) || {};

      for (const teamName of teamsUpdated) {
        pursuitMetrics[teamName] = await recalculateMetrics(sessionId, teamName);
      }

      await supabaseAdmin
        .from('sessions')
        .update({
          current_state: { ...currentState, pursuit_metrics: pursuitMetrics },
        })
        .eq('id', sessionId);

      const ws = getWebSocketService();
      ws.broadcastToSession(sessionId, {
        type: 'pursuit_metrics.updated',
        data: { pursuit_metrics: pursuitMetrics },
        timestamp: new Date().toISOString(),
      });
    } catch (metricsErr) {
      logger.warn({ err: metricsErr, sessionId }, 'Failed to update pursuit metrics state');
    }
  }
}
