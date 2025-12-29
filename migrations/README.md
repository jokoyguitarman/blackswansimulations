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
