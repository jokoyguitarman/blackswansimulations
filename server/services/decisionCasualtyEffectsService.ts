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
interface CasualtyEffect {
  target_type: 'crowd' | 'patient';
  target_description: string;
  action: 'direct_to' | 'extract' | 'treat' | 'transport';
  destination_description?: string;
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
    .or(`session_id.is.null,session_id.eq.${sessionId}`)
    .not('status', 'in', '("resolved","transported","deceased")');

  const { data: locations } = await supabaseAdmin
    .from('scenario_locations')
    .select('id, label, coordinates, conditions, claimed_by_team, claimed_as')
    .eq('scenario_id', session.scenario_id);

  const { data: placedAreas } = await supabaseAdmin
    .from('placed_assets')
    .select('id, asset_type, label, geometry, properties')
    .eq('session_id', sessionId)
    .eq('status', 'active')
    .in('asset_type', [
      'operating_area',
      'assembly_point',
      'triage_tent',
      'field_hospital',
      'exit_pathway',
    ]);

  for (const effect of effects) {
    try {
      await resolveAndApply(
        sessionId,
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
- destination_description: where they are going (e.g. "Exit A", "triage area", "hospital"). Omit for "treat".

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
  effect: CasualtyEffect,
  casualties: CasualtyRow[],
  locations: LocationRow[],
  placedAreas: PlacedAreaRow[],
): Promise<void> {
  const targetCasualty = resolveTarget(effect, casualties);
  if (!targetCasualty) return;

  const destination = effect.destination_description
    ? resolveDestination(effect.destination_description, locations, placedAreas)
    : null;

  switch (effect.action) {
    case 'direct_to': {
      if (!destination) return;
      const speed =
        targetCasualty.casualty_type === 'crowd' ? CROWD_WALK_MPM : AMBULATORY_PATIENT_MPM;
      await setCasualtyMovement(sessionId, targetCasualty, {
        destination_lat: destination.lat,
        destination_lng: destination.lng,
        destination_label: destination.label,
        movement_speed_mpm: speed,
        destination_reached_status: 'being_evacuated',
        status: targetCasualty.status === 'identified' ? 'being_evacuated' : targetCasualty.status,
      });
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
        destination_reached_status: 'endorsed_to_triage',
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
      if (['endorsed_to_triage', 'identified', 'being_evacuated'].includes(targetCasualty.status)) {
        await supabaseAdmin
          .from('scenario_casualties')
          .update({ status: 'in_treatment', updated_at: new Date().toISOString() })
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

function resolveDestination(
  desc: string,
  locations: LocationRow[],
  placedAreas: PlacedAreaRow[],
): { lat: number; lng: number; label: string } | null {
  const descLower = desc.toLowerCase();

  // Try scenario_locations first
  for (const loc of locations) {
    if (!loc.coordinates?.lat || !loc.coordinates?.lng) continue;
    if (
      loc.label.toLowerCase().includes(descLower) ||
      descLower.includes(loc.label.toLowerCase())
    ) {
      return { lat: loc.coordinates.lat, lng: loc.coordinates.lng, label: loc.label };
    }
  }

  // Try placed operational areas
  for (const area of placedAreas) {
    const label = area.label ?? area.asset_type.replace(/_/g, ' ');
    if (
      label.toLowerCase().includes(descLower) ||
      descLower.includes(label.toLowerCase()) ||
      descLower.includes(area.asset_type.replace(/_/g, ' '))
    ) {
      const center = extractCenter(area.geometry);
      if (center) return { ...center, label };
    }
  }

  return null;
}

function extractCenter(geom: Record<string, unknown>): { lat: number; lng: number } | null {
  if (geom.type === 'Point') {
    const coords = geom.coordinates as number[];
    return { lat: coords[1], lng: coords[0] };
  }
  if (geom.type === 'Polygon') {
    const coords = (geom.coordinates as number[][][])[0];
    let latSum = 0,
      lngSum = 0;
    for (const c of coords) {
      latSum += c[1];
      lngSum += c[0];
    }
    return { lat: latSum / coords.length, lng: lngSum / coords.length };
  }
  return null;
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
