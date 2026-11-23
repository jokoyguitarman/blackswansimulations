# Knowledge seed importer

Stages the field-ops research seeds, promotes the approved rows into the typed libraries, and records the owner's verification. The schema apply order is in `migrations/README.md` under "Field-ops knowledge libraries".

No run has been made against the shared Supabase project. The commands below are what the owner runs, on a database that already has `master`'s schema (migrations 001–218).

## Commands

```bash
npm run knowledge -- manifest --check --dir scripts/fieldops/seeds
npm run knowledge -- validate --dir scripts/fieldops/seeds
npm run knowledge -- stage --dir scripts/fieldops/seeds            # dry-run
npm run knowledge -- stage --apply --dir scripts/fieldops/seeds
npm run knowledge -- promote                                      # dry-run
npm run knowledge -- promote --apply --allow-unscreened-doctrines
npm run knowledge -- verify --verifier-email <owner email>        # dry-run
npm run knowledge -- verify --apply --verifier-email <owner email>
npm run knowledge -- status
```

`stage`, `promote` and `verify` are dry-run unless `--apply` is set. `--dry-run` and `--apply` together is an error. Exit 0 when the command finishes (blockers are reported, not errors). Exit 1 is a bad argument or a file that does not parse. Exit 2 is a database error. Exit 3 is a safety refusal, before a connection is opened.

Other commands: `review` (one record, or `--bulk`) and `manifest --write`.

## Environment

| Variable              | Meaning                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `KNOWLEDGE_DB_URL`    | Postgres URL. Required for `stage`, `promote`, `verify` and `status`. A local URL's host is `localhost`, `127.0.0.1` or `::1`. |
| `KNOWLEDGE_TARGET`    | `local` or `shared`. Required for `--apply`.                                                                                   |
| `KNOWLEDGE_SEEDS_DIR` | Default seed directory when `--dir` is omitted. Defaults to `scripts/fieldops/seeds`.                                          |

`--apply` with `KNOWLEDGE_TARGET=shared` also needs `--confirm-project <ref>`. `<ref>` must equal the project ref in the database host (`db.<ref>.supabase.co`) or the pooler user (`postgres.<ref>`). A substring of the URL does not match. The same flag is required for a shared dry-run. Do not run `supabase db reset`, `supabase db push`, or `DROP` against the shared project.

The URL is never printed. Errors replace it with `[redacted]`.

## What the three database commands do

`stage` reads the seed files and upserts every record into `fieldops_knowledge_records` in one transaction. A second stage of the same files changes no payload and adds no history row.

`promote` writes approved and amended rows whose blocker count is 0. It does not read the seed files; it reads the staging table. Sources that were not accessed are not written. Doctrines are written only with `--allow-unscreened-doctrines`, because the repo has no doctrine save screen; without the flag they are skipped and counted as `save_screen_unavailable`. A `use_of_force` block is omitted unless the stored review has a legal, police_service or military_service approval. A second promote of unchanged rows writes nothing.

`verify` runs after promote. With an admin `user_profiles` row it verifies each promoted library doctrine (`fieldops_verify_doctrine_version`), writes one approved physics review (`fo-physics-1.0.0`) and three approved spread reviews (`fo-spread-1.0.0`, `fo-catalogue-1.0.0`, `fo-threats-1.0.0`) in the name Jokoy Tabbada, and marks the explosive and injury rows of that dataset `reviewed`. `--verifier-email` resolves the profile only when `auth.users` exists. `--verifier-user-id` uses the id directly. If the email or id matches no `user_profiles` row, verify exits 1 and writes nothing. If the profile exists and its role is not `admin`, the command prints `verifier_not_admin`, skips doctrine verification, and still writes the physics and spread reviews with `reviewer_user_id` and `recorded_by` null.

## Re-verify after a library change

Any later change to a library's rows (a re-promotion, an admin edit, hazard/exposure/weather rows, or device presets) changes that library's dataset version. The loaders then report "Unreviewed model" again. Run `verify --apply` again after such a change. The spread library also needs its hazard, exposure and weather rows before `loadSpreadLibrary` returns a library; those seed files are out of scope here.

## Apply, stage, promote and verify

Start from a database that already has migrations 001–218. Applying those files onto an empty database failed in this workspace at migration 013 (`VERIFY`, division by zero). Do not repeat that on an empty cluster.

Apply the knowledge migrations in this order. Apply the list a second time to prove they are idempotent. Files that already contain `BEGIN`/`COMMIT` warn `already a transaction in progress` under `--single-transaction`; the file's own `COMMIT` still commits.

```bash
export KNOWLEDGE_DB_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/DATABASE'
export KNOWLEDGE_TARGET=local

for file in \
  migrations/221_team_archetypes.sql \
  migrations/222_doctrines.sql \
  migrations/223_doctrine_usage_reports_events.sql \
  migrations/224_doctrine_queue_indexes.sql \
  migrations/239_fieldops_explosive_materials.sql \
  migrations/240_fieldops_injury_thresholds.sql \
  migrations/242_fieldops_physics_reviews.sql \
  migrations/250_fieldops_spread_library.sql \
  migrations/257_fieldops_building_hazards.sql \
  migrations/258_fieldops_threats_agents_movement.sql \
  migrations/259_fieldops_knowledge_provenance.sql \
  migrations/261_fieldops_units_hospitals_library.sql \
  migrations/262_fieldops_knowledge_staging.sql \
  migrations/263_fieldops_library_row_history.sql \
  migrations/264_revoke_pr23_rls_table_grants.sql
do
  psql "$KNOWLEDGE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$file"
done
```

PRs 1, 3, 4 and 5 must be merged first: the knowledge migrations, the approved seeds, staging, and promotion. PR 2 (the importer core) is already contained in staging and promotion.

For the shared project, set `KNOWLEDGE_DB_URL` to that database and `KNOWLEDGE_TARGET=shared`, and add `--confirm-project <ref>` to every `--apply` (and to the dry-runs). `<ref>` must equal the project ref in the host (`db.<ref>.supabase.co`) or the pooler user (`postgres.<ref>`). Before applying, check what is already there:

```bash
psql "$KNOWLEDGE_DB_URL" -c "select to_regclass('public.fieldops_seed_runs'), to_regclass('public.doctrines');"
```

Never `supabase db reset`, `supabase db push`, or `DROP` there.

Then, from the repo root, after the seed files are on the branch (`scripts/fieldops/seeds`):

```bash
npm run knowledge -- manifest --check --dir scripts/fieldops/seeds
npm run knowledge -- validate --dir scripts/fieldops/seeds
npm run knowledge -- stage --dir scripts/fieldops/seeds
npm run knowledge -- stage --apply --dir scripts/fieldops/seeds
npm run knowledge -- promote
npm run knowledge -- promote --apply --allow-unscreened-doctrines
npm run knowledge -- verify --verifier-email <owner email>
npm run knowledge -- verify --apply --verifier-email <owner email>
```

`validate` on the owner-approved files reports 1,097 records and zero blockers. The verifier's `user_profiles.role` must be `admin` for doctrine verification. A profile that is not an admin prints `verifier_not_admin`: doctrines stay unverified, and the physics and spread reviews are still written with `recorded_by` null. An unknown email or id exits 1 and writes nothing.

On the shared project the same eight commands are the whole run. Paste each command's counts and issue codes back if a record of the shared run is needed. This agent did not have those credentials, so that run was not done.
