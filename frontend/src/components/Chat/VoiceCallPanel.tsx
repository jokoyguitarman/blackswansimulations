import { useState, useEffect, useCallback } from 'react';
import { useWebRTC } from '../../hooks/useWebRTC';
import { useCallRecorder } from '../../hooks/useCallRecorder';
import { api } from '../../lib/api';

interface Participant {
  id: string;
  full_name: string;
  role: string;
  team_name?: string;
}

interface VoiceCallPanelProps {
  sessionId: string;
  currentUserId: string;
  variant?: 'terminal' | 'whatsapp';
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function VoiceCallPanel({
  sessionId,
  currentUserId,
  variant = 'terminal',
}: VoiceCallPanelProps) {
  const { state, initiateCall, endCall, toggleMute, localStream } = useWebRTC(currentUserId);
  const recorder = useCallRecorder();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const isWA = variant === 'whatsapp';

  useEffect(() => {
    api.channels.getParticipants(sessionId).then((res) => {
      if (res.data) {
        setParticipants(res.data.filter((p) => p.id !== currentUserId));
      }
    });
  }, [sessionId, currentUserId]);

  useEffect(() => {
    if (state.isInCall && localStream && !recorder.isRecording) {
      recorder.startRecording(localStream);
    }
  }, [state.isInCall, localStream, recorder]);

  const handleInitiate = useCallback(async () => {
    if (selected.size === 0) {
      setError('Select at least one participant');
      return;
    }
    setError(null);
    try {
      await initiateCall(sessionId, Array.from(selected));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start call');
    }
  }, [selected, sessionId, initiateCall]);

  const handleEndCall = useCallback(async () => {
    if (state.callId && state.sessionId) {
      await recorder.stopAndUpload(state.callId, state.sessionId);
    }
    endCall();
  }, [state.callId, state.sessionId, recorder, endCall]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (state.isInCall) {
    const participantNames = new Map(participants.map((p) => [p.id, p.full_name]));

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-danger animate-pulse" />
            <span
              className={
                isWA ? 'text-xs text-red-400 font-medium' : 'text-xs terminal-text text-danger'
              }
            >
              {isWA
                ? `Live Call — ${formatDuration(recorder.duration)}`
                : `Live Call — ${formatDuration(recorder.duration)}`}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={toggleMute}
              className={
                isWA
                  ? `px-4 py-1.5 text-xs font-medium rounded-full transition-all ${state.isMuted ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'bg-wa-input text-wa-text hover:bg-[#3B4A54] border border-transparent'}`
                  : `px-3 py-1 text-xs terminal-text border transition-all ${state.isMuted ? 'border-danger text-danger bg-danger/10' : 'border-border text-ink hover:bg-accent/10'}`
              }
            >
              {isWA ? (state.isMuted ? 'Unmute' : 'Mute') : state.isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button
              onClick={handleEndCall}
              className={
                isWA
                  ? 'px-4 py-1.5 text-xs font-medium rounded-full bg-red-500 text-white hover:bg-red-600 transition-all'
                  : 'px-3 py-1 text-xs terminal-text border border-danger text-danger hover:bg-danger/10'
              }
            >
              {isWA ? 'End Call' : 'End call'}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
          {/* Local user */}
          <div
            className={
              isWA
                ? `flex items-center gap-3 px-4 py-3 rounded-xl ${state.isMuted ? 'bg-red-500/10 border border-red-500/20' : 'bg-wa-received border border-wa-teal/20'}`
                : `flex items-center gap-3 px-3 py-2 border border-border rounded`
            }
          >
            <div
              className={
                isWA
                  ? `w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${state.isMuted ? 'bg-red-500/20 text-red-400' : 'bg-wa-teal/20 text-wa-teal'}`
                  : `w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${state.isMuted ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-ink'}`
              }
            >
              {state.isMuted ? '🔇' : '🎙'}
            </div>
            <div className="flex-1">
              <div
                className={
                  isWA ? 'text-sm text-wa-text font-medium' : 'text-sm terminal-text text-ink'
                }
              >
                You
              </div>
              <div className={isWA ? 'text-xs text-wa-text-secondary' : 'text-xs text-muted'}>
                {state.isMuted ? 'Muted' : 'Speaking…'}
              </div>
            </div>
          </div>

          {/* Remote participants */}
          {state.participants
            .filter((p) => p !== currentUserId)
            .map((userId) => {
              const isSpeaking = state.speakingUsers.has(userId);
              const hasStream = state.remoteStreams.has(userId);
              const name = participantNames.get(userId) ?? userId.slice(0, 8);

              return (
                <div
                  key={userId}
                  className={
                    isWA
                      ? `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isSpeaking ? 'bg-wa-teal/10 border border-wa-teal/30' : 'bg-wa-received border border-transparent'}`
                      : `flex items-center gap-3 px-3 py-2 border rounded transition-all ${isSpeaking ? 'border-success bg-success/10' : 'border-border'}`
                  }
                >
                  <div
                    className={
                      isWA
                        ? `w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${isSpeaking ? 'bg-wa-teal/20 text-wa-teal' : hasStream ? 'bg-wa-input text-wa-text' : 'bg-wa-input text-wa-text-secondary'}`
                        : `w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${isSpeaking ? 'bg-success/10 text-success' : hasStream ? 'bg-accent/10 text-ink' : 'bg-surface-2 text-muted'}`
                    }
                  >
                    {isSpeaking ? '🔊' : hasStream ? '🎧' : '⏳'}
                  </div>
                  <div className="flex-1">
                    <div
                      className={
                        isWA ? 'text-sm text-wa-text font-medium' : 'text-sm terminal-text text-ink'
                      }
                    >
                      {name}
                    </div>
                    <div className={isWA ? 'text-xs text-wa-text-secondary' : 'text-xs text-muted'}>
                      {isSpeaking ? 'Speaking' : hasStream ? 'Connected' : 'Connecting…'}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div
        className={
          isWA ? 'text-xs text-wa-text-secondary mb-3' : 'text-xs terminal-text text-muted mb-3'
        }
      >
        Select participants to call
      </div>

      {error && (
        <div
          className={
            isWA
              ? 'text-xs text-red-400 mb-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg'
              : 'text-xs text-danger mb-2 px-2 py-1 border border-danger/30 rounded'
          }
        >
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-1 mb-3">
        {participants.length === 0 && (
          <div
            className={
              isWA
                ? 'text-xs text-wa-text-secondary text-center py-4'
                : 'text-xs text-muted text-center py-4'
            }
          >
            No other participants in session
          </div>
        )}
        {participants.map((p) => (
          <label
            key={p.id}
            className={
              isWA
                ? `flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all ${selected.has(p.id) ? 'bg-wa-teal/10 border border-wa-teal/30' : 'bg-wa-received border border-transparent hover:bg-[#283840]'}`
                : `flex items-center gap-3 px-3 py-2 border rounded cursor-pointer transition-all ${selected.has(p.id) ? 'border-accent bg-accent/10' : 'border-border hover:border-accent'}`
            }
          >
            <input
              type="checkbox"
              checked={selected.has(p.id)}
              onChange={() => toggleSelect(p.id)}
              className={isWA ? 'accent-[#00A884]' : 'accent-accent'}
            />
            <div className="flex-1">
              <div
                className={
                  isWA ? 'text-sm text-wa-text font-medium' : 'text-sm terminal-text text-ink'
                }
              >
                {p.full_name}
              </div>
              <div className={isWA ? 'text-xs text-wa-text-secondary' : 'text-xs text-muted'}>
                {p.team_name ?? p.role}
              </div>
            </div>
          </label>
        ))}
      </div>

      <button
        onClick={handleInitiate}
        disabled={selected.size === 0}
        className={
          isWA
            ? `w-full py-3 text-sm font-medium rounded-full transition-all ${selected.size > 0 ? 'bg-wa-teal text-white hover:bg-wa-teal-light' : 'bg-wa-input text-wa-text-secondary cursor-not-allowed opacity-50'}`
            : `w-full py-2 text-sm terminal-text border transition-all ${selected.size > 0 ? 'border-success text-success hover:bg-success/10' : 'border-border text-muted cursor-not-allowed opacity-50'}`
        }
      >
        {isWA
          ? `Call${selected.size > 0 ? ` (${selected.size})` : ''}`
          : `Call${selected.size > 0 ? ` (${selected.size})` : ''}`}
      </button>
    </div>
  );
}
