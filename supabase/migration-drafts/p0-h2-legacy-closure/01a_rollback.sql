-- Reversão FUNCIONAL da ETAPA 01a (exige a etapa 02 já revertida, se tiver sido aplicada).
-- Desfaz só o que pode afetar o funcionamento do app: a view pública e a RPC v2.
-- Não toca no Storage: a 01a não alterou nenhuma policy de storage.objects.
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
set local lock_timeout = '2s';
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
