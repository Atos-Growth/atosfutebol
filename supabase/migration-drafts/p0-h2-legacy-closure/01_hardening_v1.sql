-- *** SUBSTITUÍDO por 01a_hardening_sem_storage.sql (H2.2a). NÃO EXECUTAR. ***
-- Em produção storage.objects pertence a supabase_storage_admin e o postgres não é membro:
-- o bloco de Storage abaixo não pode ser aplicado. Mantido só como referência até a 01a
-- estar versionada; o bloqueio logo após o BEGIN aborta qualquer execução acidental.
-- P0 H2 / ETAPA 01 — endurecimento. RASCUNHO: não executar sem autorização.
-- Compatível com o frontend publicado (20ac666) e pré-requisito do frontend H2.
-- Ordem de implantação: 01 -> publicar frontend H2 -> validar -> 02.
-- Exige a H1 (prepare_participant_context_v1.sql) já aplicada. Transacional; colisões abortam.
begin;
do $superseded$ begin raise exception 'P0_H2_SUPERSEDED_USE_01A'; end $superseded$;
set local search_path = pg_catalog, pg_temp;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
-- Mesmo cuidado da H1: o deployer nunca herda a executora (PG16+).
set local createrole_self_grant = '';

do $preflight$
begin
  if pg_catalog.current_setting('server_version_num')::integer < 170000 then
    raise exception 'P0_H2_REQUIRES_PG17';
  end if;
  if pg_catalog.to_regrole('atos_participant_context_reader') is null
    or pg_catalog.to_regprocedure('public.obter_meu_participante_v1(uuid)') is null
    or pg_catalog.to_regprocedure('atos_participant_context.request_user_id()') is null then
    raise exception 'P0_H2_REQUIRES_H1';
  end if;
  if pg_catalog.to_regclass('public.participantes_publicos_v1') is not null
    or exists (select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'obter_meu_participante_v2')
    or exists (select 1 from pg_catalog.pg_policies where schemaname = 'storage' and tablename = 'objects'
               and policyname = 'membros leem fotos de participantes') then
    raise exception 'P0_H2_NAME_COLLISION';
  end if;
  if pg_catalog.to_regclass('public.ranking_historico') is null
    or pg_catalog.to_regclass('storage.objects') is null
    or not exists (select 1 from pg_catalog.pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'fotos públicas' and cmd = 'SELECT')
    or exists (select 1 from (values
        ('public._finalizar_partida_core(uuid,uuid,uuid)'), ('public.auto_finalizar_partidas_vencidas()'),
        ('public.fechar_mes(uuid,date)'), ('public.fechar_mes_manual(uuid,date)'),
        ('public.fechar_meses_pendentes(uuid)'), ('public.registrar_avaliacao_sessao(uuid)'),
        ('public.confirmar_sorteio(uuid,jsonb)'), ('public.finalizar_partida_e_girar_fila(uuid,uuid,uuid)'),
        ('public.finalizar_sessao(uuid)'), ('public.solicitar_acesso_racha(uuid)')) as f(sig)
      where pg_catalog.to_regprocedure(f.sig) is null) then
    raise exception 'P0_H2_SCHEMA_MISMATCH';
  end if;
  -- REVOKE de quem não é dono vira no-op silencioso: exigir posse de tudo que muda.
  if exists (select 1 from pg_catalog.pg_class as c
             where c.oid in ('public.participantes'::pg_catalog.regclass, 'public.ranking_historico'::pg_catalog.regclass,
                             'storage.objects'::pg_catalog.regclass)
               and not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE'))
    or exists (select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname in ('_finalizar_partida_core', 'auto_finalizar_partidas_vencidas',
                 'fechar_mes', 'fechar_mes_manual', 'fechar_meses_pendentes', 'registrar_avaliacao_sessao',
                 'confirmar_sorteio', 'finalizar_partida_e_girar_fila', 'finalizar_sessao', 'solicitar_acesso_racha')
                 and not pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE'))
    or not pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE WITH GRANT OPTION') then
    raise exception 'P0_H2_REQUIRES_OBJECT_OWNER';
  end if;
end;
$preflight$;

-- 1. Leitura pública da lista (rascunho 4.4 revisado). security_invoker: o RLS e as
-- permissões de coluna de quem chama continuam valendo; o filtro repete o vínculo aprovado.
create view public.participantes_publicos_v1
with (security_invoker = true, security_barrier = true) as
select p.id, p.racha_id, p.nome, p.apelido, p.foto_url, p.posicao, p.ativo, p.estrelas
from public.participantes as p
where auth.uid() is not null
  and exists (
    select 1 from public.racha_membros as m
    where m.racha_id = p.racha_id and m.perfil_id = auth.uid()
      and m.papel in ('normal'::public.papel_usuario, 'admin'::public.papel_usuario)
  );
revoke all privileges on public.participantes_publicos_v1 from public, anon, authenticated, service_role;
grant select on public.participantes_publicos_v1 to authenticated;

-- 2. Vínculo próprio + estado de nível SÓ do próprio participante (cartão do membro comum).
-- Mesmo modelo da v1: executora dona, identidade pelas claims, papel conferido a cada chamada.
create function public.obter_meu_participante_v2(p_racha_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
set row_security = on
as $self_v2$
declare
  v_uid uuid;
  v_authorized boolean;
  v_count bigint;
  v_id uuid;
  v_travado boolean;
begin
  v_uid := atos_participant_context.request_user_id();
  if v_uid is null or p_racha_id is null then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  end if;
  select pg_catalog.count(*) = 1 and pg_catalog.bool_and(
    m.papel in ('normal'::public.papel_usuario, 'admin'::public.papel_usuario))
    into v_authorized
  from public.racha_membros as m
  where m.racha_id = p_racha_id and m.perfil_id = v_uid;
  if v_authorized is distinct from true then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  end if;
  select pg_catalog.count(*), (pg_catalog.array_agg(c.id))[1], (pg_catalog.array_agg(c.estrelas_travadas))[1]
    into v_count, v_id, v_travado
  from (
    select p.id, p.estrelas_travadas from public.participantes as p
    where p.racha_id = p_racha_id and p.perfil_id = v_uid
    limit 2
  ) as c;
  if v_count > 1 or (v_count = 1 and v_travado is null) then
    raise exception using errcode = 'P0001', message = 'PARTICIPANT_CONTEXT_UNAVAILABLE';
  end if;
  return pg_catalog.jsonb_build_object('racha_id', p_racha_id, 'participante_id', v_id,
    'nivel_estado', case when v_id is null then null when v_travado then 'congelado' else 'automatico' end);
exception
  when insufficient_privilege then
    raise exception using errcode = '42501', message = 'PARTICIPANT_CONTEXT_DENIED';
  when others then
    raise exception using errcode = 'P0001', message = 'PARTICIPANT_CONTEXT_UNAVAILABLE';
end;
$self_v2$;
revoke all privileges on function public.obter_meu_participante_v2(uuid) from public, anon, authenticated, service_role;
grant execute on function public.obter_meu_participante_v2(uuid) to authenticated;
-- Troca de dono idêntica à H1: SET temporário (nunca INHERIT) e CREATE temporário.
grant create on schema public to atos_participant_context_reader;
grant atos_participant_context_reader to current_user with inherit false, set true;
alter function public.obter_meu_participante_v2(uuid) owner to atos_participant_context_reader;
revoke atos_participant_context_reader from current_user;
revoke create on schema public from atos_participant_context_reader;

-- 3. ranking_historico rodava como dono (ignorava RLS) e era legível por anon: todas as peladas.
alter view public.ranking_historico set (security_invoker = true);
revoke all privileges on public.ranking_historico from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.ranking_historico from authenticated;

-- 4. Funções internas SECURITY DEFINER sem checagem de quem chama: fora da API.
-- Continuam funcionando por dentro (triggers, cron e as RPCs SD donas rodam como postgres).
revoke execute on function
  public._finalizar_partida_core(uuid, uuid, uuid), public.auto_finalizar_partidas_vencidas(),
  public.fechar_mes(uuid, date), public.fechar_mes_manual(uuid, date),
  public.fechar_meses_pendentes(uuid), public.registrar_avaliacao_sessao(uuid)
  from public, anon, authenticated;
-- RPCs do app: só usuários autenticados (as checagens internas continuam valendo).
revoke execute on function
  public.confirmar_sorteio(uuid, jsonb), public.finalizar_partida_e_girar_fila(uuid, uuid, uuid),
  public.finalizar_sessao(uuid), public.solicitar_acesso_racha(uuid)
  from public, anon;

-- 5. Fotos: o bucket é público (download pela URL não depende de policy). A policy de
-- SELECT para todos só servia para LISTAR o bucket, inclusive anônimos. Fica restrita a
-- membros aprovados (mantida para não arriscar o upload, que pode depender de SELECT).
drop policy "fotos públicas" on storage.objects;
create policy "membros leem fotos de participantes" on storage.objects
  for select to authenticated
  using (bucket_id = 'participantes' and public.is_aprovado_em_algum_racha());

do $guard$
declare
  v_reader oid := 'atos_participant_context_reader'::pg_catalog.regrole;
  v_creator oid := (select r.oid from pg_catalog.pg_roles as r where r.rolname = current_user);
  v_v2 oid := pg_catalog.to_regprocedure('public.obter_meu_participante_v2(uuid)');
begin
  if pg_catalog.has_table_privilege('anon', 'public.participantes_publicos_v1', 'SELECT,INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('authenticated', 'public.participantes_publicos_v1', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_table_privilege('authenticated', 'public.participantes_publicos_v1', 'SELECT WITH GRANT OPTION')
    or not pg_catalog.has_table_privilege('authenticated', 'public.participantes_publicos_v1', 'SELECT')
    or not exists (select 1 from pg_catalog.pg_class where oid = 'public.participantes_publicos_v1'::pg_catalog.regclass
                   and reloptions @> array['security_invoker=true', 'security_barrier=true']) then
    raise exception 'P0_H2_UNEXPECTED_VIEW_ACL';
  end if;
  if (select p.proowner from pg_catalog.pg_proc as p where p.oid = v_v2) <> v_reader
    or pg_catalog.has_function_privilege('anon', v_v2, 'EXECUTE')
    or pg_catalog.has_function_privilege('service_role', v_v2, 'EXECUTE')
    or not pg_catalog.has_function_privilege('authenticated', v_v2, 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', v_v2, 'EXECUTE WITH GRANT OPTION')
    or exists (select 1 from pg_catalog.pg_auth_members as am where am.member = v_reader)
    or (select pg_catalog.count(*) from pg_catalog.pg_auth_members as am where am.roleid = v_reader) <> 1
    or exists (select 1 from pg_catalog.pg_auth_members as am where am.roleid = v_reader
               and not (am.member = v_creator and am.grantor <> v_creator and am.admin_option
                        and not am.inherit_option and not am.set_option))
    or pg_catalog.has_schema_privilege(v_reader, 'public', 'CREATE') then
    raise exception 'P0_H2_EXECUTOR_PRIVILEGES';
  end if;
  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.ranking_historico'::pg_catalog.regclass
                 and reloptions @> array['security_invoker=true'])
    or pg_catalog.has_table_privilege('anon', 'public.ranking_historico', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'P0_H2_UNEXPECTED_RANKING_ACL';
  end if;
  if exists (select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and ((p.proname in ('_finalizar_partida_core', 'auto_finalizar_partidas_vencidas', 'fechar_mes',
                                   'fechar_mes_manual', 'fechar_meses_pendentes', 'registrar_avaliacao_sessao')
                     and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
                          or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')))
                 or (p.proname in ('confirmar_sorteio', 'finalizar_partida_e_girar_fila', 'finalizar_sessao',
                                   'solicitar_acesso_racha')
                     and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
                          or not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'))))) then
    raise exception 'P0_H2_UNEXPECTED_FUNCTION_ACL';
  end if;
  if exists (select 1 from pg_catalog.pg_policies where schemaname = 'storage' and tablename = 'objects'
             and cmd = 'SELECT' and 'public' = any(roles) and qual like '%participantes%') then
    raise exception 'P0_H2_UNEXPECTED_STORAGE_POLICY';
  end if;
end;
$guard$;
commit;
