/**
 * Hazard Deterioration Service
 *
 * Runs every 10 minutes for active sessions. Unresolved/uncontained hazards
 * worsen over time based on their deterioration_timeline, potentially spawning
 * new hazard or casualty pins and publishing injects.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';

export async function runHazardDeterioration(sessionId: string): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, started_at')
    .eq('id', sessionId)
    .single();
  if (!session?.started_at) return;

  const elapsedMinutes = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 60000);

  const { data: hazards } = await supabaseAdmin
    .from('scenario_hazards')
    .select('*')
    .eq('scenario_id', session.scenario_id)
    .or(`session_id.is.null,session_id.eq.${sessionId}`)
    .in('status', ['active', 'escalating'])
    .lte('appears_at_minutes', elapsedMinutes);

  if (!hazards?.length) return;

  for (const hazard of hazards) {
    const timeline = (hazard.deterioration_timeline ?? {}) as Record<string, unknown>;
    if (!Object.keys(timeline).length) continue;

    const minutesSinceAppeared = elapsedMinutes - (hazard.appears_at_minutes ?? 0);
    let deteriorationStage: string | null = null;

    if (minutesSinceAppeared >= 30 && timeline.at_30min) {
      deteriorationStage = timeline.at_30min as string;
    } else if (minutesSinceAppeared >= 20 && timeline.at_20min) {
      deteriorationStage = timeline.at_20min as string;
    } else if (minutesSinceAppeared >= 10 && timeline.at_10min) {
      deteriorationStage = timeline.at_10min as string;
    }

    if (!deteriorationStage) continue;

    // Update hazard to escalating with worsened properties
    const updatedProps = {
      ...(hazard.properties as Record<string, unknown>),
      deterioration_stage: deteriorationStage,
      minutes_unaddressed: minutesSinceAppeared,
    };

    await supabaseAdmin
      .from('scenario_hazards')
      .update({
        status: 'escalating',
        properties: updatedProps,
      })
      .eq('id', hazard.id);

    // Spawn new hazards if the timeline says so
    if (timeline.spawns_new_hazards && timeline.new_hazard_description) {
      const newHazard = {
        scenario_id: session.scenario_id,
        session_id: sessionId,
        hazard_type: hazard.hazard_type,
        location_lat: (hazard.location_lat as number) + (Math.random() - 0.5) * 0.001,
        location_lng: (hazard.location_lng as number) + (Math.random() - 0.5) * 0.001,
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

      for (let i = 0; i < count; i++) {
        const newCas = {
          scenario_id: session.scenario_id,
          session_id: sessionId,
          casualty_type: 'patient',
          location_lat: (hazard.location_lat as number) + (Math.random() - 0.5) * 0.0008,
          location_lng: (hazard.location_lng as number) + (Math.random() - 0.5) * 0.0008,
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

    // Publish inject about the deterioration
    const injectBody = `${(hazard.hazard_type as string).replace(/_/g, ' ')} at ${hazard.enriched_description?.slice(0, 80) || 'incident area'} has worsened: ${deteriorationStage}`;

    await supabaseAdmin.from('scenario_injects').insert({
      scenario_id: session.scenario_id,
      title: `Hazard Escalation: ${(hazard.hazard_type as string).replace(/_/g, ' ')}`,
      body: injectBody,
      inject_type: 'deterioration',
      trigger_type: 'time_based',
      trigger_minutes: elapsedMinutes,
      target_team: null,
      generation_source: 'deterioration_cycle',
    });

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
      { hazardId: hazard.id, minutesSinceAppeared, deteriorationStage },
      'Hazard deteriorated',
    );
  }
}
