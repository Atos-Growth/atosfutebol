-- Roles mínimas no padrão do Supabase hospedado, para um cluster PostgreSQL 17 descartável.
-- postgres: LOGIN + CREATEROLE, SEM superusuário (como no Supabase). authenticator faz o
-- papel do PostgREST: membro NOINHERIT de anon/authenticated/service_role, troca por SET ROLE.
-- Executado pelo superusuário de bootstrap do cluster local; nunca em banco real.
\set ON_ERROR_STOP on
create role postgres login createrole nosuperuser password :'pw';
create role supabase_admin nologin;
create role supabase_auth_admin nologin;
create role supabase_storage_admin nologin;
create role dashboard_user nologin;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password :'pw';
grant anon, authenticated, service_role to authenticator;
-- Como na produção (preflight H2.2): storage.objects pertence a supabase_storage_admin
-- (o schema restaurado faz o ALTER OWNER) e o postgres NÃO é membro dessa role.
create database atos_h2 owner postgres;
