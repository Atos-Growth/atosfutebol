-- Estrelas automáticas com fechamento MENSAL.
--
-- A estrela que o organizador escolhe no cadastro deixa de ser um veredito
-- permanente e passa a ser a semente de uma pontuação contínua de 0 a 100.
-- Todo domingo o app registra o desempenho bruto de cada jogador; uma vez por
-- mês esse acumulado vira UM ajuste de pontuação, e a estrela acompanha por
-- faixa (com folga nas fronteiras, pra não ficar oscilando).
--
-- Por que mensal e por média:
--   - O corte é o mês, não a sessão. Quem foi a 1 domingo e quem foi a 4 são
--     avaliados no mesmo fechamento.
--   - Tudo é MÉDIA por partida, nunca soma. Como o time vencedor continua em
--     campo, somar faria quem emenda 12 partidas se mover 3x mais que quem
--     jogou 4 — o que mede presença, não desempenho.
--
-- Execute este arquivo INTEIRO no Supabase SQL Editor, depois da migração 012.
-- Não há backfill de histórico: o sistema começa do zero a partir de hoje e
-- todo mundo mantém a estrela atual como semente.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Colunas novas em participantes
-- ─────────────────────────────────────────────────────────────────────────
alter table public.participantes
  add column if not exists pontuacao         numeric(6,2),
  add column if not exists estrelas_iniciais integer,
  add column if not exists estrelas_travadas boolean not null default false,
  add column if not exists meses_avaliados   integer not null default 0;

comment on column public.participantes.pontuacao is
  'Pontuação contínua 0-100 que gera a estrela. Movida só pelo fechamento mensal.';
comment on column public.participantes.estrelas_travadas is
  'Quando true, o fechamento mensal registra o desempenho mas não move a pontuação.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Constantes por racha — cada grupo pode ter o seu ritmo
-- ─────────────────────────────────────────────────────────────────────────
alter table public.rachas
  add column if not exists config_estrelas jsonb not null default jsonb_build_object(
    'peso_resultado',    55.0,  -- botão principal: acelera/desacelera tudo
    'peso_individual',    8.0,  -- multiplica gols e assistências
    'valor_gol',          0.8,
    'valor_assistencia',  0.3,
    -- Gols e sequência são CENTRALIZADOS: o que conta é o quanto o jogador
    -- passa da média, não o valor bruto. Sem isso o jogador médio ganharia
    -- ~2 pontos por mês só por existir, e em um ano o racha inteiro estaria
    -- em 5★ — o que zera o equilíbrio do sorteio, que é feito por estrela.
    -- 0.20 é só um chute inicial. Esta é a única constante que dá pra DESCOBRIR
    -- por medição: depois de 2 ou 3 meses de dados reais, rode
    --   select sum(0.8*gols + 0.3*assistencias) / sum(partidas)
    --   from public.avaliacoes_sessao;
    -- e ponha aqui o que voltar. O valor certo depende do tamanho do time e,
    -- principalmente, de quantos gols de fato viram evento no app.
    'base_individual',    0.20,
    'bonus_sequencia',    0.5,  -- por vitória emendada acima da sequência neutra
    'sequencia_neutra',   2,
    'teto_sequencia',     2.0,
    'piso_sequencia',    -1.0,
    'limite_mes',        15.0,  -- teto do ajuste de um mês
    'fator_calibracao',   1.5,  -- multiplicador dos primeiros meses do jogador
    'meses_calibracao',   2,
    'limite_calibracao', 20.0,
    'histerese',          3.0,  -- folga nas fronteiras entre faixas
    'min_partidas_mes',   3,
    'sensibilidade',      1.5   -- divisor da diferença de força entre times
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Faixas: pontuação -> estrela, com histerese
-- ─────────────────────────────────────────────────────────────────────────
--   1★ 0-24 | 2★ 25-44 | 3★ 45-64 | 4★ 65-84 | 5★ 85-100
--   Subir exige ultrapassar o limite + histerese; cair, ficar abaixo do
--   início da faixa atual - histerese. Sem isso, quem ficasse em 64,5 viraria
--   4★ num mês e 3★ no seguinte pra sempre.
create or replace function public.estrelas_da_pontuacao(
  p_pontuacao numeric,
  p_estrela_atual integer default null,
  p_histerese numeric default 3.0
)
returns integer
language plpgsql immutable
as $function$
declare
  limites numeric[] := array[25, 45, 65, 85]::numeric[];  -- início de 2★, 3★, 4★ e 5★
  alvo integer := 1;
  i integer;
begin
  for i in 1..4 loop
    if p_pontuacao >= limites[i] then alvo := i + 1; end if;
  end loop;

  if p_estrela_atual is null or alvo = p_estrela_atual then
    return coalesce(p_estrela_atual, alvo);
  end if;

  if alvo > p_estrela_atual then
    if p_pontuacao < limites[p_estrela_atual] + p_histerese then
      return p_estrela_atual;                      -- na zona morta, não sobe
    end if;
    alvo := p_estrela_atual;
    for i in p_estrela_atual..4 loop
      if p_pontuacao >= limites[i] + p_histerese then alvo := i + 1; end if;
    end loop;
    return alvo;
  end if;

  if p_pontuacao >= limites[p_estrela_atual - 1] - p_histerese then
    return p_estrela_atual;                        -- na zona morta, não cai
  end if;
  alvo := p_estrela_atual;
  for i in reverse (p_estrela_atual - 1)..1 loop
    if p_pontuacao < limites[i] - p_histerese then alvo := i; end if;
  end loop;
  return alvo;
end;
$function$;

create or replace function public.pontuacao_semente(p_estrelas integer)
returns numeric
language sql immutable
as $function$
  select (array[15, 35, 55, 75, 92])[greatest(1, least(5, coalesce(p_estrelas, 3)))]::numeric;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Semente automática no cadastro e no ajuste manual
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.semear_pontuacao_participante()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    if new.pontuacao is null then
      new.pontuacao := public.pontuacao_semente(new.estrelas);
    end if;
    if new.estrelas_iniciais is null then
      new.estrelas_iniciais := new.estrelas;
    end if;
    return new;
  end if;

  -- Organizador mexeu na estrela na mão: re-semeia a pontuação no meio da nova
  -- faixa. Sem isso o número oculto contradiz a estrela visível e o próximo
  -- fechamento desfaz a correção do organizador. O fechamento mensal roda com
  -- app.recalculo_estrelas = 'on' e não cai aqui.
  if new.estrelas is distinct from old.estrelas
     and coalesce(current_setting('app.recalculo_estrelas', true), 'off') <> 'on' then
    new.pontuacao := public.pontuacao_semente(new.estrelas);
  end if;
  return new;
end;
$function$;

drop trigger if exists semear_pontuacao on public.participantes;
create trigger semear_pontuacao
before insert or update on public.participantes
for each row execute function public.semear_pontuacao_participante();

-- Backfill de quem já está cadastrado: a estrela de hoje vira a semente.
update public.participantes
set pontuacao = public.pontuacao_semente(estrelas)
where pontuacao is null;

update public.participantes
set estrelas_iniciais = estrelas
where estrelas_iniciais is null;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. O trigger que protege a estrela precisa deixar o fechamento passar
-- ─────────────────────────────────────────────────────────────────────────
-- Hoje quem finaliza a sessão é sempre o admin, então is_membro_admin() já
-- passaria. O bypass existe pro dia em que o fechamento rodar por cron ou
-- Edge Function, sem auth.uid() nenhum — sem ele, quebra silenciosamente.
create or replace function public.bloquear_autoalteracao_estrelas()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('app.recalculo_estrelas', true), 'off') = 'on' then
    return new;
  end if;
  if not public.is_membro_admin(new.racha_id) and new.estrelas is distinct from old.estrelas then
    raise exception 'Apenas o organizador pode alterar o nível de habilidade';
  end if;
  return new;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Desempenho bruto por sessão (sem mover estrela nenhuma)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.avaliacoes_sessao (
  id uuid primary key default gen_random_uuid(),
  racha_id uuid not null references public.rachas(id) on delete cascade,
  sessao_id uuid not null references public.sessoes(id) on delete cascade,
  participante_id uuid not null references public.participantes(id) on delete cascade,
  partidas integer not null,
  vitorias integer not null,
  empates integer not null,
  derrotas integer not null,
  soma_res numeric(8,4) not null,      -- Σ (resultado − esperado)
  gols integer not null,
  assistencias integer not null,
  maior_sequencia integer not null,
  criado_em timestamptz not null default now(),
  unique (sessao_id, participante_id)
);

create index if not exists avaliacoes_por_racha on public.avaliacoes_sessao(racha_id, sessao_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. O fechamento aplicado, com a conta que o gerou
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.fechamentos_mensais (
  id uuid primary key default gen_random_uuid(),
  racha_id uuid not null references public.rachas(id) on delete cascade,
  competencia date not null,            -- sempre o dia 1 do mês
  participante_id uuid not null references public.participantes(id) on delete cascade,
  sessoes integer not null,
  partidas integer not null,
  res_medio numeric(8,4) not null,
  gols integer not null,
  assistencias integer not null,
  maior_sequencia integer not null,
  delta numeric(6,2) not null,
  pontuacao_antes numeric(6,2) not null,
  pontuacao_depois numeric(6,2) not null,
  estrelas_antes integer not null,
  estrelas_depois integer not null,
  memoria jsonb not null,               -- as parcelas, pra responder "por quê?"
  criado_em timestamptz not null default now(),
  unique (racha_id, competencia, participante_id)
);

create index if not exists fechamentos_por_racha
  on public.fechamentos_mensais(racha_id, competencia desc);

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Cálculo do desempenho de uma sessão
-- ─────────────────────────────────────────────────────────────────────────
-- Para cada partida finalizada, cada jogador em campo recebe
--   res = resultado − esperado
-- onde o esperado sai da diferença entre a força média do time dele e a do
-- adversário, ambas congeladas no sorteio. Vencer um time equilibrado é só
-- cumprir o esperado; o que move é vencer o que era mais forte.
create or replace function public.registrar_avaliacao_sessao(p_sessao_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $function$
declare
  v_racha_id uuid;
  v_sensibilidade numeric;
  v_linhas integer;
begin
  select s.racha_id into v_racha_id from public.sessoes s where s.id = p_sessao_id;
  if v_racha_id is null then raise exception 'Sessão não encontrada'; end if;

  select coalesce((r.config_estrelas->>'sensibilidade')::numeric, 1.5)
  into v_sensibilidade
  from public.rachas r where r.id = v_racha_id;

  with jogos as (
    select
      tj.participante_id,
      pa.id as partida_id,
      pa.horario_inicio,
      case when tj.time_id = pa.time_a_id then pa.placar_a else pa.placar_b end as gols_pro,
      case when tj.time_id = pa.time_a_id then pa.placar_b else pa.placar_a end as gols_contra,
      coalesce(meu.forca_media, 3.0) as forca_propria,
      coalesce(adv.forca_media, 3.0) as forca_adversaria
    from public.partidas pa
    join public.times_jogadores tj on tj.time_id in (pa.time_a_id, pa.time_b_id)
    join public.times meu on meu.id = tj.time_id
    join public.times adv on adv.id = case
      when tj.time_id = pa.time_a_id then pa.time_b_id else pa.time_a_id end
    where pa.sessao_id = p_sessao_id
      and pa.status = 'finalizada'::public.status_partida
  ),
  avaliado as (
    select j.*,
      case when j.gols_pro > j.gols_contra then 1.0
           when j.gols_pro = j.gols_contra then 0.5
           else 0.0 end as s,
      1.0 / (1.0 + power(10.0, (j.forca_adversaria - j.forca_propria) / v_sensibilidade)) as e
    from jogos j
  ),
  ordenado as (
    select a.*,
      (a.s - a.e) as res,
      case when a.s = 1.0 then 1 else 0 end as venceu,
      row_number() over (partition by a.participante_id
                         order by a.horario_inicio, a.partida_id) as rn
    from avaliado a
  ),
  -- Gaps and islands: agrupa vitórias consecutivas pra achar a maior sequência.
  ilhas as (
    select o.participante_id, o.venceu,
      o.rn - row_number() over (partition by o.participante_id, o.venceu order by o.rn) as ilha
    from ordenado o
  ),
  maior as (
    select i.participante_id, max(i.tamanho) as maior_sequencia
    from (
      select participante_id, ilha, count(*) as tamanho
      from ilhas where venceu = 1
      group by participante_id, ilha
    ) i
    group by i.participante_id
  ),
  contribuicao as (
    select participante_id, sum(gols)::integer as gols, sum(assistencias)::integer as assistencias
    from (
      select ev.jogador_id as participante_id, count(*)::integer as gols, 0 as assistencias
      from public.eventos ev
      join public.partidas pa on pa.id = ev.partida_id
      where pa.sessao_id = p_sessao_id
        and pa.status = 'finalizada'::public.status_partida
      group by ev.jogador_id
      union all
      select ev.assistente_id, 0, count(*)::integer
      from public.eventos ev
      join public.partidas pa on pa.id = ev.partida_id
      where pa.sessao_id = p_sessao_id
        and pa.status = 'finalizada'::public.status_partida
        and ev.assistente_id is not null
      group by ev.assistente_id
    ) t
    group by participante_id
  )
  insert into public.avaliacoes_sessao (
    racha_id, sessao_id, participante_id, partidas, vitorias, empates, derrotas,
    soma_res, gols, assistencias, maior_sequencia
  )
  select
    v_racha_id, p_sessao_id, o.participante_id,
    count(*)::integer,
    count(*) filter (where o.s = 1.0)::integer,
    count(*) filter (where o.s = 0.5)::integer,
    count(*) filter (where o.s = 0.0)::integer,
    round(sum(o.res)::numeric, 4),
    coalesce(max(c.gols), 0),
    coalesce(max(c.assistencias), 0),
    coalesce(max(m.maior_sequencia), 0)
  from ordenado o
  left join maior m on m.participante_id = o.participante_id
  left join contribuicao c on c.participante_id = o.participante_id
  group by o.participante_id
  on conflict (sessao_id, participante_id) do update set
    partidas        = excluded.partidas,
    vitorias        = excluded.vitorias,
    empates         = excluded.empates,
    derrotas        = excluded.derrotas,
    soma_res        = excluded.soma_res,
    gols            = excluded.gols,
    assistencias    = excluded.assistencias,
    maior_sequencia = excluded.maior_sequencia;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. O fechamento do mês
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.fechar_mes(p_racha_id uuid, p_competencia date)
returns integer
language plpgsql security definer set search_path = public
as $function$
declare
  cfg jsonb;
  v_peso_res numeric; v_peso_ind numeric; v_gol numeric; v_assist numeric;
  v_base_ind numeric; v_seq numeric; v_seq_neutra numeric;
  v_teto_seq numeric; v_piso_seq numeric; v_limite numeric; v_calib numeric;
  v_meses_calib integer; v_limite_calib numeric; v_hist numeric; v_min_part integer;
  v_comp date := date_trunc('month', p_competencia)::date;
  reg record;
  jog public.participantes;
  v_res_medio numeric; v_bonus numeric; v_bseq numeric;
  v_delta numeric; v_limite_ef numeric;
  v_antes numeric; v_depois numeric;
  v_estrela_depois integer;
  v_avaliado boolean;
  v_linhas integer := 0;
begin
  select coalesce(r.config_estrelas, '{}'::jsonb) into cfg
  from public.rachas r where r.id = p_racha_id;
  if not found then raise exception 'Racha não encontrado'; end if;

  v_peso_res     := coalesce((cfg->>'peso_resultado')::numeric,    55.0);
  v_peso_ind     := coalesce((cfg->>'peso_individual')::numeric,    8.0);
  v_gol          := coalesce((cfg->>'valor_gol')::numeric,          0.8);
  v_assist       := coalesce((cfg->>'valor_assistencia')::numeric,  0.3);
  v_base_ind     := coalesce((cfg->>'base_individual')::numeric,    0.20);
  v_seq          := coalesce((cfg->>'bonus_sequencia')::numeric,    0.5);
  v_seq_neutra   := coalesce((cfg->>'sequencia_neutra')::numeric,   2);
  v_teto_seq     := coalesce((cfg->>'teto_sequencia')::numeric,     2.0);
  v_piso_seq     := coalesce((cfg->>'piso_sequencia')::numeric,    -1.0);
  v_limite       := coalesce((cfg->>'limite_mes')::numeric,        15.0);
  v_calib        := coalesce((cfg->>'fator_calibracao')::numeric,   1.5);
  v_meses_calib  := coalesce((cfg->>'meses_calibracao')::integer,     2);
  v_limite_calib := coalesce((cfg->>'limite_calibracao')::numeric, 20.0);
  v_hist         := coalesce((cfg->>'histerese')::numeric,          3.0);
  v_min_part     := coalesce((cfg->>'min_partidas_mes')::integer,     3);

  -- Idempotente: mês já fechado não refaz.
  if exists (
    select 1 from public.fechamentos_mensais f
    where f.racha_id = p_racha_id and f.competencia = v_comp
  ) then
    return 0;
  end if;

  perform set_config('app.recalculo_estrelas', 'on', true);

  for reg in
    select a.participante_id,
      count(distinct a.sessao_id)::integer as sessoes,
      sum(a.partidas)::integer             as partidas,
      sum(a.soma_res)                      as soma_res,
      sum(a.gols)::integer                 as gols,
      sum(a.assistencias)::integer         as assistencias,
      max(a.maior_sequencia)::integer      as maior_sequencia
    from public.avaliacoes_sessao a
    join public.sessoes s on s.id = a.sessao_id
    where a.racha_id = p_racha_id
      and date_trunc('month', s.data)::date = v_comp
    group by a.participante_id
  loop
    select * into jog from public.participantes where id = reg.participante_id for update;
    if not found then continue; end if;

    v_antes    := coalesce(jog.pontuacao, public.pontuacao_semente(jog.estrelas));
    v_avaliado := not jog.estrelas_travadas and reg.partidas >= v_min_part;

    if v_avaliado then
      -- Média por partida do mês inteiro: ir a 1 domingo ou a 4 não muda o peso.
      v_res_medio := reg.soma_res / reg.partidas;
      -- Ambos centralizados: quem produz na média fica em zero, e só o desvio
      -- pra cima ou pra baixo move a pontuação.
      v_bonus     := (v_gol * reg.gols + v_assist * reg.assistencias) / reg.partidas - v_base_ind;
      v_bseq      := greatest(v_piso_seq, least(v_teto_seq, v_seq * (reg.maior_sequencia - v_seq_neutra)));
      v_delta     := v_peso_res * v_res_medio + v_peso_ind * v_bonus + v_bseq;

      if jog.meses_avaliados < v_meses_calib then
        v_delta     := v_delta * v_calib;
        v_limite_ef := v_limite_calib;
      else
        v_limite_ef := v_limite;
      end if;

      v_delta          := greatest(-v_limite_ef, least(v_limite_ef, v_delta));
      v_depois         := greatest(0, least(100, v_antes + v_delta));
      v_estrela_depois := public.estrelas_da_pontuacao(v_depois, jog.estrelas, v_hist);
    else
      v_res_medio      := case when reg.partidas > 0 then reg.soma_res / reg.partidas else 0 end;
      v_delta          := 0;
      v_depois         := v_antes;
      v_estrela_depois := jog.estrelas;
    end if;

    insert into public.fechamentos_mensais (
      racha_id, competencia, participante_id, sessoes, partidas, res_medio,
      gols, assistencias, maior_sequencia, delta, pontuacao_antes, pontuacao_depois,
      estrelas_antes, estrelas_depois, memoria
    ) values (
      p_racha_id, v_comp, reg.participante_id, reg.sessoes, reg.partidas,
      round(v_res_medio, 4), reg.gols, reg.assistencias, reg.maior_sequencia,
      round(v_delta, 2), round(v_antes, 2), round(v_depois, 2),
      jog.estrelas, v_estrela_depois,
      jsonb_build_object(
        'avaliado',        v_avaliado,
        'travado',         jog.estrelas_travadas,
        'soma_res',        round(reg.soma_res, 4),
        'parcela_resultado', case when v_avaliado then round(v_peso_res * v_res_medio, 2) else 0 end,
        'parcela_individual', case when v_avaliado then round(v_peso_ind * v_bonus, 2) else 0 end,
        'parcela_sequencia', case when v_avaliado then round(v_bseq, 2) else 0 end,
        'calibracao',      v_avaliado and jog.meses_avaliados < v_meses_calib,
        'config',          cfg
      )
    );

    update public.participantes
    set pontuacao       = v_depois,
        estrelas        = v_estrela_depois,
        meses_avaliados = meses_avaliados + case when v_avaliado then 1 else 0 end
    where id = reg.participante_id;

    v_linhas := v_linhas + 1;
  end loop;

  -- Solta o bypass: o fechamento roda dentro da transação do cliente (via
  -- trigger na abertura da sessão), e o resto dela não deve herdar a permissão.
  perform set_config('app.recalculo_estrelas', 'off', true);
  return v_linhas;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Fechamento preguiçoso: sem cron, dispara ao abrir a sessão seguinte
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.fechar_meses_pendentes(p_racha_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $function$
declare
  v_mes date;
  v_atual date := date_trunc('month', current_date)::date;
  v_total integer := 0;
begin
  for v_mes in
    select distinct date_trunc('month', s.data)::date
    from public.avaliacoes_sessao a
    join public.sessoes s on s.id = a.sessao_id
    where a.racha_id = p_racha_id
      and date_trunc('month', s.data)::date < v_atual
    order by 1
  loop
    v_total := v_total + public.fechar_mes(p_racha_id, v_mes);
  end loop;
  return v_total;
end;
$function$;

-- Roda quando a primeira sessão do mês novo é criada, ANTES do sorteio: assim
-- o domingo já começa com as estrelas do mês anterior aplicadas.
-- A exceção é engolida de propósito: um erro no cálculo não pode impedir o
-- grupo de abrir a pelada. Se falhar, o admin refaz pelo fechar_mes_manual.
create or replace function public.trg_fechar_meses_ao_abrir_sessao()
returns trigger
language plpgsql security definer set search_path = public
as $function$
begin
  begin
    perform public.fechar_meses_pendentes(new.racha_id);
  exception when others then
    raise warning 'Fechamento mensal falhou no racha %: %', new.racha_id, sqlerrm;
  end;
  return new;
end;
$function$;

drop trigger if exists fechar_meses_ao_abrir_sessao on public.sessoes;
create trigger fechar_meses_ao_abrir_sessao
after insert on public.sessoes
for each row execute function public.trg_fechar_meses_ao_abrir_sessao();

-- ─────────────────────────────────────────────────────────────────────────
-- 11. RPCs do app
-- ─────────────────────────────────────────────────────────────────────────
-- Substitui o UPDATE direto em sessoes que o cliente fazia: agora finalizar a
-- sessão e registrar o desempenho do dia acontecem na mesma transação.
create or replace function public.finalizar_sessao(p_sessao_id uuid)
returns public.sessoes
language plpgsql security definer set search_path = public
as $function$
declare
  v_sessao public.sessoes;
begin
  select * into v_sessao from public.sessoes where id = p_sessao_id for update;
  if not found then raise exception 'Sessão não encontrada'; end if;
  if not public.is_membro_admin(v_sessao.racha_id) then
    raise exception 'Apenas o organizador pode finalizar a sessão';
  end if;

  if v_sessao.status <> 'finalizada'::public.status_sessao then
    update public.sessoes
    set status = 'finalizada'::public.status_sessao,
        horario_fim = coalesce(horario_fim, now())
    where id = p_sessao_id
    returning * into v_sessao;
  end if;

  perform public.registrar_avaliacao_sessao(p_sessao_id);
  return v_sessao;
end;
$function$;

-- Escape hatch do organizador: fecha os meses pendentes na mão, ou antecipa o
-- fechamento do mês corrente (p_competencia = qualquer dia do mês desejado).
create or replace function public.fechar_mes_manual(
  p_racha_id uuid,
  p_competencia date default null
)
returns integer
language plpgsql security definer set search_path = public
as $function$
begin
  if not public.is_membro_admin(p_racha_id) then
    raise exception 'Apenas o organizador pode fechar o mês';
  end if;
  if p_competencia is null then
    return public.fechar_meses_pendentes(p_racha_id);
  end if;
  return public.fechar_mes(p_racha_id, p_competencia);
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 12. RLS: leitura pra quem é do racha, escrita só pelas funções acima
-- ─────────────────────────────────────────────────────────────────────────
alter table public.avaliacoes_sessao   enable row level security;
alter table public.fechamentos_mensais enable row level security;

drop policy if exists "avaliações leitura racha" on public.avaliacoes_sessao;
create policy "avaliações leitura racha" on public.avaliacoes_sessao
for select to authenticated using (public.is_membro_aprovado(racha_id));

drop policy if exists "fechamentos leitura racha" on public.fechamentos_mensais;
create policy "fechamentos leitura racha" on public.fechamentos_mensais
for select to authenticated using (public.is_membro_aprovado(racha_id));

grant select on public.avaliacoes_sessao, public.fechamentos_mensais to authenticated;

revoke all on function public.estrelas_da_pontuacao(numeric, integer, numeric) from public;
revoke all on function public.pontuacao_semente(integer) from public;
revoke all on function public.registrar_avaliacao_sessao(uuid) from public;
revoke all on function public.fechar_mes(uuid, date) from public;
revoke all on function public.fechar_meses_pendentes(uuid) from public;
revoke all on function public.finalizar_sessao(uuid) from public;
revoke all on function public.fechar_mes_manual(uuid, date) from public;

grant execute on function public.finalizar_sessao(uuid) to authenticated;
grant execute on function public.fechar_mes_manual(uuid, date) to authenticated;

commit;

-- ─────────────────────────────────────────────────────────────────────────
-- Verificações
-- ─────────────────────────────────────────────────────────────────────────

-- Faixas e histerese. O resultado esperado é 3, 3, 4, 3, 4:
--   55 vindo de 3★ -> 3 (meio da faixa)
--   67 vindo de 3★ -> 3 (passou de 65, mas ainda na zona morta; sobe só em 68)
--   68 vindo de 3★ -> 4 (atravessou de vez)
--   50 vindo de 4★ -> 3 (caiu abaixo de 62)
--   63 vindo de 4★ -> 4 (abaixo de 65, mas ainda na zona morta; cai só em 61,99)
select
  public.estrelas_da_pontuacao(55, 3)  as p55_de3,
  public.estrelas_da_pontuacao(67, 3)  as p67_de3,
  public.estrelas_da_pontuacao(68, 3)  as p68_de3,
  public.estrelas_da_pontuacao(50, 4)  as p50_de4,
  public.estrelas_da_pontuacao(63, 4)  as p63_de4;

-- Todo mundo com pontuação semeada.
select count(*) filter (where pontuacao is null) as sem_pontuacao,
       count(*) as total
from public.participantes;

-- As funções novas existem.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('finalizar_sessao', 'fechar_mes', 'fechar_meses_pendentes',
                    'fechar_mes_manual', 'registrar_avaliacao_sessao',
                    'estrelas_da_pontuacao', 'pontuacao_semente')
order by p.proname;
