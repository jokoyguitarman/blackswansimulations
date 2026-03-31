import { useState, useRef, useCallback, useEffect } from 'react';
import { websocketClient } from '../lib/websocketClient';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

if (import.meta.env.VITE_TURN_URL) {
  ICE_SERVERS.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME ?? '',
    credential: import.meta.env.VITE_TURN_CREDENTIAL ?? '',
  });
}

export interface VoiceCallState {
  callId: string | null;
  sessionId: string | null;
  isInCall: boolean;
  isMuted: boolean;
  participants: string[];
  remoteStreams: Map<string, MediaStream>;
  speakingUsers: Set<string>;
}

interface IncomingCall {
  callId: string;
  sessionId: string;
  from: string;
  participants: string[];
}

export function useWebRTC(currentUserId: string | undefined) {
  const [state, setState] = useState<VoiceCallState>({
    callId: null,
    sessionId: null,
    isInCall: false,
    isMuted: false,
    participants: [],
    remoteStreams: new Map(),
    speakingUsers: new Set(),
  });

  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);

  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStream = useRef<MediaStream | null>(null);
  const callIdRef = useRef<string | null>(null);
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const analysersRef = useRef<Map<string, { analyser: AnalyserNode; ctx: AudioContext }>>(
    new Map(),
  );
  const speakingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const getSocket = useCallback(() => {
    return websocketClient.getSocket();
  }, []);

  const startSpeakingDetection = useCallback(() => {
    if (speakingIntervalRef.current) return;
    speakingIntervalRef.current = setInterval(() => {
      const speaking = new Set<string>();
      for (const [userId, { analyser }] of analysersRef.current) {
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        if (rms > 0.02) speaking.add(userId);
      }
      setState((prev) => ({ ...prev, speakingUsers: speaking }));
    }, 150);
  }, []);

  const stopSpeakingDetection = useCallback(() => {
    if (speakingIntervalRef.current) {
      clearInterval(speakingIntervalRef.current);
      speakingIntervalRef.current = null;
    }
    for (const { ctx } of analysersRef.current.values()) {
      ctx.close().catch(() => {});
    }
    analysersRef.current.clear();
  }, []);

  const addRemoteStreamAnalyser = useCallback(
    (userId: string, stream: MediaStream) => {
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analysersRef.current.set(userId, { analyser, ctx });
        startSpeakingDetection();
      } catch {
        // AudioContext may not be available in all contexts
      }
    },
    [startSpeakingDetection],
  );

  const playRemoteStream = useCallback((userId: string, stream: MediaStream) => {
    let audio = audioElementsRef.current.get(userId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      (audio as unknown as { playsInline: boolean }).playsInline = true;
      audio.id = `voice-remote-${userId}`;
      document.body.appendChild(audio);
      audioElementsRef.current.set(userId, audio);
    }
    audio.srcObject = stream;
    audio.play().catch((err) => {
      console.warn('[VoiceChat] Audio autoplay blocked for', userId, err);
    });
  }, []);

  const removeRemoteAudio = useCallback((userId: string) => {
    const audio = audioElementsRef.current.get(userId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      audioElementsRef.current.delete(userId);
    }
  }, []);

  const removeAllRemoteAudio = useCallback(() => {
    for (const [userId] of audioElementsRef.current) {
      removeRemoteAudio(userId);
    }
  }, [removeRemoteAudio]);

  const createPeerConnection = useCallback(
    (remoteUserId: string): RTCPeerConnection => {
      const existing = peerConnections.current.get(remoteUserId);
      if (existing) {
        existing.close();
        peerConnections.current.delete(remoteUserId);
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      if (localStream.current) {
        for (const track of localStream.current.getTracks()) {
          pc.addTrack(track, localStream.current);
        }
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const socket = getSocket();
          socket?.emit('voice:ice', {
            callId: callIdRef.current,
            to: remoteUserId,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (stream) {
          setState((prev) => {
            const newStreams = new Map(prev.remoteStreams);
            newStreams.set(remoteUserId, stream);
            return { ...prev, remoteStreams: newStreams };
          });
          addRemoteStreamAnalyser(remoteUserId, stream);
          playRemoteStream(remoteUserId, stream);
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          peerConnections.current.delete(remoteUserId);
          removeRemoteAudio(remoteUserId);
          setState((prev) => {
            const newStreams = new Map(prev.remoteStreams);
            newStreams.delete(remoteUserId);
            return { ...prev, remoteStreams: newStreams };
          });
        }
      };

      peerConnections.current.set(remoteUserId, pc);
      return pc;
    },
    [getSocket, addRemoteStreamAnalyser, playRemoteStream, removeRemoteAudio],
  );

  const cleanup = useCallback(() => {
    for (const pc of peerConnections.current.values()) {
      pc.close();
    }
    peerConnections.current.clear();

    if (localStream.current) {
      localStream.current.getTracks().forEach((t) => t.stop());
      localStream.current = null;
    }

    removeAllRemoteAudio();
    stopSpeakingDetection();

    callIdRef.current = null;
    setState({
      callId: null,
      sessionId: null,
      isInCall: false,
      isMuted: false,
      participants: [],
      remoteStreams: new Map(),
      speakingUsers: new Set(),
    });
  }, [stopSpeakingDetection, removeAllRemoteAudio]);

  const initiateCall = useCallback(
    async (sessionId: string, targetUserIds: string[]) => {
      const socket = getSocket();
      if (!socket || !currentUserId) return;

      const callId = crypto.randomUUID();
      callIdRef.current = callId;

      localStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });

      const allParticipants = [currentUserId, ...targetUserIds];

      setState((prev) => ({
        ...prev,
        callId,
        sessionId,
        isInCall: true,
        participants: allParticipants,
      }));

      socket.emit('voice:initiate', { sessionId, callId, targetUserIds });
    },
    [getSocket, currentUserId],
  );

  // Callee only acquires mic and signals acceptance.
  // The caller will send the offer via handleParticipantJoined,
  // which the callee answers in handleOffer. This prevents the
  // "offer glare" where both sides send offers simultaneously.
  const acceptCall = useCallback(
    async (callId: string) => {
      const socket = getSocket();
      if (!socket || !incomingCall) return;

      callIdRef.current = callId;

      localStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });

      setState((prev) => ({
        ...prev,
        callId,
        sessionId: incomingCall.sessionId,
        isInCall: true,
        participants: incomingCall.participants,
      }));

      socket.emit('voice:accept', { callId, to: incomingCall.from });
      setIncomingCall(null);
    },
    [getSocket, incomingCall],
  );

  const rejectCall = useCallback(
    (callId: string) => {
      const socket = getSocket();
      if (!socket || !incomingCall) return;

      socket.emit('voice:reject', { callId, to: incomingCall.from });
      setIncomingCall(null);
    },
    [getSocket, incomingCall],
  );

  const endCall = useCallback(() => {
    const socket = getSocket();
    if (socket && callIdRef.current) {
      socket.emit('voice:end', { callId: callIdRef.current });
    }
    cleanup();
  }, [getSocket, cleanup]);

  const toggleMute = useCallback(() => {
    if (localStream.current) {
      const audioTrack = localStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setState((prev) => ({ ...prev, isMuted: !audioTrack.enabled }));
      }
    }
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !currentUserId) return;

    const handleIncoming = (data: IncomingCall) => {
      if (state.isInCall) return;
      setIncomingCall(data);
    };

    // Only the caller (initiator) creates offers. When the callee
    // accepts, this fires on the caller side, which creates the
    // peer connection and sends the offer. The callee answers in
    // handleOffer below.
    const handleParticipantJoined = async (data: { callId: string; userId: string }) => {
      if (data.callId !== callIdRef.current) return;

      setState((prev) => ({
        ...prev,
        participants: prev.participants.includes(data.userId)
          ? prev.participants
          : [...prev.participants, data.userId],
      }));

      try {
        const pc = createPeerConnection(data.userId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('voice:offer', { callId: data.callId, to: data.userId, sdp: offer });
      } catch (err) {
        console.error('[VoiceChat] Failed to create offer for', data.userId, err);
      }
    };

    const handleOffer = async (data: {
      callId: string;
      from: string;
      sdp: RTCSessionDescriptionInit;
    }) => {
      if (data.callId !== callIdRef.current) return;

      try {
        let pc = peerConnections.current.get(data.from);
        if (!pc) {
          pc = createPeerConnection(data.from);
        } else if (pc.signalingState !== 'stable') {
          // Glare recovery: if we somehow have a pending offer, close
          // and recreate so we can cleanly accept the remote offer.
          pc.close();
          peerConnections.current.delete(data.from);
          pc = createPeerConnection(data.from);
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice:answer', { callId: data.callId, to: data.from, sdp: answer });
      } catch (err) {
        console.error('[VoiceChat] Failed to handle offer from', data.from, err);
      }
    };

    const handleAnswer = async (data: {
      callId: string;
      from: string;
      sdp: RTCSessionDescriptionInit;
    }) => {
      if (data.callId !== callIdRef.current) return;

      try {
        const pc = peerConnections.current.get(data.from);
        if (pc && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }
      } catch (err) {
        console.error('[VoiceChat] Failed to handle answer from', data.from, err);
      }
    };

    const handleICE = async (data: {
      callId: string;
      from: string;
      candidate: RTCIceCandidateInit;
    }) => {
      if (data.callId !== callIdRef.current) return;

      try {
        const pc = peerConnections.current.get(data.from);
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (err) {
        console.error('[VoiceChat] Failed to add ICE candidate from', data.from, err);
      }
    };

    const handleEnded = (data: { callId: string }) => {
      if (data.callId !== callIdRef.current) return;
      cleanup();
    };

    const handleParticipantLeft = (data: { callId: string; userId: string }) => {
      if (data.callId !== callIdRef.current) return;

      const pc = peerConnections.current.get(data.userId);
      if (pc) {
        pc.close();
        peerConnections.current.delete(data.userId);
      }
      removeRemoteAudio(data.userId);

      setState((prev) => {
        const newStreams = new Map(prev.remoteStreams);
        newStreams.delete(data.userId);
        return {
          ...prev,
          participants: prev.participants.filter((p) => p !== data.userId),
          remoteStreams: newStreams,
        };
      });
    };

    socket.on('voice:incoming', handleIncoming);
    socket.on('voice:participant_joined', handleParticipantJoined);
    socket.on('voice:offer', handleOffer);
    socket.on('voice:answer', handleAnswer);
    socket.on('voice:ice', handleICE);
    socket.on('voice:ended', handleEnded);
    socket.on('voice:participant_left', handleParticipantLeft);

    return () => {
      socket.off('voice:incoming', handleIncoming);
      socket.off('voice:participant_joined', handleParticipantJoined);
      socket.off('voice:offer', handleOffer);
      socket.off('voice:answer', handleAnswer);
      socket.off('voice:ice', handleICE);
      socket.off('voice:ended', handleEnded);
      socket.off('voice:participant_left', handleParticipantLeft);
    };
  }, [getSocket, currentUserId, state.isInCall, createPeerConnection, cleanup, removeRemoteAudio]);

  return {
    state,
    incomingCall,
    initiateCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    localStream: localStream.current,
  };
}
