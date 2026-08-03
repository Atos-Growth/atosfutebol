-- Apelido opcional do participante, usado como label durante a partida ao vivo.
-- Nullable: participantes já cadastrados não têm apelido ainda; o app usa o
-- primeiro nome como fallback de exibição enquanto o campo não for preenchido.

alter table public.participantes add column if not exists apelido text;
