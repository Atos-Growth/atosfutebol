-- RECUPERAÇÃO ADMINISTRATIVA EXPLÍCITA — funções internas SECURITY DEFINER.
-- Só para incidente comprovado em que um consumidor legítimo FORA do app precise chamar
-- uma dessas funções pela API com sessão de usuário. O app, os triggers e o cron não precisam.
--
-- CONSEQUÊNCIA: devolve EXECUTE a `authenticated` (NUNCA a anon). Essas funções não conferem
-- quem chama: qualquer usuário logado, de QUALQUER pelada, passa a poder, por exemplo,
-- fechar antecipadamente o mês de qualquer pelada (fechar_mes / fechar_meses_pendentes /
-- fechar_mes_manual), finalizar partidas alheias (_finalizar_partida_core) e gravar
-- avaliações de sessão (registrar_avaliacao_sessao). Prefira editar a lista e reabrir só a
-- função necessária, pelo menor tempo possível, e revogar de novo em seguida.
--
-- Exige confirmação na mesma sessão, antes de rodar o arquivo:
--   set atos.reabrir_funcoes_internas = 'authenticated';
-- (no psql também: PGOPTIONS='-c atos.reabrir_funcoes_internas=authenticated').
begin;
set local lock_timeout = '2s';
do $confirm$
begin
  if pg_catalog.current_setting('atos.reabrir_funcoes_internas', true) is distinct from 'authenticated' then
    raise exception 'P0_H2_RECUPERACAO_EXIGE_CONFIRMACAO_EXPLICITA';
  end if;
end;
$confirm$;
grant execute on function
  public._finalizar_partida_core(uuid, uuid, uuid), public.auto_finalizar_partidas_vencidas(),
  public.fechar_mes(uuid, date), public.fechar_mes_manual(uuid, date),
  public.fechar_meses_pendentes(uuid), public.registrar_avaliacao_sessao(uuid)
  to authenticated;
do $guard$
begin
  if exists (select 1 from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('_finalizar_partida_core', 'auto_finalizar_partidas_vencidas', 'fechar_mes',
                                 'fechar_mes_manual', 'fechar_meses_pendentes', 'registrar_avaliacao_sessao')
               and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception 'P0_H2_RECUPERACAO_NUNCA_REABRE_ANON';
  end if;
end;
$guard$;
commit;
