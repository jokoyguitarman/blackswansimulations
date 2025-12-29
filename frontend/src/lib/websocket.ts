import { io, type Socket } from 'socket.io-client';
import { supabase } from './supabase';

/**
 * WebSocket Client - Centralized WebSocket connection management
 * Separation of concerns: All WebSocket logic in one place
 */

let socket: Socket | null = null;

export const connectWebSocket = async (): Promise<Socket> => {
  if (socket?.connected) {
    return socket;
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not authenticated');
  }

  // Use same origin for WebSocket (Vite proxy handles it)
  const wsUrl = window.location.origin.replace(':3000', ':3001');

  socket = io(wsUrl, {
    auth: {
      token: session.access_token,
    },
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    console.log('[WEBSOCKET] Connected');
  });

  socket.on('disconnect', (reason: string) => {
    console.log('[WEBSOCKET] Disconnected:', reason);
  });

  socket.on('error', (error: Error) => {
    console.error('[WEBSOCKET] Error:', error);
  });

  return socket;
};

export const disconnectWebSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

export const getSocket = (): Socket | null => {
  return socket;
};

export const joinSessionRoom = async (sessionId: string) => {
  const ws = await connectWebSocket();
  ws.emit('join_session', sessionId);
};

export const leaveSessionRoom = (sessionId: string) => {
  if (socket) {
    socket.emit('leave_session', sessionId);
  }
};

export const joinChannelRoom = async (channelId: string) => {
  const ws = await connectWebSocket();
  ws.emit('join_channel', channelId);
};

export const leaveChannelRoom = (_channelId: string) => {
  // Note: Socket.io client doesn't have a direct leave method
  // The server handles room management automatically when socket disconnects
  // This function is kept for API consistency but doesn't need implementation
};
