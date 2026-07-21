-- Papéis de acesso, RLS por papel e blindagem das RPCs.
-- Execute este arquivo INTEIRO no Supabase SQL Editor.

begin;

do $block$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'papel_usuario'
  ) then
    create type public.papel_usuario as enum ('admin', 'normal');
  end if;
end;
$block$;

create table if not exists public.perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  papel public.papel_usuario not null default 'normal',
  nome text,
  criado_em timestamptz not null default now()
);

alter table public.perfis enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select exists (
    select 1 from public.perfis
    where id = auth.uid() and papel = 'admin'::public.papel_usuario
  );
$function$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Remove a policy ampla anterior e também os nomes desta migração para que o
-- arquivo possa ser reaplicado com segurança durante a configuração.
drop policy if exists "organizador autenticado" on public.participantes;
drop policy if exists "organizador autenticado" on public.sessoes;
drop policy if exists "organizador autenticado" on public.check_ins;
drop policy if exists "organizador autenticado" on public.times;
drop policy if exists "organizador autenticado" on public.times_jogadores;
drop policy if exists "organizador autenticado" on public.partidas;
drop policy if exists "organizador autenticado" on public.eventos;

drop policy if exists "participantes leitura autenticada" on public.participantes;
drop policy if exists "participantes inserção admin" on public.participantes;
drop policy if exists "participantes atualização admin" on public.participantes;
drop policy if exists "participantes exclusão admin" on public.participantes;
create policy "participantes leitura autenticada" on public.participantes for select to authenticated using (true);
create policy "participantes inserção admin" on public.participantes for insert to authenticated with check (public.is_admin());
create policy "participantes atualização admin" on public.participantes for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "participantes exclusão admin" on public.participantes for delete to authenticated using (public.is_admin());

drop policy if exists "sessões leitura autenticada" on public.sessoes;
drop policy if exists "sessões inserção admin" on public.sessoes;
drop policy if exists "sessões atualização admin" on public.sessoes;
create policy "sessões leitura autenticada" on public.sessoes for select to authenticated using (true);
create policy "sessões inserção admin" on public.sessoes for insert to authenticated with check (public.is_admin());
create policy "sessões atualização admin" on public.sessoes for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "check-ins leitura autenticada" on public.check_ins;
drop policy if exists "check-ins inserção admin" on public.check_ins;
drop policy if exists "check-ins atualização admin" on public.check_ins;
drop policy if exists "check-ins exclusão admin" on public.check_ins;
create policy "check-ins leitura autenticada" on public.check_ins for select to authenticated using (true);
create policy "check-ins inserção admin" on public.check_ins for insert to authenticated with check (public.is_admin());
create policy "check-ins atualização admin" on public.check_ins for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "check-ins exclusão admin" on public.check_ins for delete to authenticated using (public.is_admin());

drop policy if exists "times leitura autenticada" on public.times;
drop policy if exists "times inserção admin" on public.times;
drop policy if exists "times atualização admin" on public.times;
drop policy if exists "times exclusão admin" on public.times;
create policy "times leitura autenticada" on public.times for select to authenticated using (true);
create policy "times inserção admin" on public.times for insert to authenticated with check (public.is_admin());
create policy "times atualização admin" on public.times for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "times exclusão admin" on public.times for delete to authenticated using (public.is_admin());

drop policy if exists "times jogadores leitura autenticada" on public.times_jogadores;
drop policy if exists "times jogadores inserção admin" on public.times_jogadores;
drop policy if exists "times jogadores atualização admin" on public.times_jogadores;
drop policy if exists "times jogadores exclusão admin" on public.times_jogadores;
create policy "times jogadores leitura autenticada" on public.times_jogadores for select to authenticated using (true);
create policy "times jogadores inserção admin" on public.times_jogadores for insert to authenticated with check (public.is_admin());
create policy "times jogadores atualização admin" on public.times_jogadores for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "times jogadores exclusão admin" on public.times_jogadores for delete to authenticated using (public.is_admin());

drop policy if exists "partidas leitura autenticada" on public.partidas;
drop policy if exists "partidas inserção admin" on public.partidas;
drop policy if exists "partidas atualização admin" on public.partidas;
create policy "partidas leitura autenticada" on public.partidas for select to authenticated using (true);
create policy "partidas inserção admin" on public.partidas for insert to authenticated with check (public.is_admin());
create policy "partidas atualização admin" on public.partidas for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "eventos leitura autenticada" on public.eventos;
drop policy if exists "eventos inserção admin" on public.eventos;
drop policy if exists "eventos atualização admin" on public.eventos;
create policy "eventos leitura autenticada" on public.eventos for select to authenticated using (true);
create policy "eventos inserção admin" on public.eventos for insert to authenticated with check (public.is_admin());
create policy "eventos atualização admin" on public.eventos for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "perfil leitura própria" on public.perfis;
create policy "perfil leitura própria" on public.perfis
for select to authenticated using (id = auth.uid());
-- Sem policy de INSERT/UPDATE/DELETE em perfis de propósito.

drop policy if exists "organizador envia fotos" on storage.objects;
drop policy if exists "organizador altera fotos" on storage.objects;
drop policy if exists "admin envia fotos de participantes" on storage.objects;
drop policy if exists "admin altera fotos de participantes" on storage.objects;
create policy "admin envia fotos de participantes" on storage.objects
for insert to authenticated with check (bucket_id = 'participantes' and public.is_admin());
create policy "admin altera fotos de participantes" on storage.objects
for update to authenticated
using (bucket_id = 'participantes' and public.is_admin())
with check (bucket_id = 'participantes' and public.is_admin());
-- A policy pública de SELECT do bucket criada na 001 permanece inalterada.

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
    values (p_sessao_id, (item->>'numero')::integer, (item->>'numero')::integer,
      case when (item->>'numero')::integer <= 2
        then 'jogando'::public.status_time else 'na_fila'::public.status_time end)
    returning * into novo_time;

    for jogador in select value from jsonb_array_elements(item->'jogadores')
    loop
      if not exists (
        select 1 from public.check_ins c
        where c.sessao_id = p_sessao_id
          and c.participante_id = (jogador #>> '{}')::uuid
          and c.alocado = false
      ) then raise exception 'Jogador inválido ou já alocado'; end if;
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
  if not public.is_admin() then
    raise exception 'Apenas o organizador pode fazer isso';
  end if;

  select p.* into jogo from public.partidas p
  where p.id = p_partida_id for update;
  if jogo.id is null then raise exception 'Partida não encontrada'; end if;
  if jogo.status = 'finalizada'::public.status_partida then return; end if;
  select max(t.posicao_fila) into max_fila from public.times t
  where t.sessao_id = jogo.sessao_id;
  if max_fila is null or max_fila < 2 then
    raise exception 'A sessão não possui fila válida';
  end if;

  update public.times set posicao_fila = posicao_fila + max_fila
  where sessao_id = jogo.sessao_id;
  if jogo.placar_a = jogo.placar_b then
    update public.times set posicao_fila = max_fila - 1 where id = jogo.time_a_id;
    update public.times set posicao_fila = max_fila where id = jogo.time_b_id;
    update public.times set posicao_fila = posicao_fila - max_fila - 2
    where sessao_id = jogo.sessao_id and id not in (jogo.time_a_id, jogo.time_b_id);
  elsif jogo.placar_a > jogo.placar_b then
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

-- Verificação rápida: papel, helper e duas RPCs devem aparecer.
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('is_admin', 'confirmar_sorteio', 'finalizar_partida_e_girar_fila')
order by routine_name;
