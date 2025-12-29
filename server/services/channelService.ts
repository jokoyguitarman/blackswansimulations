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
