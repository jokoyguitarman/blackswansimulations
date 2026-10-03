-- Migration 217: Save the signed copy as a draft before the application is submitted
--
-- Until now uploading the signed agreement also submitted the application in the same step. An
-- applicant now uploads the signed copy (saved, replaceable) and then submits the whole
-- application as a separate step, and cannot reach the dashboard until they have.
--
-- signed_file_uploaded_at is when the current signed copy was uploaded. A copy is a draft when it
-- was uploaded after the last submission (or there has been none). Submitting sets submitted_at,
-- which makes it no longer a draft; an admin asking for changes leaves the old copy as history and
-- the applicant uploads a new one.

ALTER TABLE trainer_agreements
  ADD COLUMN IF NOT EXISTS signed_file_uploaded_at TIMESTAMPTZ;

COMMENT ON COLUMN trainer_agreements.signed_file_uploaded_at IS
  'When the current signed copy was uploaded. Later than submitted_at (or submitted_at is NULL) means a draft copy waiting to be submitted.';

-- Every existing copy was uploaded and submitted in one step, so none of them is a draft.
UPDATE trainer_agreements
SET signed_file_uploaded_at = coalesce(submitted_at, created_at)
WHERE signed_file_path IS NOT NULL
  AND signed_file_uploaded_at IS NULL;
