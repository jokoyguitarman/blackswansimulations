-- Add email_category column to sim_emails for executive directive classification
ALTER TABLE sim_emails
  ADD COLUMN IF NOT EXISTS email_category TEXT DEFAULT 'general';

ALTER TABLE sim_emails
  DROP CONSTRAINT IF EXISTS sim_emails_email_category_check;

ALTER TABLE sim_emails
  ADD CONSTRAINT sim_emails_email_category_check
  CHECK (email_category IN (
    'general',
    'holding_statement',
    'communication_boundaries',
    'approval_chain',
    'legal_advisory',
    'stakeholder_priority',
    'resource_authorization',
    'sitrep_request',
    'stand_down_pivot',
    'messaging_framework'
  ));
