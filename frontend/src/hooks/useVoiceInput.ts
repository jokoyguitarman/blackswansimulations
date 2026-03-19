import { useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';
const apiUrl = (path: string) => {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}` : cleanPath;
};

export function useVoiceInput() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const resolveRef = useRef<((text: string) => void) | null>(null);
  const rejectRef = useRef<((err: Error) => void) | null>(null);

  const cleanup = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        cleanup();

        if (blob.size < 100) {
          const msg = 'Recording too short';
          setError(msg);
          rejectRef.current?.(new Error(msg));
          return;
        }

        setIsTranscribing(true);
        try {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (!session) throw new Error('Not authenticated');

          const response = await fetch(apiUrl('/api/ai/transcribe'), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              'Content-Type': mimeType,
            },
            body: blob,
          });

          if (!response.ok) {
            const errData = await response.json().catch(() => ({ error: 'Transcription failed' }));
            throw new Error(errData.error || `HTTP ${response.status}`);
          }

          const result = (await response.json()) as { data: { text: string } };
          const text = result.data?.text?.trim() ?? '';
          resolveRef.current?.(text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          setError(msg);
          rejectRef.current?.(new Error(msg));
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      cleanup();
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission denied'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'No microphone found'
            : err instanceof Error
              ? err.message
              : 'Failed to start recording';
      setError(msg);
      throw new Error(msg);
    }
  }, [cleanup]);

  const stopRecording = useCallback((): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current = reject;

      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== 'recording') {
        cleanup();
        setIsRecording(false);
        reject(new Error('Not recording'));
        return;
      }

      setIsRecording(false);
      recorder.stop();
    });
  }, [cleanup]);

  return { isRecording, isTranscribing, error, startRecording, stopRecording };
}
