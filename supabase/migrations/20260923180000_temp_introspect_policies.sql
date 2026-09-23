-- Temporary diagnostic function: exposes the live RLS policy definitions
-- for ifc_sessions/ifc_messages via RPC (service_role only reads this
-- output). Needed because db pull requires Docker, which isn't available
-- here, and the tracked migrations are known to have drifted from the
-- actual live schema (the device_id column itself was never in a tracked
-- migration). Safe to drop once the real policy text is known.
CREATE OR REPLACE FUNCTION debug_list_policies()
RETURNS TABLE(tablename text, policyname text, cmd text, qual text, with_check text)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT tablename::text, policyname::text, cmd::text, qual::text, with_check::text
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('ifc_sessions', 'ifc_messages');
$$;

REVOKE ALL ON FUNCTION debug_list_policies() FROM PUBLIC, anon, authenticated;
