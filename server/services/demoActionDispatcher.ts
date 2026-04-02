import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';
import { logAndBroadcastEvent } from './eventService.js';
import { validatePlacement } from './placementValidationService.js';
import { evaluatePlacement } from './spatialScoringService.js';
import { evaluatePinResolution } from './pinResolutionService.js';
import {
  updateStateOnDecisionExecution,
  updateTeamStateFromDecision,
} from './scenarioStateService.js';
import { classifyDecision } from './aiService.js';
import { evaluateAllObjectivesForSession } from './objectiveTrackingService.js';
import { evaluateDecisionBasedTriggers } from './injectTriggerService.js';
import { updateTeamHeatMeter } from './heatMeterService.js';
import { env } from '../env.js';
import { io } from '../index.js';

/**
 * Fixed UUIDs for demo bot users (must match migration 147).
 */
export const DEMO_BOT_IDS = {
  police: 'a0000000-de00-b000-0001-000000000001',
  triage: 'a0000000-de00-b000-0001-000000000002',
  evacuation: 'a0000000-de00-b000-0001-000000000003',
  media: 'a0000000-de00-b000-0001-000000000004',
  fire: 'a0000000-de00-b000-0001-000000000005',
  intelligence: 'a0000000-de00-b000-0001-000000000006',
  negotiation: 'a0000000-de00-b000-0001-000000000007',
  security: 'a0000000-de00-b000-0001-000000000008',
  trainer: 'a0000000-de00-b000-0001-000000000099',
} as const;

const BOT_TEAM_KEYWORDS: Record<string, keyof typeof DEMO_BOT_IDS> = {
  police: 'police',
  triage: 'triage',
  medical: 'triage',
  health: 'triage',
  evacuation: 'evacuation',
  civil: 'evacuation',
  media: 'media',
  press: 'media',
  fire: 'fire',
  hazmat: 'fire',
  fire_hazmat: 'fire',
  intelligence: 'intelligence',
  intel: 'intelligence',
  negotiation: 'negotiation',
  hostage: 'negotiation',
  security: 'security',
  mall_security: 'security',
  resort_security: 'security',
  bomb_squad: 'police',
  close_protection: 'police',
  event_security: 'security',
  crowd_management: 'evacuation',
  transit_security: 'security',
  public_health: 'triage',
  operations: 'evacuation',
};

/**
 * Resolve a team name from the scenario to a bot user UUID.
 */
export function resolveBotUserId(teamName: string): string {
  const key = teamName.toLowerCase().replace(/[\s-]+/g, '_');
  for (const [keyword, botKey] of Object.entries(BOT_TEAM_KEYWORDS)) {
    if (key.includes(keyword) || keyword.includes(key)) {
      return DEMO_BOT_IDS[botKey];
    }
  }
  return DEMO_BOT_IDS.police;
}

/**
 * Resolve the participant role string expected by session_participants.
 */
export function resolveBotRole(teamName: string): string {
  const key = teamName.toLowerCase();
  if (key.includes('police') || key.includes('bomb') || key.includes('close_protection'))
    return 'police_commander';
  if (
    key.includes('triage') ||
    key.includes('medical') ||
    key.includes('health') ||
    key.includes('public_health')
  )
    return 'health_director';
  if (key.includes('media') || key.includes('press')) return 'public_information_officer';
  if (key.includes('intelligence') || key.includes('intel')) return 'intelligence_analyst';
  if (key.includes('fire') || key.includes('hazmat')) return 'defence_liaison';
  if (key.includes('negotiation') || key.includes('hostage')) return 'police_commander';
  if (
    key.includes('evacuation') ||
    key.includes('civil') ||
    key.includes('crowd') ||
    key.includes('operations')
  )
    return 'civil_government';
  if (key.includes('security')) return 'defence_liaison';
  return 'civil_government';
}

export class DemoActionDispatcher {
  /**
   * Insert a decision row, mark it executed, broadcast, and fire background processing.
   */
  async proposeAndExecuteDecision(
    sessionId: string,
    botUserId: string,
    payload: {
      title: string;
      description: string;
      decision_type?: string;
      response_to_incident_id?: string;
    },
  ): Promise<string | null> {
    try {
      const title = payload.title.trim().slice(0, 200) || payload.description.trim().slice(0, 80);

      const { data: decision, error: insertErr } = await supabaseAdmin
        .from('decisions')
        .insert({
          session_id: sessionId,
          proposed_by: botUserId,
          response_to_incident_id: payload.response_to_incident_id || null,
          title,
          description: payload.description,
          type: null,
          status: 'proposed',
        })
        .select()
        .single();

      if (insertErr || !decision) {
        logger.error({ error: insertErr, sessionId }, 'Demo: failed to create decision');
        return null;
      }

      // Immediately execute (bots auto-execute their own proposals)
      const { data: executed, error: execErr } = await supabaseAdmin
        .from('decisions')
        .update({ status: 'executed', executed_at: new Date().toISOString() })
        .eq('id', decision.id)
        .eq('status', 'proposed')
        .select('*, creator:user_profiles!decisions_proposed_by_fkey(id, full_name, role)')
        .single();

      if (execErr || !executed) {
        logger.error(
          { error: execErr, decisionId: decision.id },
          'Demo: failed to execute decision',
        );
        return decision.id;
      }

      const mapped = { ...executed, decision_type: executed.type };

      try {
        getWebSocketService().decisionProposed(sessionId, mapped);
      } catch {
        /* ok */
      }
      try {
        getWebSocketService().decisionExecuted(sessionId, mapped);
      } catch {
        /* ok */
      }

      logAndBroadcastEvent(
        io,
        sessionId,
        'decision',
        {
          decision_id: decision.id,
          title: decision.title,
          decision_type: decision.type,
          status: 'executed',
          creator: executed.creator || { id: botUserId },
        },
        botUserId,
      ).catch(() => {});

      // Fire background processing (AI classification, triggers, heat meter, etc.)
      this.processDecisionBackground(decision.id, executed, botUserId).catch((err) => {
        logger.error(
          { error: err, decisionId: decision.id },
          'Demo: background decision processing failed',
        );
      });

      logger.info({ decisionId: decision.id, botUserId }, 'Demo: decision proposed + executed');
      return decision.id;
    } catch (err) {
      logger.error(
        { error: err, sessionId },
        'Demo: unexpected error in proposeAndExecuteDecision',
      );
      return null;
    }
  }

  /**
   * Background AI processing, mirroring processExecutedDecisionInBackground.
   * Runs state update, AI classification, inject triggers, heat meter.
   */
  private async processDecisionBackground(
    decisionId: string,
    decision: Record<string, unknown>,
    botUserId: string,
  ): Promise<void> {
    const sessionId = decision.session_id as string;

    try {
      await updateStateOnDecisionExecution(sessionId, {
        id: decisionId,
        decision_type: (decision.type as string) || 'operational_action',
        title: (decision.title as string) ?? '',
        description: (decision.description as string) ?? '',
        resources_needed: decision.resources_needed as Record<string, unknown> | undefined,
        consequences: decision.consequences as Record<string, unknown> | undefined,
      });
    } catch (err) {
      logger.error({ error: err, decisionId }, 'Demo: state update error');
    }

    if (!env.openAiApiKey) return;

    let aiClassification: Awaited<ReturnType<typeof classifyDecision>> | null = null;
    try {
      aiClassification = await classifyDecision(
        { title: decision.title as string, description: decision.description as string },
        env.openAiApiKey,
      );

      await supabaseAdmin
        .from('decisions')
        .update({
          type: (aiClassification as { primary_category?: string }).primary_category,
          ai_classification: aiClassification,
        })
        .eq('id', decisionId);

      const { data: authorTeams } = await supabaseAdmin
        .from('session_teams')
        .select('team_name')
        .eq('session_id', sessionId)
        .eq('user_id', decision.proposed_by as string);
      const authorTeamNames = (authorTeams ?? []).map((r: { team_name: string }) => r.team_name);

      const { data: sessionRow } = await supabaseAdmin
        .from('sessions')
        .select('start_time, scenario_id')
        .eq('id', sessionId)
        .single();

      const startTime = (sessionRow as { start_time?: string } | null)?.start_time;
      const elapsedMinutes = startTime
        ? Math.floor((Date.now() - new Date(startTime).getTime()) / 60000)
        : 0;

      await updateTeamStateFromDecision(
        sessionId,
        decisionId,
        authorTeamNames,
        aiClassification!,
        elapsedMinutes,
        {
          decisionTitle: (decision.title as string) ?? '',
          decisionDescription: (decision.description as string) ?? '',
          scenarioId: (sessionRow as { scenario_id?: string } | null)?.scenario_id ?? undefined,
        },
      );

      if (io) {
        const triggerTeamName = authorTeamNames.length > 0 ? authorTeamNames[0] : null;
        await evaluateDecisionBasedTriggers(
          sessionId,
          {
            id: decisionId,
            title: decision.title as string,
            description: decision.description as string,
          },
          aiClassification!,
          io,
          triggerTeamName,
        );
      }
    } catch (err) {
      logger.error({ error: err, decisionId }, 'Demo: AI classification/triggers failed');
    }

    // Heat meter update
    try {
      const { data: authorTeams } = await supabaseAdmin
        .from('session_teams')
        .select('team_name')
        .eq('session_id', sessionId)
        .eq('user_id', botUserId);
      const teamName = (authorTeams ?? [])[0]?.team_name;
      if (teamName) {
        await updateTeamHeatMeter(sessionId, teamName, 'good');
      }
    } catch (err) {
      logger.error({ error: err, decisionId }, 'Demo: heat meter update failed');
    }

    // Objectives evaluation
    try {
      await evaluateAllObjectivesForSession(sessionId, env.openAiApiKey);
    } catch (err) {
      logger.error({ error: err, decisionId }, 'Demo: objective evaluation failed');
    }
  }

  /**
   * Create a placement on the map (Point, LineString, or Polygon).
   */
  async createPlacement(
    sessionId: string,
    botUserId: string,
    payload: {
      team_name: string;
      asset_type: string;
      label: string;
      geometry: { type: string; coordinates: unknown };
      properties?: Record<string, unknown>;
    },
  ): Promise<string | null> {
    try {
      const { team_name, asset_type, label, geometry, properties } = payload;

      const validation = await validatePlacement(
        sessionId,
        team_name,
        asset_type,
        geometry as Record<string, unknown>,
        properties ?? {},
      );

      if (!validation.valid) {
        logger.warn(
          { sessionId, asset_type, blocks: validation.blocks },
          'Demo: placement blocked by validation',
        );
        // For demo purposes, proceed anyway by skipping validation
      }

      const spatialScore = await evaluatePlacement(
        sessionId,
        team_name,
        asset_type,
        geometry as Record<string, unknown>,
      );

      const { data: placement, error } = await supabaseAdmin
        .from('placed_assets')
        .insert({
          session_id: sessionId,
          team_name,
          placed_by: botUserId,
          asset_type,
          label: label || asset_type.replace(/_/g, ' '),
          geometry,
          properties: properties ?? {},
          placement_score: {
            ...(validation.valid ? validation.score_modifiers : {}),
            overall: spatialScore.overall,
            dimensions: spatialScore.dimensions,
          },
        })
        .select()
        .single();

      if (error || !placement) {
        logger.error({ error, sessionId, asset_type }, 'Demo: failed to create placement');
        return null;
      }

      try {
        getWebSocketService().broadcastToSession(sessionId, {
          type: 'placement.created',
          data: { placement, warnings: validation.warnings ?? [] },
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* non-blocking */
      }

      evaluatePinResolution(sessionId).catch(() => {});

      logger.info({ placementId: placement.id, asset_type, team_name }, 'Demo: placement created');
      return placement.id;
    } catch (err) {
      logger.error({ error: err, sessionId }, 'Demo: unexpected error in createPlacement');
      return null;
    }
  }

  /**
   * Send a chat message in a channel.
   */
  async sendChatMessage(
    channelId: string,
    sessionId: string,
    botUserId: string,
    content: string,
    messageType: string = 'text',
  ): Promise<string | null> {
    try {
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('chat_messages')
        .insert({
          channel_id: channelId,
          session_id: sessionId,
          sender_id: botUserId,
          content,
          type: messageType,
        })
        .select('*')
        .single();

      if (insertErr || !inserted) {
        logger.error({ error: insertErr, channelId }, 'Demo: failed to insert message');
        return null;
      }

      const { data: fullMsg } = await supabaseAdmin
        .from('chat_messages')
        .select('*, sender:user_profiles!chat_messages_sender_id_fkey(id, full_name, role)')
        .eq('id', inserted.id)
        .single();

      const msg = fullMsg || inserted;

      try {
        getWebSocketService().messageSent(channelId, msg);
      } catch {
        /* ok */
      }

      logAndBroadcastEvent(
        io,
        sessionId,
        'message',
        {
          channel_id: channelId,
          message_id: msg.id,
          sender: msg.sender || { id: botUserId },
          content: msg.content,
        },
        botUserId,
      ).catch(() => {});

      logger.info({ messageId: msg.id, channelId }, 'Demo: chat message sent');
      return msg.id;
    } catch (err) {
      logger.error({ error: err, channelId }, 'Demo: unexpected error in sendChatMessage');
      return null;
    }
  }

  /**
   * Find the main (inter_agency or public) channel for a session that a team can post in.
   */
  async getSessionChannelId(sessionId: string): Promise<string | null> {
    const { data: channels } = await supabaseAdmin
      .from('chat_channels')
      .select('id, type, name')
      .eq('session_id', sessionId)
      .in('type', ['inter_agency', 'public', 'command'])
      .order('created_at', { ascending: true })
      .limit(1);

    return channels?.[0]?.id ?? null;
  }
}
