-- Registro de gol contra.
--
-- Até aqui todo toque na foto do jogador virava gol a favor do time dele. Um
-- gol contra ou ficava sem registro, ou era lançado como gol normal de alguém
-- do outro time — o que suja o placar, a artilharia e a pontuação das estrelas
-- de uma vez só.
--
-- Decisões de modelagem:
--   - `time_id` continua sendo o time DE QUEM CHUTOU, não o que ganhou o ponto.
--     Assim a coluna sempre responde "em que time esse jogador estava", que é
--     como o resto do sistema já a usa.
--   - Gol contra não aceita assistência. Não existe garçom de gol contra, e a
--     constraint impede que a tela mande um por engano.
--   - Gol contra não entra na média de produção da partida: ele não é produção
--     de ninguém, então não pode inflar o esperado dos outros dez.
--
-- Execute este arquivo INTEIRO no Supabase SQL Editor, depois da migração 015.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. A coluna
-- ─────────────────────────────────────────────────────────────────────────
alter table public.eventos
  add column if not exists contra boolean not null default false;

comment on column public.eventos.contra is
  'Gol contra. O ponto foi para o adversário, mas time_id continua sendo o time do jogador que marcou.';

do $block$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'gol_contra_sem_assistencia'
  ) then
    alter table public.eventos
      add constraint gol_contra_sem_assistencia
      check (not contra or assistente_id is null);
  end if;
end;
$block$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Onde o gol contra aparece na conta das estrelas
-- ─────────────────────────────────────────────────────────────────────────
alter table public.avaliacoes_sessao
  add column if not exists gols_contra integer not null default 0;

alter table public.fechamentos_mensais
  add column if not exists gols_contra integer not null default 0;

-- Mesma magnitude do gol normal: o que dá +0,8 a favor tira 0,8 contra.
-- Não é centralizado como o gol normal porque não existe "gol contra
-- esperado" — a média é zero e qualquer um já é acima dela.
update public.rachas
set config_estrelas = jsonb_set(config_estrelas, '{valor_gol_contra}', '0.8')
where config_estrelas ->> 'valor_gol_contra' is null;

alter table public.rachas
  alter column config_estrelas set default jsonb_build_object(
    'peso_resultado',    55.0,
    'peso_individual',    8.0,
    'valor_gol',          0.8,
    'valor_assistencia',  0.3,
    'valor_gol_contra',   0.8,  -- subtraído, não centralizado
    'bonus_sequencia',    0.5,
    'sequencia_neutra',   2,
    'teto_sequencia',     2.0,
    'piso_sequencia',    -1.0,
    'limite_mes',        15.0,
    'fator_calibracao',   1.5,
    'meses_calibracao',   2,
    'limite_calibracao', 20.0,
    'histerese',          3.0,
    'min_partidas_mes',   3,
    'sensibilidade',      1.5
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Registro da sessão separa gol de gol contra
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
  -- Gol contra fica de fora: não é produção de ninguém e não pode inflar o
  -- esperado dos outros jogadores da partida.
  eventos_por_partida as (
    select pa.id as partida_id,
      count(ev.id) filter (where not ev.contra)::numeric            as gols,
      count(ev.assistente_id) filter (where not ev.contra)::numeric as assistencias
    from public.partidas pa
    left join public.eventos ev on ev.partida_id = pa.id
    where pa.sessao_id = p_sessao_id
      and pa.status = 'finalizada'::public.status_partida
    group by pa.id
  ),
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
    select participante_id,
      sum(gols)::integer         as gols,
      sum(assistencias)::integer as assistencias,
      sum(contras)::integer      as gols_contra
    from (
      select ev.jogador_id as participante_id,
        count(*) filter (where not ev.contra)::integer as gols,
        0 as assistencias,
        count(*) filter (where ev.contra)::integer     as contras
      from public.eventos ev
      join public.partidas pa on pa.id = ev.partida_id
      where pa.sessao_id = p_sessao_id
        and pa.status = 'finalizada'::public.status_partida
      group by ev.jogador_id
      union all
      select ev.assistente_id, 0, count(*)::integer, 0
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
    gols_esperados, assistencias_esperadas, gols_contra
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
    round(coalesce(max(x.assistencias_esperadas), 0)::numeric, 4),
    coalesce(max(c.gols_contra), 0)
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
    assistencias_esperadas = excluded.assistencias_esperadas,
    gols_contra            = excluded.gols_contra;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Fechamento desconta o gol contra
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.fechar_mes(p_racha_id uuid, p_competencia date)
returns integer
language plpgsql security definer set search_path = public
as $function$
declare
  cfg jsonb;
  v_peso_res numeric; v_peso_ind numeric; v_gol numeric; v_assist numeric;
  v_gol_contra numeric; v_seq numeric; v_seq_neutra numeric;
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
  v_gol_contra   := coalesce((cfg->>'valor_gol_contra')::numeric,   0.8);
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
      sum(a.gols_contra)::integer            as gols_contra,
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
      -- Gol e assistência entram como desvio da média real da partida (soma
      -- zero, funciona igual no 5x5 e no 6x6). Gol contra entra direto como
      -- desconto: a média dele é zero, então qualquer um já está acima.
      v_bonus     := (v_gol * (reg.gols - reg.gols_esperados)
                    + v_assist * (reg.assistencias - reg.assistencias_esperadas)
                    - v_gol_contra * reg.gols_contra)
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
      gols, assistencias, gols_contra, maior_sequencia, delta,
      pontuacao_antes, pontuacao_depois, estrelas_antes, estrelas_depois, memoria
    ) values (
      p_racha_id, v_comp, reg.participante_id, reg.sessoes, reg.partidas,
      round(v_res_medio, 4), reg.gols, reg.assistencias, reg.gols_contra,
      reg.maior_sequencia, round(v_delta, 2), round(v_antes, 2), round(v_depois, 2),
      jog.estrelas, v_estrela_depois,
      jsonb_build_object(
        'avaliado',            v_avaliado,
        'travado',             jog.estrelas_travadas,
        'soma_res',            round(reg.soma_res, 4),
        'gols_esperados',      round(reg.gols_esperados, 3),
        'assist_esperadas',    round(reg.assistencias_esperadas, 3),
        'gols_contra',         reg.gols_contra,
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

  perform set_config('app.recalculo_estrelas', 'off', true);
  return v_linhas;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. A view de ranking também para de contar gol contra como artilharia
-- ─────────────────────────────────────────────────────────────────────────
-- create or replace view não deixa remover nem reordenar coluna: a forma
-- abaixo é exatamente a da 010 (incluindo racha_id no fim e o filtro de
-- tenant no join), só com o "and not e.contra" acrescentado na artilharia.
create or replace view public.ranking_historico as
select p.id, p.nome, p.foto_url,
  count(e.id) filter (where e.jogador_id = p.id and not e.contra) as gols,
  count(e.id) filter (where e.assistente_id = p.id) as assistencias,
  p.racha_id
from public.participantes p
left join public.eventos e on (e.jogador_id = p.id or e.assistente_id = p.id) and e.racha_id = p.racha_id
left join public.partidas j on j.id = e.partida_id and j.status = 'finalizada'
group by p.id, p.nome, p.foto_url, p.racha_id;

commit;

-- ─────────────────────────────────────────────────────────────────────────
-- Verificações
-- ─────────────────────────────────────────────────────────────────────────
select 'coluna contra em eventos' as verificacao,
       (select count(*)::text from information_schema.columns
        where table_schema = 'public' and table_name = 'eventos' and column_name = 'contra') as resultado,
       '1' as esperado
union all
select 'constraint sem assistencia',
       (select count(*)::text from pg_constraint where conname = 'gol_contra_sem_assistencia'),
       '1'
union all
select 'gols_contra nas duas tabelas',
       (select count(*)::text from information_schema.columns
        where table_schema = 'public' and column_name = 'gols_contra'
          and table_name in ('avaliacoes_sessao', 'fechamentos_mensais')),
       '2'
union all
select 'valor_gol_contra na config',
       (select count(*)::text from public.rachas
        where config_estrelas ->> 'valor_gol_contra' is not null),
       (select count(*)::text from public.rachas);
