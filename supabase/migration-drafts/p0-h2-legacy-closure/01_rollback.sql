-- *** SUBSTITUÍDO por 01a_rollback.sql (H2.2a). NÃO EXECUTAR. ***
-- Recriaria a policy de Storage, que o postgres não administra em produção. Mantido só como
-- referência até a 01a estar versionada; o bloqueio logo após o BEGIN aborta a execução.
-- Reversão FUNCIONAL da ETAPA 01 (exige a etapa 02 já revertida, se tiver sido aplicada).
-- Desfaz só o que pode afetar o funcionamento do app: a policy de leitura das fotos (o
-- upload poderia depender dela), a view pública e a RPC v2.
--
-- NÃO reabre, de propósito:
--   * EXECUTE das funções internas SECURITY DEFINER sem checagem de quem chama
--     (fechar_mes, fechar_meses_pendentes, fechar_mes_manual, _finalizar_partida_core,
--     registrar_avaliacao_sessao, auto_finalizar_partidas_vencidas). O app não as chama:
--     elas rodam por dentro (trigger, cron e RPCs SD do postgres), o que segue funcionando.
--     Reabrir exige a recuperação administrativa explícita em 01_recuperacao_funcoes_admin.sql.
--   * EXECUTE de anon nas RPCs do app (o app sempre chama autenticado).
--   * ranking_historico para anon / sem RLS (o app não usa essa view).
begin;
do $superseded$ begin raise exception 'P0_H2_SUPERSEDED_USE_01A_ROLLBACK'; end $superseded$;
set local lock_timeout = '2s';
drop policy "membros leem fotos de participantes" on storage.objects;
create policy "fotos públicas" on storage.objects for select using (bucket_id = 'participantes');
-- A v2 pertence à executora; o deployer (ADMIN implícito) ganha SET só para removê-la.
grant atos_participant_context_reader to current_user with inherit false, set true;
set local role atos_participant_context_reader;
drop function public.obter_meu_participante_v2(uuid);
reset role;
revoke atos_participant_context_reader from current_user;
drop view public.participantes_publicos_v1;

do $guard$
begin
  if exists (select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('_finalizar_partida_core', 'auto_finalizar_partidas_vencidas', 'fechar_mes',
                                 'fechar_mes_manual', 'fechar_meses_pendentes', 'registrar_avaliacao_sessao',
                                 'confirmar_sorteio', 'finalizar_partida_e_girar_fila', 'finalizar_sessao',
                                 'solicitar_acesso_racha')
               and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception 'P0_H2_ROLLBACK_WOULD_REOPEN_ANON_EXECUTE';
  end if;
end;
$guard$;
commit;
