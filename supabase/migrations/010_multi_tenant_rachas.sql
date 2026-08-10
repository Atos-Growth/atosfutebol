-- Multi-tenant por racha (organização).
--
-- ATENÇÃO — DESTRUTIVO: esta migração trunca participantes, sessões,
-- check-ins, times, times_jogadores, partidas e eventos antes de tornar
-- racha_id obrigatório nessas tabelas. Não existe forma segura de "adivinhar"
-- a qual racha um registro antigo pertenceria, então os dados de futebol são
-- zerados aqui de propósito (decisão combinada: ambiente ainda em teste).
-- perfis e auth.users NÃO são apagados — só o vínculo perfis.papel some, e
-- os usuários passam a solicitar acesso a um racha explicitamente.
--
-- Execute este arquivo INTEIRO no Supabase SQL Editor, depois da migração 009.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Rachas (organizações)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.rachas (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(trim(nome)) >= 2),
  criado_em timestamptz not null default now()
);

alter table public.rachas enable row level security;

drop policy if exists "rachas leitura autenticada" on public.rachas;
create policy "rachas leitura autenticada" on public.rachas
for select to authenticated using (true);

-- De propósito: nenhuma policy de insert/update/delete para authenticated.
-- Novos rachas são criados só pelo desenvolvedor, direto no SQL Editor
-- (ex: insert into public.rachas (nome) values ('Nome do racha');).

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Vínculo usuário ↔ racha (substitui o papel global de perfis)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.racha_membros (
  id uuid primary key default gen_random_uuid(),
  racha_id uuid not null references public.rachas(id) on delete cascade,
  perfil_id uuid not null references public.perfis(id) on delete cascade,
  papel public.papel_usuario not null default 'pendente',
  criado_em timestamptz not null default now(),
  unique (racha_id, perfil_id)
);

alter table public.racha_membros enable row level security;
create index if not exists racha_membros_por_racha on public.racha_membros(racha_id, papel);
create index if not exists racha_membros_por_perfil on public.racha_membros(perfil_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Helpers de RLS escopados por racha (substituem is_admin()/is_aprovado())
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.is_membro_aprovado(p_racha_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $function$
  select exists (
    select 1 from public.racha_membros
    where racha_id = p_racha_id and perfil_id = auth.uid()
      and papel in ('admin'::public.papel_usuario, 'normal'::public.papel_usuario)
  );
$function$;
revoke all on function public.is_membro_aprovado(uuid) from public;
grant execute on function public.is_membro_aprovado(uuid) to authenticated;

create or replace function public.is_membro_admin(p_racha_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $function$
  select exists (
    select 1 from public.racha_membros
    where racha_id = p_racha_id and perfil_id = auth.uid()
      and papel = 'admin'::public.papel_usuario
  );
$function$;
revoke all on function public.is_membro_admin(uuid) from public;
grant execute on function public.is_membro_admin(uuid) to authenticated;

create or replace function public.is_admin_de_algum_racha()
returns boolean
language sql stable security definer set search_path = public
as $function$
  select exists (
    select 1 from public.racha_membros
    where perfil_id = auth.uid() and papel = 'admin'::public.papel_usuario
  );
$function$;
revoke all on function public.is_admin_de_algum_racha() from public;
grant execute on function public.is_admin_de_algum_racha() to authenticated;

-- Equivalente ao antigo is_aprovado() global, mas sem exigir um racha
-- específico: usado só pelo upload de foto do bucket (ver seção 7), que
-- precisa liberar qualquer usuário aprovado — não só admin — porque o
-- autocadastro de jogador (Participants.saveSelf) deixa o próprio jogador
-- enviar sua foto.
create or replace function public.is_aprovado_em_algum_racha()
returns boolean
language sql stable security definer set search_path = public
as $function$
  select exists (
    select 1 from public.racha_membros
    where perfil_id = auth.uid() and papel in ('admin'::public.papel_usuario, 'normal'::public.papel_usuario)
  );
$function$;
revoke all on function public.is_aprovado_em_algum_racha() from public;
grant execute on function public.is_aprovado_em_algum_racha() to authenticated;

-- racha_membros: o próprio usuário vê seus vínculos; admin de um racha vê
-- todos os vínculos daquele racha (pra aprovar/rejeitar).
drop policy if exists "racha_membros leitura própria ou admin" on public.racha_membros;
create policy "racha_membros leitura própria ou admin" on public.racha_membros
for select to authenticated using (perfil_id = auth.uid() or public.is_membro_admin(racha_id));
-- Sem policy de insert/update/delete para authenticated: pedido de acesso
-- passa pela RPC solicitar_acesso_racha, e aprovação/rejeição pelas Edge
-- Functions com service role (mesmo padrão que perfis já usava).

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Pedido de acesso a um racha
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.solicitar_acesso_racha(p_racha_id uuid)
returns public.racha_membros
language plpgsql security definer set search_path = public
as $function$
declare
  resultado public.racha_membros;
begin
  if not exists (select 1 from public.rachas where id = p_racha_id) then
    raise exception 'Racha não encontrado';
  end if;
  if exists (select 1 from public.racha_membros where racha_id = p_racha_id and perfil_id = auth.uid()) then
    raise exception 'Você já solicitou ou já tem acesso a este racha';
  end if;
  insert into public.racha_membros (racha_id, perfil_id, papel)
  values (p_racha_id, auth.uid(), 'pendente'::public.papel_usuario)
  returning * into resultado;
  return resultado;
end;
$function$;
revoke all on function public.solicitar_acesso_racha(uuid) from public;
grant execute on function public.solicitar_acesso_racha(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. perfis deixa de carregar papel global; trigger de cadastro simplifica
-- ─────────────────────────────────────────────────────────────────────────
-- Mesmo cuidado da seção 7: nomes de policy podem ter divergido do que as
-- migrations anteriores sugerem. Remove todas as policies de perfis (serão
-- recriadas já sem depender de is_admin()) antes de tirar a coluna papel.
do $block$
declare
  pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'perfis' loop
    execute format('drop policy %I on public.perfis', pol.policyname);
  end loop;
end;
$block$;

alter table public.perfis drop column if exists papel;

create policy "perfil leitura própria" on public.perfis
for select to authenticated using (id = auth.uid());

create or replace function public.criar_perfil_pendente()
returns trigger
language plpgsql security definer set search_path = public
as $function$
begin
  insert into public.perfis (id, email) values (new.id, new.email);
  return new;
end;
$function$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.criar_perfil_pendente();

-- Admin de um racha precisa ler o e-mail/nome de quem solicitou acesso
-- àquele racha (tela de Aprovações). Sem isso, o join perfis(email) some
-- por trás da RLS de perfis.
create policy "perfis leitura racha admin" on public.perfis
for select to authenticated using (
  exists (
    select 1 from public.racha_membros rm_admin
    join public.racha_membros rm_alvo on rm_alvo.racha_id = rm_admin.racha_id
    where rm_admin.perfil_id = auth.uid()
      and rm_admin.papel = 'admin'::public.papel_usuario
      and rm_alvo.perfil_id = perfis.id
  )
);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. racha_id nas tabelas de futebol (destrutivo — ver aviso no topo)
-- ─────────────────────────────────────────────────────────────────────────
alter table public.participantes add column if not exists perfil_id uuid references public.perfis(id);

truncate table
  public.eventos, public.partidas, public.times_jogadores, public.times,
  public.check_ins, public.sessoes, public.participantes
restart identity cascade;

alter table public.participantes add column if not exists racha_id uuid references public.rachas(id);
alter table public.sessoes add column if not exists racha_id uuid references public.rachas(id);
alter table public.check_ins add column if not exists racha_id uuid references public.rachas(id);
alter table public.times add column if not exists racha_id uuid references public.rachas(id);
alter table public.times_jogadores add column if not exists racha_id uuid references public.rachas(id);
alter table public.partidas add column if not exists racha_id uuid references public.rachas(id);
alter table public.eventos add column if not exists racha_id uuid references public.rachas(id);

alter table public.participantes alter column racha_id set not null;
alter table public.sessoes alter column racha_id set not null;
alter table public.check_ins alter column racha_id set not null;
alter table public.times alter column racha_id set not null;
alter table public.times_jogadores alter column racha_id set not null;
alter table public.partidas alter column racha_id set not null;
alter table public.eventos alter column racha_id set not null;

create index if not exists participantes_por_racha on public.participantes(racha_id);
create index if not exists sessoes_por_racha on public.sessoes(racha_id);
create index if not exists check_ins_por_racha on public.check_ins(racha_id);
create index if not exists times_por_racha on public.times(racha_id);
create index if not exists times_jogadores_por_racha on public.times_jogadores(racha_id);
create index if not exists partidas_por_racha on public.partidas(racha_id);
create index if not exists eventos_por_racha on public.eventos(racha_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. RLS das tabelas de futebol, agora escopada por racha
-- ─────────────────────────────────────────────────────────────────────────
-- O nome exato das policies antigas divergiu do que os arquivos de migration
-- anteriores sugerem (aplicações manuais/editadas ao longo do tempo). Em vez
-- de arriscar "drop policy if exists" com o nome errado e deixar lixo preso
-- em is_admin()/is_aprovado(), removemos TODAS as policies existentes de
-- cada tabela abaixo, seja qual for o nome, antes de recriar do zero.
do $block$
declare
  tabela text;
  pol record;
begin
  foreach tabela in array array['participantes','sessoes','check_ins','times','times_jogadores','partidas','eventos'] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = tabela loop
      execute format('drop policy %I on public.%I', pol.policyname, tabela);
    end loop;
  end loop;
end;
$block$;

create policy "participantes leitura racha" on public.participantes for select to authenticated using (public.is_membro_aprovado(racha_id));
-- Mantém o autocadastro (Participants.saveSelf): um membro aprovado pode
-- criar o próprio registro com estrelas travadas em 3, igual ao banco já
-- fazia antes (is_admin() OR (perfil_id = auth.uid() AND estrelas = 3)) —
-- só ganhou o escopo por racha. Edição (estrelas incluída) segue só-admin:
-- diferente do que existia antes, o autocadastro NUNCA mais pode alterar o
-- próprio registro depois de criado — só o organizador, quantas vezes quiser.
create policy "participantes inserção racha" on public.participantes for insert to authenticated with check (
  public.is_membro_admin(racha_id)
  or (perfil_id = auth.uid() and estrelas = 3 and public.is_membro_aprovado(racha_id))
);
create policy "participantes atualização admin racha" on public.participantes for update to authenticated using (public.is_membro_admin(racha_id)) with check (public.is_membro_admin(racha_id));
create policy "participantes exclusão admin racha" on public.participantes for delete to authenticated using (public.is_membro_admin(racha_id));

create policy "sessões leitura racha" on public.sessoes for select to authenticated using (public.is_membro_aprovado(racha_id));
create policy "sessões inserção admin racha" on public.sessoes for insert to authenticated with check (public.is_membro_admin(racha_id));
create policy "sessões atualização admin racha" on public.sessoes for update to authenticated using (public.is_membro_admin(racha_id)) with check (public.is_membro_admin(racha_id));

create policy "check-ins leitura racha" on public.check_ins for select to authenticated using (public.is_membro_aprovado(racha_id));
create policy "check-ins inserção admin racha" on public.check_ins for insert to authenticated with check (public.is_membro_admin(racha_id));
create policy "check-ins atualização admin racha" on public.check_ins for update to authenticated using (public.is_membro_admin(racha_id)) with check (public.is_membro_admin(racha_id));
create policy "check-ins exclusão admin racha" on public.check_ins for delete to authenticated using (public.is_membro_admin(racha_id));

create policy "times leitura racha" on public.times for select to authenticated using (public.is_membro_aprovado(racha_id));
create policy "times inserção admin racha" on public.times for insert to authenticated with check (public.is_membro_admin(racha_id));
create policy "times atualização admin racha" on public.times for update to authenticated using (public.is_membro_admin(racha_id)) with check (public.is_membro_admin(racha_id));
create policy "times exclusão admin racha" on public.times for delete to authenticated using (public.is_membro_admin(racha_id));

create policy "times jogadores leitura racha" on public.times_jogadores for select to authenticated using (public.is_membro_aprovado(racha_id));
create policy "times jogadores inserção admin racha" on public.times_jogadores for insert to authenticated with check (public.is_membro_admin(racha_id));
create policy "times jogadores atualização admin racha" on public.times_jogadores for update to authenticated using (public.is_membro_admin(racha_id)) with check (public.is_membro_admin(racha_id));
create policy "times jogadores exclusão admin racha" on public.times_jogadores for delete to authenticated using (public.is_membro_admin(racha_id));

create policy "partidas leitura racha" on public.partidas for select to authenticated using (public.is_membro_aprovado(racha_id));
create policy "partidas inserção admin racha" on public.partidas for insert to authenticated with check (public.is_membro_admin(racha_id));
create policy "partidas atualização admin racha" on public.partidas for update to authenticated using (public.is_membro_admin(racha_id)) with check (public.is_membro_admin(racha_id));

create policy "eventos leitura racha" on public.eventos for select to authenticated using (public.is_membro_aprovado(racha_id));
create policy "eventos inserção admin racha" on public.eventos for insert to authenticated with check (public.is_membro_admin(racha_id));
create policy "eventos atualização admin racha" on public.eventos for update to authenticated using (public.is_membro_admin(racha_id)) with check (public.is_membro_admin(racha_id));

-- Bucket de fotos continua público pra leitura (como desde a 001). Upload
-- (insert) precisa continuar liberado pra qualquer usuário aprovado — não só
-- admin — porque o autocadastro de jogador (Participants.saveSelf) deixa o
-- próprio jogador enviar sua foto ao criar o perfil. A edição (update) segue
-- restrita a admin, como sempre foi. As fotos continuam sem isolamento por
-- racha (é só o avatar do jogador, sem dado sensível).
--
-- Em vez de arriscar "drop policy if exists" com nome errado de novo (nomes
-- já divergiram do que 001/003 sugerem), removemos dinamicamente toda policy
-- de INSERT/UPDATE do bucket 'participantes' — inclusive resquícios antigos
-- da 001 ("organizador envia/altera fotos") que nem chegam a checar
-- is_admin()/is_aprovado() e hoje liberam upload pra qualquer autenticado.
-- A policy de leitura pública ("fotos públicas", SELECT) não é tocada.
do $block$
declare
  pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and cmd in ('INSERT', 'UPDATE')
      and (qual ilike '%participantes%' or with_check ilike '%participantes%')
  loop
    execute format('drop policy %I on storage.objects', pol.policyname);
  end loop;
end;
$block$;

create policy "aprovado envia fotos de participantes" on storage.objects
for insert to authenticated with check (bucket_id = 'participantes' and public.is_aprovado_em_algum_racha());
create policy "admin altera fotos de participantes" on storage.objects
for update to authenticated
using (bucket_id = 'participantes' and public.is_admin_de_algum_racha())
with check (bucket_id = 'participantes' and public.is_admin_de_algum_racha());

-- ─────────────────────────────────────────────────────────────────────────
-- 8. RPCs: resolvem o racha a partir da sessão/partida gravada no banco
--    (nunca confiam em racha_id vindo do cliente) e trocam is_admin() por
--    is_membro_admin(racha).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.confirmar_sorteio(p_sessao_id uuid, p_times jsonb)
returns setof public.times
language plpgsql security definer set search_path = public
as $function$
declare
  item jsonb;
  jogador jsonb;
  novo_time public.times;
  tamanho integer;
  v_racha_id uuid;
begin
  select s.tamanho_time, s.racha_id into tamanho, v_racha_id
  from public.sessoes s where s.id = p_sessao_id for update;
  if v_racha_id is null then raise exception 'Sessão não encontrada'; end if;
  if not public.is_membro_admin(v_racha_id) then
    raise exception 'Apenas o organizador pode fazer isso';
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

    insert into public.times (sessao_id, racha_id, numero, posicao_fila, status)
    values (
      p_sessao_id, v_racha_id,
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

      insert into public.times_jogadores (time_id, participante_id, racha_id)
      values (novo_time.id, (jogador #>> '{}')::uuid, v_racha_id);
      update public.check_ins set alocado = true
      where sessao_id = p_sessao_id
        and participante_id = (jogador #>> '{}')::uuid;
    end loop;

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

  if jogo.status = 'finalizada'::public.status_partida and not ja_pendente then
    return;
  end if;

  if jogo.status <> 'finalizada'::public.status_partida then
    update public.partidas
    set status = 'finalizada'::public.status_partida,
        horario_fim = now(), timer_running = false
    where id = p_partida_id;
  end if;

  if jogo.placar_a <> jogo.placar_b then
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
    update public.times set posicao_fila = 1, status = 'jogando'::public.status_time where id = jogo.time_a_id;
    update public.times set posicao_fila = 2, status = 'jogando'::public.status_time where id = jogo.time_b_id;
    update public.sessoes set pendente_escolha_partida_id = null
    where id = jogo.sessao_id and pendente_escolha_partida_id = jogo.id;
  elsif p_proximo_time_a_id is not null and p_proximo_time_b_id is not null then
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

    update public.times set posicao_fila = posicao_fila + max_fila
    where sessao_id = jogo.sessao_id;
    update public.times set posicao_fila = 1 where id = p_proximo_time_a_id;
    update public.times set posicao_fila = 2 where id = p_proximo_time_b_id;

    if jogo.time_a_id in (p_proximo_time_a_id, p_proximo_time_b_id) then
      update public.times set posicao_fila = max_fila where id = jogo.time_b_id;
    elsif jogo.time_b_id in (p_proximo_time_a_id, p_proximo_time_b_id) then
      update public.times set posicao_fila = max_fila where id = jogo.time_a_id;
    else
      update public.times set posicao_fila = max_fila - 1 where id = jogo.time_a_id;
      update public.times set posicao_fila = max_fila where id = jogo.time_b_id;
    end if;

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
    update public.sessoes set pendente_escolha_partida_id = jogo.id
    where id = jogo.sessao_id;
  end if;
end;
$function$;
revoke all on function public._finalizar_partida_core(uuid, uuid, uuid) from public;

create or replace function public.finalizar_partida_e_girar_fila(
  p_partida_id uuid,
  p_proximo_time_a_id uuid default null,
  p_proximo_time_b_id uuid default null
)
returns void
language plpgsql security definer set search_path = public
as $function$
declare
  v_racha_id uuid;
begin
  select racha_id into v_racha_id from public.partidas where id = p_partida_id;
  if v_racha_id is null then raise exception 'Partida não encontrada'; end if;
  if not public.is_membro_admin(v_racha_id) then
    raise exception 'Apenas o organizador pode fazer isso';
  end if;
  perform public._finalizar_partida_core(p_partida_id, p_proximo_time_a_id, p_proximo_time_b_id);
end;
$function$;
revoke all on function public.finalizar_partida_e_girar_fila(uuid, uuid, uuid) from public;
grant execute on function public.finalizar_partida_e_girar_fila(uuid, uuid, uuid) to authenticated;

-- auto_finalizar_partidas_vencidas roda pelo pg_cron (dono da função, sem
-- usuário autenticado) e chama _finalizar_partida_core diretamente — não
-- precisa checar racha/admin, e não muda nesta migração.

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Funções globais antigas: sem mais uso, removidas.
-- ─────────────────────────────────────────────────────────────────────────
-- Rede de segurança: depois de tudo que já foi tratado acima, varre TODAS as
-- policies do banco (qualquer schema/tabela) e remove qualquer uma que ainda
-- referencie is_admin()/is_aprovado(). Isso cobre qualquer policy que a gente
-- não soubesse que existia, sem precisar adivinhar nome nenhum.
do $block$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname from pg_policies
    where qual ilike '%is_admin(%' or with_check ilike '%is_admin(%'
       or qual ilike '%is_aprovado(%' or with_check ilike '%is_aprovado(%'
  loop
    execute format('drop policy %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end;
$block$;

drop function if exists public.is_admin();
drop function if exists public.is_aprovado();

-- ─────────────────────────────────────────────────────────────────────────
-- 10. ranking_historico: view fica consistente com o racha do participante
-- ─────────────────────────────────────────────────────────────────────────
-- create or replace view exige manter nome/ordem das colunas existentes
-- (id, nome, foto_url, gols, assistencias) e só permite ACRESCENTAR coluna
-- no final — por isso racha_id vai depois de assistencias, não depois de id.
create or replace view public.ranking_historico as
select p.id, p.nome, p.foto_url,
  count(e.id) filter (where e.jogador_id = p.id) as gols,
  count(e.id) filter (where e.assistente_id = p.id) as assistencias,
  p.racha_id
from public.participantes p
left join public.eventos e on (e.jogador_id = p.id or e.assistente_id = p.id) and e.racha_id = p.racha_id
left join public.partidas j on j.id = e.partida_id and j.status = 'finalizada'
group by p.id, p.nome, p.foto_url, p.racha_id;

commit;

-- Verificação rápida: tabelas e funções novas devem aparecer.
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('rachas', 'racha_membros')
order by table_name;

select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('is_membro_aprovado', 'is_membro_admin', 'is_admin_de_algum_racha', 'solicitar_acesso_racha')
order by routine_name;
