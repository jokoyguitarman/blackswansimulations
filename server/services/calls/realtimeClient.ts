/**
 * The only module that talks to api.openai.com for Realtime.
 * The API key and the minted client secret are never logged and never stored.
 */

import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

const MINT_URL = 'https://api.openai.com/v1/realtime/client_secrets';
export const WEBRTC_URL = 'https://api.openai.com/v1/realtime/calls';
const MINT_TIMEOUT_MS = 8_000;

export interface Sideband {
  send(payload: unknown): void;
  close(): void;
}

export type MintResult =
  | { ok: true; value: string; expires_at: string | number | null }
  | { ok: false; status?: number };

export interface RealtimeClient {
  hasKey(): boolean;
  mintClientSecret(body: Record<string, unknown>): Promise<MintResult>;
  openSideband(
    openaiCallId: string,
    onEvent: (event: Record<string, unknown>) => void,
  ): Promise<Sideband | null>;
  hangup(openaiCallId: string): Promise<void>;
}

export function createRealtimeClient(options?: {
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
}): RealtimeClient {
  const apiKey = () => (options && 'apiKey' in options ? options.apiKey : env.openAiApiKey) ?? null;
  const fetchImpl = options?.fetchImpl ?? fetch;

  return {
    hasKey() {
      return Boolean(apiKey());
    },
    async mintClientSecret(body) {
      const key = apiKey();
      if (!key) return { ok: false };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
      try {
        const response = await fetchImpl(MINT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          logger.warn({ status: response.status, event: 'realtime_mint_failed' }, 'Realtime client secret mint failed');
          return { ok: false, status: response.status };
        }
        const payload = (await response.json()) as {
          value?: unknown;
          expires_at?: unknown;
          client_secret?: { value?: unknown; expires_at?: unknown };
        };
        const value = typeof payload.value === 'string' ? payload.value : payload.client_secret?.value;
        if (typeof value !== 'string' || !value) {
          logger.warn({ status: response.status, event: 'realtime_mint_failed' }, 'Realtime client secret mint failed');
          return { ok: false, status: response.status };
        }
        const expires = payload.expires_at ?? payload.client_secret?.expires_at ?? null;
        return {
          ok: true,
          value,
          expires_at: typeof expires === 'string' || typeof expires === 'number' ? expires : null,
        };
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        logger.warn(
          { status: aborted ? 408 : undefined, event: 'realtime_mint_failed' },
          'Realtime client secret mint failed',
        );
        return { ok: false, status: aborted ? 408 : undefined };
      } finally {
        clearTimeout(timer);
      }
    },
    async openSideband(openaiCallId, onEvent) {
      const key = apiKey();
      if (!key || !openaiCallId) return null;
      try {
        const imported = await import('ws');
        const WebSocket = imported.default;
        const socket = new WebSocket(
          `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(openaiCallId)}`,
          { headers: { Authorization: `Bearer ${key}` } },
        );
        const sideband: Sideband = {
          send(payload) {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
          },
          close() {
            try {
              socket.close();
            } catch {
              /* already closed */
            }
          },
        };
        socket.on('message', (data) => {
          try {
            const parsed = JSON.parse(String(data)) as Record<string, unknown>;
            onEvent(parsed);
          } catch {
            logger.warn({ event: 'realtime_sideband_parse' }, 'Realtime sideband event was not JSON');
          }
        });
        socket.on('error', () => {
          logger.warn({ event: 'realtime_sideband_error' }, 'Realtime sideband error');
        });
        await new Promise<void>((resolve, reject) => {
          socket.once('open', () => resolve());
          socket.once('error', () => reject(new Error('sideband')));
        });
        return sideband;
      } catch {
        logger.warn({ event: 'realtime_sideband_unavailable' }, 'Realtime sideband unavailable');
        return null;
      }
    },
    async hangup(openaiCallId) {
      const key = apiKey();
      if (!key || !openaiCallId) return;
      try {
        const response = await fetchImpl(`${WEBRTC_URL}/${encodeURIComponent(openaiCallId)}/hangup`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!response.ok) {
          logger.warn({ status: response.status, event: 'realtime_hangup_failed' }, 'Realtime hangup failed');
        }
      } catch {
        logger.warn({ event: 'realtime_hangup_failed' }, 'Realtime hangup failed');
      }
    },
  };
}
