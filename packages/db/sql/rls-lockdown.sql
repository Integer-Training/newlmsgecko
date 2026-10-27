-- RLS lockdown for the Gecko Supabase project (docs/REPLICATION.md Phase 4 step 6, issue K4).
--
-- Mirrors PearlLMS production exactly: RLS enabled on every public table, NO policies
-- (deny-all over PostgREST for anon/authenticated), plus an event trigger that enables RLS
-- on every table created later (e.g. by future drizzle migrations).
-- The app connects as the `postgres` owner, which bypasses RLS, so app behaviour is unchanged.
--
-- Function body and trigger tags copied verbatim from Pearl prod (read-only check 2026-10-27:
-- function public.rls_auto_enable(), trigger ensure_rls_on_new_tables; 119 tables, 119 RLS, 0 policies).
--
-- Run by hand in the Supabase SQL editor AFTER the first API boot has run the migrations.
-- Idempotent: safe to run again.

-- 1. Enable RLS on every existing public table.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

-- 2. Auto-enable RLS on tables created in the future.
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
             where object_type in ('table','partitioned table') and schema_name = 'public' loop
    execute format('alter table %s enable row level security', cmd.object_identity);
  end loop;
end $function$;

DROP EVENT TRIGGER IF EXISTS ensure_rls_on_new_tables;
CREATE EVENT TRIGGER ensure_rls_on_new_tables ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();

-- 3. Check (expect tables = rls = 119 at migration 0026, policies = 0):
-- select (select count(*) from pg_tables where schemaname='public') tables,
--        (select count(*) from pg_tables where schemaname='public' and rowsecurity) rls,
--        (select count(*) from pg_policies where schemaname='public') policies;
