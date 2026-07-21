-- Execute ESTE ARQUIVO INTEIRO em uma nova consulta do Supabase SQL Editor.
-- Pode ser executado novamente: CREATE OR REPLACE não duplica as funções.

begin;

create or replace function public.confirmar_sorteio(p_sessao_id uuid, p_times jsonb)
returns setof public.times
language plpgsql security definer set search_path = public
as $function$
declare
  item jsonb;
  jogador jsonb;
  novo_time public.times;
  tamanho integer;
begin
  select s.tamanho_time into tamanho
  from public.sessoes s where s.id = p_sessao_id for update;

  if tamanho is null then
    raise exception 'Sessão não encontrada';
  end if;
  if p_times is null or jsonb_typeof(p_times) <> 'array' or jsonb_array_length(p_times) < 2 then
    raise exception 'São necessários ao menos dois times';
  end if;
  if exists (select 1 from public.times t where t.sessao_id = p_sessao_id) then
    raise exception 'O sorteio desta sessão já foi confirmado';
  end if;

  for item in select value from jsonb_array_elements(p_times)
  loop
    if jsonb_array_length(item->'jogadores') <> tamanho then
      raise exception 'Todos os times devem estar completos';
    end if;

    insert into public.times (sessao_id, numero, posicao_fila, status)
    values (
      p_sessao_id,
      (item->>'numero')::integer,
      (item->>'numero')::integer,
      case when (item->>'numero')::integer <= 2
        then 'jogando'::public.status_time
        else 'na_fila'::public.status_time end
    ) returning * into novo_time;

    for jogador in select value from jsonb_array_elements(item->'jogadores')
    loop
      if not exists (
        select 1 from public.check_ins c
        where c.sessao_id = p_sessao_id
          and c.participante_id = (jogador #>> '{}')::uuid
          and c.alocado = false
      ) then
        raise exception 'Jogador inválido ou já alocado';
      end if;

      insert into public.times_jogadores (time_id, participante_id)
      values (novo_time.id, (jogador #>> '{}')::uuid);
      update public.check_ins set alocado = true
      where sessao_id = p_sessao_id
        and participante_id = (jogador #>> '{}')::uuid;
    end loop;
  end loop;

  update public.sessoes
  set status = 'em_andamento'::public.status_sessao,
      horario_sorteio = coalesce(horario_sorteio, now())
  where id = p_sessao_id;

  return query select t.* from public.times t
  where t.sessao_id = p_sessao_id order by t.posicao_fila;
end;
$function$;

create or replace function public.finalizar_partida_e_girar_fila(p_partida_id uuid)
returns void
language plpgsql security definer set search_path = public
as $function$
declare
  jogo public.partidas;
  max_fila integer;
begin
  select p.* into jogo from public.partidas p
  where p.id = p_partida_id for update;

  if jogo.id is null then
    raise exception 'Partida não encontrada';
  end if;
  if jogo.status = 'finalizada'::public.status_partida then
    return;
  end if;

  select max(t.posicao_fila) into max_fila from public.times t
  where t.sessao_id = jogo.sessao_id;
  if max_fila is null or max_fila < 2 then
    raise exception 'A sessão não possui fila válida';
  end if;

  -- Faixa temporária positiva: evita UNIQUE e respeita CHECK (posicao_fila > 0).
  update public.times set posicao_fila = posicao_fila + max_fila
  where sessao_id = jogo.sessao_id;

  if jogo.placar_a = jogo.placar_b then
    update public.times set posicao_fila = max_fila - 1 where id = jogo.time_a_id;
    update public.times set posicao_fila = max_fila where id = jogo.time_b_id;
    update public.times set posicao_fila = posicao_fila - max_fila - 2
    where sessao_id = jogo.sessao_id
      and id not in (jogo.time_a_id, jogo.time_b_id);
  elsif jogo.placar_a > jogo.placar_b then
    update public.times set posicao_fila = 1 where id = jogo.time_a_id;
    update public.times set posicao_fila = max_fila where id = jogo.time_b_id;
    update public.times set posicao_fila = posicao_fila - max_fila - 1
    where sessao_id = jogo.sessao_id
      and id not in (jogo.time_a_id, jogo.time_b_id);
  else
    update public.times set posicao_fila = 1 where id = jogo.time_b_id;
    update public.times set posicao_fila = max_fila where id = jogo.time_a_id;
    update public.times set posicao_fila = posicao_fila - max_fila - 1
    where sessao_id = jogo.sessao_id
      and id not in (jogo.time_a_id, jogo.time_b_id);
  end if;

  update public.times
  set status = case when posicao_fila <= 2
    then 'jogando'::public.status_time
    else 'na_fila'::public.status_time end
  where sessao_id = jogo.sessao_id;

  update public.partidas
  set status = 'finalizada'::public.status_partida,
      horario_fim = now(), timer_running = false
  where id = p_partida_id;
end;
$function$;

revoke all on function public.confirmar_sorteio(uuid, jsonb) from public;
revoke all on function public.finalizar_partida_e_girar_fila(uuid) from public;
grant execute on function public.confirmar_sorteio(uuid, jsonb) to authenticated;
grant execute on function public.finalizar_partida_e_girar_fila(uuid) to authenticated;

commit;

-- Deve retornar duas linhas.
select p.proname as funcao, pg_get_function_identity_arguments(p.oid) as argumentos
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('confirmar_sorteio', 'finalizar_partida_e_girar_fila')
order by p.proname;
