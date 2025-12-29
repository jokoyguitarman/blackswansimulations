import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';

const router = Router();

router.get('/', async (req, res) => {
  const checks: Record<string, string> = {
    server: 'ok',
  };

  let overallStatus = 'ok';

  // Check Supabase connectivity
  try {
    const { error } = await supabaseAdmin.from('_health_check').select('id').limit(1);
    // Table might not exist, but connection works if no network error
    checks.supabase = error?.message.includes('relation') ? 'ok' : error ? 'degraded' : 'ok';
  } catch (err) {
    logger.error({ error: err }, 'Health check: Supabase connection failed');
    checks.supabase = 'down';
    overallStatus = 'degraded';
  }

  res.status(overallStatus === 'ok' ? 200 : 503).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
  });
});

export { router as healthRouter };
