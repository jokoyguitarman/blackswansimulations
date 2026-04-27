/**
 * War Room Persistence Service
 * Inserts scenario data into Supabase via supabaseAdmin (no SQL migration execution).
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { refreshOsmVicinityForScenario } from './osmVicinityService.js';
import type { WarroomScenarioPayload } from './warroomAiService.js';
import { haversineM, circleToPolygon, pointInPolygon } from './geoUtils.js';
import type { OsmBuilding } from './osmVicinityService.js';

const VALID_INJECT_TYPES = [
  'media_report',
  'field_update',
  'citizen_call',
  'intel_brief',
  'resource_shortage',
  'weather_change',
  'political_pressure',
];

function normalizeInjectType(type: string): string {
  const t = type?.toLowerCase().replace(/\s+/g, '_') || 'field_update';
  return VALID_INJECT_TYPES.includes(t) ? t : 'field_update';
}

function normalizeInjectScope(
  scope: string | undefined,
): 'universal' | 'role_specific' | 'team_specific' {
  const s = (scope ?? 'universal').toLowerCase().replace(/\s+/g, '_');
  if (s === 'team_specific' || s === 'team') return 'team_specific';
  if (s === 'role_specific' || s === 'role') return 'role_specific';
  return 'universal';
}

export interface PersistOptions {
  center_lat?: number;
  center_lng?: number;
  vicinity_radius_meters?: number;
  osmBuildings?: OsmBuilding[];
}

/**
 * Persist War Room scenario to Supabase.
 * Insert order: scenarios → scenario_teams → scenario_injects (time) → scenario_objectives →
 * scenario_locations → update insider_knowledge → scenario_injects (decision).
 */
export async function persistWarroomScenario(
  payload: WarroomScenarioPayload,
  createdBy: string,
  options: PersistOptions = {},
): Promise<string> {
  const {
    scenario,
    teams,
    objectives,
    time_injects,
    decision_injects,
    condition_driven_injects,
    locations,
    hazards,
    floor_plans,
    casualties,
    equipment,
    insider_knowledge,
    sweep_device_pool,
  } = payload;

  const { data: scenarioRow, error: scenarioError } = await supabaseAdmin
    .from('scenarios')
    .insert({
      title: scenario.title,
      description: scenario.description,
      category: scenario.category,
      difficulty: scenario.difficulty,
      duration_minutes: scenario.duration_minutes,
      objectives: scenario.objectives,
      initial_state: scenario.initial_state,
      briefing: scenario.briefing,
      role_specific_briefs: scenario.role_specific_briefs,
      created_by: createdBy,
      is_active: true,
      center_lat: options.center_lat ?? null,
      center_lng: options.center_lng ?? null,
      vicinity_radius_meters: options.vicinity_radius_meters ?? null,
      sweep_device_pool: sweep_device_pool ?? [],
    })
    .select('id')
    .single();

  if (scenarioError || !scenarioRow) {
    logger.error({ error: scenarioError }, 'Failed to insert scenario');
    throw new Error(scenarioError?.message || 'Failed to create scenario');
  }

  const scenarioId = scenarioRow.id;

  try {
    if (teams.length > 0) {
      const { error: teamsError } = await supabaseAdmin.from('scenario_teams').insert(
        teams.map((t) => ({
          scenario_id: scenarioId,
          team_name: t.team_name,
          team_description: t.team_description,
          required_roles: [],
          min_participants: t.min_participants ?? 1,
          max_participants: t.max_participants ?? 10,
          ...(t.counter_definitions?.length ? { counter_definitions: t.counter_definitions } : {}),
          is_investigative: t.is_investigative ?? false,
        })),
      );
      if (teamsError) throw new Error(`scenario_teams: ${teamsError.message}`);
    }

    const timeUsedTitles = new Set<string>();
    // Track pursuit inject indices → DB UUIDs for debunk resolution
    const pursuitIndexToDbId = new Map<number, string>();
    const debunkInjectIds: Array<{ dbId: string; debunksIndex: number }> = [];

    for (const inj of time_injects) {
      let title = inj.title || 'Timed inject';
      if (timeUsedTitles.has(title)) {
        let suffix = 1;
        while (timeUsedTitles.has(`${title} (${suffix})`)) suffix++;
        title = `${title} (${suffix})`;
      }
      timeUsedTitles.add(title);
      const injAny = inj as Record<string, unknown>;
      const pursuitIdx = injAny._pursuit_inject_index as number | undefined;
      const debunksIdx = injAny.debunks_inject_index as number | undefined;

      const { data: insertedInj, error: injError } = await supabaseAdmin
        .from('scenario_injects')
        .insert({
          scenario_id: scenarioId,
          trigger_time_minutes: inj.trigger_time_minutes,
          trigger_condition: null,
          type: normalizeInjectType(inj.type),
          title,
          content: inj.content,
          affected_roles: [],
          severity: inj.severity || 'high',
          inject_scope: normalizeInjectScope(inj.inject_scope),
          target_teams: inj.target_teams || [],
          requires_response: inj.requires_response ?? true,
          requires_coordination: inj.requires_coordination ?? false,
          conditions_to_appear: inj.conditions_to_appear ?? null,
          conditions_to_cancel: inj.conditions_to_cancel ?? null,
          eligible_after_minutes: inj.eligible_after_minutes ?? null,
          objective_penalty: inj.objective_penalty ?? null,
          state_effect: inj.state_effect ?? null,
          response_type: (inj as Record<string, unknown>).response_type ?? 'standard',
          ai_generated: true,
          generation_source: 'war_room',
        })
        .select('id')
        .single();
      if (injError) throw new Error(`scenario_injects (time): ${injError.message}`);

      const dbId = insertedInj?.id as string;
      if (typeof pursuitIdx === 'number' && dbId) {
        pursuitIndexToDbId.set(pursuitIdx, dbId);
      }
      if (typeof debunksIdx === 'number' && dbId) {
        debunkInjectIds.push({ dbId, debunksIndex: debunksIdx });
      }
    }

    // Resolve debunk references: set debunks_sighting_inject_id in state_effect
    for (const { dbId, debunksIndex } of debunkInjectIds) {
      const targetId = pursuitIndexToDbId.get(debunksIndex);
      if (targetId) {
        await supabaseAdmin
          .from('scenario_injects')
          .update({
            state_effect: { debunks_sighting_inject_id: targetId },
          })
          .eq('id', dbId);
        logger.info(
          { debunkInjectId: dbId, targetSightingInjectId: targetId, debunksIndex },
          'Resolved debunk inject → sighting inject link',
        );
      } else {
        logger.warn(
          { dbId, debunksIndex },
          'Could not resolve debunks_inject_index — target sighting inject not found',
        );
      }
    }

    // Clear any existing sighting pins before pre-creating (prevents duplicates on re-generation)
    await supabaseAdmin
      .from('scenario_locations')
      .delete()
      .eq('scenario_id', scenarioId)
      .eq('pin_category', 'adversary_sighting');

    // Pre-create sighting pins for pursuit injects that have adversary_sighting data
    const sightingPinRows: Array<Record<string, unknown>> = [];
    let sightingOrder = 0;
    for (const inj of time_injects) {
      const injAny = inj as Record<string, unknown>;
      const pursuitIdx = injAny._pursuit_inject_index as number | undefined;
      const se = inj.state_effect as Record<string, unknown> | undefined;
      const sighting = se?.adversary_sighting as Record<string, unknown> | undefined;
      if (!sighting || typeof sighting.lat !== 'number' || typeof sighting.lng !== 'number')
        continue;

      const injectDbId =
        typeof pursuitIdx === 'number' ? pursuitIndexToDbId.get(pursuitIdx) : undefined;
      const adversaryId = (sighting.adversary_id as string) || 'adversary_1';
      const isFalseLead = sighting.is_false_lead === true;
      const intelSource = (sighting.intel_source as string) || 'unknown';
      const confidence = (sighting.confidence as string) || 'medium';
      const accuracyRadius = (sighting.accuracy_radius_m as number) || 300;
      const directionOfTravel = (sighting.direction_of_travel as string) || null;
      const zoneLabel = (sighting.zone_label as string) || intelSource.replace(/_/g, ' ');
      const triggerMin = inj.trigger_time_minutes ?? 0;

      sightingPinRows.push({
        scenario_id: scenarioId,
        location_type: 'adversary_sighting',
        pin_category: 'adversary_sighting',
        label: `Sighting #${sightingOrder + 1}: ${zoneLabel} (T+${triggerMin}min)`,
        coordinates: { lat: sighting.lat, lng: sighting.lng },
        conditions: {
          adversary_id: adversaryId,
          pin_category: 'adversary_sighting',
          sighting_status: 'hidden',
          sighting_order: sightingOrder,
          zone_label: zoneLabel,
          intel_source: intelSource,
          confidence,
          accuracy_radius_m: accuracyRadius,
          direction_of_travel: directionOfTravel,
          is_false_lead: isFalseLead,
          trigger_time_minutes: triggerMin,
          source_inject_id: injectDbId ?? null,
        },
        display_order: 900 + sightingOrder,
      });
      sightingOrder++;
    }
    if (sightingPinRows.length > 0) {
      const { error: sightingErr } = await supabaseAdmin
        .from('scenario_locations')
        .insert(sightingPinRows);
      if (sightingErr) {
        logger.warn(
          { error: sightingErr },
          'Pre-created sighting pins insert failed (non-blocking)',
        );
      } else {
        logger.info(
          { count: sightingPinRows.length, scenarioId },
          'Pre-created adversary sighting pins from pursuit injects',
        );
      }
    }

    if (objectives.length > 0) {
      const { error: objError } = await supabaseAdmin.from('scenario_objectives').insert(
        objectives.map((o) => ({
          scenario_id: scenarioId,
          objective_id:
            o.objective_id || o.objective_name.toLowerCase().replace(new RegExp('\\s+', 'g'), '_'),
          objective_name: o.objective_name,
          description: o.description,
          weight: o.weight ?? 25,
          success_criteria: o.success_criteria ?? {},
        })),
      );
      if (objError) throw new Error(`scenario_objectives: ${objError.message}`);
    }

    if (locations && locations.length > 0) {
      const { error: locError } = await supabaseAdmin.from('scenario_locations').insert(
        locations.map((loc, i) => ({
          scenario_id: scenarioId,
          location_type: loc.location_type,
          label: loc.label,
          coordinates: loc.coordinates,
          pin_category: loc.pin_category ?? null,
          visible_to_teams: loc.visible_to_teams ?? null,
          conditions: {
            ...(loc.conditions ?? {}),
            ...(loc.pin_category ? { pin_category: loc.pin_category } : {}),
            ...(loc.description ? { narrative_description: loc.description } : {}),
          },
          display_order: loc.display_order ?? i,
          ...(loc.pin_category === 'entry_exit' ? { claimable_by: ['all'] } : {}),
        })),
      );
      if (locError) throw new Error(`scenario_locations: ${locError.message}`);
    }

    if (hazards && hazards.length > 0) {
      const VALID_HAZARD_STATUSES = new Set([
        'active',
        'escalating',
        'contained',
        'resolved',
        'delayed',
      ]);

      const hazardRows = hazards.map((h) => {
        const hAny = h as Record<string, unknown>;
        const props = { ...(h.properties ?? {}) } as Record<string, unknown>;
        if (hAny.label && !props.label) props.label = hAny.label;
        return {
          scenario_id: scenarioId,
          hazard_type: h.hazard_type,
          location_lat: h.location_lat,
          location_lng: h.location_lng,
          floor_level: h.floor_level ?? 'G',
          properties: props,
          assessment_criteria: h.assessment_criteria ?? [],
          image_url: h.image_url ?? null,
          image_sequence: h.image_sequence ?? null,
          status: VALID_HAZARD_STATUSES.has(h.status ?? '') ? h.status : 'active',
          appears_at_minutes: h.appears_at_minutes ?? 0,
          resolution_requirements: h.resolution_requirements ?? {},
          personnel_requirements: h.personnel_requirements ?? {},
          equipment_requirements: h.equipment_requirements ?? [],
          deterioration_timeline: h.deterioration_timeline ?? {},
          enriched_description: h.enriched_description ?? null,
          fire_class: h.fire_class ?? null,
          debris_type: h.debris_type ?? null,
          zones: h.zones ?? [],
          spawn_condition: (h as Record<string, unknown>)._spawn_condition ?? null,
        };
      });

      const { error: hazError } = await supabaseAdmin.from('scenario_hazards').insert(hazardRows);
      if (hazError) {
        logger.warn({ error: hazError }, 'scenario_hazards insert failed (non-blocking)');
      }

      // Resolve parent_pin_id for spawn hazards (those with _parent_pin_label)
      const spawnHazards = hazards.filter((h) => (h as Record<string, unknown>)._parent_pin_label);
      if (spawnHazards.length > 0) {
        const { data: insertedHazardRows } = await supabaseAdmin
          .from('scenario_hazards')
          .select('id, hazard_type, location_lat, location_lng, properties')
          .eq('scenario_id', scenarioId);

        if (insertedHazardRows?.length) {
          const labelToId = new Map<string, string>();
          for (const row of insertedHazardRows) {
            const label =
              (row.properties as Record<string, unknown>)?.label ??
              (row as Record<string, unknown>).hazard_type;
            labelToId.set(String(label), row.id as string);
          }

          for (const original of hazards) {
            const hAny = original as Record<string, unknown>;
            if (!hAny._parent_pin_label) continue;
            const parentLabel = String(hAny._parent_pin_label);
            const parentId = labelToId.get(parentLabel);
            if (!parentId) continue;

            const childRow = insertedHazardRows.find(
              (r) =>
                Math.abs(Number(r.location_lat) - Number(original.location_lat)) < 0.00001 &&
                Math.abs(Number(r.location_lng) - Number(original.location_lng)) < 0.00001 &&
                r.hazard_type === original.hazard_type,
            );
            if (childRow) {
              await supabaseAdmin
                .from('scenario_hazards')
                .update({ parent_pin_id: parentId })
                .eq('id', childRow.id);
            }
          }
        }
      }

      // Auto-generate blast radius guide circles for explosion/bomb hazards
      const EXPLOSION_TYPES = /explosion|bomb|blast|detonat|ied|improvised_explosive/i;
      const explosionHazards = hazards.filter((h) => EXPLOSION_TYPES.test(h.hazard_type));
      if (explosionHazards.length > 0) {
        // Look up inserted hazard IDs so we can link blast zones
        const { data: insertedHazards } = await supabaseAdmin
          .from('scenario_hazards')
          .select('id, hazard_type, location_lat, location_lng')
          .eq('scenario_id', scenarioId)
          .in(
            'hazard_type',
            explosionHazards.map((h) => h.hazard_type),
          );

        const blastZoneRows: Array<Record<string, unknown>> = [];
        const BLAST_BANDS = [
          { radius_m: 15, label: 'Lethal Zone (0–49 ft)', zone_type: 'blast_lethal' },
          { radius_m: 30, label: 'Severe Injury Zone (49–98 ft)', zone_type: 'blast_severe' },
          { radius_m: 50, label: 'Fragment Zone (98–164 ft)', zone_type: 'blast_fragment' },
        ];

        for (const h of (insertedHazards ?? []) as Array<Record<string, unknown>>) {
          const lat = Number(h.location_lat);
          const lng = Number(h.location_lng);
          const hazardId = h.id as string;

          for (const band of BLAST_BANDS) {
            blastZoneRows.push({
              scenario_id: scenarioId,
              location_type: 'blast_radius',
              label: band.label,
              coordinates: { lat, lng },
              pin_category: 'blast_zone',
              conditions: {
                zone_type: band.zone_type,
                radius_m: band.radius_m,
                polygon: circleToPolygon(lat, lng, band.radius_m),
                linked_hazard_id: hazardId,
              },
            });
          }
        }

        if (blastZoneRows.length > 0) {
          const { error: bzError } = await supabaseAdmin
            .from('scenario_locations')
            .insert(blastZoneRows);
          if (bzError) {
            logger.warn({ error: bzError }, 'blast_zone locations insert failed (non-blocking)');
          } else {
            logger.info(
              { scenarioId, count: blastZoneRows.length },
              'Auto-generated blast radius guide circles for explosion hazard(s)',
            );
          }
        }
      }
    }

    if (floor_plans && floor_plans.length > 0) {
      const { error: fpError } = await supabaseAdmin.from('scenario_floor_plans').insert(
        floor_plans.map((fp) => ({
          scenario_id: scenarioId,
          floor_level: fp.floor_level,
          floor_label: fp.floor_label,
          plan_svg: fp.plan_svg ?? null,
          plan_image_url: fp.plan_image_url ?? null,
          bounds: fp.bounds ?? null,
          features: fp.features ?? [],
          environmental_factors: fp.environmental_factors ?? [],
        })),
      );
      if (fpError) {
        logger.warn({ error: fpError }, 'scenario_floor_plans insert failed (non-blocking)');
      }
    }

    if (casualties && casualties.length > 0) {
      const VALID_CASUALTY_TYPES = new Set([
        'patient',
        'crowd',
        'evacuee_group',
        'convergent_crowd',
      ]);
      const spacedCasualties = enforceMinSpacing(casualties, 12, options.osmBuildings);
      const validCasualties = spacedCasualties.filter(
        (c) => Number.isFinite(c.location_lat) && Number.isFinite(c.location_lng),
      );
      if (validCasualties.length < spacedCasualties.length) {
        logger.warn(
          { total: spacedCasualties.length, valid: validCasualties.length },
          'Filtered out casualties with non-finite coordinates before DB insert',
        );
      }
      const { error: casError } = await supabaseAdmin.from('scenario_casualties').insert(
        validCasualties.map((c) => {
          return {
            scenario_id: scenarioId,
            casualty_type: VALID_CASUALTY_TYPES.has(c.casualty_type) ? c.casualty_type : 'crowd',
            location_lat: c.location_lat,
            location_lng: c.location_lng,
            floor_level: c.floor_level ?? 'G',
            headcount: c.headcount ?? 1,
            conditions: c.conditions ?? {},
            status: c.status ?? 'undiscovered',
            appears_at_minutes: c.appears_at_minutes ?? 0,
            destination_lat: c.destination_lat ?? null,
            destination_lng: c.destination_lng ?? null,
            destination_label: c.destination_label ?? null,
            movement_speed_mpm: c.movement_speed_mpm ?? 0,
            spawn_condition: (c as Record<string, unknown>)._spawn_condition ?? null,
          };
        }),
      );
      if (casError) {
        logger.warn({ error: casError }, 'scenario_casualties insert failed (non-blocking)');
      }

      // Resolve parent_pin_id for spawn casualties (those with _parent_pin_label)
      const spawnCasualties = spacedCasualties.filter(
        (c) => (c as Record<string, unknown>)._parent_pin_label,
      );
      if (spawnCasualties.length > 0) {
        const { data: allHazardRows } = await supabaseAdmin
          .from('scenario_hazards')
          .select('id, hazard_type, properties')
          .eq('scenario_id', scenarioId);

        const { data: insertedCasRows } = await supabaseAdmin
          .from('scenario_casualties')
          .select('id, casualty_type, location_lat, location_lng')
          .eq('scenario_id', scenarioId);

        if (allHazardRows?.length && insertedCasRows?.length) {
          const hazardLabelToId = new Map<string, string>();
          for (const row of allHazardRows) {
            const label =
              (row.properties as Record<string, unknown>)?.label ??
              (row as Record<string, unknown>).hazard_type;
            hazardLabelToId.set(String(label), row.id as string);
          }

          for (const original of spawnCasualties) {
            const cAny = original as Record<string, unknown>;
            const parentLabel = String(cAny._parent_pin_label);
            const parentId = hazardLabelToId.get(parentLabel);
            if (!parentId) continue;

            const childRow = insertedCasRows.find(
              (r) =>
                Math.abs(Number(r.location_lat) - Number(original.location_lat)) < 0.00001 &&
                Math.abs(Number(r.location_lng) - Number(original.location_lng)) < 0.00001,
            );
            if (childRow) {
              await supabaseAdmin
                .from('scenario_casualties')
                .update({ parent_pin_id: parentId })
                .eq('id', childRow.id);
            }
          }
        }
      }
    }

    if (equipment && equipment.length > 0) {
      const { error: eqError } = await supabaseAdmin.from('scenario_equipment').insert(
        equipment.map((e) => ({
          scenario_id: scenarioId,
          equipment_type: e.equipment_type,
          label: e.label,
          icon: e.icon ?? null,
          properties: e.properties ?? {},
          applicable_teams: e.applicable_teams ?? [],
        })),
      );
      if (eqError) {
        logger.warn({ error: eqError }, 'scenario_equipment insert failed (non-blocking)');
      }
    }

    const knowledgeToSave = insider_knowledge || {};
    if (Object.keys(knowledgeToSave).length > 0) {
      const { error: updError } = await supabaseAdmin
        .from('scenarios')
        .update({ insider_knowledge: knowledgeToSave })
        .eq('id', scenarioId);
      if (updError) throw new Error(`insider_knowledge update: ${updError.message}`);
    }

    const usedTitles = new Set<string>(timeUsedTitles);

    if (decision_injects && decision_injects.length > 0) {
      for (const inj of decision_injects) {
        let title = inj.title || inj.trigger_condition?.slice(0, 100) || 'Decision point';
        if (usedTitles.has(title)) {
          let suffix = 1;
          while (usedTitles.has(`${title} (${suffix})`)) suffix++;
          title = `${title} (${suffix})`;
        }
        usedTitles.add(title);
        const content = inj.content || inj.trigger_condition || '';
        const { error: injError } = await supabaseAdmin.from('scenario_injects').insert({
          scenario_id: scenarioId,
          trigger_time_minutes: null,
          trigger_condition: inj.trigger_condition,
          type: normalizeInjectType(inj.type),
          title,
          content,
          affected_roles: [],
          severity: inj.severity || 'high',
          inject_scope: normalizeInjectScope(inj.inject_scope),
          target_teams: inj.target_teams || [],
          requires_response: inj.requires_response ?? true,
          requires_coordination: inj.requires_coordination ?? false,
          conditions_to_appear: inj.conditions_to_appear ?? null,
          conditions_to_cancel: inj.conditions_to_cancel ?? null,
          eligible_after_minutes: inj.eligible_after_minutes ?? null,
          objective_penalty: inj.objective_penalty ?? null,
          state_effect: inj.state_effect ?? null,
          response_type: (inj as Record<string, unknown>).response_type ?? 'standard',
          ai_generated: true,
          generation_source: 'war_room',
        });
        if (injError) throw new Error(`scenario_injects (decision): ${injError.message}`);
      }
    }

    if (condition_driven_injects && condition_driven_injects.length > 0) {
      for (const inj of condition_driven_injects) {
        let title = inj.title || 'Condition-driven inject';
        if (usedTitles.has(title)) {
          let suffix = 1;
          while (usedTitles.has(`${title} (${suffix})`)) suffix++;
          title = `${title} (${suffix})`;
        }
        usedTitles.add(title);
        const { error: injError } = await supabaseAdmin.from('scenario_injects').insert({
          scenario_id: scenarioId,
          trigger_time_minutes: null,
          trigger_condition: null,
          type: normalizeInjectType(inj.type),
          title,
          content: inj.content,
          affected_roles: [],
          severity: inj.severity || 'high',
          inject_scope: normalizeInjectScope(inj.inject_scope),
          target_teams: inj.target_teams || [],
          requires_response: inj.requires_response ?? true,
          requires_coordination: false,
          conditions_to_appear: inj.conditions_to_appear,
          conditions_to_cancel: inj.conditions_to_cancel?.length ? inj.conditions_to_cancel : null,
          eligible_after_minutes: inj.eligible_after_minutes ?? null,
          objective_penalty: inj.objective_penalty ?? null,
          state_effect: inj.state_effect ?? null,
          response_type: (inj as Record<string, unknown>).response_type ?? 'standard',
          ai_generated: true,
          generation_source: 'war_room',
        });
        if (injError) throw new Error(`scenario_injects (condition-driven): ${injError.message}`);
      }
    }

    const pursuitGates = (payload as unknown as Record<string, unknown>).pursuit_gates as
      | Array<{
          gate_id: string;
          gate_order: number;
          check_at_minutes: number;
          condition: Record<string, unknown>;
        }>
      | undefined;
    if (pursuitGates && pursuitGates.length > 0) {
      const { error: gateError } = await supabaseAdmin.from('scenario_gates').insert(
        pursuitGates.map((g) => ({
          scenario_id: scenarioId,
          gate_id: g.gate_id,
          gate_order: g.gate_order,
          check_at_minutes: g.check_at_minutes,
          condition: g.condition,
        })),
      );
      if (gateError) {
        logger.warn({ error: gateError }, 'scenario_gates (pursuit) insert failed (non-blocking)');
      }
    }

    if (
      options.center_lat != null &&
      options.center_lng != null &&
      options.vicinity_radius_meters != null
    ) {
      try {
        await refreshOsmVicinityForScenario(scenarioId);
      } catch (osmErr) {
        logger.warn(
          { err: osmErr, scenarioId },
          'OSM vicinity refresh failed during persist; scenario created without real facility data',
        );
      }
    }

    logger.info(
      {
        scenarioId,
        teams: teams.length,
        injects:
          time_injects.length +
          (decision_injects?.length ?? 0) +
          (condition_driven_injects?.length ?? 0),
      },
      'War Room scenario persisted',
    );
    return scenarioId;
  } catch (err) {
    await supabaseAdmin.from('scenarios').delete().eq('id', scenarioId);
    throw err;
  }
}

/**
 * Nudge pins that are closer than `minMeters` apart so they don't overlap.
 * Iterates each pin; if it's too close to an already-placed pin, it gets
 * shifted by a small random offset until it's spaced out (up to 8 attempts).
 *
 * Pins inside a building footprint are assumed to be stud-snapped and are
 * kept at their exact coordinates (no random nudging).
 */
function enforceMinSpacing<T extends { location_lat: number; location_lng: number }>(
  pins: T[],
  minMeters: number,
  osmBuildings?: OsmBuilding[],
): T[] {
  const placed: { lat: number; lng: number }[] = [];
  const METER_TO_DEG_LAT = 1 / 111_320;

  const isInsideBuilding = (lat: number, lng: number): boolean => {
    if (!osmBuildings?.length) return false;
    for (const b of osmBuildings) {
      if (b.footprint_polygon && b.footprint_polygon.length >= 3) {
        if (pointInPolygon(lat, lng, b.footprint_polygon)) return true;
      }
    }
    return false;
  };

  return pins.map((pin) => {
    let lat = pin.location_lat;
    let lng = pin.location_lng;

    if (!isInsideBuilding(lat, lng)) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const tooClose = placed.some((p) => haversineM(lat, lng, p.lat, p.lng) < minMeters);
        if (!tooClose) break;
        const angle = Math.random() * 2 * Math.PI;
        const dist = minMeters + Math.random() * minMeters * 0.5;
        lat = pin.location_lat + Math.cos(angle) * dist * METER_TO_DEG_LAT;
        lng =
          pin.location_lng +
          Math.sin(angle) * dist * METER_TO_DEG_LAT * (1 / Math.cos((lat * Math.PI) / 180));
      }
    }

    placed.push({ lat, lng });
    return { ...pin, location_lat: lat, location_lng: lng };
  });
}
