-- Reversão da ETAPA 02: devolve os grants legados de public.participantes exatamente
-- como estavam (GRANT ALL para anon e authenticated). Reabre a exposição: usar só para
-- restaurar o funcionamento se o frontend falhar após a revogação.
begin;
set local lock_timeout = '2s';
revoke select (id, racha_id, nome, apelido, foto_url, posicao, ativo, estrelas),
       insert (racha_id, nome, apelido, estrelas, posicao, foto_url, perfil_id),
       update (nome, apelido, estrelas, posicao, foto_url, ativo, estrelas_travadas)
  on public.participantes from authenticated;
grant all privileges on table public.participantes to anon, authenticated;
commit;
