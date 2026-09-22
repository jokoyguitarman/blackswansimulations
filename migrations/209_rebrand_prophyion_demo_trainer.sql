-- Rebrand: Black Swan Simulations -> Prophyion.
--
-- The only brand name persisted in the database is the agency of the demo
-- trainer account seeded in migration 147 ("Black Swan Simulations"), which
-- surfaces in the trainer admin list. Rename it. Bot e-mail addresses on the
-- @blackswan.internal domain are internal identifiers, are never shown to
-- users, and are deliberately left unchanged.

UPDATE public.user_profiles
SET agency_name = 'Prophyion'
WHERE agency_name = 'Black Swan Simulations';

UPDATE auth.users
SET raw_user_meta_data = jsonb_set(raw_user_meta_data, '{agency_name}', '"Prophyion"'),
    updated_at = NOW()
WHERE raw_user_meta_data->>'agency_name' = 'Black Swan Simulations';
