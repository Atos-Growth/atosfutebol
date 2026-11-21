-- P0 H2 / ETAPA 02 — revogação dos grants legados de public.participantes.
-- RASCUNHO: não executar sem autorização. SÓ depois da etapa 01 e do frontend H2
-- publicado e validado: o frontend 20ac666 lê perfil_id/estrelas_travadas e quebraria.
-- Antes: GRANT ALL para anon e authenticated (inclusive colunas internas de cálculo).
-- Depois: anon sem acesso; authenticated lê só as 8 colunas públicas (RLS inalterado)
-- e escreve só as colunas que o app grava. DELETE (restrito a admin por policy) mantido.
begin;
set local search_path = pg_catalog, pg_temp;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $preflight$
begin
  if pg_catalog.to_regclass('public.participantes_publicos_v1') is null
    or pg_catalog.to_regprocedure('public.obter_meu_participante_v2(uuid)') is null then
    raise exception 'P0_H2_REQUIRES_STAGE_01';
  end if;
  if not pg_catalog.pg_has_role(current_user,
       (select c.relowner from pg_catalog.pg_class as c where c.oid = 'public.participantes'::pg_catalog.regclass), 'USAGE') then
    raise exception 'P0_H2_REQUIRES_OBJECT_OWNER';
  end if;
  -- Views security_invoker não podem depender de colunas que deixarão de ser legíveis.
  if exists (
    select 1 from pg_catalog.pg_depend as d
    join pg_catalog.pg_rewrite as r on r.oid = d.objid
    join pg_catalog.pg_class as v on v.oid = r.ev_class
    join pg_catalog.pg_attribute as a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
    where d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
      and d.refobjid = 'public.participantes'::pg_catalog.regclass and d.refobjsubid > 0
      and v.oid <> d.refobjid and coalesce(v.reloptions, '{}') @> array['security_invoker=true']
      and a.attname not in ('id', 'racha_id', 'nome', 'apelido', 'foto_url', 'posicao', 'ativo', 'estrelas')
  ) then
    raise exception 'P0_H2_INVOKER_VIEW_DEPENDS_ON_PRIVATE_COLUMN';
  end if;
end;
$preflight$;

revoke all privileges on table public.participantes from public, anon;
revoke select, insert, update, truncate, references, trigger on table public.participantes from authenticated;
grant select (id, racha_id, nome, apelido, foto_url, posicao, ativo, estrelas)
  on public.participantes to authenticated;
grant insert (racha_id, nome, apelido, estrelas, posicao, foto_url, perfil_id)
  on public.participantes to authenticated;
grant update (nome, apelido, estrelas, posicao, foto_url, ativo, estrelas_travadas)
  on public.participantes to authenticated;

do $guard$
declare
  v_t oid := 'public.participantes'::pg_catalog.regclass;
begin
  if pg_catalog.has_table_privilege('anon', v_t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_any_column_privilege('anon', v_t, 'SELECT,INSERT,UPDATE,REFERENCES')
    or pg_catalog.has_table_privilege('authenticated', v_t, 'SELECT,INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'P0_H2_UNEXPECTED_TABLE_ACL';
  end if;
  if exists (
    select 1 from pg_catalog.pg_attribute as a
    where a.attrelid = v_t and a.attnum > 0 and not a.attisdropped
      and (pg_catalog.has_column_privilege('authenticated', v_t, a.attnum, 'SELECT')
           <> (a.attname in ('id', 'racha_id', 'nome', 'apelido', 'foto_url', 'posicao', 'ativo', 'estrelas'))
        or pg_catalog.has_column_privilege('authenticated', v_t, a.attnum, 'INSERT')
           <> (a.attname in ('racha_id', 'nome', 'apelido', 'estrelas', 'posicao', 'foto_url', 'perfil_id'))
        or pg_catalog.has_column_privilege('authenticated', v_t, a.attnum, 'UPDATE')
           <> (a.attname in ('nome', 'apelido', 'estrelas', 'posicao', 'foto_url', 'ativo', 'estrelas_travadas'))
        or pg_catalog.has_column_privilege('authenticated', v_t, a.attnum, 'SELECT WITH GRANT OPTION'))
  ) then
    raise exception 'P0_H2_UNEXPECTED_COLUMN_ACL';
  end if;
  -- A executora da H1 tem grants próprios e não pode ter sido afetada.
  if not pg_catalog.has_column_privilege('atos_participant_context_reader', v_t, 'estrelas_travadas', 'SELECT')
    or not pg_catalog.has_column_privilege('atos_participant_context_reader', v_t, 'perfil_id', 'SELECT') then
    raise exception 'P0_H2_EXECUTOR_GRANTS_CHANGED';
  end if;
end;
$guard$;
commit;
