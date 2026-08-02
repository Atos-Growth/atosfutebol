-- Remove o formato residual "7x7": a UI de sorteio só oferece 5x5 e 6x6.
-- Execute inteiro depois da migração 006 (já aplicada em produção).

begin;

-- Trava de segurança: aborta a migração inteira se existir alguma sessão
-- com tamanho_time = 7. Não decide por conta própria o que fazer com esse
-- dado — cabe a quem operar o banco investigar e corrigir manualmente
-- antes de reaplicar esta migração.
do $block$
declare
  qtd integer;
begin
  select count(*) into qtd from public.sessoes where tamanho_time = 7;
  if qtd > 0 then
    raise exception
      'Abortado: % sessão(ões) com tamanho_time = 7 ainda existem em public.sessoes. Trate esses registros manualmente antes de reaplicar esta migração.',
      qtd;
  end if;
end;
$block$;

-- Localiza e remove dinamicamente a CHECK constraint de tamanho_time
-- (mesmo padrão da migração 006, não assume o nome padrão).
do $block$
declare
  nome_constraint text;
begin
  select con.conname into nome_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'sessoes'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%tamanho_time%';

  if nome_constraint is not null then
    execute format('alter table public.sessoes drop constraint %I', nome_constraint);
  end if;
end;
$block$;

alter table public.sessoes
add constraint sessoes_tamanho_time_check check (tamanho_time in (5, 6));

commit;
