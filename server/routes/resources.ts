import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { validate, schemas } from '../lib/validation.js';
import { getWebSocketService } from '../services/websocketService.js';
import { logAndBroadcastEvent } from '../services/eventService.js';
import { io } from '../index.js';

const router = Router();

const createResourceRequestSchema = z.object({
  body: z.object({
    session_id: z.string().uuid(),
    resource_type: z.string(),
    quantity: z.number().int().positive(),
    from_agency: z.string(),
    to_agency: z.string(),
    conditions: z.string().optional(),
  }),
});

const updateResourceRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'countered', 'cancelled']).optional(),
    counter_offer: z
      .object({
        quantity: z.number().int().positive().optional(),
        conditions: z.string().optional(),
      })
      .optional(),
  }),
});

// Get resources for a session
router.get('/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const user = req.user!;

    // Verify session access
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, trainer_id')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Get agency resources
    const { data: resources, error: resourcesError } = await supabaseAdmin
      .from('agency_resources')
      .select('*')
      .eq('session_id', sessionId);

    if (resourcesError) {
      logger.error({ error: resourcesError, sessionId }, 'Failed to fetch resources');
      return res.status(500).json({ error: 'Failed to fetch resources' });
    }

    // Get resource requests
    const { data: requests, error: requestsError } = await supabaseAdmin
      .from('resource_requests')
      .select(
        '*, requester:user_profiles!resource_requests_requester_id_fkey(id, full_name, agency_name)',
      )
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false });

    if (requestsError) {
      logger.error({ error: requestsError, sessionId }, 'Failed to fetch resource requests');
      return res.status(500).json({ error: 'Failed to fetch resource requests' });
    }

    res.json({ data: { resources, requests } });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /resources/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create resource request
router.post(
  '/request',
  requireAuth,
  validate(createResourceRequestSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { session_id, resource_type, quantity, from_agency, to_agency, conditions } = req.body;

      // Verify session access
      const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('id, status')
        .eq('id', session_id)
        .single();

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.status !== 'in_progress') {
        return res.status(400).json({ error: 'Session is not active' });
      }

      // Verify user's agency matches requester agency
      if (user.agency !== to_agency) {
        return res
          .status(403)
          .json({ error: 'You can only request resources for your own agency' });
      }

      const { data, error } = await supabaseAdmin
        .from('resource_requests')
        .insert({
          session_id,
          requester_id: user.id,
          resource_type,
          quantity,
          from_agency,
          to_agency,
          conditions,
          status: 'pending',
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create resource request');
        return res.status(500).json({ error: 'Failed to create resource request' });
      }

      // Get full request with requester info for WebSocket
      const { data: fullRequest } = await supabaseAdmin
        .from('resource_requests')
        .select(
          '*, requester:user_profiles!resource_requests_requester_id_fkey(id, full_name, agency_name)',
        )
        .eq('id', data.id)
        .single();

      // Broadcast resource request event
      getWebSocketService().resourceRequested(session_id, fullRequest || data);

      // Log event
      await logAndBroadcastEvent(
        io,
        session_id,
        'resource',
        {
          request_id: data.id,
          resource_type: data.resource_type,
          quantity: data.quantity,
          from_agency: data.from_agency,
          to_agency: data.to_agency,
          requester: fullRequest?.requester || { id: user.id },
        },
        user.id,
      );

      logger.info({ requestId: data.id, userId: user.id }, 'Resource request created');
      res.status(201).json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in POST /resources/request');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Update resource request (approve/reject/counter)
router.patch(
  '/request/:id',
  requireAuth,
  validate(updateResourceRequestSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id } = req.params;
      const user = req.user!;
      const { status, counter_offer } = req.body;

      // Get request
      const { data: request } = await supabaseAdmin
        .from('resource_requests')
        .select('*, session:sessions!resource_requests_session_id_fkey(status)')
        .eq('id', id)
        .single();

      if (!request) {
        return res.status(404).json({ error: 'Resource request not found' });
      }

      // Verify user's agency matches from_agency (resource owner)
      if (user.agency !== request.from_agency) {
        return res
          .status(403)
          .json({ error: "You can only respond to requests for your agency's resources" });
      }

      // Verify session is active
      if (request.session.status !== 'in_progress') {
        return res.status(400).json({ error: 'Session is not active' });
      }

      const updates: Record<string, unknown> = {};
      if (status) {
        updates.status = status;
        if (status === 'approved' || status === 'rejected') {
          updates.responded_at = new Date().toISOString();
          updates.responder_id = user.id;
        }
      }
      if (counter_offer) {
        updates.counter_quantity = counter_offer.quantity;
        updates.counter_conditions = counter_offer.conditions;
        updates.status = 'countered';
      }

      const { data, error } = await supabaseAdmin
        .from('resource_requests')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        logger.error({ error, requestId: id }, 'Failed to update resource request');
        return res.status(500).json({ error: 'Failed to update resource request' });
      }

      // If approved, create allocation
      if (status === 'approved') {
        await supabaseAdmin.from('resource_allocations').insert({
          session_id: request.session_id,
          resource_type: request.resource_type,
          quantity: request.quantity,
          from_agency: request.from_agency,
          to_agency: request.to_agency,
          allocated_at: new Date().toISOString(),
        });

        // Broadcast resource transfer
        getWebSocketService().resourceTransferred(request.session_id, {
          request_id: id,
          resource_type: request.resource_type,
          quantity: request.quantity,
          from_agency: request.from_agency,
          to_agency: request.to_agency,
        });
      }

      // Get full request for WebSocket
      const { data: fullRequest } = await supabaseAdmin
        .from('resource_requests')
        .select(
          '*, requester:user_profiles!resource_requests_requester_id_fkey(id, full_name, agency_name)',
        )
        .eq('id', id)
        .single();

      // Broadcast resource update
      if (status === 'approved') {
        getWebSocketService().resourceApproved(request.session_id, fullRequest || data);
      } else if (status === 'rejected') {
        getWebSocketService().resourceRejected(request.session_id, fullRequest || data);
      } else if (status === 'countered') {
        getWebSocketService().resourceCountered(request.session_id, fullRequest || data);
      }

      // Log event
      await logAndBroadcastEvent(
        io,
        request.session_id,
        'resource',
        {
          request_id: id,
          status,
          counter_offer: counter_offer || null,
          responder: { id: user.id, role: user.role },
        },
        user.id,
      );

      logger.info({ requestId: id, status, userId: user.id }, 'Resource request updated');
      res.json({ data });
    } catch (err) {
      logger.error({ error: err }, 'Error in PATCH /resources/request/:id');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export { router as resourcesRouter };
