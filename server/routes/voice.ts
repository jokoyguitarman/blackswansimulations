import { Router, raw } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';

const router = Router();

// -----------------------------------------------------------------------
// POST /upload — store a voice recording blob
// -----------------------------------------------------------------------
router.post(
  '/upload',
  requireAuth,
  raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }),
  async (req: AuthenticatedRequest, res) => {
    try {
      const audioBuffer = req.body as Buffer;
      if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length < 100) {
        return res.status(400).json({ error: 'No audio data provided' });
      }

      const callId = req.headers['x-call-id'] as string | undefined;
      const sessionId = req.headers['x-session-id'] as string | undefined;
      if (!callId || !sessionId) {
        return res.status(400).json({ error: 'Missing x-call-id or x-session-id header' });
      }

      const userId = req.user!.id;
      const contentType = req.headers['content-type'] || 'audio/webm';
      const ext = contentType.includes('wav')
        ? 'wav'
        : contentType.includes('mp4')
          ? 'mp4'
          : 'webm';
      const storagePath = `voice/${sessionId}/${callId}/${userId}.${ext}`;

      const { error: uploadErr } = await supabaseAdmin.storage
        .from('voice-recordings')
        .upload(storagePath, audioBuffer, { contentType, upsert: true });

      if (uploadErr) {
        logger.error({ uploadErr, storagePath }, 'Voice recording upload failed');
        return res.status(502).json({ error: 'Upload failed' });
      }

      const durationHeader = req.headers['x-duration-seconds'] as string | undefined;
      const duration = durationHeader ? parseFloat(durationHeader) : null;

      const { error: dbErr } = await supabaseAdmin.from('voice_recordings').insert({
        call_id: callId,
        session_id: sessionId,
        user_id: userId,
        storage_path: storagePath,
        duration_seconds: duration,
      });

      if (dbErr) {
        logger.error({ dbErr, callId }, 'Failed to insert voice_recordings row');
        return res.status(500).json({ error: 'Failed to save recording metadata' });
      }

      logger.info({ callId, sessionId, userId, storagePath }, 'Voice recording uploaded');
      res.json({ data: { storagePath } });
    } catch (err) {
      logger.error({ err }, 'Error in POST /voice/upload');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// -----------------------------------------------------------------------
// POST /transcribe-session/:sessionId — batch-transcribe all recordings
// -----------------------------------------------------------------------
router.post(
  '/transcribe-session/:sessionId',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { sessionId } = req.params;

      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('trainer_id')
        .eq('id', sessionId)
        .single();

      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.trainer_id !== req.user!.id && req.user!.role !== 'admin') {
        return res.status(403).json({ error: 'Only the trainer can trigger transcription' });
      }

      if (!env.openAiApiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
      }

      const { data: recordings, error: fetchErr } = await supabaseAdmin
        .from('voice_recordings')
        .select('id, storage_path, call_id, user_id')
        .eq('session_id', sessionId)
        .is('transcript', null);

      if (fetchErr || !recordings) {
        return res.status(500).json({ error: 'Failed to fetch recordings' });
      }

      if (recordings.length === 0) {
        return res.json({ data: { transcribed: 0 } });
      }

      let transcribed = 0;

      for (const rec of recordings) {
        try {
          const { data: fileData, error: dlErr } = await supabaseAdmin.storage
            .from('voice-recordings')
            .download(rec.storage_path);

          if (dlErr || !fileData) {
            logger.warn({ recId: rec.id, dlErr }, 'Skipping recording: download failed');
            continue;
          }

          const arrayBuf = await fileData.arrayBuffer();
          const ext = rec.storage_path.endsWith('.wav') ? 'wav' : 'webm';
          const mimeType = ext === 'wav' ? 'audio/wav' : 'audio/webm';

          const formData = new FormData();
          const blob = new Blob([arrayBuf], { type: mimeType });
          formData.append('file', blob, `recording.${ext}`);
          formData.append('model', 'whisper-1');
          formData.append('language', 'en');

          const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.openAiApiKey}` },
            body: formData,
          });

          if (!whisperRes.ok) {
            const errBody = await whisperRes.text();
            logger.warn(
              { recId: rec.id, status: whisperRes.status, errBody },
              'Whisper transcription failed',
            );
            continue;
          }

          const result = (await whisperRes.json()) as { text?: string };
          const text = result.text?.trim() ?? '';

          if (!text) continue;

          await supabaseAdmin
            .from('voice_recordings')
            .update({ transcript: text, transcribed_at: new Date().toISOString() })
            .eq('id', rec.id);

          const { data: call } = await supabaseAdmin
            .from('voice_calls')
            .select('session_id')
            .eq('id', rec.call_id)
            .single();

          if (call) {
            const { data: channels } = await supabaseAdmin
              .from('chat_channels')
              .select('id')
              .eq('session_id', call.session_id)
              .eq('name', 'All Teams')
              .limit(1);

            const channelId = channels?.[0]?.id;
            if (channelId) {
              await supabaseAdmin.from('chat_messages').insert({
                channel_id: channelId,
                session_id: call.session_id,
                sender_id: rec.user_id,
                content: text,
                type: 'voice_transcript',
              });
            }
          }

          transcribed++;
        } catch (recErr) {
          logger.error({ recId: rec.id, recErr }, 'Error transcribing individual recording');
        }
      }

      logger.info(
        { sessionId, total: recordings.length, transcribed },
        'Batch transcription complete',
      );
      res.json({ data: { total: recordings.length, transcribed } });
    } catch (err) {
      logger.error({ err }, 'Error in POST /voice/transcribe-session');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// -----------------------------------------------------------------------
// GET /calls/:sessionId — list calls and recordings for AAR
// -----------------------------------------------------------------------
router.get('/calls/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const { data: calls, error } = await supabaseAdmin
      .from('voice_calls')
      .select('*, voice_recordings(*)')
      .eq('session_id', sessionId)
      .order('started_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch calls' });
    }

    res.json({ data: calls ?? [] });
  } catch (err) {
    logger.error({ err }, 'Error in GET /voice/calls');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as voiceRouter };
