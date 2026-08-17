-- Migration: keepalive RPC function
-- Purpose: a stable, table-independent probe used by the Supabase Heartbeat
-- worker to prevent Supabase free-tier auto-pause after 7 days of inactivity.
-- Returns now() — it touches the database without depending on any specific
-- table existing or being readable.
--
-- Apply this to EVERY Supabase project you want to keep alive:
--   - Supabase SQL editor (paste & run), or
--   - `supabase migration new` + `supabase db push` if using the CLI.
--
-- The Heartbeat worker calls POST /rest/v1/rpc/keepalive with a project API
-- key. It works with either the anon (publishable) key or the service_role key
-- — both are granted EXECUTE below. Prefer the anon key for the generic worker
-- (see the SUPABASE_TARGETS `apiKey` field): keepalive() only does SELECT now()
-- and exposes no data, so the low-privilege anon key is sufficient and safer to
-- scatter across many target projects.

CREATE OR REPLACE FUNCTION public.keepalive()
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT now();
$$;

COMMENT ON FUNCTION public.keepalive() IS
  'Trivial probe function called by the Supabase Heartbeat Cloudflare Worker '
  'to prevent Supabase free-tier auto-pause after 7 days of inactivity. '
  'Returns now().';

-- Grants: allow both `service_role` and `anon` to execute.
-- `keepalive()` only does SELECT now() — it reads no tables and exposes no data
-- — so letting the public anon key call it is low-risk. Prefer the anon /
-- publishable key for the Heartbeat worker (SUPABASE_TARGETS `apiKey` field);
-- reserve service_role for cases where anon access is locked down.
REVOKE ALL ON FUNCTION public.keepalive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.keepalive() TO service_role;
GRANT EXECUTE ON FUNCTION public.keepalive() TO anon;
