-- DRAFT ONLY. Not in supabase/migrations; DO NOT APPLY without separate approval.
-- Creates EMPTY infrastructure. No data copy, mirror, table or business RPC.
-- A collision fails rather than changing an existing schema/role.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

create role atos_internal_owner
  nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
create schema internal authorization atos_internal_owner;
revoke all privileges on schema internal from public, anon, authenticated;

-- GLOBAL defaults for this NEW, dedicated creator, not existing application roles.
-- A schema-local REVOKE cannot cancel PostgreSQL's global PUBLIC EXECUTE default.
alter default privileges for role atos_internal_owner
  revoke all privileges on functions from public, anon, authenticated;
alter default privileges for role atos_internal_owner
  revoke all privileges on tables from public, anon, authenticated;
alter default privileges for role atos_internal_owner
  revoke all privileges on sequences from public, anon, authenticated;
alter default privileges for role atos_internal_owner
  revoke all privileges on types from public, anon, authenticated;
alter default privileges for role atos_internal_owner
  revoke all privileges on schemas from public, anon, authenticated;

-- Future creation must use this creator explicitly; other creators do NOT inherit
-- these defaults. Executor roles, table RLS, grants and deployment role membership
-- are intentionally pending review of real dependencies. No role memberships here.
commit;
