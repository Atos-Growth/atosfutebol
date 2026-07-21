-- Força média persistida por time e encerramento real da sessão.
-- Execute inteiro depois da migração 004.

begin;

alter table public.times
add column if not exists forca_media numeric(4,2);

alter table public.sessoes
add column if not exists horario_fim timestamptz;

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
  if not public.is_admin() then
    raise exception 'Apenas o organizador pode fazer isso';
  end if;

  select s.tamanho_time into tamanho
  from public.sessoes s where s.id = p_sessao_id for update;
  if tamanho is null then raise exception 'Sessão não encontrada'; end if;
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

    -- Fonte de verdade: estrelas persistidas em participantes. Nenhuma força
    -- enviada pelo cliente entra neste cálculo.
    update public.times t
    set forca_media = (
      select round(avg(p.estrelas)::numeric, 2)
      from public.times_jogadores tj
      join public.participantes p on p.id = tj.participante_id
      where tj.time_id = novo_time.id
    )
    where t.id = novo_time.id;
  end loop;

  update public.sessoes
  set status = 'em_andamento'::public.status_sessao,
      horario_sorteio = coalesce(horario_sorteio, now())
  where id = p_sessao_id;

  return query select t.* from public.times t
  where t.sessao_id = p_sessao_id order by t.posicao_fila;
end;
$function$;

revoke all on function public.confirmar_sorteio(uuid, jsonb) from public;
grant execute on function public.confirmar_sorteio(uuid, jsonb) to authenticated;

commit;

-- Verificação das colunas novas.
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'times' and column_name = 'forca_media')
    or (table_name = 'sessoes' and column_name = 'horario_fim'))
order by table_name, column_name;
