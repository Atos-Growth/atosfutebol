-- Corrige o trigger bloquear_autoalteracao_estrelas, que ficou quebrado
-- depois da 010: ele chamava is_admin() (função global removida) e passou a
-- lançar "function public.is_admin() does not exist" em qualquer UPDATE em
-- participantes (inclusive o toggle de ativo/inativo na aba Participantes).
--
-- Esse trigger já existia no banco antes da 010 — não está em nenhuma
-- migration anterior do repo — e reforça exatamente a regra pedida (só o
-- organizador altera o nível de habilidade). Mantido, só que escopado por
-- racha agora. É redundante com a policy "participantes atualização admin
-- racha" (que já exige admin pra qualquer update), mas serve como segunda
-- camada de defesa caso algum caminho futuro faça update via service role.
--
-- Execute este arquivo INTEIRO no Supabase SQL Editor, depois da migração 010.

create or replace function public.bloquear_autoalteracao_estrelas()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_membro_admin(new.racha_id) and new.estrelas is distinct from old.estrelas then
    raise exception 'Apenas o organizador pode alterar o nível de habilidade';
  end if;
  return new;
end;
$function$;

-- Verificação rápida: a definição não deve mais mencionar is_admin().
select pg_get_functiondef(oid) as definicao
from pg_proc
where proname = 'bloquear_autoalteracao_estrelas';
