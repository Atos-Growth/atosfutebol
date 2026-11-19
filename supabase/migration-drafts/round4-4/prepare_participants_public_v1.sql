-- DRAFT ONLY. No base-table grants/revocations or privileged RPC modifications.
-- PostgreSQL 17. Requires existing authenticated SELECT on the referenced columns,
-- auth.uid() execution and RLS-compatible membership reads. Do not widen grants
-- to make this view work; unresolved dependencies block deployment.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Fail closed if the catalog differs from the reviewed base. This is NOT a proof
-- that existing policies/helpers are safe; those still require restricted review.
do $guard$
begin
  if pg_catalog.current_setting('server_version_num')::integer < 170000 then
    raise exception 'PARTICIPANTS_V1_REQUIRES_PG17';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'participantes'
      and c.relkind = 'r' and c.relrowsecurity
  ) or not exists (
    select 1 from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'racha_membros'
      and c.relkind = 'r' and c.relrowsecurity
  ) then
    raise exception 'PARTICIPANTS_V1_REQUIRES_BASE_RLS';
  end if;
end;
$guard$;

-- CREATE (not OR REPLACE): never overwrite an unexpected deployed object.
create view public.participantes_publicos_v1
with (security_invoker = true, security_barrier = true) as
select p.id, p.racha_id, p.nome, p.apelido, p.foto_url, p.posicao, p.ativo, p.estrelas
from public.participantes as p
where auth.uid() is not null
  and exists (
    select 1 from public.racha_membros as m
    where m.racha_id = p.racha_id
      and m.perfil_id = auth.uid()
      and m.papel in ('normal'::public.papel_usuario, 'admin'::public.papel_usuario)
  );

-- The view is read-only for API users even if it could be auto-updatable.
-- Remove inherited default object grants on this NEW view, then allow SELECT.
revoke all privileges on public.participantes_publicos_v1 from public, anon, authenticated;
grant select on public.participantes_publicos_v1 to authenticated;

-- Abort on unexpected inherited/default privileges rather than revoke unrelated
-- role grants blindly. Only the new view is inspected; no application is invoked.
do $acl_guard$
begin
  if pg_catalog.has_table_privilege('anon', 'public.participantes_publicos_v1',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or pg_catalog.has_table_privilege('authenticated', 'public.participantes_publicos_v1',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or pg_catalog.has_table_privilege('authenticated', 'public.participantes_publicos_v1',
       'SELECT WITH GRANT OPTION') then
    raise exception 'PARTICIPANTS_V1_UNEXPECTED_EFFECTIVE_ACL';
  end if;
end;
$acl_guard$;
commit;
