/**
 * People Deterioration Service
 *
 * Runs every 10 minutes for active sessions. Untreated casualties worsen
 * (triage color escalates), unmanaged crowds escalate in behavior, and
 * patients waiting without care are flagged.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';

const TRIAGE_ESCALATION: Record<string, string> = {
  green: 'yellow',
  yellow: 'red',
  red: 'black',
};

const BEHAVIOR_ESCALATION: Record<string, string> = {
  calm: 'anxious',
  anxious: 'panicking',
};

export async function runPeopleDeterioration(sessionId: string): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time')
    .eq('id', sessionId)
    .single();
  if (!session?.start_time) return;

  const elapsedMinutes = Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000);

  const { data: casualties } = await supabaseAdmin
    .from('scenario_casualties')
    .select('*')
    .eq('scenario_id', session.scenario_id)
    .or(`session_id.is.null,session_id.eq.${sessionId}`)
    .not('status', 'in', '("resolved","transported","deceased")')
    .lte('appears_at_minutes', elapsedMinutes);

  if (!casualties?.length) return;

  const injectsToCreate: Array<Record<string, unknown>> = [];

  for (const cas of casualties) {
    const conds = { ...(cas.conditions as Record<string, unknown>) };
    const minutesSinceAppeared = elapsedMinutes - (cas.appears_at_minutes ?? 0);
    let updated = false;
    let statusChange: string | null = null;

    if (cas.casualty_type === 'patient') {
      // Patients deteriorate every 10 minutes if not being treated
      if (['undiscovered', 'identified'].includes(cas.status) && minutesSinceAppeared >= 10) {
        const currentTriage = (conds.triage_color as string) ?? 'green';
        const newTriage = TRIAGE_ESCALATION[currentTriage];

        if (newTriage && newTriage !== currentTriage) {
          conds.triage_color = newTriage;
          updated = true;

          if (newTriage === 'black') {
            statusChange = 'deceased';
            injectsToCreate.push({
              scenario_id: session.scenario_id,
              title: 'Patient Deceased',
              body: `A patient near the incident area has died due to lack of treatment. Visible condition: ${(conds.visible_description as string)?.slice(0, 100) || 'unknown'}`,
              inject_type: 'deterioration',
              trigger_type: 'time_based',
              trigger_minutes: elapsedMinutes,
              target_team: cas.assigned_team,
              generation_source: 'deterioration_cycle',
            });
          } else {
            injectsToCreate.push({
              scenario_id: session.scenario_id,
              title: `Patient Condition Worsening`,
              body: `A patient's condition has deteriorated from ${currentTriage.toUpperCase()} to ${newTriage.toUpperCase()} triage. ${(conds.visible_description as string)?.slice(0, 100) || ''}`,
              inject_type: 'deterioration',
              trigger_type: 'time_based',
              trigger_minutes: elapsedMinutes,
              target_team: cas.assigned_team,
              generation_source: 'deterioration_cycle',
            });
          }
        }
      }

      // Patients endorsed but not in treatment for too long
      if (cas.status === 'endorsed_to_triage' && minutesSinceAppeared >= 15) {
        injectsToCreate.push({
          scenario_id: session.scenario_id,
          title: 'Patient Waiting Without Care',
          body: `A patient endorsed to triage has been waiting for treatment for ${minutesSinceAppeared} minutes without care.`,
          inject_type: 'deterioration',
          trigger_type: 'time_based',
          trigger_minutes: elapsedMinutes,
          target_team: cas.assigned_team,
          generation_source: 'deterioration_cycle',
        });
      }
    } else if (cas.casualty_type === 'crowd') {
      // Crowds escalate behavior if unmanaged
      if (['identified'].includes(cas.status) && minutesSinceAppeared >= 10) {
        const currentBehavior = (conds.behavior as string) ?? 'calm';
        const newBehavior = BEHAVIOR_ESCALATION[currentBehavior];

        if (newBehavior && newBehavior !== currentBehavior) {
          conds.behavior = newBehavior;
          updated = true;

          injectsToCreate.push({
            scenario_id: session.scenario_id,
            title: 'Crowd Behavior Escalation',
            body: `A group of ${cas.headcount} civilians has escalated from ${currentBehavior} to ${newBehavior}. ${(conds.visible_description as string)?.slice(0, 100) || ''}`,
            inject_type: 'deterioration',
            trigger_type: 'time_based',
            trigger_minutes: elapsedMinutes,
            target_team: null,
            generation_source: 'deterioration_cycle',
          });

          // Panicking crowds can cause stampede injuries
          if (newBehavior === 'panicking' && cas.headcount > 20) {
            const stampedeCasualties = Math.min(Math.floor(cas.headcount * 0.05), 3);
            for (let i = 0; i < stampedeCasualties; i++) {
              await supabaseAdmin.from('scenario_casualties').insert({
                scenario_id: session.scenario_id,
                session_id: sessionId,
                casualty_type: 'patient',
                location_lat: cas.location_lat + (Math.random() - 0.5) * 0.0005,
                location_lng: cas.location_lng + (Math.random() - 0.5) * 0.0005,
                floor_level: cas.floor_level,
                headcount: 1,
                conditions: {
                  injuries: [
                    {
                      type: 'crush_injury',
                      severity: 'moderate',
                      body_part: 'lower_body',
                      visible_signs: 'Trampled during crowd panic',
                    },
                  ],
                  triage_color: 'yellow',
                  mobility: 'non_ambulatory',
                  accessibility: 'open',
                  consciousness: 'alert',
                  breathing: 'normal',
                  visible_description: 'Person trampled during crowd stampede, unable to walk',
                },
                status: 'identified',
                appears_at_minutes: elapsedMinutes,
              });
            }

            if (stampedeCasualties > 0) {
              injectsToCreate.push({
                scenario_id: session.scenario_id,
                title: 'Stampede Injuries',
                body: `${stampedeCasualties} people have been injured in a stampede caused by panicking crowd of ${cas.headcount}.`,
                inject_type: 'deterioration',
                trigger_type: 'time_based',
                trigger_minutes: elapsedMinutes,
                target_team: null,
                generation_source: 'deterioration_cycle',
              });

              try {
                getWebSocketService().broadcastToSession(sessionId, {
                  type: 'casualty.created',
                  data: { count: stampedeCasualties, cause: 'stampede' },
                  timestamp: new Date().toISOString(),
                });
              } catch {
                /* ws not initialized */
              }
            }
          }
        }
      }
    }

    if (updated || statusChange) {
      const updatePayload: Record<string, unknown> = {
        conditions: conds,
        updated_at: new Date().toISOString(),
      };
      if (statusChange) updatePayload.status = statusChange;

      await supabaseAdmin.from('scenario_casualties').update(updatePayload).eq('id', cas.id);

      try {
        getWebSocketService().broadcastToSession(sessionId, {
          type: 'casualty.updated',
          data: {
            casualty_id: cas.id,
            status: statusChange ?? cas.status,
            triage_color: conds.triage_color,
            behavior: conds.behavior,
          },
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* ws not initialized */
      }
    }
  }

  // Batch insert all deterioration injects
  if (injectsToCreate.length > 0) {
    await supabaseAdmin.from('scenario_injects').insert(injectsToCreate);
    logger.info(
      { sessionId, injectCount: injectsToCreate.length },
      'People deterioration injects created',
    );
  }
}
