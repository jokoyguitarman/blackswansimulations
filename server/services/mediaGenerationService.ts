import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { randomUUID } from 'crypto';

type ImageStyle =
  | 'meme'
  | 'news_photo'
  | 'infographic'
  | 'evidence_photo'
  | 'video_thumbnail'
  | 'social_media_photo';

const STYLE_PROMPTS: Record<ImageStyle, string> = {
  meme: 'A social media meme image. Bold text overlay style. Shareable and eye-catching. No watermarks.',
  news_photo:
    'A realistic news photograph. Photojournalistic style, high quality, looks like it was taken by a reporter on scene.',
  infographic:
    'A clean, professional infographic. Data visualization style with clear typography and organized layout.',
  evidence_photo:
    'A social media photo that looks like it was taken by a bystander with a phone. Slightly blurry, candid angle, realistic lighting.',
  video_thumbnail:
    'A cinematic video still frame. 16:9 aspect ratio. Looks like a paused video with dramatic lighting and composition.',
  social_media_photo:
    'A social media photo post. Clean, well-composed, suitable for sharing on a social media platform.',
};

const XAI_BASE = 'https://api.x.ai/v1';
const BUCKET_NAME = 'sim-media';

async function ensureBucket(): Promise<void> {
  const { error } = await supabaseAdmin.storage.getBucket(BUCKET_NAME);
  if (error) {
    await supabaseAdmin.storage.createBucket(BUCKET_NAME, {
      public: true,
      fileSizeLimit: 50 * 1024 * 1024,
    });
  }
}

let bucketReady = false;

async function uploadToStorage(
  buffer: Buffer,
  ext: string,
  contentType: string,
): Promise<string | null> {
  const fileName = `${randomUUID()}.${ext}`;
  const filePath = `generated/${fileName}`;

  if (!bucketReady) {
    await ensureBucket();
    bucketReady = true;
  }

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .upload(filePath, buffer, { contentType, cacheControl: '3600' });

  if (uploadErr) {
    logger.warn({ error: uploadErr }, 'Failed to upload media to storage');
    return null;
  }

  const { data: urlData } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(filePath);
  return urlData.publicUrl;
}

// ---------------------------------------------------------------------------
// Image Generation (Grok)
// ---------------------------------------------------------------------------

export async function generatePostImage(
  prompt: string,
  style: ImageStyle | string = 'meme',
  scenarioContext?: string,
): Promise<string | null> {
  if (!env.xaiApiKey) {
    logger.warn('No XAI_API_KEY for Grok image generation');
    return null;
  }

  try {
    const stylePrompt = STYLE_PROMPTS[style as ImageStyle] || STYLE_PROMPTS.social_media_photo;
    const contextClause = scenarioContext
      ? `\n\nSETTING & CONTEXT: ${scenarioContext}\nEnsure people, locations, signage, and environment reflect this setting realistically.`
      : '';
    const fullPrompt = `${stylePrompt}\n\nSubject: ${prompt}${contextClause}\n\nIMPORTANT: This is for a crisis simulation training exercise. Do NOT include real people, real logos, or real brand names.`;

    const response = await fetch(`${XAI_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.xaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-imagine-image-quality',
        prompt: fullPrompt,
        n: 1,
        aspect_ratio: style === 'infographic' ? '3:4' : style === 'meme' ? '1:1' : '16:9',
        resolution: '1k',
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      logger.warn(
        { status: response.status, body: errBody.substring(0, 300) },
        'Grok image API error',
      );
      return null;
    }

    const data = await response.json();
    const imageItem = data.data?.[0];

    if (!imageItem) {
      logger.warn('Grok image API returned no data');
      return null;
    }

    // Grok may return b64_json or a URL
    if (imageItem.b64_json || imageItem.b64) {
      const b64 = imageItem.b64_json || imageItem.b64;
      const imageBuffer = Buffer.from(b64, 'base64');
      const url = await uploadToStorage(imageBuffer, 'png', 'image/png');
      logger.info({ style }, 'Generated and uploaded Grok image');
      return url;
    }

    if (imageItem.url) {
      // Download the image from the URL and re-upload to our storage
      const imgResponse = await fetch(imageItem.url);
      if (!imgResponse.ok) {
        logger.warn({ status: imgResponse.status }, 'Failed to download Grok image from URL');
        return null;
      }
      const arrayBuffer = await imgResponse.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuffer);
      const url = await uploadToStorage(imageBuffer, 'png', 'image/png');
      logger.info({ style }, 'Downloaded and uploaded Grok image');
      return url;
    }

    logger.warn({ keys: Object.keys(imageItem) }, 'Grok image API: unrecognized response format');
    return null;
  } catch (err) {
    logger.error({ err }, 'Grok image generation failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Video Generation (Grok)
// ---------------------------------------------------------------------------

export async function generateVideo(
  prompt: string,
  durationSeconds: number = 10,
  aspectRatio: string = '16:9',
  scenarioContext?: string,
): Promise<string | null> {
  if (!env.xaiApiKey) {
    logger.warn('No XAI_API_KEY for Grok video generation');
    return null;
  }

  try {
    const contextClause = scenarioContext
      ? `\n\nSETTING & CONTEXT: ${scenarioContext}\nEnsure people, locations, signage, and environment reflect this setting realistically.`
      : '';
    const fullPrompt = `${prompt}${contextClause}\n\nIMPORTANT: This is for a crisis simulation training exercise. Do NOT include real people, real logos, or real brand names.`;

    // 1. Start video generation
    const startResponse = await fetch(`${XAI_BASE}/videos/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.xaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-imagine-video',
        prompt: fullPrompt,
        duration: durationSeconds,
        resolution: '480p',
        aspect_ratio: aspectRatio,
      }),
    });

    if (!startResponse.ok) {
      const errBody = await startResponse.text().catch(() => '');
      logger.warn(
        { status: startResponse.status, body: errBody.substring(0, 300) },
        'Grok video start API error',
      );
      return null;
    }

    const startData = await startResponse.json();
    logger.info(
      {
        startResponseKeys: Object.keys(startData),
        startData: JSON.stringify(startData).substring(0, 500),
      },
      'Grok video start response',
    );
    const requestId = startData.request_id || startData.id;

    if (!requestId) {
      logger.warn(
        { startData: JSON.stringify(startData).substring(0, 500) },
        'Grok video API: no request_id returned',
      );
      return null;
    }

    logger.info(
      { requestId, durationSeconds },
      'Grok video generation started, polling for result',
    );

    // 2. Poll for completion (up to 5 minutes)
    const maxAttempts = 60;
    const pollInterval = 5000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const pollResponse = await fetch(`${XAI_BASE}/videos/${requestId}`, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.xaiApiKey}`,
        },
      });

      if (!pollResponse.ok) {
        const errBody = await pollResponse.text().catch(() => '');
        logger.warn(
          { status: pollResponse.status, attempt, body: errBody.substring(0, 300) },
          'Grok video poll error',
        );
        continue;
      }

      const pollData = await pollResponse.json();
      const status = pollData.status || pollData.state;

      // Log first 3 polls and every 10th after that for diagnostics
      if (attempt < 3 || attempt % 10 === 0) {
        logger.info(
          {
            requestId,
            attempt,
            status,
            pollKeys: Object.keys(pollData),
            pollData: JSON.stringify(pollData).substring(0, 500),
          },
          'Grok video poll response',
        );
      }

      if (status === 'failed' || status === 'error') {
        logger.warn(
          { pollData: JSON.stringify(pollData).substring(0, 500) },
          'Grok video generation failed',
        );
        return null;
      }

      if (
        status === 'completed' ||
        status === 'succeeded' ||
        status === 'done' ||
        pollData.url ||
        pollData.video_url ||
        pollData.video?.url
      ) {
        const videoUrl =
          pollData.video?.url || pollData.url || pollData.video_url || pollData.data?.url;

        if (!videoUrl) {
          logger.warn({ keys: Object.keys(pollData) }, 'Grok video completed but no URL');
          return null;
        }

        // Download and upload to storage
        const videoResponse = await fetch(videoUrl);
        if (!videoResponse.ok) {
          logger.warn({ status: videoResponse.status }, 'Failed to download Grok video');
          return null;
        }

        const arrayBuffer = await videoResponse.arrayBuffer();
        const videoBuffer = Buffer.from(arrayBuffer);
        const url = await uploadToStorage(videoBuffer, 'mp4', 'video/mp4');
        logger.info({ requestId, durationSeconds, attempt }, 'Generated and uploaded Grok video');
        return url;
      }

      logger.debug({ requestId, status, attempt }, 'Grok video still processing');
    }

    logger.warn({ requestId }, 'Grok video generation timed out after polling');
    return null;
  } catch (err) {
    logger.error({ err }, 'Grok video generation failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Video thumbnail fallback (generates image, not video)
// ---------------------------------------------------------------------------

export async function generateVideoThumbnail(videoDescription: string): Promise<string | null> {
  return generatePostImage(
    `A still frame from a video: ${videoDescription}. The image should look like a paused video player screenshot.`,
    'video_thumbnail',
  );
}

// ---------------------------------------------------------------------------
// Format -> style mapping
// ---------------------------------------------------------------------------

export function getImageStyleForFormat(postFormat: string): ImageStyle | null {
  switch (postFormat) {
    case 'humor_meme':
      return 'meme';
    case 'infographic':
      return 'infographic';
    case 'video_concept':
      return 'video_thumbnail';
    case 'personal_story':
      return 'news_photo';
    default:
      return null;
  }
}
