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
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function VoiceCallPanel({ sessionId, currentUserId }: VoiceCallPanelProps) {
  const { state, initiateCall, endCall, toggleMute, localStream } = useWebRTC(currentUserId);
  const recorder = useCallRecorder();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

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
            <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs terminal-text text-red-400 uppercase tracking-wider">
              Live Call — {formatDuration(recorder.duration)}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={toggleMute}
              className={`px-3 py-1 text-xs terminal-text uppercase border transition-all ${
                state.isMuted
                  ? 'border-red-500 text-red-400 bg-red-500/10'
                  : 'border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10'
              }`}
            >
              {state.isMuted ? '[UNMUTE]' : '[MUTE]'}
            </button>
            <button
              onClick={handleEndCall}
              className="px-3 py-1 text-xs terminal-text uppercase border border-red-500 text-red-400 hover:bg-red-500/10"
            >
              [END CALL]
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
          {/* Local user */}
          <div className="flex items-center gap-3 px-3 py-2 border border-robotic-yellow/20 rounded">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                state.isMuted
                  ? 'bg-red-900/50 text-red-400'
                  : 'bg-robotic-yellow/20 text-robotic-yellow'
              }`}
            >
              {state.isMuted ? '🔇' : '🎙'}
            </div>
            <div className="flex-1">
              <div className="text-sm terminal-text text-robotic-yellow">You</div>
              <div className="text-xs text-robotic-yellow/50">
                {state.isMuted ? 'Muted' : 'Speaking...'}
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
                  className={`flex items-center gap-3 px-3 py-2 border rounded transition-all ${
                    isSpeaking ? 'border-green-500/60 bg-green-500/5' : 'border-robotic-yellow/20'
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                      isSpeaking
                        ? 'bg-green-900/50 text-green-400'
                        : hasStream
                          ? 'bg-robotic-yellow/20 text-robotic-yellow'
                          : 'bg-robotic-gray-200/20 text-robotic-gray-50'
                    }`}
                  >
                    {isSpeaking ? '🔊' : hasStream ? '🎧' : '⏳'}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm terminal-text text-robotic-yellow">{name}</div>
                    <div className="text-xs text-robotic-yellow/50">
                      {isSpeaking ? 'Speaking' : hasStream ? 'Connected' : 'Connecting...'}
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
      <div className="text-xs terminal-text text-robotic-yellow/70 mb-3 uppercase tracking-wider">
        Select participants to call
      </div>

      {error && (
        <div className="text-xs text-red-400 mb-2 px-2 py-1 border border-red-500/30 rounded">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-1 mb-3">
        {participants.length === 0 && (
          <div className="text-xs text-robotic-yellow/40 text-center py-4">
            No other participants in session
          </div>
        )}
        {participants.map((p) => (
          <label
            key={p.id}
            className={`flex items-center gap-3 px-3 py-2 border rounded cursor-pointer transition-all ${
              selected.has(p.id)
                ? 'border-robotic-yellow bg-robotic-yellow/10'
                : 'border-robotic-yellow/20 hover:border-robotic-yellow/40'
            }`}
          >
            <input
              type="checkbox"
              checked={selected.has(p.id)}
              onChange={() => toggleSelect(p.id)}
              className="accent-yellow-400"
            />
            <div className="flex-1">
              <div className="text-sm terminal-text text-robotic-yellow">{p.full_name}</div>
              <div className="text-xs text-robotic-yellow/50">{p.team_name ?? p.role}</div>
            </div>
          </label>
        ))}
      </div>

      <button
        onClick={handleInitiate}
        disabled={selected.size === 0}
        className={`w-full py-2 text-sm terminal-text uppercase border transition-all ${
          selected.size > 0
            ? 'border-green-500 text-green-400 hover:bg-green-500/10'
            : 'border-robotic-gray-200 text-robotic-gray-50 cursor-not-allowed opacity-50'
        }`}
      >
        [CALL {selected.size > 0 ? `(${selected.size})` : ''}]
      </button>
    </div>
  );
}
