-- Empate na fila: com 3+ times, quem empatou vai pro fim da fila e o
-- organizador escolhe manualmente o próximo confronto entre quem estava
-- esperando (com exatamente 3 times, o único jeito de fechar um confronto é
-- um dos que empataram voltar pra jogar com quem estava de fora).
--
-- Também adiciona o encerramento automático por tempo esgotado mesmo sem
-- ninguém com o app aberto: um job agendado (pg_cron) varre partidas cujo
-- cronômetro já expirou e finaliza sozinho. Como o job roda sem um usuário
-- autenticado, a lógica de finalizar+girar fila foi extraída pra uma função
-- interna (_finalizar_partida_core) que NÃO é exposta a authenticated/anon;
-- só quem pode chamá-la é o dono da função (o job de cron) ou as duas RPCs
-- públicas que a envolvem com as checagens de autorização corretas.
--
-- Execute inteiro depois da migração 008.

begin;

alter table public.sessoes
add column if not exists pendente_escolha_partida_id uuid references public.partidas(id);

create or replace function public._finalizar_partida_core(
  p_partida_id uuid,
  p_proximo_time_a_id uuid default null,
  p_proximo_time_b_id uuid default null
)
returns void
language plpgsql security definer set search_path = public
as $function$
declare
  jogo public.partidas;
  max_fila integer;
  ja_pendente boolean;
begin
  select p.* into jogo from public.partidas p
  where p.id = p_partida_id for update;
  if jogo.id is null then raise exception 'Partida não encontrada'; end if;

  select count(*) into max_fila from public.times t
  where t.sessao_id = jogo.sessao_id;
  if max_fila is null or max_fila < 2 then
    raise exception 'A sessão não possui fila válida';
  end if;

  select exists (
    select 1 from public.sessoes s
    where s.id = jogo.sessao_id and s.pendente_escolha_partida_id = jogo.id
  ) into ja_pendente;

  -- Já finalizada e a fila já foi girada antes (ou nunca ficou pendente): nada a fazer.
  if jogo.status = 'finalizada'::public.status_partida and not ja_pendente then
    return;
  end if;

  -- A partida em si sempre termina, independente do que acontece com a fila.
  if jogo.status <> 'finalizada'::public.status_partida then
    update public.partidas
    set status = 'finalizada'::public.status_partida,
        horario_fim = now(), timer_running = false
    where id = p_partida_id;
  end if;

  if jogo.placar_a <> jogo.placar_b then
    -- Vitória: comportamento automático, igual antes.
    update public.times set posicao_fila = posicao_fila + max_fila
    where sessao_id = jogo.sessao_id;
    if jogo.placar_a > jogo.placar_b then
      update public.times set posicao_fila = 1 where id = jogo.time_a_id;
      update public.times set posicao_fila = max_fila where id = jogo.time_b_id;
      update public.times set posicao_fila = posicao_fila - max_fila - 1
      where sessao_id = jogo.sessao_id and id not in (jogo.time_a_id, jogo.time_b_id);
    else
      update public.times set posicao_fila = 1 where id = jogo.time_b_id;
      update public.times set posicao_fila = max_fila where id = jogo.time_a_id;
      update public.times set posicao_fila = posicao_fila - max_fila - 1
      where sessao_id = jogo.sessao_id and id not in (jogo.time_a_id, jogo.time_b_id);
    end if;
    update public.times set status = case when posicao_fila <= 2
      then 'jogando'::public.status_time else 'na_fila'::public.status_time end
    where sessao_id = jogo.sessao_id;
    update public.sessoes set pendente_escolha_partida_id = null
    where id = jogo.sessao_id and pendente_escolha_partida_id = jogo.id;
  elsif max_fila <= 2 then
    -- Empate com só 2 times na sessão: os mesmos dois times continuam.
    update public.times set posicao_fila = 1, status = 'jogando'::public.status_time where id = jogo.time_a_id;
    update public.times set posicao_fila = 2, status = 'jogando'::public.status_time where id = jogo.time_b_id;
    update public.sessoes set pendente_escolha_partida_id = null
    where id = jogo.sessao_id and pendente_escolha_partida_id = jogo.id;
  elsif p_proximo_time_a_id is not null and p_proximo_time_b_id is not null then
    -- Empate com 3+ times e o próximo confronto já foi escolhido.
    if p_proximo_time_a_id = p_proximo_time_b_id then
      raise exception 'Escolha dois times diferentes para o próximo confronto';
    end if;
    if not exists (select 1 from public.times where id = p_proximo_time_a_id and sessao_id = jogo.sessao_id)
      or not exists (select 1 from public.times where id = p_proximo_time_b_id and sessao_id = jogo.sessao_id) then
      raise exception 'Time inválido para o próximo confronto';
    end if;
    if p_proximo_time_a_id in (jogo.time_a_id, jogo.time_b_id)
      and p_proximo_time_b_id in (jogo.time_a_id, jogo.time_b_id) then
      raise exception 'Os dois times que empataram não podem jogar entre si de novo';
    end if;
    if max_fila >= 4 and (
      p_proximo_time_a_id in (jogo.time_a_id, jogo.time_b_id)
      or p_proximo_time_b_id in (jogo.time_a_id, jogo.time_b_id)
    ) then
      raise exception 'Com 4 times ou mais, o próximo confronto é só entre quem estava esperando';
    end if;

    -- Faixa temporária positiva pra não violar UNIQUE(sessao_id, posicao_fila).
    update public.times set posicao_fila = posicao_fila + max_fila
    where sessao_id = jogo.sessao_id;
    update public.times set posicao_fila = 1 where id = p_proximo_time_a_id;
    update public.times set posicao_fila = 2 where id = p_proximo_time_b_id;

    -- Quem empatou e não voltou a jogar vai pro fim da fila.
    if jogo.time_a_id in (p_proximo_time_a_id, p_proximo_time_b_id) then
      update public.times set posicao_fila = max_fila where id = jogo.time_b_id;
    elsif jogo.time_b_id in (p_proximo_time_a_id, p_proximo_time_b_id) then
      update public.times set posicao_fila = max_fila where id = jogo.time_a_id;
    else
      update public.times set posicao_fila = max_fila - 1 where id = jogo.time_a_id;
      update public.times set posicao_fila = max_fila where id = jogo.time_b_id;
    end if;

    -- Todo o resto (quem já estava esperando e não foi chamado agora) mantém a ordem relativa.
    with resto as (
      select id, row_number() over (order by posicao_fila) as rn
      from public.times
      where sessao_id = jogo.sessao_id
        and id not in (p_proximo_time_a_id, p_proximo_time_b_id, jogo.time_a_id, jogo.time_b_id)
    )
    update public.times t set posicao_fila = resto.rn + 2
    from resto where t.id = resto.id;

    update public.times set status = case when posicao_fila <= 2
      then 'jogando'::public.status_time else 'na_fila'::public.status_time end
    where sessao_id = jogo.sessao_id;
    update public.sessoes set pendente_escolha_partida_id = null
    where id = jogo.sessao_id and pendente_escolha_partida_id = jogo.id;
  else
    -- Empate com 3+ times e ainda sem escolha: a partida termina, mas a fila
    -- fica travada até alguém (o organizador) escolher o próximo confronto.
    update public.sessoes set pendente_escolha_partida_id = jogo.id
    where id = jogo.sessao_id;
  end if;
end;
$function$;

revoke all on function public._finalizar_partida_core(uuid, uuid, uuid) from public;

-- RPC pública: chamada pelo app com um usuário autenticado. Continua exigindo
-- ser admin, exatamente como antes.
create or replace function public.finalizar_partida_e_girar_fila(
  p_partida_id uuid,
  p_proximo_time_a_id uuid default null,
  p_proximo_time_b_id uuid default null
)
returns void
language plpgsql security definer set search_path = public
as $function$
begin
  if not public.is_admin() then
    raise exception 'Apenas o organizador pode fazer isso';
  end if;
  perform public._finalizar_partida_core(p_partida_id, p_proximo_time_a_id, p_proximo_time_b_id);
end;
$function$;

revoke all on function public.finalizar_partida_e_girar_fila(uuid, uuid, uuid) from public;
grant execute on function public.finalizar_partida_e_girar_fila(uuid, uuid, uuid) to authenticated;

-- A assinatura mudou (2 parâmetros novos com default). Remove a versão antiga
-- de 1 parâmetro pra não deixar as duas convivendo com o mesmo nome.
drop function if exists public.finalizar_partida_e_girar_fila(uuid);

-- Função de sistema: varre partidas com o cronômetro já expirado e finaliza
-- sozinha. Não é exposta a authenticated/anon — só o job de cron (que roda
-- como o dono da função) consegue chamá-la.
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

-- Agenda o job (pg_cron). Precisa da extensão habilitada no projeto — no
-- Supabase isso normalmente já vem disponível, mas se o "create extension"
-- falhar aqui, habilite pg_cron pelo Dashboard (Database > Extensions) e
-- rode só a parte do cron.schedule depois.
create extension if not exists pg_cron with schema extensions;

do $block$
begin
  if exists (select 1 from cron.job where jobname = 'finalizar-partidas-vencidas') then
    perform cron.unschedule('finalizar-partidas-vencidas');
  end if;
end;
$block$;

-- Roda a cada minuto (granularidade padrão do cron). Uma partida pode ficar
-- visualmente zerada por até ~59s antes do banco marcar como finalizada.
select cron.schedule(
  'finalizar-partidas-vencidas',
  '* * * * *',
  $$select public.auto_finalizar_partidas_vencidas()$$
);

commit;
