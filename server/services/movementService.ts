/**
 * Movement Service
 *
 * Each scheduler tick, interpolates casualty/crowd pin positions toward their
 * destination at a realistic speed. On arrival, transitions status and clears
 * the destination fields.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import { haversineM } from './geoUtils.js';

export const CROWD_WALK_MPM = 72; // ~1.2 m/s
export const STRETCHER_CARRY_MPM = 30; // ~0.5 m/s
export const AMBULATORY_PATIENT_MPM = 40;
export const AMBULANCE_MPM = 500;
const PANIC_MODIFIER = 1.5;
const ARRIVAL_THRESHOLD_M = 5;

interface MovingCasualty {
  id: string;
  location_lat: number;
  location_lng: number;
  destination_lat: number;
  destination_lng: number;
  destination_label: string | null;
  movement_speed_mpm: number;
  destination_reached_status: string | null;
  status: string;
  conditions: Record<string, unknown> | null;
  casualty_type: string;
}

/**
 * Run one movement tick for all moving casualties in a session.
 * @param tickDeltaMinutes real minutes elapsed since last tick
 */
export async function runMovementTick(
  sessionId: string,
  scenarioId: string,
  tickDeltaMinutes: number,
): Promise<void> {
  if (tickDeltaMinutes <= 0) return;

  const { data: movers } = await supabaseAdmin
    .from('scenario_casualties')
    .select(
      'id, location_lat, location_lng, destination_lat, destination_lng, destination_label, movement_speed_mpm, destination_reached_status, status, conditions, casualty_type',
    )
    .eq('scenario_id', scenarioId)
    .eq('session_id', sessionId)
    .not('destination_lat', 'is', null)
    .not('status', 'in', '("resolved","transported","deceased")');

  if (!movers?.length) return;

  const { data: sessionState } = await supabaseAdmin
    .from('sessions')
    .select('current_state, inject_state_effects')
    .eq('id', sessionId)
    .single();
  const rawState = (sessionState?.current_state as Record<string, unknown>) ?? {};
  const injEffects = (sessionState?.inject_state_effects as Record<string, unknown>) ?? {};
  const movementState = {
    ...((rawState.movement_state as Record<string, unknown>) ?? {}),
    ...((injEffects.movement_state as Record<string, unknown>) ?? {}),
  };
  const globalSpeedMod = Math.max(0.1, Number(movementState.speed_modifier) || 1);

  for (const cas of movers as MovingCasualty[]) {
    const speed = applySpeedModifiers(cas) * globalSpeedMod;
    if (speed <= 0) continue;

    const remaining = haversineM(
      cas.location_lat,
      cas.location_lng,
      cas.destination_lat,
      cas.destination_lng,
    );
    const travelDist = speed * tickDeltaMinutes;

    if (remaining <= ARRIVAL_THRESHOLD_M || travelDist >= remaining) {
      await handleArrival(sessionId, cas);
    } else {
      const fraction = travelDist / remaining;
      const newLat = cas.location_lat + (cas.destination_lat - cas.location_lat) * fraction;
      const newLng = cas.location_lng + (cas.destination_lng - cas.location_lng) * fraction;

      await supabaseAdmin
        .from('scenario_casualties')
        .update({
          location_lat: newLat,
          location_lng: newLng,
          updated_at: new Date().toISOString(),
        })
        .eq('id', cas.id);

      broadcastMove(sessionId, cas.id, newLat, newLng, cas.status);
    }
  }
}

function applySpeedModifiers(cas: MovingCasualty): number {
  let speed = cas.movement_speed_mpm;
  if (speed <= 0) return 0;

  const conds = cas.conditions ?? {};
  if (conds.behavior === 'panicking') {
    speed *= PANIC_MODIFIER;
  }
  return speed;
}

async function handleArrival(sessionId: string, cas: MovingCasualty): Promise<void> {
  const update: Record<string, unknown> = {
    location_lat: cas.destination_lat,
    location_lng: cas.destination_lng,
    destination_lat: null,
    destination_lng: null,
    destination_label: null,
    movement_speed_mpm: 0,
    destination_reached_status: null,
    updated_at: new Date().toISOString(),
  };

  if (cas.destination_reached_status) {
    update.status = cas.destination_reached_status;
  }

  // Set current_area label from destination_label so counters can track location
  if (cas.destination_label) {
    const existingConds = (cas.conditions ?? {}) as Record<string, unknown>;
    update.conditions = { ...existingConds, current_area: cas.destination_label };
  }

  await supabaseAdmin.from('scenario_casualties').update(update).eq('id', cas.id);

  const finalStatus = (cas.destination_reached_status ?? cas.status) as string;

  broadcastMove(sessionId, cas.id, cas.destination_lat, cas.destination_lng, finalStatus, true);

  logger.info(
    {
      sessionId,
      casualtyId: cas.id,
      destination: cas.destination_label,
      newStatus: finalStatus,
    },
    'Casualty arrived at destination',
  );
}

function broadcastMove(
  sessionId: string,
  casualtyId: string,
  lat: number,
  lng: number,
  status: string,
  arrived = false,
): void {
  try {
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'casualty.moved',
      data: { casualty_id: casualtyId, lat, lng, status, arrived },
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* ws not initialized */
  }
}
