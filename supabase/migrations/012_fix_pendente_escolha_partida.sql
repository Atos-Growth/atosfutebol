-- Conserta a finalização de partida quebrada com
-- "column s.pendente_escolha_partida_id does not exist".
--
-- A migração 009 era uma transação única que terminava em
-- "create extension pg_cron" + "cron.schedule". Em projetos onde o pg_cron não
-- estava habilitado, esse trecho falhou e levou a transação inteira ao
-- rollback — inclusive o "alter table public.sessoes add column
-- pendente_escolha_partida_id". A 010 recriou as funções que usam a coluna,
-- mas não cria a coluna, e o corpo de uma função plpgsql só é validado em
-- tempo de execução: por isso tudo "instalou" sem erro e só quebrou na hora de
-- encerrar a partida.
--
-- Esta migração é idempotente (pode rodar mesmo se a 009 tiver dado certo) e
-- isola o pg_cron do resto, pra que uma falha lá não derrube mais nada.

begin;

-- 1. A coluna que ficou faltando.
alter table public.sessoes
add column if not exists pendente_escolha_partida_id uuid references public.partidas(id);

-- 2. Função do job de encerramento por tempo esgotado — também se perdeu no
--    rollback da 009 e a 010 assumiu que ela já existia.
create or replace function public.auto_finalizar_partidas_vencidas()
returns void
language plpgsql security definer set search_path = public
as $function$
declare
  partida_rec public.partidas;
begin
  for partida_rec in
    select * from public.partidas
    where status = 'em_andamento'::public.status_partida
      and timer_running = true
      and timer_started_at is not null
      and (timer_remaining_seconds - extract(epoch from (now() - timer_started_at))) <= 0
    for update
  loop
    perform public._finalizar_partida_core(partida_rec.id, null, null);
  end loop;
end;
$function$;

revoke all on function public.auto_finalizar_partidas_vencidas() from public;

-- 3. A versão antiga de 1 parâmetro (o drop da 009 também sumiu no rollback).
--    Deixar as duas convivendo torna a resolução da RPC ambígua.
drop function if exists public.finalizar_partida_e_girar_fila(uuid);

commit;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. pg_cron: agora FORA da transação acima. Se falhar, o resto já está
--    aplicado — o encerramento por tempo continua funcionando pelo app aberto,
--    só não roda com todo mundo com o app fechado.
-- ─────────────────────────────────────────────────────────────────────────
do $block$
begin
  execute 'create extension if not exists pg_cron with schema extensions';
exception when others then
  raise notice 'pg_cron indisponível (%). Habilite em Database > Extensions e rode o bloco seguinte de novo.', sqlerrm;
end;
$block$;

do $block$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron não instalado — job "finalizar-partidas-vencidas" não agendado.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'finalizar-partidas-vencidas') then
    perform cron.unschedule('finalizar-partidas-vencidas');
  end if;

  perform cron.schedule(
    'finalizar-partidas-vencidas',
    '* * * * *',
    'select public.auto_finalizar_partidas_vencidas()'
  );
end;
$block$;

-- ─────────────────────────────────────────────────────────────────────────
-- Verificação: as duas linhas abaixo devem retornar resultado.
-- ─────────────────────────────────────────────────────────────────────────
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'sessoes'
  and column_name = 'pendente_escolha_partida_id';

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('finalizar_partida_e_girar_fila', '_finalizar_partida_core', 'auto_finalizar_partidas_vencidas')
order by p.proname;
