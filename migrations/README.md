# Database Migrations Guide

This directory contains SQL migration files for setting up the Unified Simulation Environment database in Supabase.

## Migration Files

1. **001_initial_schema.sql** - Creates all database tables, indexes, and triggers
2. **002_rls_policies.sql** - Sets up Row Level Security (RLS) policies for data access control
3. **003_auth_triggers.sql** - Creates helper functions and triggers for user management

## How to Run Migrations

### Option 1: Supabase Dashboard (Recommended)

1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Open each migration file in order (001, 002, 003)
4. Copy and paste the SQL into the editor
5. Click **Run** to execute

### Option 2: Supabase CLI

If you have Supabase CLI installed:

```bash
# Link your project
supabase link --project-ref your-project-ref

# Run migrations
supabase db push
```

### Option 3: Direct SQL Connection

If you have direct database access:

```bash
psql "postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT].supabase.co:5432/postgres" -f migrations/001_initial_schema.sql
psql "postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT].supabase.co:5432/postgres" -f migrations/002_rls_policies.sql
psql "postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT].supabase.co:5432/postgres" -f migrations/003_auth_triggers.sql
```

## Migration Order

**IMPORTANT**: Run migrations in this exact order:

1. ✅ `001_initial_schema.sql` - Creates tables (must run first)
2. ✅ `002_rls_policies.sql` - Adds security policies (requires tables)
3. ✅ `003_auth_triggers.sql` - Adds triggers (requires tables and policies)

## Verification

After running migrations, verify everything worked:

```sql
-- Check tables were created
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

-- Check RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public';

-- Check triggers
SELECT trigger_name, event_object_table
FROM information_schema.triggers
WHERE trigger_schema = 'public';
```

## Troubleshooting

### Error: "relation already exists"

- Tables already exist - you may have run migrations before
- Option 1: Drop and recreate (⚠️ **WARNING**: This deletes all data)
- Option 2: Skip migration and continue

### Error: "permission denied"

- Make sure you're using the **service_role** key or have admin access
- RLS policies require proper authentication

### Error: "function does not exist"

- Make sure you ran migrations in order
- Check that `003_auth_triggers.sql` was executed

## Schema Overview

### Core Tables

- **user_profiles** - User information (extends Supabase Auth)
- **scenarios** - Exercise scenarios
- **sessions** - Active simulation sessions
- **scenario_injects** - Event injections for scenarios
- **session_participants** - Users participating in sessions

### Decision & Workflow Tables

- **decisions** - Proposed decisions
- **decision_steps** - Approval workflow steps
- **incidents** - Reported incidents during sessions

### Resource Management Tables

- **agency_resources** - Resource pools per agency
- **resource_allocations** - Resource assignments
- **resource_requests** - Inter-agency resource negotiations

### Communication Tables

- **chat_channels** - Communication channels
- **chat_messages** - Messages in channels

### Analytics Tables

- **media_posts** - Simulated social media/news posts
- **sentiment_snapshots** - Sentiment tracking over time
- **session_events** - Event log for AAR (event sourcing)
- **aar_reports** - After-action review reports
- **participant_scores** - Performance metrics

## Security Notes

- All tables have **Row Level Security (RLS)** enabled
- Users can only access data for sessions they're part of
- Trainers have elevated permissions for their sessions
- Admins have full access
- Service role key bypasses RLS (use only server-side)

## Next Steps

After running migrations:

1. ✅ Verify tables exist in Supabase dashboard
2. ✅ Test user signup (should auto-create profile)
3. ✅ Test RLS policies with different user roles
4. ✅ Create test scenarios via API or dashboard

## Field-ops knowledge libraries

Applied by hand after `master`'s migrations, in this order. Each file is one transaction. Do not use `supabase db push` for these: the numbers are not contiguous, and nothing here is under `supabase/migrations`.

```bash
psql "$KNOWLEDGE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f <file>
```

1. `221_team_archetypes.sql`
2. `222_doctrines.sql`
3. `223_doctrine_usage_reports_events.sql`
4. `224_doctrine_queue_indexes.sql`
5. `239_fieldops_explosive_materials.sql`
6. `240_fieldops_injury_thresholds.sql`
7. `242_fieldops_physics_reviews.sql`
8. `250_fieldops_spread_library.sql`
9. `257_fieldops_building_hazards.sql`
10. `258_fieldops_threats_agents_movement.sql`
11. `259_fieldops_knowledge_provenance.sql`
12. `261_fieldops_units_hospitals_library.sql`
13. `262_fieldops_knowledge_staging.sql`
14. `263_fieldops_library_row_history.sql`
15. `264_revoke_pr23_rls_table_grants.sql`

Files 221–224, 239, 240, 242, 250 and 257–259 are PR #23's blocks, copied byte-for-byte. 261, 262 and 263 are new. 264 revokes `anon` and `authenticated` on the twelve tables from 221, 222, 223, 239, 240 and 242 that enabled row security without a revoke. `service_role` keeps its grants. Migration 254's D54/D56 knowledge tables (unit kinds, equipment, unit equipment, response standards, hospitals, hospital specialties and capacity aggregates) are created here by `261_fieldops_units_hospitals_library.sql`, because 254 refuses to apply until 252 exists. 261's statements are `IF NOT EXISTS`, so applying 254 later leaves those tables as they are. Re-apply 263 after 254 so history triggers attach to any library table 254 creates.

Rollback statements are in each file's header. Run them in reverse order, on a branch or a local database only, never on the shared project.
