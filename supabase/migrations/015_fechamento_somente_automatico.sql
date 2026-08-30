-- Tira o fechamento manual do alcance do app.
--
-- A 013 criou fechar_mes_manual como escape de recuperação e o app ganhou um
-- botão "Fechar o mês". Os dois saem agora, porque o argumento não se sustenta:
-- fechar_meses_pendentes roda a CADA sessão criada, então uma falha do trigger
-- já é retentada sozinha no domingo seguinte. O botão não recuperava nada que
-- não se recuperasse sozinho.
--
-- O que ele fazia de fato era abrir um jeito silencioso de estragar um mês:
-- fechar em 10 de setembro grava os domingos até ali, marca setembro como
-- fechado, e os domingos restantes do mês passam a ser gravados em
-- avaliacoes_sessao sem NUNCA serem contados — porque fechar_mes se recusa,
-- corretamente, a refazer um mês já fechado. Ninguém é avisado.
--
-- A função continua existindo para recuperação pelo SQL Editor, onde quem roda
-- consegue olhar o estado antes. Só deixa de ser chamável pela API do app.
--
-- Execute este arquivo INTEIRO no Supabase SQL Editor, depois da migração 014.

begin;

revoke execute on function public.fechar_mes_manual(uuid, date) from authenticated;

comment on function public.fechar_mes_manual(uuid, date) is
  'Recuperação manual, SÓ pelo SQL Editor — sem grant para authenticated de propósito. Fechar um mês antes dele terminar deixa os domingos restantes gravados e nunca contados. O caminho normal é o trigger fechar_meses_ao_abrir_sessao.';

commit;

-- ─────────────────────────────────────────────────────────────────────────
-- Verificação: as duas linhas devem bater.
-- ─────────────────────────────────────────────────────────────────────────
select 'fechar_mes_manual fora do app' as verificacao,
       (select count(*)::text from information_schema.role_routine_grants
        where routine_schema = 'public'
          and routine_name = 'fechar_mes_manual'
          and grantee = 'authenticated') as resultado,
       '0' as esperado
union all
select 'finalizar_sessao ainda no app',
       (select count(*)::text from information_schema.role_routine_grants
        where routine_schema = 'public'
          and routine_name = 'finalizar_sessao'
          and grantee = 'authenticated'),
       '1';
