import nodemailer from 'nodemailer';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import {
  APPLICATION_REVIEW_TIME,
  type TrainerAgreementPurpose,
} from '../../shared/trainerAgreements.js';

/**
 * Email Service - Handles sending emails via SMTP
 * Separation of concerns: All email-related logic
 */

let transporter: nodemailer.Transporter | null = null;

const initializeTransporter = () => {
  if (!env.emailEnabled) {
    logger.info('Email service disabled (EMAIL_ENABLED=false)');
    return null;
  }

  if (!env.smtpUser || !env.smtpPass) {
    logger.warn('SMTP credentials not configured, emails will be logged only');
    return null;
  }

  try {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure, // true for 465, false for other ports
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass,
      },
    });

    logger.info({ host: env.smtpHost, port: env.smtpPort }, 'Email transporter initialized');
    return transporter;
  } catch (error) {
    logger.error({ error }, 'Failed to initialize email transporter');
    return null;
  }
};

// Initialize on module load
transporter = initializeTransporter();

interface InvitationEmailData {
  to: string;
  toName: string;
  sessionTitle: string;
  scenarioTitle: string;
  assignedRole: string;
  sessionId: string;
  scheduledStartTime?: string;
  trainerName: string;
}

interface PendingInvitationEmailData {
  to: string;
  sessionTitle: string;
  scenarioTitle: string;
  assignedRole: string;
  invitationToken: string;
  scheduledStartTime?: string;
  trainerName: string;
}

/**
 * Send session invitation email
 */
export const sendInvitationEmail = async (data: InvitationEmailData): Promise<boolean> => {
  try {
    const sessionUrl = `${env.clientUrl}/sessions/${data.sessionId}`;
    const scheduledTimeText = data.scheduledStartTime
      ? `\nScheduled Start Time: ${new Date(data.scheduledStartTime).toLocaleString()}`
      : '';

    const emailContent = `
You have been invited to participate in a simulation exercise.

Session: ${data.sessionTitle}
Scenario: ${data.scenarioTitle}
Assigned Role: ${data.assignedRole}
Trainer: ${data.trainerName}${scheduledTimeText}

Join the session: ${sessionUrl}

Please review the briefing materials and mark yourself as ready before the session begins.

---
This is an automated message from the Simulation Environment.
`;

    if (!transporter) {
      // Log email instead of sending
      logger.info(
        {
          to: data.to,
          subject: `Invitation: ${data.sessionTitle}`,
          content: emailContent,
        },
        'Email would be sent (email disabled)',
      );
      return true; // Return true so flow continues
    }

    const info = await transporter.sendMail({
      from: `"${env.emailFromName}" <${env.emailFrom}>`,
      to: data.to,
      subject: `Invitation: ${data.sessionTitle}`,
      text: emailContent,
    });

    logger.info({ messageId: info.messageId, to: data.to }, 'Invitation email sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Failed to send invitation email');
    return false;
  }
};

/**
 * Send invitation email to non-registered user (with signup link)
 */
export const sendPendingInvitationEmail = async (
  data: PendingInvitationEmailData,
): Promise<boolean> => {
  try {
    const signupUrl = `${env.clientUrl}/signup?invite=${data.invitationToken}`;
    const scheduledTimeText = data.scheduledStartTime
      ? `\nScheduled Start Time: ${new Date(data.scheduledStartTime).toLocaleString()}`
      : '';

    const emailContent = `
You have been invited to participate in a simulation exercise.

Session: ${data.sessionTitle}
Scenario: ${data.scenarioTitle}
Assigned Role: ${data.assignedRole}
Trainer: ${data.trainerName}${scheduledTimeText}

To join this session, please sign up using the link below:
${signupUrl}

After signing up, you will automatically be added to the session and can review the briefing materials.

This invitation will expire in 30 days.

---
This is an automated message from the Simulation Environment.
`;

    if (!transporter) {
      // Log email instead of sending
      logger.info(
        {
          to: data.to,
          subject: `Invitation: ${data.sessionTitle}`,
          content: emailContent,
        },
        'Email would be sent (email disabled)',
      );
      return true; // Return true so flow continues
    }

    const info = await transporter.sendMail({
      from: `"${env.emailFromName}" <${env.emailFrom}>`,
      to: data.to,
      subject: `Invitation: ${data.sessionTitle}`,
      text: emailContent,
      html: `
        <div style="font-family: monospace; background-color: #000; color: #FFB800; padding: 20px; border: 2px solid #FF6B35;">
          <h2 style="color: #FFB800; text-transform: uppercase;">SIMULATION INVITATION</h2>
          <p>You have been invited to participate in a simulation exercise.</p>
          <div style="margin: 20px 0; padding: 15px; background-color: #1a1a1a; border-left: 3px solid #FF6B35;">
            <p><strong>Session:</strong> ${data.sessionTitle}</p>
            <p><strong>Scenario:</strong> ${data.scenarioTitle}</p>
            <p><strong>Assigned Role:</strong> ${data.assignedRole}</p>
            <p><strong>Trainer:</strong> ${data.trainerName}</p>
            ${scheduledTimeText ? `<p><strong>Scheduled Start:</strong> ${new Date(data.scheduledStartTime!).toLocaleString()}</p>` : ''}
          </div>
          <p>To join this session, please sign up using the link below:</p>
          <p style="margin: 20px 0;">
            <a href="${signupUrl}" style="display: inline-block; padding: 12px 24px; background-color: #FF6B35; color: #000; text-decoration: none; font-weight: bold; text-transform: uppercase;">
              [SIGN UP TO JOIN]
            </a>
          </p>
          <p style="font-size: 12px; color: #888;">After signing up, you will automatically be added to the session.</p>
          <p style="font-size: 12px; color: #888;">This invitation will expire in 30 days.</p>
        </div>
      `,
    });

    logger.info({ messageId: info.messageId, to: data.to }, 'Pending invitation email sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Failed to send pending invitation email');
    return false;
  }
};

interface TrainerEnrollmentEmailData {
  to: string;
  toName: string;
  temporaryPassword: string;
  enrolledByName: string;
}

/**
 * Send credentials to a trainer enrolled by an admin (payment portal).
 */
export const sendTrainerEnrollmentEmail = async (
  data: TrainerEnrollmentEmailData,
): Promise<boolean> => {
  try {
    const loginUrl = `${env.clientUrl}/login`;

    const emailContent = `
You have been enrolled as a trainer on Prophyion by ${data.enrolledByName}.

Your trainer account is ready:

Email: ${data.to}
Temporary password: ${data.temporaryPassword}

Sign in here: ${loginUrl}

As a trainer you can enroll your client organisations, invoice them for
training engagements, build scenarios in the War Room, and run live training
sessions. Please change your password after your first sign-in.

Before your first engagement, please review and sign the Prophyion Consultant
Agreement: ${env.clientUrl}/apply

---
This is an automated message from Prophyion.
`;

    if (!transporter) {
      logger.info(
        { to: data.to, subject: 'Your Prophyion trainer account' },
        'Email would be sent (email disabled)',
      );
      return false; // credentials NOT delivered - caller must surface them to the admin
    }

    const info = await transporter.sendMail({
      from: `"${env.emailFromName}" <${env.emailFrom}>`,
      to: data.to,
      subject: 'Your Prophyion trainer account',
      text: emailContent,
      html: `
        <div style="font-family: -apple-system, 'Segoe UI', sans-serif; color: #172033; padding: 24px; border: 1px solid #E4DFD4; border-radius: 12px; max-width: 520px;">
          <h2 style="color: #1E3A5F; margin-top: 0;">Welcome to Prophyion</h2>
          <p>You have been enrolled as a <strong>trainer</strong> by ${data.enrolledByName}.</p>
          <div style="margin: 20px 0; padding: 14px 16px; background-color: #F4F1EA; border-left: 3px solid #D97706; border-radius: 6px;">
            <p style="margin: 4px 0;"><strong>Email:</strong> ${data.to}</p>
            <p style="margin: 4px 0;"><strong>Temporary password:</strong> <code>${data.temporaryPassword}</code></p>
          </div>
          <p style="margin: 20px 0;">
            <a href="${loginUrl}" style="display: inline-block; padding: 11px 22px; background-color: #D97706; color: #fff; text-decoration: none; font-weight: 600; border-radius: 8px;">
              Sign in
            </a>
          </p>
          <p style="font-size: 13px; color: #6B7280;">As a trainer you can enroll your client organisations, invoice them for training engagements, build scenarios in the War Room, and run live training sessions.</p>
          <p style="font-size: 13px; color: #6B7280;">Please change your password after your first sign-in.</p>
          <p style="font-size: 13px; color: #6B7280;">Before your first engagement, please review and sign the <a href="${env.clientUrl}/apply" style="color: #1E3A5F;">Prophyion Consultant Agreement</a>.</p>
        </div>
      `,
    });

    logger.info({ messageId: info.messageId, to: data.to }, 'Trainer enrollment email sent');
    return true;
  } catch (error) {
    logger.error({ error, to: data.to }, 'Failed to send trainer enrollment email');
    return false;
  }
};

interface EnquiryNotificationData {
  enquiryId: string;
  organisation: string;
  sector?: string | null;
  contactName: string;
  contactEmail: string;
  teamSize?: string | null;
  message?: string | null;
  source?: string | null;
}

/**
 * Notify the team that a scoping-call enquiry has arrived.
 *
 * The enquiry is already stored before this runs, so a false return means the
 * notification failed rather than the enquiry being lost.
 */
export const sendEnquiryNotificationEmail = async (
  data: EnquiryNotificationData,
): Promise<boolean> => {
  const subject = `Scoping call enquiry: ${data.organisation}`;
  const emailContent = `New scoping-call enquiry from the marketing site.

Organisation: ${data.organisation}
Contact:      ${data.contactName} <${data.contactEmail}>
Sector:       ${data.sector || 'not given'}
Participants: ${data.teamSize || 'not given'}
Submitted on: ${data.source || 'unknown page'}

What they want to rehearse:
${data.message?.trim() || 'Nothing written.'}

---
Reply directly to ${data.contactEmail}.
Enquiry reference: ${data.enquiryId}
`;

  try {
    if (!transporter) {
      logger.info(
        { to: env.enquiryNotifyEmail, subject, content: emailContent },
        'Enquiry notification would be sent (email disabled)',
      );
      return true;
    }

    const info = await transporter.sendMail({
      from: `"${env.emailFromName}" <${env.emailFrom}>`,
      to: env.enquiryNotifyEmail,
      // Lets the team hit reply and reach the enquirer directly.
      replyTo: `"${data.contactName}" <${data.contactEmail}>`,
      subject,
      text: emailContent,
    });

    logger.info(
      { messageId: info.messageId, enquiryId: data.enquiryId },
      'Enquiry notification email sent',
    );
    return true;
  } catch (error) {
    logger.error({ error, enquiryId: data.enquiryId }, 'Failed to send enquiry notification');
    return false;
  }
};

/**
 * Acknowledge the enquiry to the person who sent it.
 *
 * Separate from the internal notification on purpose: this one is read by a
 * prospect, so it carries the reference they can quote and sets the expectation
 * for when a human replies. Failure is never surfaced to the visitor, because the
 * enquiry is already safely stored by the time this runs.
 */
export const sendEnquiryAcknowledgementEmail = async (
  data: EnquiryNotificationData,
): Promise<boolean> => {
  const reference = data.enquiryId.slice(0, 8).toUpperCase();
  const subject = 'We have your enquiry | Prophyion';
  const emailContent = `Dear ${data.contactName},

Thank you for getting in touch. We have your enquiry about a crisis simulation
for ${data.organisation}, and a risk consultant is reading it rather than an
automated system.

What happens next:

  1. We review what you told us and come back to arrange a scoping call.
     Expect to hear from us within one business day.
  2. The call takes about thirty minutes. We use it to understand your exposure,
     who would be involved, and what you need to be able to prove.
  3. We then send a scenario outline and a recommended format. Nothing gets
     built until you have approved it.

If anything has changed, or you would like to add to what you sent, simply reply
to this email and it will reach us directly.

Your reference is ${reference}.

Kind regards,
Prophyion

---
Prophyion | Unified Simulation Environment
Exercise scenarios are fictional and non-operational.
`;

  try {
    if (!transporter) {
      logger.info(
        { to: data.contactEmail, subject, content: emailContent },
        'Enquiry acknowledgement would be sent (email disabled)',
      );
      return true;
    }

    const info = await transporter.sendMail({
      from: `"${env.emailFromName}" <${env.emailFrom}>`,
      to: data.contactEmail,
      // Replies go to the team, not to the unattended from-address.
      replyTo: env.enquiryNotifyEmail,
      subject,
      text: emailContent,
    });

    logger.info(
      { messageId: info.messageId, enquiryId: data.enquiryId },
      'Enquiry acknowledgement email sent',
    );
    return true;
  } catch (error) {
    logger.error({ error, enquiryId: data.enquiryId }, 'Failed to send enquiry acknowledgement');
    return false;
  }
};

// ---------------------------------------------------------------------------
// Consultant Agreement: applications and signed agreements
// ---------------------------------------------------------------------------

interface PlainEmail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

/** Returns false when the email was not delivered, including when email is switched off. */
async function deliver(
  message: PlainEmail,
  label: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  if (!transporter) {
    logger.info(
      { ...context, to: message.to, subject: message.subject },
      `${label} email would be sent (email disabled)`,
    );
    return false;
  }
  try {
    const info = await transporter.sendMail({
      from: `"${env.emailFromName}" <${env.emailFrom}>`,
      ...message,
    });
    logger.info({ ...context, messageId: info.messageId }, `${label} email sent`);
    return true;
  } catch (error) {
    logger.error({ ...context, error }, `Failed to send ${label.toLowerCase()} email`);
    return false;
  }
}

interface AgreementEmailData {
  to: string;
  toName: string;
  reference: string;
  purpose: TrainerAgreementPurpose;
}

/** Confirm to the uploader that their signed agreement arrived and say what happens next. */
export const sendAgreementReceivedEmail = async (data: AgreementEmailData): Promise<boolean> => {
  const isApplication = data.purpose === 'application';
  const next = isApplication
    ? `We review every application personally and aim to respond within
${APPLICATION_REVIEW_TIME}. We will email you at this address when your consultant
account is approved, or if anything needs changing first.`
    : `We will check it and confirm by email once it is on file. Your trainer
access carries on as normal in the meantime.`;

  return deliver(
    {
      to: data.to,
      replyTo: env.trainerApplicationsNotifyEmail,
      subject: isApplication
        ? 'We have your consultant application | Prophyion'
        : 'We have your signed agreement | Prophyion',
      text: `Dear ${data.toName},

Thank you. We have received your signed Prophyion Consultant Agreement
(reference ${data.reference}).

${next}

You can check where things stand at any time: ${env.clientUrl}/apply

Kind regards,
Prophyion
`,
    },
    'Agreement receipt',
    { reference: data.reference },
  );
};

interface AgreementSubmittedData {
  reference: string;
  purpose: TrainerAgreementPurpose;
  fullName: string;
  email: string;
  contactNumber: string | null;
  organisation: string | null;
  address: string | null;
  pageCount: number;
  expectedPages: number | null;
  hasReference: boolean | null;
}

/** Tell the team a signed agreement is waiting in the Business console. */
export const sendAgreementSubmittedNotificationEmail = async (
  data: AgreementSubmittedData,
): Promise<boolean> => {
  const isApplication = data.purpose === 'application';
  const pages = data.expectedPages
    ? `${data.pageCount} of ${data.expectedPages} expected`
    : String(data.pageCount);
  const referenceCheck =
    data.hasReference === null
      ? 'not readable (a scanned copy, check it by eye)'
      : data.hasReference
        ? 'found'
        : 'NOT found, check this is the agreement we issued';

  return deliver(
    {
      to: env.trainerApplicationsNotifyEmail,
      replyTo: `"${data.fullName}" <${data.email}>`,
      subject: isApplication
        ? `Consultant application: ${data.fullName}`
        : `Signed agreement from trainer: ${data.fullName}`,
      text: `${isApplication ? 'A new consultant application' : 'A signed agreement from an existing trainer'} is ready for review.

Name:          ${data.fullName}
Email:         ${data.email}
Contact:       ${data.contactNumber || 'not given'}
Organisation:  ${data.organisation || 'not given'}
Address:       ${data.address || 'not given'}
Reference:     ${data.reference}
Pages:         ${pages}
Reference in the file: ${referenceCheck}

Review it in the Business console: ${env.clientUrl}/admin/trainers

---
Reply directly to ${data.email}.
`,
    },
    'Agreement review notification',
    { reference: data.reference },
  );
};

interface AgreementDecisionData extends AgreementEmailData {
  decision: 'approved' | 'changes_requested' | 'rejected';
  note: string | null;
}

/** Tell the uploader what the reviewer decided. */
export const sendAgreementDecisionEmail = async (data: AgreementDecisionData): Promise<boolean> => {
  const isApplication = data.purpose === 'application';
  const note = data.note?.trim() || null;
  let subject: string;
  let body: string;

  switch (data.decision) {
    case 'approved':
      if (isApplication) {
        subject = 'Your Prophyion consultant account is approved';
        body = `Your application has been approved and your account now has consultant access.

Sign in here: ${env.clientUrl}/login

Before your first engagement, set up your payout account from the Clients &
billing page so Stripe can pay your Consultant Share.`;
      } else {
        subject = 'Your Prophyion Consultant Agreement is on file';
        body = `Your signed Prophyion Consultant Agreement (reference ${data.reference}) is
now on file. Nothing else is needed from you.`;
      }
      if (note) body += `\n\nA note from the reviewer:\n${note}`;
      break;
    case 'changes_requested':
      subject = 'Your Prophyion agreement needs a change';
      body = `We have looked at the signed agreement you sent (reference ${data.reference})
and need a change before we can ${isApplication ? 'approve your application' : 'put it on file'}.
${note ? `\nWhat to change:\n${note}\n` : ''}
Update your details if needed, sign the agreement again and upload it here:
${env.clientUrl}/apply`;
      break;
    case 'rejected':
      subject = isApplication
        ? 'Your Prophyion consultant application'
        : 'Your Prophyion Consultant Agreement';
      body = isApplication
        ? 'Thank you for applying to become a Prophyion consultant. We are not able to\napprove your application at this time.'
        : `We were not able to accept the signed agreement you sent (reference ${data.reference}).`;
      if (note) body += `\n\n${note}`;
      body += '\n\nIf you have any questions, reply to this email.';
      break;
  }

  return deliver(
    {
      to: data.to,
      replyTo: env.trainerApplicationsNotifyEmail,
      subject,
      text: `Dear ${data.toName},

${body}

Kind regards,
Prophyion
`,
    },
    'Agreement decision',
    { reference: data.reference, decision: data.decision },
  );
};

/**
 * Test email configuration
 */
export const testEmailConnection = async (): Promise<boolean> => {
  if (!transporter) {
    logger.warn('Email transporter not initialized');
    return false;
  }

  try {
    await transporter.verify();
    logger.info('Email connection verified');
    return true;
  } catch (error) {
    logger.error({ error }, 'Email connection test failed');
    return false;
  }
};
