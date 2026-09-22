import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import {
  sendEnquiryAcknowledgementEmail,
  sendEnquiryNotificationEmail,
} from '../services/emailService.js';

const router = Router();

/**
 * Public scoping-call enquiries from the marketing pages.
 *
 * Unauthenticated by design. The enquiry is persisted first and the notification
 * email sent afterwards, so a mail outage degrades to "we still have the lead"
 * rather than losing it.
 */

const enquirySchema = z.object({
  organisation: z.string().trim().min(1, 'Organisation is required').max(200),
  sector: z.string().trim().max(100).nullish(),
  contact_name: z.string().trim().min(1, 'Name is required').max(200),
  contact_email: z.string().trim().email('A valid email address is required').max(320),
  team_size: z.string().trim().max(50).nullish(),
  message: z.string().trim().max(5000).nullish(),
  source: z.string().trim().max(200).nullish(),
  // Honeypot: hidden in the form, so anything here is a bot.
  website: z.string().max(200).optional(),
});

/** Salted so the table cannot be used to confirm whether a given IP enquired. */
const hashIp = (ip: string) =>
  createHash('sha256')
    .update(`${ip}:${env.sessionSecret ?? 'enquiries'}`)
    .digest('hex')
    .slice(0, 32);

router.post('/', async (req, res) => {
  const parsed = enquirySchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Please check the form and try again.',
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const data = parsed.data;

  // Accept and discard silently: telling a bot it failed only invites a retry.
  if (data.website && data.website.trim() !== '') {
    logger.info({ organisation: data.organisation }, 'Enquiry honeypot tripped, discarding');
    return res.status(202).json({ received: true });
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? null;

  try {
    const { data: inserted, error } = await supabaseAdmin
      .from('enquiries')
      .insert({
        organisation: data.organisation,
        sector: data.sector ?? null,
        contact_name: data.contact_name,
        contact_email: data.contact_email,
        team_size: data.team_size ?? null,
        message: data.message ?? null,
        source: data.source ?? null,
        ip_hash: ip ? hashIp(ip) : null,
        user_agent: req.headers['user-agent']?.slice(0, 500) ?? null,
      })
      .select('id')
      .single();

    if (error) throw error;

    const emailData = {
      enquiryId: inserted.id,
      organisation: data.organisation,
      sector: data.sector,
      contactName: data.contact_name,
      contactEmail: data.contact_email,
      teamSize: data.team_size,
      message: data.message,
      source: data.source,
    };

    // The enquiry is safe at this point, so an email failure is logged and still
    // reported as success rather than asking the visitor to submit twice. Both go
    // out together: one failing must not stop the other.
    const [notified, acknowledged] = await Promise.all([
      sendEnquiryNotificationEmail(emailData),
      sendEnquiryAcknowledgementEmail(emailData),
    ]);

    const stamps: Record<string, string> = {};
    if (notified) stamps.notified_at = new Date().toISOString();
    if (acknowledged) stamps.acknowledged_at = new Date().toISOString();
    if (Object.keys(stamps).length > 0) {
      await supabaseAdmin.from('enquiries').update(stamps).eq('id', inserted.id);
    }

    if (!notified) {
      logger.error(
        { enquiryId: inserted.id },
        'Enquiry stored but team notification failed - follow up manually',
      );
    }
    if (!acknowledged) {
      logger.warn(
        { enquiryId: inserted.id },
        'Enquiry stored but the enquirer was not acknowledged',
      );
    }

    logger.info(
      {
        enquiryId: inserted.id,
        organisation: data.organisation,
        source: data.source,
        notified,
        acknowledged,
      },
      'Enquiry received',
    );

    return res.status(201).json({ received: true, id: inserted.id });
  } catch (err) {
    logger.error({ error: err, organisation: data.organisation }, 'Failed to record enquiry');
    return res.status(500).json({
      error: `Something went wrong on our end. Please email ${env.enquiryNotifyEmail} and we will pick it up.`,
    });
  }
});

export { router as contactRouter };
