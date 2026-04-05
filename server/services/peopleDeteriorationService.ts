/**
 * People Deterioration Service
 *
 * Runs every scheduler tick for active sessions. Untreated casualties worsen
 * (triage color escalates every ESCALATION_INTERVAL minutes), unmanaged crowds
 * escalate in behavior, and critical patients in treatment die if not
 * transported within the critical transport window.
 *
 * Escalation timeline for a fully neglected patient:
 *   green ─(10 min)─> yellow ─(10 min)─> red ─(10 min)─> black (deceased)
 *
 * Critical transport window:
 *   red patient in_treatment/endorsed_to_transport without transport ─(20 min)─> deceased
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import { placeOutsideZoneType } from './zonePlacementService.js';

const TRIAGE_ESCALATION: Record<string, string> = {
  green: 'yellow',
  yellow: 'red',
  red: 'black',
};

const BEHAVIOR_ESCALATION: Record<string, string> = {
  calm: 'anxious',
  anxious: 'panicking',
};

const DEMO_TRAINER_ID = 'a0000000-de00-b000-0001-000000000099';

/** Minutes between each triage color escalation step for untreated patients */
const ESCALATION_INTERVAL_MIN = 10;
const DEMO_ESCALATION_INTERVAL_MIN = 4;
/** Minutes a critical (red) patient can remain in treatment/endorsed_to_transport before dying */
const CRITICAL_TRANSPORT_WINDOW_MIN = 20;
const DEMO_CRITICAL_TRANSPORT_WINDOW_MIN = 8;
/** Warning issued this many minutes before the critical transport deadline */
const CRITICAL_TRANSPORT_WARNING_BEFORE_MIN = 5;
const DEMO_CRITICAL_TRANSPORT_WARNING_BEFORE_MIN = 2;

const UNTREATED_STATUSES = [
  'undiscovered',
  'identified',
  'being_moved',
  'being_evacuated',
  'awaiting_triage',
  'endorsed_to_triage',
  'at_assembly',
];

/**
 * Compute minutes since last deterioration step. Uses `last_deterioration_at`
 * stored in conditions JSONB when available; otherwise falls back to time
 * since the casualty first appeared.
 */
function minutesSinceLastDeterioration(
  conds: Record<string, unknown>,
  sessionStartMs: number,
  appearsAtMinutes: number,
): number {
  const lastDetAt = conds.last_deterioration_at as string | undefined;
  const referenceMs = lastDetAt
    ? new Date(lastDetAt).getTime()
    : sessionStartMs + appearsAtMinutes * 60000;
  return Math.floor((Date.now() - referenceMs) / 60000);
}

export async function runPeopleDeterioration(sessionId: string): Promise<void> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time, trainer_id')
    .eq('id', sessionId)
    .single();
  if (!session?.start_time) return;

  const isDemo = (session as { trainer_id?: string }).trainer_id === DEMO_TRAINER_ID;
  const escalationMin = isDemo ? DEMO_ESCALATION_INTERVAL_MIN : ESCALATION_INTERVAL_MIN;
  const transportWindowMin = isDemo
    ? DEMO_CRITICAL_TRANSPORT_WINDOW_MIN
    : CRITICAL_TRANSPORT_WINDOW_MIN;
  const transportWarningBeforeMin = isDemo
    ? DEMO_CRITICAL_TRANSPORT_WARNING_BEFORE_MIN
    : CRITICAL_TRANSPORT_WARNING_BEFORE_MIN;

  const sessionStartMs = new Date(session.start_time).getTime();
  const elapsedMinutes = Math.floor((Date.now() - sessionStartMs) / 60000);

  const { data: casualties } = await supabaseAdmin
    .from('scenario_casualties')
    .select('*')
    .eq('scenario_id', session.scenario_id)
    .eq('session_id', sessionId)
    .not('status', 'in', '("resolved","transported","deceased")')
    .lte('appears_at_minutes', elapsedMinutes);

  if (!casualties?.length) return;

  const injectsToCreate: Array<Record<string, unknown>> = [];

  for (const cas of casualties) {
    const conds = { ...(cas.conditions as Record<string, unknown>) };
    let updated = false;
    let statusChange: string | null = null;

    if (cas.casualty_type === 'patient') {
      const currentTriage = (conds.triage_color as string) ?? 'green';
      const sinceLastDet = minutesSinceLastDeterioration(
        conds,
        sessionStartMs,
        cas.appears_at_minutes ?? 0,
      );

      // --- Untreated patients: escalate triage color every escalationMin ---
      if (UNTREATED_STATUSES.includes(cas.status) && sinceLastDet >= escalationMin) {
        const newTriage = TRIAGE_ESCALATION[currentTriage];

        if (newTriage) {
          conds.triage_color = newTriage;
          conds.last_deterioration_at = new Date().toISOString();
          updated = true;

          if (newTriage === 'black') {
            statusChange = 'deceased';
            injectsToCreate.push({
              scenario_id: session.scenario_id,
              session_id: sessionId,
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
              session_id: sessionId,
              title: 'Patient Condition Worsening',
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

      // --- Endorsed-to-triage waiting warning (once only) ---
      if (
        cas.status === 'endorsed_to_triage' &&
        !statusChange &&
        sinceLastDet >= escalationMin &&
        !conds.waiting_warned
      ) {
        conds.waiting_warned = true;
        updated = true;
        injectsToCreate.push({
          scenario_id: session.scenario_id,
          session_id: sessionId,
          title: 'Patient Waiting Without Care',
          body: `A patient endorsed to triage has been waiting for treatment without care. Condition: ${currentTriage.toUpperCase()}.`,
          inject_type: 'deterioration',
          trigger_type: 'time_based',
          trigger_minutes: elapsedMinutes,
          target_team: cas.assigned_team,
          generation_source: 'deterioration_cycle',
        });
      }

      // --- Critical transport window: red patients in treatment or endorsed_to_transport ---
      if (
        ['in_treatment', 'endorsed_to_transport'].includes(cas.status) &&
        currentTriage === 'red' &&
        !statusChange
      ) {
        if (!conds.critical_clock_started_at) {
          conds.critical_clock_started_at = new Date().toISOString();
          updated = true;
        } else {
          const clockStartMs = new Date(conds.critical_clock_started_at as string).getTime();
          const minutesInCritical = Math.floor((Date.now() - clockStartMs) / 60000);

          if (minutesInCritical >= transportWindowMin) {
            conds.triage_color = 'black';
            statusChange = 'deceased';
            updated = true;

            const context =
              cas.status === 'in_treatment'
                ? 'despite receiving field treatment — required hospital intervention'
                : 'while awaiting transport — ambulance did not arrive in time';
            injectsToCreate.push({
              scenario_id: session.scenario_id,
              session_id: sessionId,
              title: 'Critical Patient Deceased — Transport Failure',
              body: `A critical (RED) patient has died ${context}. ${(conds.visible_description as string)?.slice(0, 100) || ''}`,
              inject_type: 'deterioration',
              trigger_type: 'time_based',
              trigger_minutes: elapsedMinutes,
              target_team: cas.assigned_team,
              generation_source: 'deterioration_cycle',
            });
          } else if (
            minutesInCritical >= transportWindowMin - transportWarningBeforeMin &&
            !conds.critical_transport_warned
          ) {
            conds.critical_transport_warned = true;
            updated = true;

            const remainingMin = transportWindowMin - minutesInCritical;
            injectsToCreate.push({
              scenario_id: session.scenario_id,
              session_id: sessionId,
              title: 'URGENT: Critical Patient Requires Immediate Transport',
              body: `A critical (RED) patient's condition is deteriorating rapidly. Without hospital transfer within ~${remainingMin} minutes, this patient will not survive. ${(conds.visible_description as string)?.slice(0, 100) || ''}`,
              inject_type: 'deterioration',
              trigger_type: 'time_based',
              trigger_minutes: elapsedMinutes,
              target_team: cas.assigned_team,
              generation_source: 'deterioration_cycle',
            });
          }
        }
      }
    } else if (cas.casualty_type === 'crowd') {
      const sinceLastDet = minutesSinceLastDeterioration(
        conds,
        sessionStartMs,
        cas.appears_at_minutes ?? 0,
      );

      if (
        ['identified', 'being_moved', 'being_evacuated'].includes(cas.status) &&
        sinceLastDet >= escalationMin
      ) {
        const currentBehavior = (conds.behavior as string) ?? 'calm';
        const newBehavior = BEHAVIOR_ESCALATION[currentBehavior];

        if (newBehavior) {
          conds.behavior = newBehavior;
          conds.last_deterioration_at = new Date().toISOString();
          updated = true;

          injectsToCreate.push({
            scenario_id: session.scenario_id,
            session_id: sessionId,
            title: 'Crowd Behavior Escalation',
            body: `A group of ${cas.headcount} civilians has escalated from ${currentBehavior} to ${newBehavior}. ${(conds.visible_description as string)?.slice(0, 100) || ''}`,
            inject_type: 'deterioration',
            trigger_type: 'time_based',
            trigger_minutes: elapsedMinutes,
            target_team: null,
            generation_source: 'deterioration_cycle',
          });

          if (newBehavior === 'panicking' && cas.headcount > 20) {
            const stampedeCasualties = Math.min(Math.floor(cas.headcount * 0.05), 3);
            const crowdRef = { lat: cas.location_lat, lng: cas.location_lng };
            for (let i = 0; i < stampedeCasualties; i++) {
              const coord = await placeOutsideZoneType(
                sessionId,
                'hot',
                crowdRef,
                28,
                undefined,
                session.scenario_id as string,
              );
              await supabaseAdmin.from('scenario_casualties').insert({
                scenario_id: session.scenario_id,
                session_id: sessionId,
                casualty_type: 'patient',
                location_lat: coord.lat,
                location_lng: coord.lng,
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
                session_id: sessionId,
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

  if (injectsToCreate.length > 0) {
    await supabaseAdmin.from('scenario_injects').insert(injectsToCreate);
    logger.info(
      { sessionId, injectCount: injectsToCreate.length },
      'People deterioration injects created',
    );
  }
}
