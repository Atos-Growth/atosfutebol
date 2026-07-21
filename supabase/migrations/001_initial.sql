-- Atos Futebol · esquema inicial
create extension if not exists pgcrypto;

create type public.posicao_jogador as enum ('goleiro', 'zagueiro', 'meio', 'atacante', 'qualquer');
create type public.status_sessao as enum ('aguardando_checkin', 'sorteando', 'em_andamento', 'finalizada');
create type public.status_time as enum ('na_fila', 'jogando', 'finalizado_no_dia');
create type public.status_partida as enum ('em_andamento', 'finalizada');

create table public.participantes (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(trim(nome)) >= 2),
  foto_url text,
  estrelas integer not null check (estrelas between 1 and 5),
  posicao public.posicao_jogador not null default 'qualquer',
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create table public.sessoes (
  id uuid primary key default gen_random_uuid(),
  data date not null default current_date,
  status public.status_sessao not null default 'aguardando_checkin',
  tamanho_time integer not null default 6 check (tamanho_time in (6, 7)),
  duracao_partida_minutos integer not null default 10 check (duracao_partida_minutos between 1 and 60),
  horario_sorteio timestamptz,
  criado_em timestamptz not null default now()
);

create table public.check_ins (
  id uuid primary key default gen_random_uuid(),
  sessao_id uuid not null references public.sessoes(id) on delete cascade,
  participante_id uuid not null references public.participantes(id) on delete cascade,
  horario_chegada timestamptz not null default now(),
  alocado boolean not null default false,
  unique (sessao_id, participante_id)
);

create table public.times (
  id uuid primary key default gen_random_uuid(),
  sessao_id uuid not null references public.sessoes(id) on delete cascade,
  numero integer not null check (numero > 0),
  posicao_fila integer not null check (posicao_fila > 0),
  status public.status_time not null default 'na_fila',
  unique (sessao_id, numero),
  unique (sessao_id, posicao_fila)
);

create table public.times_jogadores (
  time_id uuid not null references public.times(id) on delete cascade,
  participante_id uuid not null references public.participantes(id) on delete cascade,
  primary key (time_id, participante_id)
);

create table public.partidas (
  id uuid primary key default gen_random_uuid(),
  sessao_id uuid not null references public.sessoes(id) on delete cascade,
  time_a_id uuid not null references public.times(id),
  time_b_id uuid not null references public.times(id),
  horario_inicio timestamptz not null default now(),
  horario_fim timestamptz,
  placar_a integer not null default 0 check (placar_a >= 0),
  placar_b integer not null default 0 check (placar_b >= 0),
  status public.status_partida not null default 'em_andamento',
  -- Estado do cronômetro sincronizado. Cada cliente deriva o tempo do servidor.
  timer_started_at timestamptz,
  timer_remaining_seconds integer not null default 600 check (timer_remaining_seconds >= 0),
  timer_running boolean not null default false,
  check (time_a_id <> time_b_id)
);

create unique index apenas_uma_partida_ativa_por_sessao
  on public.partidas(sessao_id) where status = 'em_andamento';

create table public.eventos (
  id uuid primary key default gen_random_uuid(),
  partida_id uuid not null references public.partidas(id) on delete cascade,
  jogador_id uuid not null references public.participantes(id),
  assistente_id uuid references public.participantes(id),
  time_id uuid not null references public.times(id),
  criado_em timestamptz not null default now(),
  check (assistente_id is null or assistente_id <> jogador_id)
);

create index checkins_por_sessao_chegada on public.check_ins(sessao_id, alocado, horario_chegada);
create index times_por_sessao_fila on public.times(sessao_id, posicao_fila);
create index partidas_por_sessao on public.partidas(sessao_id, status);
create index eventos_por_partida on public.eventos(partida_id, criado_em);

-- Confirma em uma transação a prévia montada pelo cliente.
create or replace function public.confirmar_sorteio(p_sessao_id uuid, p_times jsonb)
returns setof public.times
language plpgsql security definer set search_path = public as $function$
declare
  item jsonb;
  jogador jsonb;
  novo_time public.times;
  tamanho integer;
begin
  select tamanho_time into tamanho from sessoes where id = p_sessao_id for update;
  if tamanho is null then raise exception 'Sessão não encontrada'; end if;
  if jsonb_array_length(p_times) < 2 then raise exception 'São necessários ao menos dois times'; end if;
  if exists (select 1 from times where sessao_id = p_sessao_id) then raise exception 'O sorteio desta sessão já foi confirmado'; end if;

  for item in select * from jsonb_array_elements(p_times)
  loop
    if jsonb_array_length(item->'jogadores') <> tamanho then raise exception 'Todos os times devem estar completos'; end if;
    insert into times(sessao_id, numero, posicao_fila, status)
    values (p_sessao_id, (item->>'numero')::int, (item->>'numero')::int,
      case when (item->>'numero')::int <= 2 then 'jogando'::status_time else 'na_fila'::status_time end)
    returning * into novo_time;

    for jogador in select * from jsonb_array_elements(item->'jogadores')
    loop
      if not exists (select 1 from check_ins where sessao_id = p_sessao_id and participante_id = (jogador#>>'{}')::uuid and alocado = false)
        then raise exception 'Jogador inválido ou já alocado'; end if;
      insert into times_jogadores(time_id, participante_id) values (novo_time.id, (jogador#>>'{}')::uuid);
      update check_ins set alocado = true where sessao_id = p_sessao_id and participante_id = (jogador#>>'{}')::uuid;
    end loop;
  end loop;
  update sessoes set status = 'em_andamento', horario_sorteio = coalesce(horario_sorteio, now()) where id = p_sessao_id;
  return query select * from times where sessao_id = p_sessao_id order by posicao_fila;
end;
$function$;

-- Encerra a partida e gira a fila sob lock, evitando conflito entre celulares.
create or replace function public.finalizar_partida_e_girar_fila(p_partida_id uuid)
returns void language plpgsql security definer set search_path = public as $function$
declare
  jogo partidas;
  max_fila integer;
begin
  select * into jogo from partidas where id = p_partida_id for update;
  if jogo.id is null then raise exception 'Partida não encontrada'; end if;
  if jogo.status = 'finalizada' then return; end if;
  select max(posicao_fila) into max_fila from times where sessao_id = jogo.sessao_id;

  -- Move temporariamente a fila para uma faixa livre sem violar o CHECK > 0.
  update times set posicao_fila = posicao_fila + max_fila where sessao_id = jogo.sessao_id;
  if jogo.placar_a = jogo.placar_b then
    update times set posicao_fila = max_fila - 1 where id = jogo.time_a_id;
    update times set posicao_fila = max_fila where id = jogo.time_b_id;
    update times set posicao_fila = posicao_fila - max_fila - 2 where sessao_id = jogo.sessao_id and id not in (jogo.time_a_id, jogo.time_b_id);
  elsif jogo.placar_a > jogo.placar_b then
    update times set posicao_fila = 1 where id = jogo.time_a_id;
    update times set posicao_fila = max_fila where id = jogo.time_b_id;
    update times set posicao_fila = posicao_fila - max_fila - 1 where sessao_id = jogo.sessao_id and id not in (jogo.time_a_id, jogo.time_b_id);
  else
    update times set posicao_fila = 1 where id = jogo.time_b_id;
    update times set posicao_fila = max_fila where id = jogo.time_a_id;
    update times set posicao_fila = posicao_fila - max_fila - 1 where sessao_id = jogo.sessao_id and id not in (jogo.time_a_id, jogo.time_b_id);
  end if;
  update times set status = case when posicao_fila <= 2 then 'jogando'::status_time else 'na_fila'::status_time end where sessao_id = jogo.sessao_id;
  update partidas set status = 'finalizada', horario_fim = now(), timer_running = false where id = p_partida_id;
end;
$function$;

-- Estatísticas reutilizáveis para sessão ou histórico.
create or replace view public.ranking_historico as
select p.id, p.nome, p.foto_url,
  count(e.id) filter (where e.jogador_id = p.id) as gols,
  count(e.id) filter (where e.assistente_id = p.id) as assistencias
from participantes p
left join eventos e on e.jogador_id = p.id or e.assistente_id = p.id
left join partidas j on j.id = e.partida_id and j.status = 'finalizada'
group by p.id, p.nome, p.foto_url;

alter table participantes enable row level security;
alter table sessoes enable row level security;
alter table check_ins enable row level security;
alter table times enable row level security;
alter table times_jogadores enable row level security;
alter table partidas enable row level security;
alter table eventos enable row level security;

-- V1: qualquer usuário autenticado é organizador. Evolua para perfis/roles se necessário.
do $block$ declare tabela text; begin
  foreach tabela in array array['participantes','sessoes','check_ins','times','times_jogadores','partidas','eventos'] loop
    execute format('create policy "organizador autenticado" on public.%I for all to authenticated using (true) with check (true)', tabela);
  end loop;
end;
$block$;

insert into storage.buckets(id, name, public) values ('participantes', 'participantes', true)
on conflict (id) do nothing;
create policy "fotos públicas" on storage.objects for select using (bucket_id = 'participantes');
create policy "organizador envia fotos" on storage.objects for insert to authenticated with check (bucket_id = 'participantes');
create policy "organizador altera fotos" on storage.objects for update to authenticated using (bucket_id = 'participantes');

alter publication supabase_realtime add table public.partidas, public.eventos, public.times;
grant execute on function public.confirmar_sorteio(uuid, jsonb) to authenticated;
grant execute on function public.finalizar_partida_e_girar_fila(uuid) to authenticated;
