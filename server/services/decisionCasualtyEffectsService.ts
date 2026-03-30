/**
 * Decision → Casualty Effects Bridge
 *
 * After a decision is classified, this service uses an LLM call to determine
 * whether the decision implies physical movement of casualties or crowds,
 * resolves targets and destinations to actual DB rows, and sets movement
 * fields so the movementService can interpolate positions each tick.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getWebSocketService } from './websocketService.js';
import {
  CROWD_WALK_MPM,
  STRETCHER_CARRY_MPM,
  AMBULATORY_PATIENT_MPM,
  AMBULANCE_MPM,
} from './movementService.js';
import {
  randomPointInGeoJSONPolygon,
  randomPointInPolygon,
  pointInPolygon,
  pointInGeoJSONPolygon,
  haversineM,
} from './geoUtils.js';
interface CasualtyEffect {
  target_type: 'crowd' | 'patient';
  target_description: string;
  action: 'direct_to' | 'extract' | 'treat' | 'transport';
  destination_description?: string;
  via_exit?: string;
}

interface CasualtyEffectsResult {
  casualty_effects: CasualtyEffect[];
}

/**
 * Extract casualty effects from a decision using LLM, then resolve and apply.
 */
export async function applyDecisionCasualtyEffects(
  sessionId: string,
  decisionTitle: string,
  decisionDescription: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _authorTeamName: string | null,
): Promise<void> {
  if (!env.openAiApiKey) return;

  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time')
    .eq('id', sessionId)
    .single();
  if (!session) return;

  const effects = await extractCasualtyEffects(decisionTitle, decisionDescription);
  if (!effects.length) return;

  const { data: casualties } = await supabaseAdmin
    .from('scenario_casualties')
    .select('id, casualty_type, location_lat, location_lng, conditions, status, headcount')
    .eq('scenario_id', session.scenario_id)
    .eq('session_id', sessionId)
    .not('status', 'in', '("resolved","transported","deceased")');

  const [locResult, claimResult] = await Promise.all([
    supabaseAdmin
      .from('scenario_locations')
      .select('id, label, coordinates, conditions')
      .eq('scenario_id', session.scenario_id),
    supabaseAdmin
      .from('session_location_claims')
      .select('location_id, claimed_by_team, claimed_as')
      .eq('session_id', sessionId),
  ]);
  const claimLookup = new Map((claimResult.data ?? []).map((c) => [c.location_id, c]));
  const locations = (locResult.data ?? []).map((loc) => {
    const claim = claimLookup.get(loc.id);
    return {
      ...loc,
      claimed_by_team: claim?.claimed_by_team ?? null,
      claimed_as: claim?.claimed_as ?? null,
    };
  });

  const { data: placedAreas } = await supabaseAdmin
    .from('placed_assets')
    .select('id, asset_type, label, geometry, properties')
    .eq('session_id', sessionId)
    .eq('status', 'active')
    .in('asset_type', [
      'operating_area',
      'operational_area',
      'assembly_point',
      'triage_tent',
      'field_hospital',
      'exit_pathway',
      'hazard_zone',
      'decon_zone',
    ]);

  for (const effect of effects) {
    try {
      await resolveAndApply(
        sessionId,
        session.scenario_id as string,
        effect,
        (casualties ?? []) as CasualtyRow[],
        (locations ?? []) as LocationRow[],
        (placedAreas ?? []) as PlacedAreaRow[],
      );
    } catch (err) {
      logger.warn({ err, effect }, 'Failed to apply casualty effect');
    }
  }
}

interface CasualtyRow {
  id: string;
  casualty_type: string;
  location_lat: number;
  location_lng: number;
  conditions: Record<string, unknown> | null;
  status: string;
  headcount: number;
}

interface LocationRow {
  id: string;
  label: string;
  coordinates: { lat?: number; lng?: number } | null;
  conditions: Record<string, unknown> | null;
  claimed_by_team: string | null;
  claimed_as: string | null;
}

interface PlacedAreaRow {
  id: string;
  asset_type: string;
  label: string | null;
  geometry: Record<string, unknown>;
  properties: Record<string, unknown> | null;
}

async function extractCasualtyEffects(
  title: string,
  description: string,
): Promise<CasualtyEffect[]> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: `You analyze crisis management decisions to detect if they involve physical movement of people (crowds, patients, casualties). Return a JSON object with a single key "casualty_effects" containing an array.

Each effect object has:
- target_type: "crowd" or "patient"
- target_description: brief description of who is being moved (e.g. "crowd near Building C", "trapped patient")
- action: one of "direct_to" (guide crowd), "extract" (rescue/carry patient), "treat" (begin treatment), "transport" (ambulance transport)
- destination_description: the FINAL destination (e.g. "holding area", "triage area", "assembly point", "hospital"). Omit for "treat".
- via_exit: if the decision specifies routing THROUGH a particular exit or doorway (e.g. "Exit A", "Main Gate", "South Door"), include the exit name here. Omit if no specific exit is mentioned.

If the decision does NOT involve moving people, return {"casualty_effects": []}.
Only include effects where the decision clearly implies physical movement or relocation of people.`,
          },
          {
            role: 'user',
            content: `Decision title: ${title}\nDescription: ${description}`,
          },
        ],
      }),
    });

    if (!response.ok) return [];
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content) as CasualtyEffectsResult;
    return Array.isArray(parsed.casualty_effects) ? parsed.casualty_effects : [];
  } catch (err) {
    logger.warn({ err }, 'Failed to extract casualty effects from decision');
    return [];
  }
}

async function resolveAndApply(
  sessionId: string,
  scenarioId: string,
  effect: CasualtyEffect,
  casualties: CasualtyRow[],
  locations: LocationRow[],
  placedAreas: PlacedAreaRow[],
): Promise<void> {
  const targetCasualty = resolveTarget(effect, casualties);
  if (!targetCasualty) return;

  let destination = effect.destination_description
    ? resolveDestination(effect.destination_description, locations, placedAreas, casualties)
    : null;

  // Zone-step fallback: when no explicit destination, move one zone outward
  if (!destination && effect.action !== 'treat') {
    destination = await resolveZoneStepFallback(
      sessionId,
      scenarioId,
      targetCasualty,
      placedAreas,
      casualties,
      effect.action,
    );
  }

  // Via-exit routing: resolve the exit as the first waypoint, store final destination for later
  let exitWaypoint: { lat: number; lng: number; label: string } | null = null;
  if (effect.via_exit && effect.action === 'direct_to') {
    exitWaypoint = resolveExitLocation(effect.via_exit, locations);
  }

  switch (effect.action) {
    case 'direct_to': {
      if (!exitWaypoint && !destination) return;
      const speed =
        targetCasualty.casualty_type === 'crowd' ? CROWD_WALK_MPM : AMBULATORY_PATIENT_MPM;

      if (exitWaypoint) {
        // Two-step: walk to exit first, store final destination in conditions
        const updatedConds = { ...(targetCasualty.conditions ?? {}) };
        if (destination) {
          updatedConds.final_destination = {
            lat: destination.lat,
            lng: destination.lng,
            label: destination.label,
          };
        }
        await supabaseAdmin
          .from('scenario_casualties')
          .update({ conditions: updatedConds })
          .eq('id', targetCasualty.id);

        await setCasualtyMovement(sessionId, targetCasualty, {
          destination_lat: exitWaypoint.lat,
          destination_lng: exitWaypoint.lng,
          destination_label: exitWaypoint.label,
          movement_speed_mpm: speed,
          destination_reached_status: 'at_exit',
          status:
            targetCasualty.status === 'identified' ? 'being_evacuated' : targetCasualty.status,
        });
      } else {
        // Direct: walk straight to final destination
        await setCasualtyMovement(sessionId, targetCasualty, {
          destination_lat: destination!.lat,
          destination_lng: destination!.lng,
          destination_label: destination!.label,
          movement_speed_mpm: speed,
          destination_reached_status: 'being_evacuated',
          status:
            targetCasualty.status === 'identified' ? 'being_evacuated' : targetCasualty.status,
        });
      }
      break;
    }
    case 'extract': {
      if (!destination) return;
      const conds = targetCasualty.conditions ?? {};
      const mobility = conds.mobility as string | undefined;
      const speed =
        mobility === 'trapped' || mobility === 'non_ambulatory'
          ? STRETCHER_CARRY_MPM
          : AMBULATORY_PATIENT_MPM;
      await setCasualtyMovement(sessionId, targetCasualty, {
        destination_lat: destination.lat,
        destination_lng: destination.lng,
        destination_label: destination.label,
        movement_speed_mpm: speed,
        destination_reached_status: 'awaiting_triage',
        status: targetCasualty.status === 'identified' ? 'being_evacuated' : targetCasualty.status,
      });
      break;
    }
    case 'transport': {
      if (!destination) return;
      await setCasualtyMovement(sessionId, targetCasualty, {
        destination_lat: destination.lat,
        destination_lng: destination.lng,
        destination_label: destination.label,
        movement_speed_mpm: AMBULANCE_MPM,
        destination_reached_status: 'transported',
        status: 'endorsed_to_transport',
      });
      break;
    }
    case 'treat': {
      if (
        ['awaiting_triage', 'endorsed_to_triage', 'identified', 'being_evacuated'].includes(
          targetCasualty.status,
        )
      ) {
        const treatConds = { ...(targetCasualty.conditions ?? {}) };
        const triageColor = (treatConds.triage_color as string) ?? 'green';
        if (triageColor === 'red') {
          treatConds.critical_clock_started_at = new Date().toISOString();
        }

        await supabaseAdmin
          .from('scenario_casualties')
          .update({
            status: 'in_treatment',
            conditions: treatConds,
            updated_at: new Date().toISOString(),
          })
          .eq('id', targetCasualty.id);

        try {
          getWebSocketService().broadcastToSession(sessionId, {
            type: 'casualty.updated',
            data: { casualty_id: targetCasualty.id, status: 'in_treatment' },
            timestamp: new Date().toISOString(),
          });
        } catch {
          /* ws not initialized */
        }
      }
      break;
    }
  }
}

function resolveTarget(effect: CasualtyEffect, casualties: CasualtyRow[]): CasualtyRow | null {
  const desc = effect.target_description.toLowerCase();
  const typeFilter =
    effect.target_type === 'crowd'
      ? (c: CasualtyRow) => c.casualty_type === 'crowd' || c.casualty_type === 'evacuee_group'
      : (c: CasualtyRow) => c.casualty_type === 'patient';

  const candidates = casualties.filter(typeFilter);
  if (!candidates.length) return null;

  // Try matching by visible_description or conditions
  const descMatch = candidates.find((c) => {
    const vis = ((c.conditions ?? {}).visible_description as string) ?? '';
    return vis.toLowerCase().includes(desc) || desc.includes(vis.toLowerCase());
  });
  if (descMatch) return descMatch;

  // Fallback: largest headcount for crowds, first match for patients
  if (effect.target_type === 'crowd') {
    return candidates.sort((a, b) => b.headcount - a.headcount)[0];
  }
  return candidates[0];
}

const ZONE_CLASSIFICATION_ALIASES: Record<string, string[]> = {
  hot: ['hot zone', 'danger zone', 'exclusion zone', 'inner cordon'],
  warm: ['warm zone', 'buffer zone', 'transition zone', 'decon zone', 'casualty collection'],
  cold: ['cold zone', 'safe zone', 'outer cordon', 'support zone', 'staging area'],
};

function resolveDestination(
  desc: string,
  locations: LocationRow[],
  placedAreas: PlacedAreaRow[],
  casualties: CasualtyRow[],
): { lat: number; lng: number; label: string } | null {
  const descLower = desc.toLowerCase();
  const existing = casualties.map((c) => ({ lat: c.location_lat, lng: c.location_lng }));

  // 1. Try player-drawn hazard_zone polygons first (zone_classification match)
  const matchedZoneClass = matchZoneClassification(descLower);
  if (matchedZoneClass) {
    const zoneArea = placedAreas.find(
      (a) =>
        a.asset_type === 'hazard_zone' &&
        (a.properties?.zone_classification as string) === matchedZoneClass,
    );
    if (zoneArea) {
      const pt = pickPointInArea(zoneArea.geometry, existing);
      if (pt) {
        const label = zoneArea.label ?? `${matchedZoneClass.toUpperCase()} ZONE`;
        return { ...pt, label };
      }
    }
  }

  // 2. Try placed polygon areas (triage_tent, field_hospital, assembly_point, etc.)
  for (const area of placedAreas) {
    const label = area.label ?? area.asset_type.replace(/_/g, ' ');
    if (
      label.toLowerCase().includes(descLower) ||
      descLower.includes(label.toLowerCase()) ||
      descLower.includes(area.asset_type.replace(/_/g, ' '))
    ) {
      const pt = pickPointInArea(area.geometry, existing);
      if (pt) return { ...pt, label };
    }
  }

  // 3. Try scenario_locations (pre-generated exits, POIs)
  for (const loc of locations) {
    if (!loc.coordinates?.lat || !loc.coordinates?.lng) continue;
    if (
      loc.label.toLowerCase().includes(descLower) ||
      descLower.includes(loc.label.toLowerCase())
    ) {
      return { lat: loc.coordinates.lat, lng: loc.coordinates.lng, label: loc.label };
    }
  }

  return null;
}

function matchZoneClassification(desc: string): string | null {
  for (const [classification, aliases] of Object.entries(ZONE_CLASSIFICATION_ALIASES)) {
    if (aliases.some((alias) => desc.includes(alias))) return classification;
  }
  return null;
}

function pickPointInArea(
  geom: Record<string, unknown>,
  existing: { lat: number; lng: number }[],
): { lat: number; lng: number } | null {
  if (geom.type === 'Point') {
    const coords = geom.coordinates as number[];
    return { lat: coords[1], lng: coords[0] };
  }
  if (geom.type === 'Polygon') {
    const ring = (geom.coordinates as number[][][])[0];
    return randomPointInGeoJSONPolygon(ring, existing, 15);
  }
  return null;
}

function resolveExitLocation(
  exitName: string,
  locations: LocationRow[],
): { lat: number; lng: number; label: string } | null {
  const name = exitName.toLowerCase();
  for (const loc of locations) {
    if (!loc.coordinates?.lat || !loc.coordinates?.lng) continue;
    const locLabel = loc.label.toLowerCase();
    if (locLabel.includes(name) || name.includes(locLabel)) {
      return { lat: loc.coordinates.lat, lng: loc.coordinates.lng, label: loc.label };
    }
  }
  // Fuzzy: try matching just the identifier part (e.g. "A" from "Exit A")
  const parts = name.split(/\s+/);
  const identifier = parts[parts.length - 1];
  if (identifier.length <= 3) {
    for (const loc of locations) {
      if (!loc.coordinates?.lat || !loc.coordinates?.lng) continue;
      if (
        loc.label.toLowerCase().includes(identifier) &&
        loc.label.toLowerCase().includes('exit')
      ) {
        return { lat: loc.coordinates.lat, lng: loc.coordinates.lng, label: loc.label };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zone-step fallback: move casualty one zone outward when no destination given
// ---------------------------------------------------------------------------

const ZONE_ORDER = ['hot', 'warm', 'cold'] as const;

function nextZoneOutward(current: string): string | null {
  const idx = ZONE_ORDER.indexOf(current as (typeof ZONE_ORDER)[number]);
  if (idx < 0 || idx >= ZONE_ORDER.length - 1) return null;
  return ZONE_ORDER[idx + 1];
}

interface WarRoomZone {
  zone_type: string;
  radius_m: number;
  polygon?: [number, number][];
}

function detectCurrentZone(
  lat: number,
  lng: number,
  playerZones: PlacedAreaRow[],
  warRoomZones: WarRoomZone[],
  incidentLat: number,
  incidentLng: number,
): string | null {
  // 1. Check player-drawn zones (most authoritative)
  for (const zone of playerZones) {
    if (zone.asset_type !== 'hazard_zone') continue;
    const classification = zone.properties?.zone_classification as string | undefined;
    if (!classification) continue;
    const geom = zone.geometry;
    if (geom.type === 'Polygon') {
      const ring = (geom.coordinates as number[][][])[0];
      if (pointInGeoJSONPolygon(lat, lng, ring)) return classification;
    }
  }

  // 2. Check war room ground-truth zones (sorted inner→outer)
  const sorted = [...warRoomZones].sort((a, b) => a.radius_m - b.radius_m);
  for (const z of sorted) {
    if (z.polygon?.length) {
      if (pointInPolygon(lat, lng, z.polygon)) return z.zone_type;
    } else {
      const dist = haversineM(lat, lng, incidentLat, incidentLng);
      if (dist <= z.radius_m) return z.zone_type;
    }
  }

  return null;
}

function findPlayerZoneByClassification(
  classification: string,
  playerZones: PlacedAreaRow[],
): PlacedAreaRow | null {
  return (
    playerZones.find(
      (z) =>
        z.asset_type === 'hazard_zone' &&
        (z.properties?.zone_classification as string) === classification,
    ) ?? null
  );
}

function findWarRoomZoneByType(zoneType: string, zones: WarRoomZone[]): WarRoomZone | null {
  return zones.find((z) => z.zone_type === zoneType) ?? null;
}

async function resolveZoneStepFallback(
  sessionId: string,
  scenarioId: string,
  casualty: CasualtyRow,
  placedAreas: PlacedAreaRow[],
  allCasualties: CasualtyRow[],
  action: string,
): Promise<{ lat: number; lng: number; label: string } | null> {
  const { data: hazards } = await supabaseAdmin
    .from('scenario_hazards')
    .select('location_lat, location_lng, zones')
    .eq('scenario_id', scenarioId)
    .eq('session_id', sessionId);

  if (!hazards?.length) return null;

  // Compute incident centroid from all hazards
  let cLat = 0,
    cLng = 0;
  for (const h of hazards) {
    cLat += Number(h.location_lat);
    cLng += Number(h.location_lng);
  }
  cLat /= hazards.length;
  cLng /= hazards.length;

  // Get war room unified zones (stored on the first hazard with non-empty zones)
  const warRoomZones: WarRoomZone[] =
    hazards.map((h) => (h.zones ?? []) as WarRoomZone[]).find((z) => z.length > 0) ?? [];

  const playerZones = placedAreas.filter((a) => a.asset_type === 'hazard_zone');
  const existing = allCasualties.map((c) => ({ lat: c.location_lat, lng: c.location_lng }));

  const currentZone = detectCurrentZone(
    casualty.location_lat,
    casualty.location_lng,
    placedAreas,
    warRoomZones,
    cLat,
    cLng,
  );

  // For transport with no destination, try to find nearest hospital/facility
  if (action === 'transport') {
    const { data: facilities } = await supabaseAdmin
      .from('scenario_locations')
      .select('label, coordinates')
      .eq('scenario_id', scenarioId)
      .or('label.ilike.%hospital%,label.ilike.%medical%,label.ilike.%clinic%')
      .limit(5);
    if (facilities?.length) {
      let nearest = facilities[0];
      let nearestDist = Infinity;
      for (const f of facilities) {
        const coords = f.coordinates as { lat?: number; lng?: number } | null;
        if (!coords?.lat || !coords?.lng) continue;
        const d = haversineM(casualty.location_lat, casualty.location_lng, coords.lat, coords.lng);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = f;
        }
      }
      const coords = nearest.coordinates as { lat?: number; lng?: number } | null;
      if (coords?.lat && coords?.lng) {
        return { lat: coords.lat, lng: coords.lng, label: nearest.label as string };
      }
    }
    return null;
  }

  const targetZoneType = currentZone ? nextZoneOutward(currentZone) : 'warm';

  if (!targetZoneType) {
    logger.info(
      { casualtyId: casualty.id, currentZone },
      'Casualty already in outermost zone, no further extraction needed',
    );
    return null;
  }

  // 1. Try player-drawn zone polygon for the target zone
  const playerTarget = findPlayerZoneByClassification(targetZoneType, playerZones);
  if (playerTarget?.geometry?.type === 'Polygon') {
    const ring = (playerTarget.geometry.coordinates as number[][][])[0];
    const pt = randomPointInGeoJSONPolygon(ring, existing, 15);
    return { ...pt, label: playerTarget.label ?? `${targetZoneType.toUpperCase()} ZONE` };
  }

  // 2. Try war room ground-truth zone
  const wrTarget = findWarRoomZoneByType(targetZoneType, warRoomZones);
  if (wrTarget?.polygon?.length) {
    const pt = randomPointInPolygon(wrTarget.polygon, existing, 15);
    return { ...pt, label: `${targetZoneType.toUpperCase()} ZONE (ground truth)` };
  }

  // 3. No zones at all — nudge outward from incident centroid
  const currentDist = haversineM(casualty.location_lat, casualty.location_lng, cLat, cLng);
  const nudgeDist = currentDist + 40;
  const bearing = Math.atan2(casualty.location_lng - cLng, casualty.location_lat - cLat);
  const R = 6371000;
  const latRad = (cLat * Math.PI) / 180;
  const angDist = nudgeDist / R;
  const destLat =
    (Math.asin(
      Math.sin(latRad) * Math.cos(angDist) +
        Math.cos(latRad) * Math.sin(angDist) * Math.cos(bearing),
    ) *
      180) /
    Math.PI;
  const destLng =
    cLng +
    (Math.atan2(
      Math.sin(bearing) * Math.sin(angDist) * Math.cos(latRad),
      Math.cos(angDist) - Math.sin(latRad) * Math.sin((destLat * Math.PI) / 180),
    ) *
      180) /
      Math.PI;

  logger.info(
    { casualtyId: casualty.id, nudgeDist },
    'No zones found — nudging casualty outward from incident centroid',
  );
  return { lat: destLat, lng: destLng, label: 'Extracted to safety' };
}

async function setCasualtyMovement(
  sessionId: string,
  casualty: CasualtyRow,
  fields: {
    destination_lat: number;
    destination_lng: number;
    destination_label: string;
    movement_speed_mpm: number;
    destination_reached_status: string;
    status: string;
  },
): Promise<void> {
  await supabaseAdmin
    .from('scenario_casualties')
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq('id', casualty.id);

  try {
    getWebSocketService().broadcastToSession(sessionId, {
      type: 'casualty.updated',
      data: {
        casualty_id: casualty.id,
        status: fields.status,
        destination_label: fields.destination_label,
        moving: true,
      },
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* ws not initialized */
  }

  logger.info(
    {
      sessionId,
      casualtyId: casualty.id,
      action: fields.destination_reached_status,
      destination: fields.destination_label,
      speed: fields.movement_speed_mpm,
    },
    'Casualty movement set from decision',
  );
}
