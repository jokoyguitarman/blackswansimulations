/**
 * Storage helpers for scenario assets (e.g. generated map images).
 * Bucket 'scenario-assets' must exist (see migrations/065_scenario_assets_bucket.sql).
 */

import { supabaseAdmin } from './supabaseAdmin.js';
import { logger } from './logger.js';

const SCENARIO_ASSETS_BUCKET = 'scenario-assets';
const RTS_SCENE_IMAGES_BUCKET = 'rts-scene-images';

/**
 * Upload a scenario map image to Supabase Storage and return its public URL.
 * @param buffer - PNG/JPEG buffer
 * @param path - Object path within bucket (e.g. "{scenarioId}/vicinity.png")
 * @param contentType - e.g. "image/png"
 */
export async function uploadScenarioMap(
  buffer: Buffer,
  path: string,
  contentType: string = 'image/png',
): Promise<string> {
  const { data, error } = await supabaseAdmin.storage
    .from(SCENARIO_ASSETS_BUCKET)
    .upload(path, buffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    logger.error({ error, path }, 'Failed to upload scenario map to storage');
    throw error;
  }

  const { data: urlData } = supabaseAdmin.storage
    .from(SCENARIO_ASSETS_BUCKET)
    .getPublicUrl(data.path);

  logger.info({ path: data.path }, 'Scenario map uploaded to storage');
  return urlData.publicUrl;
}

/**
 * Upload an RTS scene image (Street View cache, trainer photo, DALL-E image)
 * to Supabase Storage and return its public URL.
 */
export async function uploadRtsSceneImage(
  buffer: Buffer,
  sceneId: string,
  key: string,
  contentType: string = 'image/jpeg',
): Promise<string> {
  const path = `${sceneId}/${key}.jpg`;
  const { data, error } = await supabaseAdmin.storage
    .from(RTS_SCENE_IMAGES_BUCKET)
    .upload(path, buffer, { contentType, upsert: true });

  if (error) {
    logger.error({ error, path }, 'Failed to upload RTS scene image');
    throw error;
  }

  const { data: urlData } = supabaseAdmin.storage
    .from(RTS_SCENE_IMAGES_BUCKET)
    .getPublicUrl(data.path);

  return urlData.publicUrl;
}
