import { io, type Socket } from 'socket.io-client';

/**
 * One simulated player: a real Socket.io connection that authenticates with a
 * Supabase JWT, joins the session room, and passively receives every broadcast
 * — mirroring frontend/src/lib/websocketClient.ts.
 *
 * Probe messages (sent by the trainer via REST) carry a probe id in their
 * content; when one arrives the spectator reports the receive time so the
 * runner can compute fan-out latency on a single clock.
 */

export const PROBE_PREFIX = 'LOADTEST_PROBE::';

interface BroadcastEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface SpectatorCallbacks {
  onProbe: (probeId: string, spectatorIndex: number, receivedAt: number) => void;
  onPassiveEvent: (eventType: string) => void;
  onDisconnect: (spectatorIndex: number, reason: string) => void;
}

export class Spectator {
  readonly index: number;
  private socket: Socket | null = null;
  disconnects = 0;
  connectFailed = false;

  constructor(
    index: number,
    private readonly url: string,
    private readonly token: string,
    private readonly sessionId: string,
    private readonly channelId: string,
    private readonly callbacks: SpectatorCallbacks,
  ) {
    this.index = index;
  }

  connect(timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = io(this.url, {
        auth: { token: this.token },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5,
        timeout: timeoutMs,
      });
      this.socket = socket;

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.connectFailed = true;
          socket.disconnect();
          reject(new Error(`spectator ${this.index}: connect timeout`));
        }
      }, timeoutMs);

      socket.on('connect', () => {
        // (Re-)join the session and probe-channel rooms; the server validates access.
        // Probe messages are broadcast to the channel room (message.sent), so
        // spectators must join it — exactly like the real chat UI does.
        socket.emit('join_session', this.sessionId);
        socket.emit('join_channel', this.channelId);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });

      socket.on('connect_error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.connectFailed = true;
          socket.disconnect();
          reject(new Error(`spectator ${this.index}: ${err.message}`));
        }
      });

      socket.on('disconnect', (reason) => {
        // Deliberate teardown calls disconnect(); only count server/transport drops.
        if (reason !== 'io client disconnect') {
          this.disconnects++;
          this.callbacks.onDisconnect(this.index, reason);
        }
      });

      socket.on('event', (event: BroadcastEvent) => {
        const receivedAt = Date.now();
        // Chat messages are broadcast to the channel room as `message.sent`
        // with the row nested under data.message (see websocketService.messageSent).
        const message = event?.data?.message as { content?: string } | undefined;
        const content = event?.type === 'message.sent' ? message?.content : undefined;
        if (content && content.startsWith(PROBE_PREFIX)) {
          const probeId = content.slice(PROBE_PREFIX.length).split('::')[0];
          this.callbacks.onProbe(probeId, this.index, receivedAt);
        } else if (event?.type) {
          this.callbacks.onPassiveEvent(event.type);
        }
      });
    });
  }

  close(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
  }
}
