-- Permite sessões de 5x5, além dos formatos já suportados.
-- Execute inteiro depois da migração 005.
-- Localiza e remove dinamicamente a CHECK constraint de tamanho_time
-- (não assume o nome padrão, caso tenha sido renomeada manualmente).

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
add constraint sessoes_tamanho_time_check check (tamanho_time in (5, 6, 7));
