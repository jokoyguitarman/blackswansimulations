-- Replace holding_statement/messaging_framework with verified_facts/leak_notice
-- Update any existing rows first
UPDATE sim_emails SET email_category = 'verified_facts' WHERE email_category = 'holding_statement';
UPDATE sim_emails SET email_category = 'general' WHERE email_category = 'messaging_framework';

ALTER TABLE sim_emails DROP CONSTRAINT IF EXISTS sim_emails_email_category_check;

ALTER TABLE sim_emails
  ADD CONSTRAINT sim_emails_email_category_check
  CHECK (email_category IN (
    'general',
    'verified_facts',
    'communication_boundaries',
    'approval_chain',
    'legal_advisory',
    'stakeholder_priority',
    'resource_authorization',
    'sitrep_request',
    'stand_down_pivot',
    'leak_notice'
  ));
