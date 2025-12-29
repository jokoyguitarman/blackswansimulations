import { Server as SocketServer, type Socket } from 'socket.io';
import { type Server } from 'http';
import { env } from '../env.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userRole?: string;
  userAgency?: string;
}

export const setupWebSocket = (httpServer: Server): SocketServer => {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: env.clientUrl,
      credentials: true,
    },
  });
  // Authentication middleware for WebSocket connections
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token =
        socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];

      if (!token) {
        logger.warn({ socketId: socket.id }, 'WebSocket connection rejected: missing token');
        return next(new Error('Authentication required'));
      }

      const { data, error } = await supabaseAdmin.auth.getUser(token);

      if (error || !data?.user) {
        logger.warn(
          { socketId: socket.id, error: error?.message },
          'WebSocket connection rejected: invalid token',
        );
        return next(new Error('Invalid or expired token'));
      }

      socket.userId = data.user.id;
      socket.userRole = (data.user.app_metadata as Record<string, unknown>)?.role as
        | string
        | undefined;
      socket.userAgency = (data.user.app_metadata as Record<string, unknown>)?.agency_name as
        | string
        | undefined;

      logger.info(
        { socketId: socket.id, userId: socket.userId, role: socket.userRole },
        'WebSocket authenticated',
      );

      next();
    } catch (err) {
      logger.error({ error: err, socketId: socket.id }, 'WebSocket auth error');
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    logger.info(
      { socketId: socket.id, userId: socket.userId, role: socket.userRole },
      'WebSocket connected',
    );

    // Join session room
    socket.on('join_session', async (sessionId: string) => {
      // Verify user has access to session
      try {
        const { data: session } = await supabaseAdmin
          .from('sessions')
          .select('id, trainer_id')
          .eq('id', sessionId)
          .single();

        if (!session) {
          socket.emit('error', { message: 'Session not found' });
          return;
        }

        if (session.trainer_id !== socket.userId && socket.userRole !== 'admin') {
          const { data: participant } = await supabaseAdmin
            .from('session_participants')
            .select('*')
            .eq('session_id', sessionId)
            .eq('user_id', socket.userId)
            .single();

          if (!participant) {
            socket.emit('error', { message: 'Access denied' });
            return;
          }
        }

        socket.join(`session:${sessionId}`);
        logger.info(
          { socketId: socket.id, sessionId, userId: socket.userId },
          'Joined session room',
        );
      } catch (err) {
        logger.error({ error: err, socketId: socket.id }, 'Error joining session');
        socket.emit('error', { message: 'Failed to join session' });
      }
    });

    // Leave session room
    socket.on('leave_session', (sessionId: string) => {
      socket.leave(`session:${sessionId}`);
      logger.info({ socketId: socket.id, sessionId }, 'Left session room');
    });

    // Join channel room
    socket.on('join_channel', async (channelId: string) => {
      try {
        const { data: channel } = await supabaseAdmin
          .from('chat_channels')
          .select('session_id, type, role_filter')
          .eq('id', channelId)
          .single();

        if (!channel) {
          socket.emit('error', { message: 'Channel not found' });
          return;
        }

        // Access control based on channel type
        if (channel.type === 'role_specific' && channel.role_filter !== socket.userRole) {
          socket.emit('error', { message: 'Access denied' });
          return;
        }

        socket.join(`channel:${channelId}`);
        logger.info(
          { socketId: socket.id, channelId, userId: socket.userId },
          'Joined channel room',
        );
      } catch (err) {
        logger.error({ error: err, socketId: socket.id }, 'Error joining channel');
        socket.emit('error', { message: 'Failed to join channel' });
      }
    });

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, userId: socket.userId, reason }, 'WebSocket disconnected');
    });

    socket.on('error', (error) => {
      logger.error({ socketId: socket.id, userId: socket.userId, error }, 'WebSocket error');
    });
  });

  return io;
};
