import { useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';
const apiUrl = (path: string) => {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}` : cleanPath;
};

export function useCallRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRecording = useCallback((stream: MediaStream) => {
    try {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      startTimeRef.current = Date.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start(1000);
      setIsRecording(true);
      setDuration(0);

      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } catch (err) {
      console.error('[CALL_RECORDER] Failed to start:', err);
    }
  }, []);

  const stopAndUpload = useCallback(async (callId: string, sessionId: string): Promise<void> => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setIsRecording(false);
      return;
    }

    return new Promise<void>((resolve) => {
      recorder.onstop = async () => {
        setIsRecording(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];

        if (blob.size < 100) {
          resolve();
          return;
        }

        const durationSeconds = Math.floor((Date.now() - startTimeRef.current) / 1000);

        try {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (!session) {
            resolve();
            return;
          }

          await fetch(apiUrl('/api/voice/upload'), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              'Content-Type': recorder.mimeType,
              'x-call-id': callId,
              'x-session-id': sessionId,
              'x-duration-seconds': String(durationSeconds),
            },
            body: blob,
          });
        } catch (err) {
          console.error('[CALL_RECORDER] Upload failed:', err);
        }

        resolve();
      };

      recorder.stop();
    });
  }, []);

  return { isRecording, duration, startRecording, stopAndUpload };
}
