-- OFFLINE DRAFT. DO NOT EXECUTE. Not a migration or an inventory query.
-- Based on versioned 001/010/013, NOT verified deployed definitions.
-- Requires catalog/definition review and separately authorized homologation.
-- New objects only; collisions abort. Existing functions/grants remain untouched.
begin;
set local search_path = pg_catalog, pg_temp;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
-- PG16+: a non-superuser CREATEROLE creator always receives an implicit ADMIN OPTION
-- grant on the role it creates; createrole_self_grant may add INHERIT/SET on top.
-- Pin it empty so no session/role default gives the deployer the executor's privileges.
set local createrole_self_grant = '';

-- Deployment principal (superuser NOT assumed; Supabase `postgres` is not one). The
-- preflight aborts before any DDL unless it has: CREATEROLE; ownership of both base
-- tables (policies and column grants); CREATE with grant option on public (functions and
-- the temporary CREATE for the new owner); and CREATE on the database (private schema).
-- No privilege on the Supabase-managed auth schema is needed or granted: on hosted
-- Supabase `postgres` holds USAGE on auth without grant option, so a custom role cannot
-- be given auth.uid() (Supabase KB "permission errors when granting custom roles access
-- to the auth schema"). The executor reads the caller id from the PostgREST JWT claims
-- through a private SECURITY INVOKER helper instead (KB option 2), same source as auth.uid().
do $preflight$
begin
  if pg_catalog.current_setting('server_version_num')::integer < 170000 then
    raise exception 'PARTICIPANT_CONTEXT_REQUIRES_PG17';
  end if;
  if exists (
    select 1 from (values ('participantes'), ('racha_membros')) as required(name)
    where not exists (
      select 1 from pg_catalog.pg_class as c
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = required.name
        and c.relkind = 'r' and c.relrowsecurity
    )
  ) then
    raise exception 'PARTICIPANT_CONTEXT_REQUIRES_BASE_RLS';
  end if;
  if exists (
    select 1 from (values
      ('participantes', 'id', 'uuid', true),
      ('participantes', 'racha_id', 'uuid', true),
      ('participantes', 'perfil_id', 'uuid', false),
      ('participantes', 'estrelas_travadas', 'boolean', true),
      ('racha_membros', 'racha_id', 'uuid', true),
      ('racha_membros', 'perfil_id', 'uuid', true),
      ('racha_membros', 'papel', 'public.papel_usuario', true)
    ) as required(relation_name, column_name, type_name, required_not_null)
    where not exists (
      select 1 from pg_catalog.pg_attribute as a
      join pg_catalog.pg_class as c on c.oid = a.attrelid
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = required.relation_name
        and a.attname = required.column_name and a.attnum > 0 and not a.attisdropped
        and a.atttypid = pg_catalog.to_regtype(required.type_name)
        and (not required.required_not_null or a.attnotnull)
    )
  ) then
    raise exception 'PARTICIPANT_CONTEXT_SCHEMA_MISMATCH';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint as c
    join pg_catalog.pg_attribute as a on a.attrelid = c.conrelid and a.attname = 'id'
    where c.conrelid = 'public.participantes'::pg_catalog.regclass
      and c.contype = 'p' and c.conkey = array[a.attnum]
  ) or not exists (
    select 1 from pg_catalog.pg_constraint as c
    join pg_catalog.pg_attribute as tenant on tenant.attrelid = c.conrelid and tenant.attname = 'racha_id'
    join pg_catalog.pg_attribute as actor on actor.attrelid = c.conrelid and actor.attname = 'perfil_id'
    where c.conrelid = 'public.racha_membros'::pg_catalog.regclass
      and c.contype in ('p', 'u') and not c.condeferrable
      and pg_catalog.cardinality(c.conkey) = 2
      and c.conkey @> array[tenant.attnum, actor.attnum]
  ) or exists (
    select 1 from (values ('admin'), ('normal'), ('pendente')) as required(label)
    where not exists (
      select 1 from pg_catalog.pg_enum as e
      where e.enumtypid = pg_catalog.to_regtype('public.papel_usuario')
        and e.enumlabel = required.label
    )
  ) then
    raise exception 'PARTICIPANT_CONTEXT_IDENTITY_MISMATCH';
  end if;
  -- Reject every overload under the proposed names, not just matching signatures.
  if exists (
    select 1 from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('obter_meu_participante_v1', 'obter_gestao_participantes_v1')
  ) then
    raise exception 'PARTICIPANT_CONTEXT_NAME_COLLISION';
  end if;
  if pg_catalog.to_regrole('atos_participant_context_reader') is not null
    or pg_catalog.to_regnamespace('atos_participant_context') is not null then
    raise exception 'PARTICIPANT_CONTEXT_NAME_COLLISION';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_roles as r
    where r.rolname = current_user and (r.rolcreaterole or r.rolsuper)
  ) then
    raise exception 'PARTICIPANT_CONTEXT_REQUIRES_CREATEROLE';
  end if;
  if exists (
    select 1 from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('participantes', 'racha_membros')
      and not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
  ) or not pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE WITH GRANT OPTION') then
    raise exception 'PARTICIPANT_CONTEXT_REQUIRES_OBJECT_OWNER';
  end if;
  if not pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE') then
    raise exception 'PARTICIPANT_CONTEXT_REQUIRES_SCHEMA_CREATE';
  end if;
end;
$preflight$;

create role atos_participant_context_reader
  nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
-- A new role: no login credentials, ownership of base tables, service-role exception or
-- access to calculation columns. Its only membership row is the implicit ADMIN OPTION of
-- a CREATEROLE creator (no INHERIT/SET), which the final guard pins exactly.
-- No ALTER DEFAULT PRIVILEGES FOR ROLE: defaults only affect objects that role creates,
-- and it creates none (the functions are created by the deployer, whose ACL is set
-- explicitly below). It would also fail: it requires the deployer to inherit the role.

-- Caller identity without the auth schema. Same expression as Supabase's auth.uid():
-- PostgREST sets request.jwt.claims (and legacy request.jwt.claim.sub) per request from
-- the verified JWT; SECURITY DEFINER callers still see these session settings. SECURITY
-- INVOKER, empty search_path, no table access, NULL when no claims. Private schema: not
-- exposed by the Data API, no PUBLIC/API-role access; only the executor may call it.
create schema atos_participant_context;
revoke all privileges on schema atos_participant_context from public, anon, authenticated, service_role;
create function atos_participant_context.request_user_id()
returns uuid
language sql stable security invoker
set search_path = ''
as $request_user_id$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$request_user_id$;
revoke all privileges on function atos_participant_context.request_user_id()
  from public, anon, authenticated, service_role;
grant usage on schema public, atos_participant_context to atos_participant_context_reader;
grant execute on function atos_participant_context.request_user_id() to atos_participant_context_reader;
grant select (racha_id, perfil_id, papel) on public.racha_membros to atos_participant_context_reader;
grant select (id, racha_id, perfil_id, estrelas_travadas) on public.participantes to atos_participant_context_reader;

-- Only the new non-login executor receives these policies. No API role inherits it.
-- RPC guards below still check the exact tenant and role, even if a preexisting
-- permissive PUBLIC policy happens to apply. Review restrictive policies as well.
create policy participant_context_membership_v1 on public.racha_membros
  for select to atos_participant_context_reader
  using (atos_participant_context.request_user_id() is not null
    and perfil_id = atos_participant_context.request_user_id()
    and papel in ('normal'::public.papel_usuario, 'admin'::public.papel_usuario));

create policy participant_context_participants_v1 on public.participantes
  for select to atos_participant_context_reader
  using (atos_participant_context.request_user_id() is not null and exists (
    select 1 from public.racha_membros as m
    where m.racha_id = participantes.racha_id and m.perfil_id = atos_participant_context.request_user_id()
      and (m.papel = 'admin'::public.papel_usuario
        or (m.papel = 'normal'::public.papel_usuario
          and participantes.perfil_id = atos_participant_context.request_user_id()))
  ));

create function public.obter_meu_participante_v1(p_racha_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
set row_security = on
as $self$
declare
  v_uid uuid;
  v_authorized boolean;
  v_count bigint;
  v_id uuid;
begin
  v_uid := atos_participant_context.request_user_id();
  if v_uid is null or p_racha_id is null then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  end if;
  -- Direct current membership, not UI/JWT role claims or legacy SD helpers.
  select pg_catalog.count(*) = 1 and pg_catalog.bool_and(
    m.papel in ('normal'::public.papel_usuario, 'admin'::public.papel_usuario))
    into v_authorized
  from public.racha_membros as m
  where m.racha_id = p_racha_id and m.perfil_id = v_uid;
  if v_authorized is distinct from true then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  end if;

  -- Detect ambiguous linkage instead of silently selecting an arbitrary player.
  select pg_catalog.count(*), (pg_catalog.array_agg(candidate.id))[1] into v_count, v_id
  from (
    select p.id from public.participantes as p
    where p.racha_id = p_racha_id and p.perfil_id = v_uid
    limit 2
  ) as candidate;
  if v_count > 1 then
    raise exception using errcode = 'P0001', message = 'PARTICIPANT_CONTEXT_UNAVAILABLE';
  end if;
  return pg_catalog.jsonb_build_object('racha_id', p_racha_id, 'participante_id', v_id);
exception
  when insufficient_privilege then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  when others then
    raise exception using errcode = 'P0001', message = 'PARTICIPANT_CONTEXT_UNAVAILABLE';
end;
$self$;

create function public.obter_gestao_participantes_v1(p_racha_id uuid, p_participante_ids uuid[])
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
set row_security = on
as $management$
declare
  v_uid uuid;
  v_authorized boolean;
  v_ids uuid[];
  v_count bigint;
  v_valid boolean;
  v_result jsonb;
begin
  v_uid := atos_participant_context.request_user_id();
  if v_uid is null or p_racha_id is null then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  end if;
  select pg_catalog.count(*) = 1 and pg_catalog.bool_and(m.papel = 'admin'::public.papel_usuario)
    into v_authorized
  from public.racha_membros as m
  where m.racha_id = p_racha_id and m.perfil_id = v_uid;
  if v_authorized is distinct from true then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  end if;

  -- Authorize BEFORE validating/returning even an empty batch. Bound raw input
  -- before deduplication; reject multidimensional/noncanonical arrays and nulls.
  if p_participante_ids is null or pg_catalog.cardinality(p_participante_ids) > 100 then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_CONTEXT_REQUEST';
  end if;
  if pg_catalog.cardinality(p_participante_ids) = 0 then
    return '[]'::jsonb;
  end if;
  if pg_catalog.array_ndims(p_participante_ids) <> 1
    or pg_catalog.array_lower(p_participante_ids, 1) <> 1 then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_CONTEXT_REQUEST';
  end if;
  -- array_position requires one dimension; do not rely on boolean evaluation order.
  if pg_catalog.array_position(p_participante_ids, null) is not null then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_CONTEXT_REQUEST';
  end if;
  select pg_catalog.array_agg(requested.id order by requested.first_position) into v_ids
  from (
    select item.id, pg_catalog.min(item.position) as first_position
    from pg_catalog.unnest(p_participante_ids) with ordinality as item(id, position)
    group by item.id
  ) as requested;

  -- One statement for the full batch, explicit projection, no partial success.
  select pg_catalog.count(*), pg_catalog.bool_and(p.estrelas_travadas is not null),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'racha_id', p.racha_id, 'participante_id', p.id,
      'nivel_estado', case when p.estrelas_travadas then 'congelado' else 'automatico' end
    ) order by pg_catalog.array_position(v_ids, p.id))
    into v_count, v_valid, v_result
  from public.participantes as p
  where p.racha_id = p_racha_id and p.id = any(v_ids);
  if v_count <> pg_catalog.cardinality(v_ids) or v_valid is distinct from true then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  end if;
  return v_result;
exception
  when insufficient_privilege then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  when invalid_parameter_value then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPANT_CONTEXT_REQUEST';
  when others then
    raise exception using errcode = 'P0001', message = 'PARTICIPANT_CONTEXT_UNAVAILABLE';
end;
$management$;

-- ACL first, while the deployer still owns the functions. After the transfer it is
-- neither the owner nor a role with the owner's privileges, so REVOKE would be a silent
-- no-op and GRANT would fail. ALTER OWNER rewrites these grantor entries to the new owner.
revoke all privileges on function public.obter_meu_participante_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all privileges on function public.obter_gestao_participantes_v1(uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.obter_meu_participante_v1(uuid) to authenticated;
grant execute on function public.obter_gestao_participantes_v1(uuid, uuid[]) to authenticated;

-- PG16+ ALTER ... OWNER TO: the current user must be able to SET ROLE to the new owner,
-- and the new owner needs CREATE on the schema. The implicit ADMIN OPTION allows the
-- deployer to grant itself SET (never INHERIT) only for the transfer; both temporary
-- privileges are removed in this same transaction and the final guard verifies it.
-- pg_auth_members rows are keyed by (role, member, grantor). The implicit ADMIN row has
-- the bootstrap superuser as grantor; this GRANT, without GRANTED BY, records the deployer
-- (direct ADMIN holder) as grantor, i.e. a separate row. The full REVOKE resolves the same
-- grantor and deletes only that row, leaving ADMIN true / INHERIT false / SET false intact.
-- Do NOT use REVOKE SET OPTION FOR: it keeps an option-less self-granted row (rejected by
-- the guard). Superuser deployer: no implicit row; grant and revoke both use bootstrap.
grant create on schema public to atos_participant_context_reader;
grant atos_participant_context_reader to current_user with inherit false, set true;
alter function public.obter_meu_participante_v1(uuid) owner to atos_participant_context_reader;
alter function public.obter_gestao_participantes_v1(uuid, uuid[]) owner to atos_participant_context_reader;
revoke atos_participant_context_reader from current_user;
revoke create on schema public from atos_participant_context_reader;

-- Fail, rather than silently remove unknown inherited/default privileges or
-- accept a broad effective executor. This gate is not a replacement for review.
do $acl_guard$
declare
  v_reader oid := 'atos_participant_context_reader'::pg_catalog.regrole;
  v_authenticated oid := 'authenticated'::pg_catalog.regrole;
  v_creator oid := (select r.oid from pg_catalog.pg_roles as r where r.rolname = current_user);
begin
  -- The executor is a member of nothing. The only accepted row naming it as the granted
  -- role is the implicit PG16+ ADMIN OPTION of the creator (grantor is not the creator),
  -- without INHERIT/SET; the temporary self-granted SET row must already be revoked.
  if exists (select 1 from pg_catalog.pg_auth_members as am where am.member = v_reader)
    or exists (
      select 1 from pg_catalog.pg_auth_members as am
      where am.roleid = v_reader
        and not (am.member = v_creator and am.grantor <> v_creator
          and am.admin_option and not am.inherit_option and not am.set_option)
    )
    or exists (select 1 from pg_catalog.pg_roles where oid = v_reader and
      (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolreplication or rolbypassrls))
    or pg_catalog.has_schema_privilege(v_reader, 'public', 'CREATE')
    or pg_catalog.has_schema_privilege(v_reader, 'atos_participant_context', 'CREATE')
    -- No dependency on, nor access to, the Supabase-managed auth schema.
    or pg_catalog.has_schema_privilege(v_reader, 'auth', 'USAGE')
    or pg_catalog.has_schema_privilege(v_reader, 'auth', 'CREATE') then
    raise exception 'PARTICIPANT_CONTEXT_EXECUTOR_PRIVILEGES';
  end if;
  if exists (
    select 1 from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('participantes', 'racha_membros')
      and (c.relowner = v_reader
        or pg_catalog.has_table_privilege(v_reader, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
  ) or exists (
    select 1 from pg_catalog.pg_attribute as a
    join pg_catalog.pg_class as c on c.oid = a.attrelid
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('participantes', 'racha_membros')
      and a.attnum > 0 and not a.attisdropped
      and (pg_catalog.has_column_privilege(v_reader, c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES,SELECT WITH GRANT OPTION')
        or (pg_catalog.has_column_privilege(v_reader, c.oid, a.attnum, 'SELECT') and not (
          (c.relname = 'participantes' and a.attname in ('id', 'racha_id', 'perfil_id', 'estrelas_travadas'))
          or (c.relname = 'racha_membros' and a.attname in ('racha_id', 'perfil_id', 'papel'))
        )))
  ) then
    raise exception 'PARTICIPANT_CONTEXT_EXCESS_BASE_ACCESS';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) as acl
    where n.nspname = 'public' and p.proname in
      ('obter_meu_participante_v1', 'obter_gestao_participantes_v1')
      and (p.proowner <> v_reader or acl.grantee not in (v_reader, v_authenticated)
        or (acl.grantee = v_authenticated and acl.is_grantable))
  ) or exists (
    select 1 from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('obter_meu_participante_v1', 'obter_gestao_participantes_v1')
      and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE WITH GRANT OPTION')
        or not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) then
    raise exception 'PARTICIPANT_CONTEXT_UNEXPECTED_RPC_ACL';
  end if;
  -- Private identity helper: exactly one invoker function owned by the deployer, usable
  -- only by the executor; no API role reaches the schema or the helper.
  if pg_catalog.to_regprocedure('atos_participant_context.request_user_id()') is null then
    raise exception 'PARTICIPANT_CONTEXT_UNEXPECTED_IDENTITY_ACL';
  end if;
  if exists (
    select 1 from pg_catalog.pg_namespace as n
    where n.nspname = 'atos_participant_context' and n.nspowner <> v_creator
  ) or (
    select pg_catalog.count(*) from pg_catalog.pg_proc as p
    where p.pronamespace = 'atos_participant_context'::pg_catalog.regnamespace
  ) <> 1 or exists (
    select 1 from pg_catalog.pg_class as c
    where c.relnamespace = 'atos_participant_context'::pg_catalog.regnamespace
  ) or not exists (
    select 1 from pg_catalog.pg_proc as p
    where p.oid = pg_catalog.to_regprocedure('atos_participant_context.request_user_id()')
      and p.proowner = v_creator and not p.prosecdef and p.provolatile = 's'
      and p.prorettype = 'uuid'::pg_catalog.regtype and not p.proretset
  ) or exists (
    select 1 from pg_catalog.pg_namespace as n
    cross join lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) as acl
    where n.nspname = 'atos_participant_context' and acl.grantee <> n.nspowner
      and not (acl.grantee = v_reader and acl.privilege_type = 'USAGE' and not acl.is_grantable)
  ) or exists (
    select 1 from pg_catalog.pg_proc as p
    cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) as acl
    where p.oid = pg_catalog.to_regprocedure('atos_participant_context.request_user_id()')
      and acl.grantee <> p.proowner
      and not (acl.grantee = v_reader and acl.privilege_type = 'EXECUTE' and not acl.is_grantable)
  ) or not pg_catalog.has_schema_privilege(v_reader, 'atos_participant_context', 'USAGE')
    or not pg_catalog.has_function_privilege(v_reader, 'atos_participant_context.request_user_id()', 'EXECUTE')
    or pg_catalog.has_schema_privilege('anon', 'atos_participant_context', 'USAGE')
    or pg_catalog.has_schema_privilege('authenticated', 'atos_participant_context', 'USAGE')
    or pg_catalog.has_schema_privilege('service_role', 'atos_participant_context', 'USAGE')
    or pg_catalog.has_function_privilege('anon', 'atos_participant_context.request_user_id()', 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', 'atos_participant_context.request_user_id()', 'EXECUTE')
    or pg_catalog.has_function_privilege('service_role', 'atos_participant_context.request_user_id()', 'EXECUTE') then
    raise exception 'PARTICIPANT_CONTEXT_UNEXPECTED_IDENTITY_ACL';
  end if;
end;
$acl_guard$;
commit;
