"""P0 H2 — autorização real em PostgreSQL 17 local e descartável.

Sobe um cluster temporário (só 127.0.0.1, SCRAM), aplica a ESTRUTURA do banco de produção
(schema-only extraído do backup, sem dados), a H1 e as etapas H2 como `postgres` sem
superusuário e sem membership em supabase_storage_admin (dono de storage.objects, como na
produção), semeia dados fictícios e testa cada ator como o PostgREST faria:
`authenticator` -> SET ROLE anon/authenticated + request.jwt.claims.

Uso:
  ATOS_PG_BIN=<pasta bin do servidor PG17> ATOS_SCHEMA_SQL=<schema.sql> python -I run_h2_pg.py
Não toca em banco real. Remove o cluster ao final.
"""
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
H1 = ROOT / 'supabase/migration-drafts/participant-context-v1/prepare_participant_context_v1.sql'
H2 = ROOT / 'supabase/migration-drafts/p0-h2-legacy-closure'

RA, RB = 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001'
U = {
    'a_admin': 'a0000000-0000-4000-8000-0000000000a1', 'a_normal': 'a0000000-0000-4000-8000-0000000000a2',
    'a_normal2': 'a0000000-0000-4000-8000-0000000000a3', 'b_admin': 'b0000000-0000-4000-8000-0000000000b1',
    'b_normal': 'b0000000-0000-4000-8000-0000000000b2', 'mix': 'c0000000-0000-4000-8000-0000000000c1',
    'pend': 'd0000000-0000-4000-8000-0000000000d1', 'none': 'e0000000-0000-4000-8000-0000000000e1',
}
PA1, PA2, PA3 = ('11111111-0000-4000-8000-00000000000%d' % i for i in (1, 2, 3))
PB1 = '22222222-0000-4000-8000-000000000001'
SA, MA = '5a000000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000001'
PUBLIC_COLS = 'id, racha_id, nome, apelido, foto_url, posicao, ativo, estrelas'
DENIED = 'PARTICIPANT_CONTEXT_DENIED'

# (fases, ator, sql, esperado). esperado: ('rows', texto) | ('err', SQLSTATE) | ('msg', trecho) | ('ok',)
COMPAT_20AC666 = 'id, perfil_id, nome, apelido, foto_url, estrelas, posicao, ativo, estrelas_travadas'
CASES = [
    # --- Estado legado (antes da H2): evidência das exposições corrigidas.
    ({'before'}, 'anon', 'select count(distinct racha_id) from public.ranking_historico', ('rows', '2')),
    ({'before'}, 'anon', "select has_function_privilege('public.fechar_mes(uuid,date)', 'EXECUTE')", ('rows', 't')),
    ({'before'}, 'anon', "select count(*) from storage.objects where bucket_id = 'participantes'", ('rows', '1')),
    ({'before'}, 'a_normal', 'select count(*) from public.participantes where perfil_id is not null', ('rows', '1')),
    # --- Compatibilidade do frontend publicado (20ac666) depois da etapa 01.
    ({'before', 'after01', 'rb02'}, 'a_admin', f"select count(*) from (select {COMPAT_20AC666} from public.participantes where racha_id = '{RA}') x", ('rows', '3')),
    ({'after01', 'after02', 'rb02'}, 'a_normal', f"select pg_catalog.jsonb_build_object('n', count(*)) from public.participantes_publicos_v1 where racha_id = '{RA}'", ('rows', '{"n": 3}')),
    # --- View pública: isolamento entre peladas e atores sem vínculo.
    ({'after01', 'after02'}, 'a_normal', f"select count(*) from public.participantes_publicos_v1 where racha_id = '{RB}'", ('rows', '0')),
    ({'after01', 'after02'}, 'a_admin', 'select count(*) from public.participantes_publicos_v1', ('rows', '3')),
    ({'after01', 'after02'}, 'b_admin', 'select count(*) from public.participantes_publicos_v1', ('rows', '2')),
    ({'after01', 'after02'}, 'mix', 'select count(*) from public.participantes_publicos_v1', ('rows', '5')),
    ({'after01', 'after02'}, 'pend', 'select count(*) from public.participantes_publicos_v1', ('rows', '0')),
    ({'after01', 'after02'}, 'none', 'select count(*) from public.participantes_publicos_v1', ('rows', '0')),
    ({'after01', 'after02'}, 'anon', 'select count(*) from public.participantes_publicos_v1', ('err', '42501')),
    ({'after01', 'after02'}, 'a_normal', 'select * from public.participantes_publicos_v1 limit 0', ('ok',)),
    # --- RPC v2: vínculo + estado de nível só do próprio participante.
    ({'after01', 'after02'}, 'a_normal', f"select public.obter_meu_participante_v2('{RA}')",
     ('rows', json.dumps({'racha_id': RA, 'nivel_estado': 'congelado', 'participante_id': PA1}))),
    ({'after01', 'after02'}, 'b_normal', f"select public.obter_meu_participante_v2('{RB}')",
     ('rows', json.dumps({'racha_id': RB, 'nivel_estado': 'automatico', 'participante_id': PB1}))),
    ({'after01', 'after02'}, 'a_normal2', f"select public.obter_meu_participante_v2('{RA}')",
     ('rows', json.dumps({'racha_id': RA, 'nivel_estado': None, 'participante_id': None}))),
    ({'after01', 'after02'}, 'a_normal', f"select public.obter_meu_participante_v2('{RB}')", ('msg', DENIED)),
    ({'after01', 'after02'}, 'pend', f"select public.obter_meu_participante_v2('{RA}')", ('msg', DENIED)),
    ({'after01', 'after02'}, 'none', f"select public.obter_meu_participante_v2('{RA}')", ('msg', DENIED)),
    ({'after01', 'after02'}, 'anon', f"select public.obter_meu_participante_v2('{RA}')", ('err', '42501')),
    # --- RPCs da H1 continuam iguais.
    ({'before', 'after01', 'after02'}, 'a_admin', f"select public.obter_gestao_participantes_v1('{RA}', array['{PA1}']::uuid[])",
     ('rows', json.dumps([{'racha_id': RA, 'nivel_estado': 'congelado', 'participante_id': PA1}]))),
    ({'before', 'after01', 'after02'}, 'a_admin', f"select public.obter_gestao_participantes_v1('{RA}', array['{PA1}', '{PB1}']::uuid[])", ('msg', DENIED)),
    # --- ranking_historico: sem anon e só a própria pelada.
    ({'after01', 'after02'}, 'anon', 'select count(*) from public.ranking_historico', ('err', '42501')),
    ({'after01', 'after02'}, 'a_normal', 'select count(distinct racha_id) from public.ranking_historico', ('rows', '1')),
    ({'after01', 'after02'}, 'mix', 'select count(distinct racha_id) from public.ranking_historico', ('rows', '2')),
    ({'after01', 'after02'}, 'a_normal', f"select gols from public.ranking_historico where id = '{PA1}'", ('rows', '1')),
    # --- Funções internas fora da API; RPCs do app só para autenticados.
    ({'after01', 'after02'}, 'anon', f"select public.fechar_mes('{RA}', date '2026-11-01')", ('err', '42501')),
    ({'after01', 'after02'}, 'a_admin', f"select public.fechar_mes('{RA}', date '2026-11-01')", ('err', '42501')),
    ({'after01', 'after02'}, 'a_admin', f"select public.fechar_meses_pendentes('{RA}')", ('err', '42501')),
    ({'after01', 'after02'}, 'a_admin', f"select public.registrar_avaliacao_sessao('{SA}')", ('err', '42501')),
    ({'after01', 'after02'}, 'a_admin', f"select public._finalizar_partida_core('{MA}')", ('err', '42501')),
    ({'after01', 'after02'}, 'anon', 'select public.auto_finalizar_partidas_vencidas()', ('err', '42501')),
    ({'after01', 'after02'}, 'anon', f"select public.finalizar_sessao('{SA}')", ('err', '42501')),
    ({'after01', 'after02'}, 'anon', f"select public.solicitar_acesso_racha('{RA}')", ('err', '42501')),
    # Caminhos internos continuam funcionando (SD dono postgres / trigger / RPC do app).
    ({'before', 'after01', 'after02'}, 'a_admin', f"select public.finalizar_partida_e_girar_fila('{MA}')", ('ok',)),
    ({'before', 'after01', 'after02'}, 'a_admin', f"select (public.finalizar_sessao('{SA}')).status", ('rows', 'finalizada')),
    ({'before', 'after01', 'after02'}, 'a_admin', f"insert into public.sessoes (racha_id) values ('{RA}') returning racha_id", ('rows', RA)),
    ({'before', 'after01', 'after02'}, 'b_admin', f"select public.finalizar_partida_e_girar_fila('{MA}')", ('msg', 'Apenas o organizador')),
    # --- Storage: a 01a NÃO mexe no Storage; a listagem segue como antes (tratada à parte).
    ({'after01', 'after02'}, 'anon', "select count(*) from storage.objects where bucket_id = 'participantes'", ('rows', '1')),
    ({'after01', 'after02'}, 'a_normal', "select count(*) from storage.objects where bucket_id = 'participantes'", ('rows', '1')),
    # --- Etapa 02: colunas privadas fechadas; leitura pública e escritas do app preservadas.
    ({'after02'}, 'a_admin', 'select * from public.participantes limit 1', ('err', '42501')),
    ({'after02'}, 'a_admin', 'select perfil_id from public.participantes limit 1', ('err', '42501')),
    ({'after02'}, 'a_admin', 'select estrelas_travadas from public.participantes limit 1', ('err', '42501')),
    ({'after02'}, 'a_admin', 'select pontuacao from public.participantes limit 1', ('err', '42501')),
    ({'after02'}, 'anon', 'select id from public.participantes limit 1', ('err', '42501')),
    ({'after02'}, 'a_admin', f"select count(*) from (select {PUBLIC_COLS} from public.participantes where racha_id = '{RA}') x", ('rows', '3')),
    ({'after02'}, 'a_admin', f"select count(*) from (select {PUBLIC_COLS} from public.participantes where racha_id = '{RB}') x", ('rows', '0')),
    ({'after02'}, 'a_normal', f"select count(*) from public.times_jogadores tj join public.participantes p on p.id = tj.participante_id where tj.racha_id = '{RA}' and p.nome is not null", ('rows', '2')),
    ({'after02'}, 'a_admin', f"insert into public.participantes (racha_id, nome, estrelas, posicao) values ('{RA}', 'Novo Teste', 3, 'meio') returning nome", ('rows', 'Novo Teste')),
    ({'after02'}, 'a_admin', f"insert into public.participantes (racha_id, nome, estrelas, posicao, pontuacao) values ('{RA}', 'Novo Teste', 3, 'meio', 99) returning id", ('err', '42501')),
    ({'after02'}, 'a_admin', f"update public.participantes set nome = 'Editado', estrelas_travadas = false where id = '{PA2}' returning nome, ativo", ('rows', 'Editado|t')),
    ({'after02'}, 'a_admin', f"update public.participantes set ativo = false where id = '{PA2}' returning ativo", ('rows', 'f')),
    ({'after02'}, 'a_admin', f"update public.participantes set pontuacao = 99 where id = '{PA2}'", ('err', '42501')),
    ({'after02'}, 'a_admin', f"update public.participantes set meses_avaliados = 9 where id = '{PA2}'", ('err', '42501')),
    ({'after02'}, 'a_normal2', f"insert into public.participantes (racha_id, nome, estrelas, posicao, perfil_id) values ('{RA}', 'Auto Cadastro', 3, 'meio', '{U['a_normal2']}') returning nome", ('rows', 'Auto Cadastro')),
    ({'after02'}, 'a_normal2', f"insert into public.participantes (racha_id, nome, estrelas, posicao, perfil_id) values ('{RB}', 'Fora', 3, 'meio', '{U['a_normal2']}') returning id", ('err', '42501')),
    ({'after02'}, 'a_normal', f"update public.participantes set nome = 'Invasor' where id = '{PA2}' returning id", ('rows', '')),
    ({'after02'}, 'b_admin', f"update public.participantes set nome = 'Invasor' where id = '{PA2}' returning id", ('rows', '')),
    ({'after02'}, 'a_normal', f"select public.obter_meu_participante_v1('{RA}')", ('rows', json.dumps({'racha_id': RA, 'participante_id': PA1}))),
    # --- Reversões restauram o comportamento anterior.
    ({'rb02'}, 'a_admin', f"select count(perfil_id) from public.participantes where racha_id = '{RA}'", ('rows', '1')),
    ({'rb01'}, 'a_normal', 'select count(*) from public.participantes_publicos_v1', ('err', '42P01')),
    ({'rb01'}, 'a_normal', f"select public.obter_meu_participante_v2('{RA}')", ('err', '42883')),
    ({'rb01'}, 'a_admin', f"select count(*) from (select {COMPAT_20AC666} from public.participantes where racha_id = '{RA}') x", ('rows', '3')),
    ({'rb01'}, 'anon', "select count(*) from storage.objects where bucket_id = 'participantes'", ('rows', '1')),
    # A reversão funcional NÃO reabre as funções SD perigosas nem o ranking sem RLS.
    ({'rb01', 'recadm'}, 'anon', f"select public.fechar_mes('{RA}', date '2026-11-01')", ('err', '42501')),
    ({'rb01'}, 'a_admin', f"select public.fechar_mes('{RA}', date '2026-11-01')", ('err', '42501')),
    ({'rb01', 'recadm'}, 'anon', f"select public._finalizar_partida_core('{MA}')", ('err', '42501')),
    ({'rb01', 'recadm'}, 'anon', f"select public.finalizar_sessao('{SA}')", ('err', '42501')),
    ({'rb01'}, 'anon', 'select count(*) from public.ranking_historico', ('err', '42501')),
    # ...e o app segue funcional depois dela (caminhos internos).
    ({'rb01'}, 'a_admin', f"select public.finalizar_partida_e_girar_fila('{MA}')", ('ok',)),
    ({'rb01'}, 'a_admin', f"insert into public.sessoes (racha_id) values ('{RA}') returning racha_id", ('rows', RA)),
    # Recuperação administrativa explícita: só authenticated, nunca anon.
    ({'recadm'}, 'a_admin', "select has_function_privilege('public.fechar_mes(uuid,date)', 'EXECUTE')", ('rows', 't')),
    ({'recadm'}, 'anon', "select has_function_privilege('public.fechar_mes(uuid,date)', 'EXECUTE')", ('rows', 'f')),
    ({'recadm'}, 'anon', "select has_function_privilege('public.registrar_avaliacao_sessao(uuid)', 'EXECUTE')", ('rows', 'f')),
]


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Cluster:
    def __init__(self, bindir: Path):
        self.bin = bindir
        self.tmp = Path(tempfile.mkdtemp(prefix='atos-h2-'))
        self.data = self.tmp / 'data'
        self.port = free_port()
        self.pw = secrets.token_urlsafe(24)
        pgpass = self.tmp / 'pgpass'
        pgpass.write_text(f'127.0.0.1:{self.port}:*:*:{self.pw}\n')
        self.env = {**os.environ, 'PGPASSFILE': str(pgpass), 'PGHOST': '127.0.0.1', 'PGPORT': str(self.port),
                    'PGCONNECT_TIMEOUT': '10', 'PGAPPNAME': 'atos-h2-local', 'PGCLIENTENCODING': 'UTF8',
                    'LC_ALL': 'C', 'LC_MESSAGES': 'C', 'LANG': 'C', 'LANGUAGE': 'en'}
        for key in ('PGPASSWORD', 'PGUSER', 'PGDATABASE', 'PGSERVICE'):
            self.env.pop(key, None)

    def tool(self, name):
        return str(self.bin / (name + ('.exe' if os.name == 'nt' else '')))

    def start(self):
        pwfile = self.tmp / 'pw'
        pwfile.write_text(self.pw)
        subprocess.run([self.tool('initdb'), '-D', str(self.data), '-U', 'restore_admin', f'--pwfile={pwfile}',
                        '--auth=scram-sha-256', '--encoding=UTF8', '--no-locale', '--no-instructions'],
                       check=True, capture_output=True, env=self.env)
        pwfile.unlink()
        with open(self.data / 'postgresql.conf', 'a') as conf:
            conf.write(f"\nlisten_addresses = '127.0.0.1'\nport = {self.port}\nunix_socket_directories = ''\n")
        (self.data / 'pg_hba.conf').write_text('host all all 127.0.0.1/32 scram-sha-256\n')
        subprocess.run([self.tool('pg_ctl'), 'start', '-D', str(self.data), '-l', str(self.tmp / 'server.log'), '-w', '-t', '60'],
                       check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=self.env)

    def stop(self):
        subprocess.run([self.tool('pg_ctl'), 'stop', '-D', str(self.data), '-m', 'fast', '-w'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=self.env)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def psql(self, user, db, script=None, file=None, variables=None, extra_env=None):
        args = [self.tool('psql'), '-X', '-q', '-A', '-t', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']
        for k, v in (variables or {}).items():
            args += ['-v', f'{k}={v}']
        if file:
            args += ['-f', str(file)]
        r = subprocess.run(args, input=script, capture_output=True, text=True, encoding='utf-8', errors='replace',
                           env={**self.env, **(extra_env or {})})
        return r.returncode, r.stdout or '', r.stderr or ''

    def apply(self, user, db, file=None, script=None, variables=None, label='', extra_env=None):
        code, out, err = self.psql(user, db, script=script, file=file, variables=variables, extra_env=extra_env)
        if code != 0:
            raise RuntimeError(f'{label} falhou:\n{err[-2000:]}')

    def apply_must_fail(self, user, db, file, needle, label, script=None):
        code, out, err = self.psql(user, db, file=file, script=script)
        if code == 0 or needle not in err:
            raise RuntimeError(f'{label}: deveria falhar com {needle}, obtido code={code}\n{err[-800:]}')

    def case(self, actor, sql):
        if actor == 'anon':
            role, claims = 'anon', {'role': 'anon'}
        else:
            role, claims = 'authenticated', {'sub': U[actor], 'role': 'authenticated', 'aud': 'authenticated'}
        script = ('\\set VERBOSITY verbose\nbegin;\n'
                  f"set local role {role};\n"
                  f"select set_config('request.jwt.claims', '{json.dumps(claims)}', true) as c \\gset\n"
                  f'{sql};\nrollback;\n')
        code, out, err = self.psql('authenticator', 'atos_h2', script=script)
        return code, out.strip(), err


# Impressão do Storage (policies, dono, ACL e RLS de storage.objects/buckets): a 01a não pode mudá-la.
STORAGE_FP = r"""select md5(coalesce((select string_agg(tablename||'|'||policyname||'|'||cmd||'|'||array_to_string(roles, ',')
  ||'|'||coalesce(qual, '')||'|'||coalesce(with_check, ''), E'\n' order by tablename, policyname)
  from pg_policies where schemaname = 'storage'), '')
  ||(select string_agg(relname||'|'||relowner::regrole::text||'|'||coalesce(relacl::text, '')||'|'||relrowsecurity::text, E'\n' order by relname)
     from pg_class where oid in ('storage.objects'::regclass, 'storage.buckets'::regclass)))"""
# Espelho da produção: dono supabase_storage_admin, postgres sem membership (nem USAGE), SELECT só por GRANT.
PROD_MIRROR = """select (select relowner::regrole::text from pg_class where oid = 'storage.objects'::regclass)
  ||'|'||pg_has_role('postgres', (select relowner from pg_class where oid = 'storage.objects'::regclass), 'USAGE')::text
  ||'|'||pg_has_role('postgres', (select relowner from pg_class where oid = 'storage.objects'::regclass), 'MEMBER')::text
  ||'|'||exists (select 1 from pg_auth_members where roleid = 'supabase_storage_admin'::regrole)::text
  ||'|'||has_table_privilege('postgres', 'storage.objects', 'SELECT')::text"""


def check(expect, code, out, err):
    kind = expect[0]
    if kind == 'ok':
        return code == 0
    if kind == 'rows':
        return code == 0 and out == expect[1]
    state = re.search(r'ERROR:\s+([0-9A-Z]{5}):', err)
    if kind == 'err':
        return code != 0 and state is not None and state.group(1) == expect[1]
    if kind == 'msg':
        return code != 0 and expect[1] in err
    raise ValueError(kind)


def normalize_json(out):
    try:
        return json.dumps(json.loads(out), sort_keys=True)
    except ValueError:
        return out


def main():
    bindir, schema = os.environ.get('ATOS_PG_BIN'), os.environ.get('ATOS_SCHEMA_SQL')
    if not bindir or not schema:
        sys.exit('Defina ATOS_PG_BIN e ATOS_SCHEMA_SQL.')
    cluster = Cluster(Path(bindir))
    results = []
    try:
        cluster.start()
        cluster.apply('restore_admin', 'postgres', file=HERE / 'bootstrap.sql', variables={'pw': cluster.pw}, label='bootstrap')
        cluster.apply('restore_admin', 'atos_h2', label='stubs', script=(
            "drop schema public;\ncreate schema supabase_functions;\n"
            "create function supabase_functions.http_request() returns trigger language plpgsql as $$ begin return null; end $$;\n"))
        cluster.apply('restore_admin', 'atos_h2', file=Path(schema), label='schema de producao (estrutura)')
        cluster.apply('postgres', 'atos_h2', file=H1, label='H1 como postgres')
        cluster.apply('restore_admin', 'atos_h2', file=HERE / 'seed.sql', label='dados ficticios')

        def run_phase(phase):
            for phases, actor, sql, expect in CASES:
                if phase not in phases:
                    continue
                code, out, err = cluster.case(actor, sql)
                if expect[0] == 'rows' and expect[1].startswith(('{', '[')):
                    out, expect = normalize_json(out), ('rows', normalize_json(expect[1]))
                ok = check(expect, code, out, err)
                detail = '' if ok else f' -> obtido: code={code} out={out!r} err={err.strip().splitlines()[0] if err.strip() else ""!r}'
                results.append((phase, ok, actor, sql, detail))

        def query(sql):
            code, out, err = cluster.psql('restore_admin', 'atos_h2', script=sql + ';\n')
            if code != 0:
                raise RuntimeError(f'consulta falhou:\n{err[-800:]}')
            return out.strip()

        def expect_fact(label, ok, detail=''):
            results.append(('storage', ok, 'restore_admin', label, '' if ok else f' -> obtido: {detail}'))

        mirror = query(PROD_MIRROR)
        expect_fact('espelho da producao: dono supabase_storage_admin, postgres sem USAGE/MEMBER, SELECT por GRANT',
                    mirror == 'supabase_storage_admin|false|false|false|true', mirror)
        storage_fp = query(STORAGE_FP)

        def storage_unchanged(when):
            fp = query(STORAGE_FP)
            expect_fact(f'policies/dono/ACL do Storage inalterados {when}', fp == storage_fp, fp)

        # O postgres de fato não administra storage.objects (o motivo da divisão da etapa 01).
        cluster.apply_must_fail('postgres', 'atos_h2', None, 'must be owner of', 'postgres altera policy do Storage',
                                script='begin;\ndrop policy "fotos públicas" on storage.objects;\nrollback;\n')
        expect_fact('postgres nao consegue DROP POLICY em storage.objects (must be owner)', True)
        nothing_applied = ("select to_regclass('public.participantes_publicos_v1') is null"
                           " and to_regprocedure('public.obter_meu_participante_v2(uuid)') is null"
                           " and has_function_privilege('anon', 'public.fechar_mes(uuid,date)', 'EXECUTE')")
        # A 01 original está marcada como substituída: aborta logo após o BEGIN, sem efeito.
        cluster.apply_must_fail('postgres', 'atos_h2', H2 / '01_hardening_v1.sql', 'P0_H2_SUPERSEDED_USE_01A',
                                '01 original substituida')
        expect_fact('01 original (substituida) abortada sem deixar nada aplicado', query(nothing_applied) == 't')
        # Sem o bloqueio, ela abortaria inteira no preflight (exatamente o que a produção mostrou).
        original = (H2 / '01_hardening_v1.sql').read_text(encoding='utf-8')
        marker = "do $superseded$ begin raise exception 'P0_H2_SUPERSEDED_USE_01A'; end $superseded$;\n"
        assert original.count(marker) == 1
        cluster.apply_must_fail('postgres', 'atos_h2', None, 'P0_H2_REQUIRES_OBJECT_OWNER', '01 original sem posse do Storage',
                                script=original.replace(marker, ''))
        leftover = query(nothing_applied)
        expect_fact('01 original sem o bloqueio: abortada no preflight sem deixar nada aplicado', leftover == 't', leftover)
        storage_unchanged('depois da 01 original abortada')

        run_phase('before')
        cluster.apply('postgres', 'atos_h2', file=H2 / '01a_hardening_sem_storage.sql', label='H2 etapa 01a como postgres')
        storage_unchanged('depois da 01a')
        # O rollback antigo também está bloqueado: nem a view nem a v2 são removidas por ele.
        cluster.apply_must_fail('postgres', 'atos_h2', H2 / '01_rollback.sql', 'P0_H2_SUPERSEDED_USE_01A_ROLLBACK',
                                '01_rollback substituido')
        kept = query("select to_regclass('public.participantes_publicos_v1') is not null"
                     " and to_regprocedure('public.obter_meu_participante_v2(uuid)') is not null")
        expect_fact('01_rollback (substituido) abortado sem desfazer a 01a', kept == 't', kept)
        storage_unchanged('depois do 01_rollback abortado')
        run_phase('after01')
        cluster.apply('postgres', 'atos_h2', file=H2 / '02_revoke_participantes_v1.sql', label='H2 etapa 02 como postgres')
        storage_unchanged('depois da 02')
        run_phase('after02')
        cluster.apply('postgres', 'atos_h2', file=H2 / '02_rollback.sql', label='rollback 02')
        run_phase('rb02')
        cluster.apply('postgres', 'atos_h2', file=H2 / '01a_rollback.sql', label='rollback 01a')
        storage_unchanged('depois do rollback 01a')
        run_phase('rb01')
        recovery = H2 / '01_recuperacao_funcoes_admin.sql'
        cluster.apply_must_fail('postgres', 'atos_h2', recovery, 'P0_H2_RECUPERACAO_EXIGE_CONFIRMACAO_EXPLICITA',
                                'recuperacao sem confirmacao')
        results.append(('recadm', True, 'postgres', 'recuperacao administrativa sem confirmacao -> abortada', ''))
        cluster.apply('postgres', 'atos_h2', file=recovery, label='recuperacao administrativa confirmada',
                      extra_env={'PGOPTIONS': '-c atos.reabrir_funcoes_internas=authenticated'})
        run_phase('recadm')
        # Reaplicação depois das reversões: os scripts continuam consistentes.
        cluster.apply('postgres', 'atos_h2', file=H2 / '01a_hardening_sem_storage.sql', label='reaplicar 01a')
        cluster.apply('postgres', 'atos_h2', file=H2 / '02_revoke_participantes_v1.sql', label='reaplicar 02')
        storage_unchanged('depois de reaplicar 01a e 02')
        run_phase('after02')
    finally:
        cluster.stop()
    failed = [r for r in results if not r[1]]
    for phase, ok, actor, sql, detail in results:
        print(f"{'ok  ' if ok else 'FAIL'} [{phase:7}] {actor:9} {sql[:95]}{detail}")
    print(f'\n{len(results) - len(failed)}/{len(results)} casos passaram')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
