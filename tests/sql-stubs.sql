-- Test-only stand-ins for what Supabase already provides. Never run this in Supabase.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as
  $$ select jsonb_build_object('email', nullif(current_setting('request.jwt.claim.email', true), '')) $$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
