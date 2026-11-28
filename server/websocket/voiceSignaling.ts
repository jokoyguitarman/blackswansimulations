import { Server as SocketServer, type Socket } from 'socket.io';
import { findSessionParticipant } from '../lib/access.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { staffViewAsEnabled } from '../lib/viewerDecision.js';
import { allowVoiceInitiate, allowVoiceSignal, type VoiceMembership } from './voiceSpectator.js';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userRole?: string;
}

interface VoiceInitiatePayload {
  sessionId: string;
  callId: string;
  targetUserIds: string[];
}

interface VoiceAcceptPayload {
  callId: string;
  to: string;
}

interface VoiceRejectPayload {
  callId: string;
  to: string;
}

interface VoiceSDPPayload {
  callId: string;
  to: string;
  sdp: RTCSessionDescriptionInit;
}

interface VoiceICEPayload {
  callId: string;
  to: string;
  candidate: RTCIceCandidateInit;
}

interface VoiceEndPayload {
  callId: string;
}

const activeCalls = new Map<string, { sessionId: string; participants: Set<string> }>();

function memoryMembership(callId: string | undefined, userId: string): VoiceMembership {
  if (!callId) return 'unknown';
  const call = activeCalls.get(callId);
  if (!call) return 'unknown';
  return call.participants.has(userId) ? 'member' : 'outsider';
}

async function isStoredCallParticipant(callId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('voice_calls')
    .select('participants')
    .eq('id', callId)
    .maybeSingle();
  if (error || !data) return false;
  const list = (data as { participants?: unknown }).participants;
  return Array.isArray(list) && list.includes(userId);
}

/**
 * Flag off runs the handler on this turn, with no participant query.
 * Flag on ignores the event unless the socket user is in the session (initiate)
 * or in the call (every other voice event).
 */
function voiceGate<T>(
  userId: string,
  kind: 'initiate' | 'signal',
  ids: (payload: T) => { sessionId?: string; callId?: string },
  handle: (payload: T) => void | Promise<void>,
): (payload: T) => void {
  return (payload) => {
    if (!staffViewAsEnabled()) {
      void handle(payload);
      return;
    }
    const { sessionId, callId } = ids(payload);
    void (async () => {
      let allowed = false;
      try {
        if (kind === 'initiate') {
          const playing = sessionId ? await findSessionParticipant(sessionId, userId) : 'no';
          allowed = allowVoiceInitiate(true, playing === 'yes');
        } else {
          const membership = memoryMembership(callId, userId);
          const dbMember =
            membership === 'unknown' && callId
              ? await isStoredCallParticipant(callId, userId)
              : null;
          allowed = allowVoiceSignal(true, membership, dbMember);
        }
      } catch (err) {
        logger.warn({ err }, 'Voice spectator check failed; ignoring the event');
        return;
      }
      if (!allowed) return;
      await handle(payload);
    })();
  };
}

export function registerVoiceSignaling(io: SocketServer): void {
  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.userId;
    if (!userId) return;

    socket.on(
      'voice:initiate',
      voiceGate(
        userId,
        'initiate',
        (payload: VoiceInitiatePayload) => ({ sessionId: payload.sessionId }),
        async (payload) => {
          const { sessionId, callId, targetUserIds } = payload;
          try {
            const allParticipants = [userId, ...targetUserIds];

            const { error } = await supabaseAdmin.from('voice_calls').insert({
              id: callId,
              session_id: sessionId,
              initiated_by: userId,
              participants: allParticipants,
              status: 'active',
            });

            if (error) {
              logger.error({ error, callId }, 'Failed to create voice_call row');
              socket.emit('voice:error', { callId, message: 'Failed to create call' });
              return;
            }

            activeCalls.set(callId, { sessionId, participants: new Set(allParticipants) });

            for (const targetId of targetUserIds) {
              io.to(`user:${targetId}`).emit('voice:incoming', {
                callId,
                sessionId,
                from: userId,
                participants: allParticipants,
              });
            }

            logger.info(
              { callId, sessionId, from: userId, targets: targetUserIds },
              'Voice call initiated',
            );
          } catch (err) {
            logger.error({ err, callId }, 'Error initiating voice call');
            socket.emit('voice:error', { callId, message: 'Internal error' });
          }
        },
      ),
    );

    socket.on(
      'voice:accept',
      voiceGate(
        userId,
        'signal',
        (payload: VoiceAcceptPayload) => ({ callId: payload.callId }),
        (payload) => {
          const { callId, to } = payload;
          const call = activeCalls.get(callId);
          if (call) {
            call.participants.add(userId);
          }
          io.to(`user:${to}`).emit('voice:participant_joined', { callId, userId });
          logger.info({ callId, userId }, 'Voice call accepted');
        },
      ),
    );

    socket.on(
      'voice:reject',
      voiceGate(
        userId,
        'signal',
        (payload: VoiceRejectPayload) => ({ callId: payload.callId }),
        (payload) => {
          const { callId, to } = payload;
          io.to(`user:${to}`).emit('voice:participant_rejected', { callId, userId });
          logger.info({ callId, userId }, 'Voice call rejected');
        },
      ),
    );

    socket.on(
      'voice:offer',
      voiceGate(
        userId,
        'signal',
        (payload: VoiceSDPPayload) => ({ callId: payload.callId }),
        (payload) => {
          const { callId, to, sdp } = payload;
          io.to(`user:${to}`).emit('voice:offer', { callId, from: userId, sdp });
        },
      ),
    );

    socket.on(
      'voice:answer',
      voiceGate(
        userId,
        'signal',
        (payload: VoiceSDPPayload) => ({ callId: payload.callId }),
        (payload) => {
          const { callId, to, sdp } = payload;
          io.to(`user:${to}`).emit('voice:answer', { callId, from: userId, sdp });
        },
      ),
    );

    socket.on(
      'voice:ice',
      voiceGate(
        userId,
        'signal',
        (payload: VoiceICEPayload) => ({ callId: payload.callId }),
        (payload) => {
          const { callId, to, candidate } = payload;
          io.to(`user:${to}`).emit('voice:ice', { callId, from: userId, candidate });
        },
      ),
    );

    socket.on(
      'voice:end',
      voiceGate(
        userId,
        'signal',
        (payload: VoiceEndPayload) => ({ callId: payload.callId }),
        async (payload) => {
          const { callId } = payload;
          const call = activeCalls.get(callId);

          if (call) {
            for (const pid of call.participants) {
              if (pid !== userId) {
                io.to(`user:${pid}`).emit('voice:ended', { callId, endedBy: userId });
              }
            }
            activeCalls.delete(callId);
          }

          try {
            await supabaseAdmin
              .from('voice_calls')
              .update({ status: 'ended', ended_at: new Date().toISOString() })
              .eq('id', callId);
          } catch (err) {
            logger.error({ err, callId }, 'Failed to mark voice_call as ended');
          }

          logger.info({ callId, endedBy: userId }, 'Voice call ended');
        },
      ),
    );

    socket.on('disconnect', () => {
      for (const [callId, call] of activeCalls.entries()) {
        if (call.participants.has(userId)) {
          call.participants.delete(userId);
          for (const pid of call.participants) {
            io.to(`user:${pid}`).emit('voice:participant_left', { callId, userId });
          }
          if (call.participants.size === 0) {
            activeCalls.delete(callId);
            supabaseAdmin
              .from('voice_calls')
              .update({ status: 'ended', ended_at: new Date().toISOString() })
              .eq('id', callId)
              .then(() => {});
          }
        }
      }
    });
  });

  logger.info('Voice signaling handlers registered');
}
