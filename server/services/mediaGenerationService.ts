import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { randomUUID } from 'crypto';

type ImageStyle = 'meme' | 'news_photo' | 'infographic' | 'evidence_photo' | 'video_thumbnail';

const STYLE_CONFIG: Record<ImageStyle, { size: string; prefix: string }> = {
  meme: {
    size: '1024x1024',
    prefix:
      'A social media meme image. Bold text overlay style. Shareable and eye-catching. No watermarks.',
  },
  news_photo: {
    size: '1792x1024',
    prefix:
      'A realistic news photograph. Photojournalistic style, high quality, looks like it was taken by a reporter on scene.',
  },
  infographic: {
    size: '1024x1792',
    prefix:
      'A clean, professional infographic. Data visualization style with clear typography and organized layout.',
  },
  evidence_photo: {
    size: '1024x1024',
    prefix:
      'A social media photo that looks like it was taken by a bystander with a phone. Slightly blurry, candid angle, realistic lighting.',
  },
  video_thumbnail: {
    size: '1792x1024',
    prefix:
      'A cinematic video still frame. 16:9 aspect ratio. Looks like a paused video with dramatic lighting and composition.',
  },
};

const BUCKET_NAME = 'sim-media';

async function ensureBucket(): Promise<void> {
  const { error } = await supabaseAdmin.storage.getBucket(BUCKET_NAME);
  if (error) {
    await supabaseAdmin.storage.createBucket(BUCKET_NAME, {
      public: true,
      fileSizeLimit: 10 * 1024 * 1024,
    });
  }
}

let bucketReady = false;

export async function generatePostImage(
  prompt: string,
  style: ImageStyle = 'meme',
): Promise<string | null> {
  if (!env.openAiApiKey) {
    logger.warn('No OpenAI API key for image generation');
    return null;
  }

  try {
    const config = STYLE_CONFIG[style] || STYLE_CONFIG.meme;
    const fullPrompt = `${config.prefix}\n\nSubject: ${prompt}\n\nIMPORTANT: This is for a crisis simulation training exercise. Do NOT include real people, real logos, or real brand names. The image should look realistic but be clearly fictional.`;

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: fullPrompt,
        n: 1,
        size: config.size,
        quality: 'standard',
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      logger.warn(
        { status: response.status, body: errBody.substring(0, 200) },
        'Image generation API error',
      );
      return null;
    }

    const data = await response.json();
    const b64 = data.data?.[0]?.b64 || data.data?.[0]?.b64_json;
    if (!b64) {
      logger.warn({ keys: Object.keys(data.data?.[0] || {}) }, 'Image API returned no image data');
      return null;
    }

    const imageBuffer = Buffer.from(b64, 'base64');
    const fileName = `${randomUUID()}.png`;
    const filePath = `generated/${fileName}`;

    if (!bucketReady) {
      await ensureBucket();
      bucketReady = true;
    }

    const { error: uploadErr } = await supabaseAdmin.storage
      .from(BUCKET_NAME)
      .upload(filePath, imageBuffer, {
        contentType: 'image/png',
        cacheControl: '3600',
      });

    if (uploadErr) {
      logger.warn({ error: uploadErr }, 'Failed to upload generated image to storage');
      return null;
    }

    const { data: urlData } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(filePath);

    logger.info({ style, filePath }, 'Generated and uploaded post image');
    return urlData.publicUrl;
  } catch (err) {
    logger.error({ err }, 'Image generation failed');
    return null;
  }
}

export async function generateVideoThumbnail(videoDescription: string): Promise<string | null> {
  return generatePostImage(
    `A still frame from a video: ${videoDescription}. The image should look like a paused video player screenshot.`,
    'video_thumbnail',
  );
}

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
