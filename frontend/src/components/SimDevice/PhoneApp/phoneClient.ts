import { supabase } from '../../../lib/supabase';
import { withViewAsHeaders } from '../../../lib/viewAsFrame';

const API_BASE_URL = import.meta.env?.VITE_API_URL || '';

export function phoneApiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}`;
  return cleanPath;
}

export async function phoneAuthHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return withViewAsHeaders({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  });
}

export interface CallSummary {
  id: string;
  session_id: string;
  inject_id: string | null;
  direction: string;
  caller_name: string;
  caller_number: string | null;
  status: string;
  mode: 'voice' | 'text' | null;
  ring_deadline_at: string;
  answered_by_name?: string;
  started_at: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  end_reason?: string | null;
  can_callback: boolean;
  call_group_id: string;
  attempt_no: number;
  max_attempts: number;
  group_missed_count: number;
  caller_missed_count: number;
  next_attempt_at?: string;
  line_team?: string | null;
  opening?: string;
  missed_reason?: string | null;
}

export interface CallTurn {
  seq: number;
  speaker: 'npc' | 'player' | 'system';
  text: string;
  at: string;
}

export interface VoiceConnect {
  mode: 'voice';
  call_id?: string;
  client_secret: string;
  expires_at?: string | number | null;
  model: string;
  webrtc_url: string;
  opening_instruction: string;
}

export interface TextConnect {
  mode: 'text';
  call_id?: string;
  opening: string;
  ended?: boolean;
  end_reason?: string;
}

export type ConnectAnswer = VoiceConnect | TextConnect;

const pending = new Map<string, ConnectAnswer>();

export function stashConnect(callId: string, answer: ConnectAnswer): void {
  pending.set(callId, answer);
}

export function takeConnect(callId: string): ConnectAnswer | null {
  const answer = pending.get(callId) ?? null;
  pending.delete(callId);
  return answer;
}

export async function answerCall(
  callId: string,
  capabilities: { webrtc: boolean; mic: boolean },
): Promise<{ status: number; body: ConnectAnswer & { error?: string } }> {
  const res = await fetch(phoneApiUrl(`/api/calls/${callId}/answer`), {
    method: 'POST',
    headers: await phoneAuthHeaders(),
    body: JSON.stringify({ capabilities }),
  });
  const body = (await res.json()) as ConnectAnswer & { error?: string };
  return { status: res.status, body };
}

export async function declineCall(callId: string): Promise<number> {
  const res = await fetch(phoneApiUrl(`/api/calls/${callId}/decline`), {
    method: 'POST',
    headers: await phoneAuthHeaders(),
  });
  return res.status;
}

export async function callbackCall(
  callId: string,
  capabilities: { webrtc: boolean; mic: boolean },
): Promise<{ status: number; body: ConnectAnswer & { error?: string; id?: string } }> {
  const res = await fetch(phoneApiUrl(`/api/calls/${callId}/callback`), {
    method: 'POST',
    headers: await phoneAuthHeaders(),
    body: JSON.stringify({ capabilities }),
  });
  const body = (await res.json()) as ConnectAnswer & { error?: string };
  return { status: res.status, body };
}

export async function hangupCall(callId: string): Promise<void> {
  await fetch(phoneApiUrl(`/api/calls/${callId}/hangup`), {
    method: 'POST',
    headers: await phoneAuthHeaders(),
  });
}

export async function sendTextTurn(
  callId: string,
  text: string,
): Promise<{ reply: string; ended: boolean }> {
  const res = await fetch(phoneApiUrl(`/api/calls/${callId}/text-turn`), {
    method: 'POST',
    headers: await phoneAuthHeaders(),
    body: JSON.stringify({ text }),
  });
  if (!res.ok) return { reply: '', ended: false };
  return (await res.json()) as { reply: string; ended: boolean };
}

export async function loadCalls(sessionId: string): Promise<CallSummary[]> {
  const res = await fetch(phoneApiUrl(`/api/calls/session/${sessionId}`), {
    headers: await phoneAuthHeaders(),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: CallSummary[] };
  return body.data ?? [];
}

export async function loadCall(
  callId: string,
): Promise<(CallSummary & { turns: CallTurn[] }) | null> {
  const res = await fetch(phoneApiUrl(`/api/calls/${callId}`), {
    headers: await phoneAuthHeaders(),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: CallSummary & { turns: CallTurn[] } };
  return body.data ?? null;
}

export async function loadBadge(sessionId: string): Promise<number> {
  const res = await fetch(phoneApiUrl(`/api/calls/session/${sessionId}/badge`), {
    headers: await phoneAuthHeaders(),
  });
  if (!res.ok) return 0;
  const body = (await res.json()) as { missed_unseen?: number };
  return body.missed_unseen ?? 0;
}

export async function markRecentsViewed(sessionId: string): Promise<void> {
  await fetch(phoneApiUrl(`/api/calls/session/${sessionId}/recents-viewed`), {
    method: 'POST',
    headers: await phoneAuthHeaders(),
  });
}

export function browserCanCall(): { webrtc: boolean; mic: boolean } {
  const webrtc = typeof window !== 'undefined' && typeof window.RTCPeerConnection === 'function';
  const mic = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  return { webrtc, mic };
}

/**
 * Browser half of a Realtime call. Returns a cleanup function.
 * The client secret is used once for the SDP exchange and is not stored.
 */
export async function connectRealtimeVoice(input: {
  answer: VoiceConnect;
  onRemoteTrack: (stream: MediaStream) => void;
  onEvent: (event: Record<string, unknown>) => void;
  onFailure: () => void;
}): Promise<{ hangup: () => void; mute: (muted: boolean) => void; callId: string | null }> {
  const pc = new RTCPeerConnection();
  const remote = new MediaStream();
  pc.ontrack = (event) => {
    for (const track of event.streams[0]?.getTracks() ?? [event.track]) remote.addTrack(track);
    input.onRemoteTrack(remote);
  };
  const events = pc.createDataChannel('oai-events');
  events.onmessage = (message) => {
    try {
      input.onEvent(JSON.parse(String(message.data)) as Record<string, unknown>);
    } catch {
      /* ignore non-JSON events */
    }
  };
  events.onclose = () => input.onFailure();
  let local: MediaStream | null = null;
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of local.getTracks()) pc.addTrack(track, local);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await fetch(input.answer.webrtc_url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.answer.client_secret}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp ?? '',
    });
    if (!response.ok) throw new Error('sdp');
    const answerSdp = await response.text();
    const location = response.headers.get('Location') ?? '';
    const callId = location.split('/').filter(Boolean).pop() ?? null;
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    return {
      callId,
      mute(muted: boolean) {
        for (const track of local?.getTracks() ?? []) track.enabled = !muted;
      },
      hangup() {
        for (const track of local?.getTracks() ?? []) track.stop();
        pc.close();
      },
    };
  } catch {
    for (const track of local?.getTracks() ?? []) track.stop();
    pc.close();
    input.onFailure();
    return { callId: null, mute() {}, hangup() {} };
  }
}
