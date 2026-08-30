-- Troca a constante base_individual por uma média calculada em cada partida.
--
-- Motivo: o racha joga 5x5 e 6x6 dependendo de quantos aparecem. Com 10
-- jogadores em campo cada um fica, em média, com 20% mais gols do que com 12.
-- Uma constante única não dá conta dos dois formatos: quem pega mais domingos
-- de 5x5 leva uma vantagem que não tem nada a ver com desempenho.
--
-- Em vez de estimar a média de produção, agora ela é medida em cada partida:
--   esperado_do_jogador = gols_da_partida / jogadores_em_campo
-- e o sinal individual é o quanto ele passou disso.
--
-- Três consequências boas, além de resolver o 5x5/6x6:
--   1. Soma-zero exata. Dentro de uma partida, a soma dos desvios de todos os
--      jogadores é zero por construção — nenhuma inflação possível, nem
--      aproximada. Era isso que o base_individual tentava fazer no chute.
--   2. Imune a gol não anotado. Se metade dos gols não vira evento, a produção
--      do jogador e a média da partida caem juntas e se cancelam.
--   3. Some a constante que precisava ser calibrada depois. Não precisa mais.
--
-- Execute este arquivo INTEIRO no Supabase SQL Editor, depois da migração 013.
-- Não altera nenhuma pontuação nem estrela: só troca como o próximo
-- fechamento vai calcular a parcela individual.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Onde guardar a média da partida
-- ─────────────────────────────────────────────────────────────────────────
alter table public.avaliacoes_sessao
  add column if not exists gols_esperados         numeric(8,4) not null default 0,
  add column if not exists assistencias_esperadas numeric(8,4) not null default 0;

comment on column public.avaliacoes_sessao.gols_esperados is
  'Σ (gols da partida / jogadores em campo) das partidas que o jogador disputou. É a produção de um jogador médio naquelas mesmas partidas.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. A constante sai da config
-- ─────────────────────────────────────────────────────────────────────────
update public.rachas
set config_estrelas = config_estrelas - 'base_individual'
where config_estrelas ? 'base_individual';

alter table public.rachas
  alter column config_estrelas set default jsonb_build_object(
    'peso_resultado',    55.0,  -- botão principal: acelera/desacelera tudo
    'peso_individual',    8.0,  -- multiplica o desvio de gols e assistências
    'valor_gol',          0.8,
    'valor_assistencia',  0.3,
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
-- 3. Registro da sessão: agora também mede a média de cada partida
-- ─────────────────────────────────────────────────────────────────────────
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
  -- Quantos estavam em campo em cada partida: é o que separa 5x5 de 6x6.
  jogadores_por_partida as (
    select o.partida_id, count(*)::numeric as jogadores
    from ordenado o
    group by o.partida_id
  ),
  eventos_por_partida as (
    select pa.id as partida_id,
      count(ev.id)::numeric             as gols,
      count(ev.assistente_id)::numeric  as assistencias
    from public.partidas pa
    left join public.eventos ev on ev.partida_id = pa.id
    where pa.sessao_id = p_sessao_id
      and pa.status = 'finalizada'::public.status_partida
    group by pa.id
  ),
  -- O que um jogador médio teria produzido nas mesmas partidas.
  esperado as (
    select o.participante_id,
      sum(coalesce(ep.gols, 0)         / jp.jogadores) as gols_esperados,
      sum(coalesce(ep.assistencias, 0) / jp.jogadores) as assistencias_esperadas
    from ordenado o
    join jogadores_por_partida jp on jp.partida_id = o.partida_id
    left join eventos_por_partida ep on ep.partida_id = o.partida_id
    group by o.participante_id
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
    soma_res, gols, assistencias, maior_sequencia,
    gols_esperados, assistencias_esperadas
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
    coalesce(max(m.maior_sequencia), 0),
    round(coalesce(max(x.gols_esperados), 0)::numeric, 4),
    round(coalesce(max(x.assistencias_esperadas), 0)::numeric, 4)
  from ordenado o
  left join maior m on m.participante_id = o.participante_id
  left join contribuicao c on c.participante_id = o.participante_id
  left join esperado x on x.participante_id = o.participante_id
  group by o.participante_id
  on conflict (sessao_id, participante_id) do update set
    partidas               = excluded.partidas,
    vitorias               = excluded.vitorias,
    empates                = excluded.empates,
    derrotas               = excluded.derrotas,
    soma_res               = excluded.soma_res,
    gols                   = excluded.gols,
    assistencias           = excluded.assistencias,
    maior_sequencia        = excluded.maior_sequencia,
    gols_esperados         = excluded.gols_esperados,
    assistencias_esperadas = excluded.assistencias_esperadas;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Fechamento: o individual vira desvio da média real das partidas
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.fechar_mes(p_racha_id uuid, p_competencia date)
returns integer
language plpgsql security definer set search_path = public
as $function$
declare
  cfg jsonb;
  v_peso_res numeric; v_peso_ind numeric; v_gol numeric; v_assist numeric;
  v_seq numeric; v_seq_neutra numeric;
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
      count(distinct a.sessao_id)::integer   as sessoes,
      sum(a.partidas)::integer               as partidas,
      sum(a.soma_res)                        as soma_res,
      sum(a.gols)::integer                   as gols,
      sum(a.assistencias)::integer           as assistencias,
      sum(a.gols_esperados)                  as gols_esperados,
      sum(a.assistencias_esperadas)          as assistencias_esperadas,
      max(a.maior_sequencia)::integer        as maior_sequencia
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
      -- Desvio da produção real das partidas que ELE jogou. Soma-zero por
      -- partida, então funciona igual no 5x5 e no 6x6 e não infla ninguém.
      v_bonus     := (v_gol * (reg.gols - reg.gols_esperados)
                    + v_assist * (reg.assistencias - reg.assistencias_esperadas))
                    / reg.partidas;
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
      v_bonus          := 0;
      v_bseq           := 0;
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
        'avaliado',            v_avaliado,
        'travado',             jog.estrelas_travadas,
        'soma_res',            round(reg.soma_res, 4),
        'gols_esperados',      round(reg.gols_esperados, 3),
        'assist_esperadas',    round(reg.assistencias_esperadas, 3),
        'parcela_resultado',   case when v_avaliado then round(v_peso_res * v_res_medio, 2) else 0 end,
        'parcela_individual',  case when v_avaliado then round(v_peso_ind * v_bonus, 2) else 0 end,
        'parcela_sequencia',   round(v_bseq, 2),
        'calibracao',          v_avaliado and jog.meses_avaliados < v_meses_calib,
        'config',              cfg
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

commit;

-- ─────────────────────────────────────────────────────────────────────────
-- Verificações
-- ─────────────────────────────────────────────────────────────────────────
select 'colunas novas' as verificacao,
       (select count(*)::text from information_schema.columns
        where table_schema = 'public' and table_name = 'avaliacoes_sessao'
          and column_name in ('gols_esperados', 'assistencias_esperadas')) as resultado,
       '2' as esperado
union all
select 'base_individual removida',
       (select count(*)::text from public.rachas
        where config_estrelas ? 'base_individual'),
       '0'
union all
select 'peso_individual intacto',
       (select count(*)::text from public.rachas
        where config_estrelas ->> 'peso_individual' is not null),
       (select count(*)::text from public.rachas);

-- Ensaio com dados reais, sem gravar nada. Rode o bloco inteiro, o rollback
-- no fim é o que descarta tudo. A coluna desvio_individual tem que somar
-- ZERO entre todos os jogadores de uma mesma partida.
--
-- begin;
-- do $$
-- declare v_s uuid; v_r uuid; v_d date;
-- begin
--   select id, racha_id, data into v_s, v_r, v_d from public.sessoes
--   where status = 'finalizada' order by data desc, criado_em desc limit 1;
--   perform public.registrar_avaliacao_sessao(v_s);
-- end $$;
--
-- select p.nome, a.partidas, a.gols, a.gols_esperados,
--        round(0.8*(a.gols - a.gols_esperados)
--            + 0.3*(a.assistencias - a.assistencias_esperadas), 4) as desvio_individual
-- from public.avaliacoes_sessao a
-- join public.participantes p on p.id = a.participante_id
-- order by desvio_individual desc;
--
-- rollback;
