import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from '../services/websocketService.js';
import { recordPlayerAction } from '../services/sopCheckerService.js';

const router = Router();

// ─── List Events for Session ─────────────────────────────────────────────────

router.get('/session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const platformFilter = req.query.platform as string | undefined;

    let query = supabaseAdmin
      .from('sim_events')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false });

    if (platformFilter) {
      query = query.eq('platform', platformFilter);
    }

    const { data, error } = await query;

    if (error) {
      logger.error({ error, sessionId }, 'Failed to fetch events');
      return res.status(500).json({ error: 'Failed to fetch events' });
    }

    res.json({ data });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /events/session/:sessionId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Get Event Details ───────────────────────────────────────────────────────

router.get('/:eventId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { eventId } = req.params;

    const [eventResult, discussionsResult, responseResult] = await Promise.all([
      supabaseAdmin.from('sim_events').select('*').eq('id', eventId).single(),
      supabaseAdmin
        .from('sim_event_discussions')
        .select('*')
        .eq('event_id', eventId)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('sim_event_responses')
        .select('response')
        .eq('event_id', eventId)
        .eq('user_id', user.id)
        .single(),
    ]);

    if (eventResult.error || !eventResult.data) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json({
      data: {
        ...eventResult.data,
        discussions: discussionsResult.data || [],
        my_response: responseResult.data?.response || null,
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'Error in GET /events/:eventId');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Create Event ────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { session_id, title, description, event_type, location, event_date, platform } = req.body;

    let playerName = user.metadata?.full_name as string | undefined;
    if (!playerName) {
      const { data: profile } = await supabaseAdmin
        .from('user_profiles')
        .select('full_name')
        .eq('id', user.id)
        .single();
      playerName = profile?.full_name || undefined;
    }
    const displayName = playerName || user.email || 'Player';
    const handle = `@${(playerName || user.email || user.id.slice(0, 8)).replace(/[@.\s+,]/g, '_').toLowerCase()}`;

    const { data: event, error } = await supabaseAdmin
      .from('sim_events')
      .insert({
        session_id,
        title,
        description: description || null,
        event_type,
        location: location || null,
        event_date: event_date || null,
        organizer_handle: handle,
        organizer_display_name: displayName,
        organizer_type: 'player',
        interested_count: 0,
        going_count: 0,
        platform: platform || 'facebook',
        discussion_post_count: 0,
      })
      .select()
      .single();

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to create event');
      return res.status(500).json({ error: 'Failed to create event' });
    }

    await recordPlayerAction(session_id, user.id, 'event_created', event.id, title);

    getWebSocketService().broadcastToSession(session_id, {
      type: 'event.created',
      data: { event },
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ data: event });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /events');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Respond to Event ────────────────────────────────────────────────────────

router.post('/:eventId/respond', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { eventId } = req.params;
    const { response } = req.body;

    let playerName = user.metadata?.full_name as string | undefined;
    if (!playerName) {
      const { data: profile } = await supabaseAdmin
        .from('user_profiles')
        .select('full_name')
        .eq('id', user.id)
        .single();
      playerName = profile?.full_name || undefined;
    }
    const handle = `@${(playerName || user.email || user.id.slice(0, 8)).replace(/[@.\s+,]/g, '_').toLowerCase()}`;

    // Fetch current response to compute count deltas
    const { data: existing } = await supabaseAdmin
      .from('sim_event_responses')
      .select('response')
      .eq('event_id', eventId)
      .eq('user_id', user.id)
      .single();

    const oldResponse = existing?.response as string | null;

    // Upsert the response
    const { error: upsertError } = await supabaseAdmin
      .from('sim_event_responses')
      .upsert(
        { event_id: eventId, user_id: user.id, handle, response },
        { onConflict: 'event_id,user_id' },
      );

    if (upsertError) {
      logger.error({ error: upsertError }, 'Failed to upsert event response');
      return res.status(500).json({ error: 'Failed to respond to event' });
    }

    // Update counts on the event
    const { data: event } = await supabaseAdmin
      .from('sim_events')
      .select('going_count, interested_count, session_id')
      .eq('id', eventId)
      .single();

    if (event) {
      let goingDelta = 0;
      let interestedDelta = 0;

      if (oldResponse === 'going') goingDelta--;
      if (oldResponse === 'interested') interestedDelta--;
      if (response === 'going') goingDelta++;
      if (response === 'interested') interestedDelta++;

      await supabaseAdmin
        .from('sim_events')
        .update({
          going_count: Math.max(0, (event.going_count || 0) + goingDelta),
          interested_count: Math.max(0, (event.interested_count || 0) + interestedDelta),
        })
        .eq('id', eventId);

      await recordPlayerAction(event.session_id, user.id, 'event_responded', eventId, null, {
        response,
      });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /events/:eventId/respond');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Post in Event Discussion ────────────────────────────────────────────────

router.post('/:eventId/discuss', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const { eventId } = req.params;
    const { session_id, content } = req.body;

    let playerName = user.metadata?.full_name as string | undefined;
    if (!playerName) {
      const { data: profile } = await supabaseAdmin
        .from('user_profiles')
        .select('full_name')
        .eq('id', user.id)
        .single();
      playerName = profile?.full_name || undefined;
    }
    const displayName = playerName || user.email || 'Player';
    const handle = `@${(playerName || user.email || user.id.slice(0, 8)).replace(/[@.\s+,]/g, '_').toLowerCase()}`;

    const { data: discussion, error } = await supabaseAdmin
      .from('sim_event_discussions')
      .insert({
        event_id: eventId,
        session_id,
        author_handle: handle,
        author_display_name: displayName,
        author_type: 'player',
        content,
        like_count: 0,
      })
      .select()
      .single();

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to post event discussion');
      return res.status(500).json({ error: 'Failed to post discussion' });
    }

    // Increment discussion_post_count on the event
    const { data: event } = await supabaseAdmin
      .from('sim_events')
      .select('discussion_post_count')
      .eq('id', eventId)
      .single();

    if (event) {
      await supabaseAdmin
        .from('sim_events')
        .update({ discussion_post_count: (event.discussion_post_count || 0) + 1 })
        .eq('id', eventId);
    }

    await recordPlayerAction(session_id, user.id, 'event_discussed', eventId, content);

    getWebSocketService().broadcastToSession(session_id, {
      type: 'event.discussion',
      data: { discussion, event_id: eventId },
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ data: discussion });
  } catch (err) {
    logger.error({ error: err }, 'Error in POST /events/:eventId/discuss');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as socialEventsRouter };
