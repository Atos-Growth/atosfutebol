-- Autocadastro com aprovação do organizador.
-- Execute este arquivo INTEIRO depois da migração 003.
-- Não há BEGIN global: o novo valor do enum precisa ser confirmado antes de uso.

alter type public.papel_usuario add value if not exists 'pendente';

alter table public.perfis add column if not exists email text;

create or replace function public.criar_perfil_pendente()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  insert into public.perfis (id, papel, email)
  values (new.id, 'pendente'::public.papel_usuario, new.email);
  return new;
end;
$function$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.criar_perfil_pendente();

create or replace function public.is_aprovado()
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select exists (
    select 1 from public.perfis
    where id = auth.uid()
      and papel in ('admin'::public.papel_usuario, 'normal'::public.papel_usuario)
  );
$function$;

revoke all on function public.is_aprovado() from public;
grant execute on function public.is_aprovado() to authenticated;

-- Um authenticated pendente não pode ler dados do produto.
drop policy if exists "participantes leitura autenticada" on public.participantes;
create policy "participantes leitura autenticada" on public.participantes
for select to authenticated using (public.is_aprovado());

drop policy if exists "sessões leitura autenticada" on public.sessoes;
create policy "sessões leitura autenticada" on public.sessoes
for select to authenticated using (public.is_aprovado());

drop policy if exists "check-ins leitura autenticada" on public.check_ins;
create policy "check-ins leitura autenticada" on public.check_ins
for select to authenticated using (public.is_aprovado());

drop policy if exists "times leitura autenticada" on public.times;
create policy "times leitura autenticada" on public.times
for select to authenticated using (public.is_aprovado());

drop policy if exists "times jogadores leitura autenticada" on public.times_jogadores;
create policy "times jogadores leitura autenticada" on public.times_jogadores
for select to authenticated using (public.is_aprovado());

drop policy if exists "partidas leitura autenticada" on public.partidas;
create policy "partidas leitura autenticada" on public.partidas
for select to authenticated using (public.is_aprovado());

drop policy if exists "eventos leitura autenticada" on public.eventos;
create policy "eventos leitura autenticada" on public.eventos
for select to authenticated using (public.is_aprovado());

-- O usuário lê o próprio perfil; admin lê todos para gerenciar pendências.
drop policy if exists "perfil leitura própria" on public.perfis;
create policy "perfil leitura própria" on public.perfis
for select to authenticated using (id = auth.uid());

drop policy if exists "admin lista perfis" on public.perfis;
create policy "admin lista perfis" on public.perfis
for select to authenticated using (public.is_admin());

-- Continuamos deliberadamente sem INSERT/UPDATE/DELETE em perfis para authenticated.

-- Verificação rápida: deve retornar as funções e o trigger habilitado.
select p.proname as funcao
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('criar_perfil_pendente', 'is_aprovado')
order by p.proname;

select tgname as trigger, tgenabled as habilitado
from pg_trigger
where tgname = 'on_auth_user_created' and not tgisinternal;
