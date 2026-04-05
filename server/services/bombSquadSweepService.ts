import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getWebSocketService } from './websocketService.js';
import { logger } from '../lib/logger.js';

export interface SweepResult {
  found: boolean;
  message?: string;
  hazard_id?: string;
  is_live?: boolean;
  container_type?: string;
  detonation_deadline?: string | null;
  device_description?: string;
}

export async function performSweep(
  sessionId: string,
  assetId: string,
  resources?: { personnel?: number; k9?: boolean; robot?: boolean },
): Promise<SweepResult> {
  const { data: sessionRow } = await supabaseAdmin
    .from('sessions')
    .select('id, scenario_id, hidden_devices')
    .eq('id', sessionId)
    .single();
  if (!sessionRow) throw new Error('Session not found');

  const hiddenDevices = (sessionRow.hidden_devices as Array<Record<string, unknown>>) ?? [];
  const matchIdx = hiddenDevices.findIndex((d) => d.asset_id === assetId && d.discovered !== true);

  await supabaseAdmin.from('session_events').insert({
    session_id: sessionId,
    event_type: 'bomb_squad_sweep',
    description: `Bomb Squad sweep on asset ${assetId}`,
    metadata: {
      asset_id: assetId,
      resources: resources ?? {},
      found: matchIdx >= 0,
      timestamp: new Date().toISOString(),
    },
  });

  if (matchIdx < 0) {
    return { found: false, message: 'Area clear — no suspicious items found' };
  }

  const device = hiddenDevices[matchIdx];
  const updatedDevices = [...hiddenDevices];
  updatedDevices[matchIdx] = { ...device, discovered: true };
  await supabaseAdmin
    .from('sessions')
    .update({ hidden_devices: updatedDevices })
    .eq('id', sessionId);

  const profile = (device.device_profile as Record<string, unknown>) ?? {};
  const isLive = profile.is_live === true;
  const detonationDeadline = isLive ? new Date(Date.now() + 2 * 60 * 1000).toISOString() : null;

  const { data: asset } = await supabaseAdmin
    .from('placed_assets')
    .select('geometry')
    .eq('id', assetId)
    .single();
  let lat = 0;
  let lng = 0;
  if (asset) {
    const geom = (asset as Record<string, unknown>).geometry as Record<string, unknown> | undefined;
    if (geom?.type === 'Point' && Array.isArray(geom.coordinates)) {
      lng = (geom.coordinates as number[])[0];
      lat = (geom.coordinates as number[])[1];
    } else if (geom?.type === 'Polygon' && Array.isArray(geom.coordinates)) {
      const ring = (geom.coordinates as number[][][])[0] ?? [];
      if (ring.length > 0) {
        lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
        lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
      }
    }
  }

  const { data: hazard, error: hazErr } = await supabaseAdmin
    .from('scenario_hazards')
    .insert({
      scenario_id: sessionRow.scenario_id,
      session_id: sessionId,
      hazard_type: 'suspicious_package',
      location_lat: lat,
      location_lng: lng,
      floor_level: 'G',
      properties: {
        ...profile,
        discovered_via: 'sweep',
        swept_asset_id: assetId,
      },
      assessment_criteria: [
        'identify_container',
        'establish_exclusion',
        'deploy_robot',
        'xray',
        'rsp',
      ],
      status: 'active',
      appears_at_minutes: 0,
      detonation_deadline: detonationDeadline,
    })
    .select('id')
    .single();

  if (hazErr) {
    logger.error({ error: hazErr, sessionId, assetId }, 'Failed to spawn hazard from sweep');
    throw new Error('Failed to spawn device');
  }

  const ws = getWebSocketService();
  ws.broadcastToSession(sessionId, {
    type: 'secondary_device_spawned',
    data: {
      hazard_id: hazard?.id,
      lat,
      lng,
      is_live: isLive,
      container_type: profile.container_type,
      detonation_deadline: detonationDeadline,
      discovered_via: 'sweep',
    },
    timestamp: new Date().toISOString(),
  });

  const desc =
    (profile.description as string) ||
    `Suspicious ${profile.container_type ?? 'item'} found during sweep`;

  return {
    found: true,
    hazard_id: hazard?.id,
    is_live: isLive,
    container_type: profile.container_type as string | undefined,
    detonation_deadline: detonationDeadline,
    device_description: desc,
  };
}
