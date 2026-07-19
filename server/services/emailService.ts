import nodemailer from 'nodemailer';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';

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
You have been enrolled as a trainer on Black Swan Simulations by ${data.enrolledByName}.

Your trainer account is ready:

Email: ${data.to}
Temporary password: ${data.temporaryPassword}

Sign in here: ${loginUrl}

As a trainer you can enroll your client organisations, invoice them for
training engagements, build scenarios in the War Room, and run live training
sessions. Please change your password after your first sign-in.

---
This is an automated message from Black Swan Simulations.
`;

    if (!transporter) {
      logger.info(
        { to: data.to, subject: 'Your Black Swan Simulations trainer account' },
        'Email would be sent (email disabled)',
      );
      return false; // credentials NOT delivered - caller must surface them to the admin
    }

    const info = await transporter.sendMail({
      from: `"${env.emailFromName}" <${env.emailFrom}>`,
      to: data.to,
      subject: 'Your Black Swan Simulations trainer account',
      text: emailContent,
      html: `
        <div style="font-family: -apple-system, 'Segoe UI', sans-serif; color: #172033; padding: 24px; border: 1px solid #E4DFD4; border-radius: 12px; max-width: 520px;">
          <h2 style="color: #1E3A5F; margin-top: 0;">Welcome to Black Swan Simulations</h2>
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
