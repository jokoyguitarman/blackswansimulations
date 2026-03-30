/**
 * Area Monitor Service
 *
 * Runs each scheduler tick to evaluate every player-claimed operational area
 * (triage tents, assembly points, staging areas, etc.) for condition-based
 * alerts: overcrowding, bad carer-to-patient ratio, missing equipment,
 * exit congestion. Generates dynamic injects when thresholds are breached.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import { getWebSocketService } from './websocketService.js';
import type { Server as SocketServer } from 'socket.io';
import {
  haversineM as haversineMeters,
  pointInGeoJSONPolygon as pointInPolygon,
} from './geoUtils.js';

const PROXIMITY_THRESHOLD_M = 80;

function extractRing(geometry: Record<string, unknown>): number[][] | null {
  if (geometry.type === 'Polygon') {
    const coords = geometry.coordinates as number[][][];
    if (coords?.[0]?.length >= 4) return coords[0];
  }
  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates as number[][];
    if (coords?.length >= 4) {
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) return coords;
    }
  }
  return null;
}

function extractCenter(geometry: Record<string, unknown>): { lat: number; lng: number } | null {
  if (geometry.type === 'Point') {
    const c = geometry.coordinates as number[];
    return { lat: c[1], lng: c[0] };
  }
  const ring = extractRing(geometry);
  if (!ring) return null;
  let latSum = 0;
  let lngSum = 0;
  for (const [lng, lat] of ring) {
    latSum += lat;
    lngSum += lng;
  }
  return { lat: latSum / ring.length, lng: lngSum / ring.length };
}

const CAPACITY_PER_M2: Record<string, number> = {
  triage_tent: 1 / 4,
  field_hospital: 1 / 8,
  decon_zone: 1 / 6,
  assembly_point: 1 / 2,
  ambulance_staging: 1 / 25,
};

const CARER_ASSET_TYPES = [
  'medic',
  'paramedic',
  'doctor',
  'nurse',
  'emt',
  'first_aider',
  'triage_officer',
  'specialist',
];

const MEDICAL_AREA_TYPES = ['triage_tent', 'field_hospital', 'decon_zone'];

interface AreaAsset {
  id: string;
  asset_type: string;
  geometry: Record<string, unknown>;
  properties: Record<string, unknown> | null;
  team_name: string;
  status: string;
  label: string | null;
}

interface CasualtyRow {
  id: string;
  casualty_type: string;
  location_lat: number;
  location_lng: number;
  headcount: number;
  conditions: Record<string, unknown>;
  status: string;
}

interface AreaAlert {
  areaId: string;
  areaLabel: string;
  areaType: string;
  alertType: 'overcrowding' | 'carer_ratio' | 'missing_equipment' | 'exit_congestion';
  severity: 'critical' | 'high' | 'medium';
  title: string;
  content: string;
  targetTeam: string;
}

/**
 * Tracks which alerts have already been fired so we don't spam every tick.
 * Key: `${sessionId}:${areaId}:${alertType}` → timestamp of last alert.
 * Alerts re-fire after a cooldown if the condition persists.
 */
const alertCooldowns = new Map<string, number>();
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between repeated alerts

function shouldFireAlert(sessionId: string, areaId: string, alertType: string): boolean {
  const key = `${sessionId}:${areaId}:${alertType}`;
  const last = alertCooldowns.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) return false;
  alertCooldowns.set(key, Date.now());
  return true;
}

/**
 * Main entry point: scan all active polygon areas in a session and check conditions.
 */
export async function runAreaMonitors(
  sessionId: string,
  scenarioId: string,
  elapsedMinutes: number,
  io: SocketServer | null,
): Promise<void> {
  try {
    // 1. Load all active placed polygon/area assets
    const { data: areas } = await supabaseAdmin
      .from('placed_assets')
      .select('id, asset_type, geometry, properties, team_name, status, label')
      .eq('session_id', sessionId)
      .eq('status', 'active');

    if (!areas?.length) return;

    const polygonAreas: Array<
      AreaAsset & { ring: number[][]; center: { lat: number; lng: number } }
    > = [];
    for (const a of areas as AreaAsset[]) {
      const ring = extractRing(a.geometry);
      if (!ring) continue;
      const center = extractCenter(a.geometry);
      if (!center) continue;
      polygonAreas.push({ ...a, ring, center });
    }

    if (!polygonAreas.length) return;

    // 2. Load all casualties in this session
    const { data: casualties } = await supabaseAdmin
      .from('scenario_casualties')
      .select('id, casualty_type, location_lat, location_lng, headcount, conditions, status')
      .or(`session_id.is.null,session_id.eq.${sessionId}`)
      .eq('scenario_id', scenarioId)
      .lte('appears_at_minutes', elapsedMinutes)
      .not('status', 'in', '("resolved","deceased","transported")');

    // 3. Load all point-type placed assets (carers, equipment near areas)
    const { data: pointAssets } = await supabaseAdmin
      .from('placed_assets')
      .select('id, asset_type, geometry, properties, team_name, status, label')
      .eq('session_id', sessionId)
      .eq('status', 'active');

    // 4. Load equipment palette for the scenario
    const { data: equipmentPalette } = await supabaseAdmin
      .from('scenario_equipment')
      .select('equipment_type, label, properties')
      .eq('scenario_id', scenarioId);

    // 5. Load per-session claimed exits for congestion checks
    const { data: exitClaims } = await supabaseAdmin
      .from('session_location_claims')
      .select('location_id, claimed_by_team, claimed_as')
      .eq('session_id', sessionId);

    let claimedExits: Array<{
      id: string;
      label: string;
      coordinates: unknown;
      conditions: unknown;
      claimed_by_team: string | null;
      claimed_as: string | null;
    }> | null = null;
    if (exitClaims?.length) {
      const claimedIds = exitClaims.map((c) => c.location_id);
      const { data: exitLocs } = await supabaseAdmin
        .from('scenario_locations')
        .select('id, label, coordinates, conditions')
        .in('id', claimedIds);
      const ecMap = new Map(exitClaims.map((c) => [c.location_id, c]));
      claimedExits = (exitLocs ?? []).map((loc) => {
        const claim = ecMap.get(loc.id);
        return {
          ...loc,
          claimed_by_team: claim?.claimed_by_team ?? null,
          claimed_as: claim?.claimed_as ?? null,
        };
      });
    }

    const alerts: AreaAlert[] = [];

    for (const area of polygonAreas) {
      const areaLabel = area.label || area.asset_type.replace(/_/g, ' ');
      const isMedical = MEDICAL_AREA_TYPES.includes(area.asset_type);

      // Count people inside the polygon
      const occupants: CasualtyRow[] = [];
      for (const cas of (casualties ?? []) as CasualtyRow[]) {
        if (pointInPolygon(cas.location_lat, cas.location_lng, area.ring)) {
          occupants.push(cas);
        }
      }
      const totalPeople = occupants.reduce((s, c) => s + c.headcount, 0);

      // Compute area capacity — prefer pre-computed capacity from enclosed point assets
      // (set by placements.ts enclosure linking), fall back to m²-based estimate.
      let capacity: number | null = null;
      for (const asset of (pointAssets ?? []) as AreaAsset[]) {
        const assetCap = (asset.properties as Record<string, unknown>)?.capacity as
          | number
          | undefined;
        if (!assetCap) continue;
        const enclosedBy = (asset.properties as Record<string, unknown>)?.enclosed_by as
          | string
          | undefined;
        if (enclosedBy === area.id) {
          capacity = Math.max(capacity ?? 0, assetCap);
        }
      }
      if (capacity == null) {
        const capacityRate = CAPACITY_PER_M2[area.asset_type] ?? 1 / 5;
        const areaM2 = (area.properties as Record<string, unknown>)?.area_m2 as number | undefined;
        capacity = areaM2 ? Math.max(1, Math.floor(areaM2 * capacityRate)) : null;
      }

      // ── Overcrowding check ──
      if (capacity && totalPeople > 0) {
        const ratio = totalPeople / capacity;
        if (ratio >= 1.0) {
          alerts.push({
            areaId: area.id,
            areaLabel,
            areaType: area.asset_type,
            alertType: 'overcrowding',
            severity: ratio >= 1.5 ? 'critical' : 'high',
            title: `${areaLabel} is overcrowded`,
            content:
              `${totalPeople} people are in ${areaLabel} which has a maximum capacity of ${capacity}. ` +
              (ratio >= 1.5
                ? 'The area is critically overwhelmed — people are being crushed, unable to receive care, and conditions are deteriorating rapidly.'
                : 'The area is at or over capacity — operations are slowing down and conditions may deteriorate.'),
            targetTeam: area.team_name,
          });
        } else if (ratio >= 0.8) {
          alerts.push({
            areaId: area.id,
            areaLabel,
            areaType: area.asset_type,
            alertType: 'overcrowding',
            severity: 'medium',
            title: `${areaLabel} approaching capacity`,
            content: `${totalPeople} of ${capacity} capacity used in ${areaLabel}. Consider expanding the area or redirecting incoming personnel/casualties.`,
            targetTeam: area.team_name,
          });
        }
      }

      // ── Carer-to-patient ratio check (medical areas only) ──
      if (isMedical && totalPeople > 0) {
        let carerCount = 0;
        for (const asset of (pointAssets ?? []) as AreaAsset[]) {
          const assetLower = asset.asset_type.toLowerCase();
          const isCarer = CARER_ASSET_TYPES.some((ct) => assetLower.includes(ct));
          if (!isCarer) continue;
          const assetCenter = extractCenter(asset.geometry);
          if (!assetCenter) continue;
          if (
            pointInPolygon(assetCenter.lat, assetCenter.lng, area.ring) ||
            haversineMeters(assetCenter.lat, assetCenter.lng, area.center.lat, area.center.lng) <
              PROXIMITY_THRESHOLD_M
          ) {
            carerCount++;
          }
        }

        const redPatients = occupants.filter(
          (c) =>
            (c.conditions.triage_color as string) === 'red' ||
            (c.conditions.triage_color as string) === 'black',
        ).length;
        const yellowPatients = occupants.filter(
          (c) => (c.conditions.triage_color as string) === 'yellow',
        ).length;

        // SOP standard: ~1 carer per 3 red/black patients, ~1 per 8 yellow
        const requiredCarers = Math.ceil(redPatients / 3) + Math.ceil(yellowPatients / 8);

        if (carerCount === 0 && totalPeople > 0) {
          alerts.push({
            areaId: area.id,
            areaLabel,
            areaType: area.asset_type,
            alertType: 'carer_ratio',
            severity: 'critical',
            title: `No medical staff at ${areaLabel}`,
            content:
              `${totalPeople} casualties are in ${areaLabel} but there are no medical personnel assigned. ` +
              `Patients are receiving no care. Deploy medics, paramedics, or first aiders immediately.`,
            targetTeam: area.team_name,
          });
        } else if (requiredCarers > 0 && carerCount < requiredCarers) {
          const deficit = requiredCarers - carerCount;
          alerts.push({
            areaId: area.id,
            areaLabel,
            areaType: area.asset_type,
            alertType: 'carer_ratio',
            severity: deficit >= 3 ? 'critical' : 'high',
            title: `Understaffed at ${areaLabel}`,
            content:
              `${carerCount} medical staff for ${totalPeople} patients (${redPatients} red, ${yellowPatients} yellow). ` +
              `Standard ratio requires approximately ${requiredCarers} carers. ${deficit} more needed.`,
            targetTeam: area.team_name,
          });
        }
      }

      // ── Missing critical equipment check ──
      if (isMedical && totalPeople > 2 && equipmentPalette?.length) {
        const nearbyEquipment = new Set<string>();
        for (const asset of (pointAssets ?? []) as AreaAsset[]) {
          const center = extractCenter(asset.geometry);
          if (!center) continue;
          if (
            pointInPolygon(center.lat, center.lng, area.ring) ||
            haversineMeters(center.lat, center.lng, area.center.lat, area.center.lng) <
              PROXIMITY_THRESHOLD_M
          ) {
            nearbyEquipment.add(asset.asset_type.toLowerCase());
            if (asset.label) nearbyEquipment.add(asset.label.toLowerCase());
          }
        }

        const criticalTypes = [
          'stretcher',
          'triage_tag',
          'tourniquet',
          'airway_kit',
          'defibrillator',
        ];
        const missing = criticalTypes.filter(
          (t) =>
            equipmentPalette.some((eq) => eq.equipment_type.toLowerCase().includes(t)) &&
            ![...nearbyEquipment].some((ne) => ne.includes(t)),
        );

        if (missing.length >= 2) {
          alerts.push({
            areaId: area.id,
            areaLabel,
            areaType: area.asset_type,
            alertType: 'missing_equipment',
            severity: missing.length >= 3 ? 'critical' : 'high',
            title: `Missing equipment at ${areaLabel}`,
            content:
              `The ${areaLabel} has ${totalPeople} patients but is missing critical equipment: ` +
              `${missing.map((m) => m.replace(/_/g, ' ')).join(', ')}. ` +
              `Request or deploy the required equipment to maintain treatment capacity.`,
            targetTeam: area.team_name,
          });
        }
      }
    }

    // ── Exit congestion check ──
    if (claimedExits?.length) {
      for (const exit of claimedExits) {
        const exitCoords = exit.coordinates as { type: string; coordinates: number[] } | null;
        if (!exitCoords?.coordinates) continue;
        const [eLng, eLat] = exitCoords.coordinates;
        const exitConds = (exit.conditions ?? {}) as Record<string, unknown>;
        const flowRate = (exitConds.capacity_flow_per_min as number) ?? 30;

        // Count people near this exit (within 50m — queuing)
        let queueCount = 0;
        for (const cas of (casualties ?? []) as CasualtyRow[]) {
          if (
            ['being_evacuated', 'identified'].includes(cas.status) &&
            haversineMeters(cas.location_lat, cas.location_lng, eLat, eLng) < 50
          ) {
            queueCount += cas.headcount;
          }
        }

        // If queue exceeds 3x flow rate, it's congested
        if (queueCount > flowRate * 3) {
          alerts.push({
            areaId: exit.id,
            areaLabel: exit.label ?? 'Exit',
            areaType: 'exit',
            alertType: 'exit_congestion',
            severity: queueCount > flowRate * 6 ? 'critical' : 'high',
            title: `Congestion at ${exit.label ?? 'exit point'}`,
            content:
              `Approximately ${queueCount} people are queued at ${exit.label ?? 'an exit'} ` +
              `which has a flow capacity of ${flowRate} per minute. ` +
              (queueCount > flowRate * 6
                ? 'Crush risk is imminent — people are being pressed against barriers.'
                : 'Backup is building — consider opening additional exits or deploying more marshals.'),
            targetTeam: exit.claimed_by_team ?? 'all',
          });
        }
      }
    }

    // 6. Fire alerts as dynamic injects
    for (const alert of alerts) {
      if (!shouldFireAlert(sessionId, alert.areaId, alert.alertType)) continue;

      try {
        const { data: inject } = await supabaseAdmin
          .from('scenario_injects')
          .insert({
            scenario_id: scenarioId,
            trigger_time_minutes: elapsedMinutes,
            title: alert.title,
            content: alert.content,
            severity: alert.severity,
            inject_scope: 'team_specific',
            target_teams: [alert.targetTeam],
            requires_response: true,
            requires_coordination: false,
            type: 'field_update',
          })
          .select('id')
          .single();

        if (inject) {
          await publishInjectToSession(inject.id, sessionId, 'system', io!);

          try {
            const ws = getWebSocketService();
            ws.injectPublished(sessionId, {
              injectId: inject.id,
              title: alert.title,
              severity: alert.severity,
              source: 'area_monitor',
            });
          } catch {
            /* ws may not be initialized in all contexts */
          }

          logger.info(
            {
              sessionId,
              areaId: alert.areaId,
              alertType: alert.alertType,
              severity: alert.severity,
            },
            `Area monitor alert: ${alert.title}`,
          );
        }
      } catch (err) {
        logger.error({ err, alert }, 'Failed to fire area monitor alert');
      }
    }
  } catch (err) {
    logger.error({ err, sessionId }, 'Area monitor service failed');
  }
}
