import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import { validatePlacement } from '../services/placementValidationService.js';
import { evaluatePlacement } from '../services/spatialScoringService.js';

const router = Router();

// GET /sessions/:id/placements — list active placements
router.get('/sessions/:id/placements', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const { data, error } = await supabaseAdmin
      .from('placed_assets')
      .select('*')
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .order('placed_at', { ascending: true });

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch placements');
      return res.status(500).json({ error: 'Failed to fetch placements' });
    }

    return res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in GET placements');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /sessions/:id/placements — create a new placement
router.post('/sessions/:id/placements', requireAuth, async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const { team_name, asset_type, label, geometry, properties } = req.body;

    if (!team_name || !asset_type || !geometry) {
      return res.status(400).json({ error: 'team_name, asset_type, and geometry are required' });
    }

    // Validate session is in progress
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('status')
      .eq('id', sessionId)
      .single();

    if (!session || session.status !== 'in_progress') {
      return res.status(400).json({ error: 'Session is not in progress' });
    }

    // Run placement validation
    const validation = await validatePlacement(
      sessionId,
      team_name,
      asset_type,
      geometry,
      properties ?? {},
    );

    if (!validation.valid) {
      return res.status(422).json({
        error: 'Placement blocked',
        blocks: validation.blocks,
        warnings: validation.warnings,
      });
    }

    // Run spatial scoring
    const spatialScore = await evaluatePlacement(sessionId, team_name, asset_type, geometry);

    const { data: placement, error } = await supabaseAdmin
      .from('placed_assets')
      .insert({
        session_id: sessionId,
        team_name,
        placed_by: user.id,
        asset_type,
        label: label || asset_type.replace(/_/g, ' '),
        geometry,
        properties: properties ?? {},
        placement_score: {
          ...validation.score_modifiers,
          overall: spatialScore.overall,
          dimensions: spatialScore.dimensions,
        },
      })
      .select()
      .single();

    if (error) {
      logger.error({ error, sessionId }, 'Failed to create placement');
      return res.status(500).json({ error: 'Failed to create placement' });
    }

    // Broadcast to session
    try {
      const ws = getWebSocketService();
      ws.broadcastToSession(sessionId, {
        type: 'placement.created',
        data: { placement, warnings: validation.warnings },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* non-blocking */
    }

    return res.status(201).json({
      data: placement,
      warnings: validation.warnings,
    });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in POST placements');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /sessions/:id/placements/:placementId — update (relocate)
router.patch('/sessions/:id/placements/:placementId', requireAuth, async (req, res) => {
  try {
    const { id: sessionId, placementId } = req.params;
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const { geometry, properties, label } = req.body;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (geometry) updates.geometry = geometry;
    if (properties) updates.properties = properties;
    if (label) updates.label = label;

    // Re-validate if geometry changed
    if (geometry) {
      const { data: existing } = await supabaseAdmin
        .from('placed_assets')
        .select('team_name, asset_type')
        .eq('id', placementId)
        .single();

      if (existing) {
        const validation = await validatePlacement(
          sessionId,
          existing.team_name,
          existing.asset_type,
          geometry,
          properties ?? {},
        );

        if (!validation.valid) {
          return res.status(422).json({
            error: 'Relocation blocked',
            blocks: validation.blocks,
            warnings: validation.warnings,
          });
        }

        const spatialScore = await evaluatePlacement(
          sessionId,
          existing.team_name,
          existing.asset_type,
          geometry,
        );
        updates.placement_score = {
          ...validation.score_modifiers,
          overall: spatialScore.overall,
          dimensions: spatialScore.dimensions,
        };
      }
    }

    const { data: updated, error } = await supabaseAdmin
      .from('placed_assets')
      .update(updates)
      .eq('id', placementId)
      .eq('session_id', sessionId)
      .select()
      .single();

    if (error) {
      logger.error({ error, placementId }, 'Failed to update placement');
      return res.status(500).json({ error: 'Failed to update placement' });
    }

    try {
      const ws = getWebSocketService();
      ws.broadcastToSession(sessionId, {
        type: 'placement.updated',
        data: { placement: updated },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* non-blocking */
    }

    return res.json({ data: updated });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in PATCH placements');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /sessions/:id/placements/:placementId — remove (soft delete)
router.delete('/sessions/:id/placements/:placementId', requireAuth, async (req, res) => {
  try {
    const { id: sessionId, placementId } = req.params;
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const { data: updated, error } = await supabaseAdmin
      .from('placed_assets')
      .update({
        status: 'removed',
        removed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', placementId)
      .eq('session_id', sessionId)
      .select()
      .single();

    if (error) {
      logger.error({ error, placementId }, 'Failed to remove placement');
      return res.status(500).json({ error: 'Failed to remove placement' });
    }

    try {
      const ws = getWebSocketService();
      ws.broadcastToSession(sessionId, {
        type: 'placement.removed',
        data: { placement: updated },
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* non-blocking */
    }

    return res.json({ data: updated });
  } catch (err) {
    logger.error({ err }, 'Unexpected error in DELETE placements');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
