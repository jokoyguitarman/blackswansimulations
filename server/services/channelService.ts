import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

/**
 * Channel Service - Business logic for channel management
 * Separation of concerns: Channel-related business logic
 */

export const createDefaultChannels = async (
  sessionId: string,
  trainerId: string,
): Promise<void> => {
  const defaultChannels = [
    {
      session_id: sessionId,
      name: 'Command Channel',
      type: 'command',
      role_filter: null,
    },
    {
      session_id: sessionId,
      name: 'All Teams',
      type: 'inter_agency',
      role_filter: null,
    },
    {
      session_id: sessionId,
      name: 'Public Channel',
      type: 'public',
      role_filter: null,
    },
    {
      session_id: sessionId,
      name: 'Trainer Channel',
      type: 'trainer',
      role_filter: null,
    },
  ];

  try {
    for (const channel of defaultChannels) {
      const { error } = await supabaseAdmin.from('chat_channels').insert({
        ...channel,
        created_by: trainerId,
      });

      if (error) {
        logger.error(
          { error, sessionId, channel: channel.name },
          'Failed to create default channel',
        );
      } else {
        logger.info({ sessionId, channel: channel.name }, 'Default channel created');
      }
    }
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error creating default channels');
  }
};

/**
 * One `team` channel per distinct `session_teams.team_name` (runtime plan §2.3). Membership is
 * derived live from `session_teams`, so reassignments take effect without touching the channel.
 * Idempotent; safe to call on every channel-list request and after every team assignment.
 */
export const ensureTeamChannels = async (
  sessionId: string,
  createdBy: string | null,
): Promise<void> => {
  try {
    const [{ data: assignments }, { data: existing }] = await Promise.all([
      supabaseAdmin.from('session_teams').select('team_name').eq('session_id', sessionId),
      supabaseAdmin
        .from('chat_channels')
        .select('team_name')
        .eq('session_id', sessionId)
        .eq('type', 'team'),
    ]);

    const wanted = new Set(
      (assignments ?? [])
        .map((r) => String((r as { team_name: string }).team_name || '').trim())
        .filter(Boolean),
    );
    const have = new Set(
      (existing ?? []).map((r) => String((r as { team_name: string | null }).team_name || '')),
    );
    const missing = Array.from(wanted).filter((t) => !have.has(t));
    if (missing.length === 0) return;

    const { error } = await supabaseAdmin.from('chat_channels').insert(
      missing.map((teamName) => ({
        session_id: sessionId,
        name: teamName,
        type: 'team',
        team_name: teamName,
        members: [],
        role_filter: null,
        created_by: createdBy,
      })),
    );
    if (error) {
      // Unique index races with a concurrent call are expected; anything else is worth a log.
      if (error.code !== '23505') {
        logger.error({ error, sessionId, missing }, 'Failed to create team channels');
      }
    } else {
      logger.info({ sessionId, teams: missing }, 'Team channels created');
    }
  } catch (err) {
    logger.error({ error: err, sessionId }, 'Error ensuring team channels');
  }
};
