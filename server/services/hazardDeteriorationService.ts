/**
 * Hazard Deterioration Service
 *
 * Runs on each scheduler tick for active sessions. Unresolved/uncontained hazards
 * worsen over time based on their deterioration_timeline, potentially spawning
 * new hazard or casualty pins and publishing injects.
 *
 * Idempotency: tracks `properties.last_deterioration_level` (10/20/30) so each
 * stage fires exactly once per hazard.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import { placeInsideZoneType } from './zonePlacementService.js';

export async function runHazardDeterioration(sessionId: string): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time')
    .eq('id', sessionId)
    .single();
  if (!session?.start_time) return;

  const elapsedMinutes = Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000);

  const { data: hazards } = await supabaseAdmin
    .from('scenario_hazards')
    .select('*')
    .eq('scenario_id', session.scenario_id)
    .eq('session_id', sessionId)
    .in('status', ['active', 'escalating'])
    .lte('appears_at_minutes', elapsedMinutes);

  if (!hazards?.length) return;

  for (const hazard of hazards) {
    const timeline = (hazard.deterioration_timeline ?? {}) as Record<string, unknown>;
    if (!Object.keys(timeline).length) continue;

    const minutesSinceAppeared = elapsedMinutes - (hazard.appears_at_minutes ?? 0);

    // Determine which stage we're at (pick the highest applicable)
    let stageLevel = 0;
    let deteriorationStage: string | null = null;

    if (minutesSinceAppeared >= 30 && timeline.at_30min) {
      stageLevel = 30;
      deteriorationStage = timeline.at_30min as string;
    } else if (minutesSinceAppeared >= 20 && timeline.at_20min) {
      stageLevel = 20;
      deteriorationStage = timeline.at_20min as string;
    } else if (minutesSinceAppeared >= 10 && timeline.at_10min) {
      stageLevel = 10;
      deteriorationStage = timeline.at_10min as string;
    }

    if (!deteriorationStage || stageLevel === 0) continue;

    // Idempotency: skip if we've already processed this level
    const props = (hazard.properties ?? {}) as Record<string, unknown>;
    const lastLevel = (props.last_deterioration_level as number) ?? 0;
    if (stageLevel <= lastLevel) continue;

    const updatedProps = {
      ...props,
      deterioration_stage: deteriorationStage,
      minutes_unaddressed: minutesSinceAppeared,
      last_deterioration_level: stageLevel,
    };

    const { error: updateErr } = await supabaseAdmin
      .from('scenario_hazards')
      .update({
        status: 'escalating',
        properties: updatedProps,
      })
      .eq('id', hazard.id);

    if (updateErr) {
      logger.error(
        { error: updateErr, hazardId: hazard.id },
        'Failed to update hazard deterioration',
      );
      continue;
    }

    // Spawn new hazards if the timeline says so
    if (timeline.spawns_new_hazards && timeline.new_hazard_description) {
      const hazRef = { lat: hazard.location_lat as number, lng: hazard.location_lng as number };
      const hazCoord = await placeInsideZoneType(sessionId, 'hot', hazRef, 55);
      const newHazard = {
        scenario_id: session.scenario_id,
        session_id: sessionId,
        hazard_type: hazard.hazard_type,
        location_lat: hazCoord.lat,
        location_lng: hazCoord.lng,
        floor_level: hazard.floor_level,
        properties: {
          size: 'small',
          fuel_source: timeline.new_hazard_description,
          spawned_from: hazard.id,
        },
        assessment_criteria: [],
        status: 'active',
        appears_at_minutes: elapsedMinutes,
        enriched_description: `Spawned from deterioration: ${timeline.new_hazard_description}`,
      };

      const { data: created } = await supabaseAdmin
        .from('scenario_hazards')
        .insert(newHazard)
        .select()
        .single();

      if (created) {
        try {
          getWebSocketService().broadcastToSession(sessionId, {
            type: 'hazard.updated',
            data: { hazard_id: created.id, status: 'active', spawned: true },
            timestamp: new Date().toISOString(),
          });
        } catch {
          /* ws not initialized */
        }
      }
    }

    // Spawn new casualties if applicable
    if (timeline.spawns_casualties && (timeline.estimated_new_casualties as number) > 0) {
      const count = Math.min(timeline.estimated_new_casualties as number, 5);
      const injuryTypes = (timeline.new_casualty_injury_types as string[]) ?? ['blast_injury'];

      const casRef = { lat: hazard.location_lat as number, lng: hazard.location_lng as number };
      for (let i = 0; i < count; i++) {
        const casCoord = await placeInsideZoneType(sessionId, 'hot', casRef, 44);
        const newCas = {
          scenario_id: session.scenario_id,
          session_id: sessionId,
          casualty_type: 'patient',
          location_lat: casCoord.lat,
          location_lng: casCoord.lng,
          floor_level: hazard.floor_level,
          headcount: 1,
          conditions: {
            injuries: [
              {
                type: injuryTypes[i % injuryTypes.length],
                severity: i === 0 ? 'critical' : 'moderate',
                body_part: 'multiple',
                visible_signs: `Injured by worsening ${hazard.hazard_type}`,
              },
            ],
            triage_color: i === 0 ? 'red' : 'yellow',
            mobility: 'non_ambulatory',
            accessibility: 'open',
            consciousness: i === 0 ? 'unconscious' : 'confused',
            breathing: i === 0 ? 'labored' : 'normal',
            visible_description: `Person injured by worsening ${(hazard.hazard_type as string).replace(/_/g, ' ')} near ${hazard.enriched_description?.slice(0, 50) || hazard.hazard_type}`,
          },
          status: 'identified',
          appears_at_minutes: elapsedMinutes,
        };

        const { data: createdCas } = await supabaseAdmin
          .from('scenario_casualties')
          .insert(newCas)
          .select()
          .single();

        if (createdCas) {
          try {
            getWebSocketService().broadcastToSession(sessionId, {
              type: 'casualty.created',
              data: { casualty_id: createdCas.id },
              timestamp: new Date().toISOString(),
            });
          } catch {
            /* ws not initialized */
          }
        }
      }
    }

    // Publish inject about the deterioration (correct column names for scenario_injects table)
    const injectContent = `${(hazard.hazard_type as string).replace(/_/g, ' ')} at ${hazard.enriched_description?.slice(0, 80) || 'incident area'} has worsened: ${deteriorationStage}`;

    const { error: injectErr } = await supabaseAdmin.from('scenario_injects').insert({
      scenario_id: session.scenario_id,
      title: `Hazard Escalation: ${(hazard.hazard_type as string).replace(/_/g, ' ')}`,
      content: injectContent,
      type: 'field_update',
      trigger_time_minutes: elapsedMinutes,
      severity: 'high',
      inject_scope: 'universal',
      requires_response: true,
      ai_generated: true,
      generation_source: 'deterioration_cycle',
    });

    if (injectErr) {
      logger.error(
        { error: injectErr, hazardId: hazard.id },
        'Failed to insert deterioration inject',
      );
    }

    try {
      getWebSocketService().broadcastToSession(sessionId, {
        type: 'hazard.updated',
        data: { hazard_id: hazard.id, status: 'escalating', deterioration: deteriorationStage },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* ws not initialized */
    }

    logger.info(
      { hazardId: hazard.id, minutesSinceAppeared, stageLevel, deteriorationStage },
      'Hazard deteriorated',
    );
  }
}
