"""Revisão estrutural offline (parser PG17) dos rascunhos P0 H2. Não executa SQL.

A prova de comportamento (RLS, privilégios de coluna, isolamento entre peladas, rollback)
fica em tests/security/h2/run_h2_pg.py, contra PostgreSQL 17 local com dados fictícios.
"""
import json
import re
from pathlib import Path
import unittest

from pglast.parser import parse_sql_json

ROOT = Path(__file__).resolve().parents[2]
H2 = ROOT / 'supabase/migration-drafts/p0-h2-legacy-closure'
PUBLIC = ['id', 'racha_id', 'nome', 'apelido', 'foto_url', 'posicao', 'ativo', 'estrelas']
INTERNAL = {'_finalizar_partida_core', 'auto_finalizar_partidas_vencidas', 'fechar_mes',
            'fechar_mes_manual', 'fechar_meses_pendentes', 'registrar_avaliacao_sessao'}


def stmts(name):
    return [s['stmt'] for s in json.loads(parse_sql_json((H2 / name).read_text(encoding='utf-8')))['stmts']]


def strings(items):
    return [i['String']['sval'] for i in items]


def grantees(g):
    return {r['RoleSpec'].get('rolename', 'PUBLIC') for r in g['grantees']}


class H2DraftTests(unittest.TestCase):
    def test_every_script_is_one_transaction_outside_active_migrations(self):
        for f in ['01_hardening_v1.sql', '02_revoke_participantes_v1.sql', '01_rollback.sql', '02_rollback.sql',
                  '01_recuperacao_funcoes_admin.sql', '01a_hardening_sem_storage.sql', '01a_rollback.sql']:
            nodes = stmts(f)
            self.assertEqual(nodes[0]['TransactionStmt']['kind'], 'TRANS_STMT_BEGIN', f)
            self.assertEqual(nodes[-1]['TransactionStmt']['kind'], 'TRANS_STMT_COMMIT', f)
            self.assertFalse((H2 / f).is_relative_to(ROOT / 'supabase/migrations'))
            self.assertNotRegex((H2 / f).read_text(encoding='utf-8').lower(), r'create\s+or\s+replace|\bcascade\b')

    def test_stage_01_only_adds_or_restricts_and_drops_only_the_listing_policy(self):
        nodes = stmts('01_hardening_v1.sql')
        kinds = {next(iter(n)) for n in nodes}
        self.assertTrue(kinds <= {'TransactionStmt', 'VariableSetStmt', 'DoStmt', 'ViewStmt', 'GrantStmt',
                                  'CreateFunctionStmt', 'GrantRoleStmt', 'AlterOwnerStmt', 'AlterTableStmt',
                                  'DropStmt', 'CreatePolicyStmt'}, kinds)
        drops = [n['DropStmt'] for n in nodes if 'DropStmt' in n]
        self.assertEqual(len(drops), 1)
        self.assertEqual(drops[0]['removeType'], 'OBJECT_POLICY')
        self.assertIn('fotos públicas', json.dumps(drops[0], ensure_ascii=False))
        grants = [n['GrantStmt'] for n in nodes if 'GrantStmt' in n]
        self.assertFalse([g for g in grants if g.get('is_grant') and grantees(g) & {'anon', 'PUBLIC'}])
        internal = [g for g in grants if g['objtype'] == 'OBJECT_FUNCTION'
                    and {strings(o['ObjectWithArgs']['objname'])[-1] for o in g['objects']} == INTERNAL]
        self.assertEqual(len(internal), 1)
        self.assertFalse(internal[0].get('is_grant', False))
        self.assertEqual(grantees(internal[0]), {'PUBLIC', 'anon', 'authenticated'})

    def test_stage_01a_is_stage_01_minus_only_the_storage_block(self):
        # Fora dos blocos DO: exatamente os comandos da 01, menos o DROP/CREATE POLICY do Storage.
        def plain(name, skip_storage):
            out = []
            for n in stmts(name):
                if 'DoStmt' in n or (skip_storage and ('DropStmt' in n or 'CreatePolicyStmt' in n)):
                    continue
                out.append(re.sub(r'"\w*location": -?\d+', '', json.dumps(n, sort_keys=True)))
            return out
        self.assertEqual(plain('01a_hardening_sem_storage.sql', False), plain('01_hardening_v1.sql', True))
        # Blocos DO (preflight e guarda): só remoções em relação à 01, e nenhuma menção ao Storage.
        def bodies(name):
            all_ = [n['DoStmt']['args'][0]['DefElem']['arg']['String']['sval'] for n in stmts(name) if 'DoStmt' in n]
            return [b for b in all_ if 'P0_H2_SUPERSEDED' not in b]
        tokens = lambda t: re.findall(r'\w+|[^\s\w]', t)
        for new, old in zip(bodies('01a_hardening_sem_storage.sql'), bodies('01_hardening_v1.sql'), strict=True):
            self.assertNotIn('storage', new.lower())
            rest = iter(tokens(old))
            self.assertTrue(all(tok in rest for tok in tokens(new)), 'bloco DO da 01a não é subsequência da 01')
        text = (H2 / '01a_hardening_sem_storage.sql').read_text(encoding='utf-8')
        executable = '\n'.join(l for l in text.splitlines() if not l.lstrip().startswith('--'))
        self.assertNotIn('storage', executable.lower())
        for code in ['P0_H2_REQUIRES_PG17', 'P0_H2_REQUIRES_H1', 'P0_H2_NAME_COLLISION', 'P0_H2_SCHEMA_MISMATCH',
                     'P0_H2_REQUIRES_OBJECT_OWNER', 'P0_H2_UNEXPECTED_VIEW_ACL', 'P0_H2_EXECUTOR_PRIVILEGES',
                     'P0_H2_UNEXPECTED_RANKING_ACL', 'P0_H2_UNEXPECTED_FUNCTION_ACL']:
            self.assertIn(code, executable)

    def test_superseded_01_and_rollback_abort_right_after_begin(self):
        for name, code in [('01_hardening_v1.sql', 'P0_H2_SUPERSEDED_USE_01A'),
                           ('01_rollback.sql', 'P0_H2_SUPERSEDED_USE_01A_ROLLBACK')]:
            nodes = stmts(name)
            self.assertEqual(nodes[0]['TransactionStmt']['kind'], 'TRANS_STMT_BEGIN')
            body = nodes[1]['DoStmt']['args'][0]['DefElem']['arg']['String']['sval']
            self.assertEqual(body.strip(), f"begin raise exception '{code}'; end")
            self.assertTrue((H2 / name).read_text(encoding='utf-8').startswith('-- *** SUBSTITUÍDO por 01a'))
        for name in ['01a_hardening_sem_storage.sql', '01a_rollback.sql']:
            self.assertNotIn('SUPERSEDED', (H2 / name).read_text(encoding='utf-8'))

    def test_stage_01a_rollback_is_01_rollback_without_storage(self):
        nodes = stmts('01a_rollback.sql')
        self.assertFalse([n for n in nodes if 'CreatePolicyStmt' in n or 'GrantStmt' in n])
        text = (H2 / '01a_rollback.sql').read_text(encoding='utf-8')
        self.assertNotIn('storage', '\n'.join(l for l in text.splitlines() if not l.lstrip().startswith('--')).lower())
        self.assertIn('P0_H2_ROLLBACK_WOULD_REOPEN_ANON_EXECUTE', text)
        drops = [n['DropStmt']['removeType'] for n in nodes if 'DropStmt' in n]
        self.assertEqual(drops, ['OBJECT_FUNCTION', 'OBJECT_VIEW'])

    def test_functional_rollback_never_reopens_functions_or_anon(self):
        grants = [n['GrantStmt'] for n in stmts('01_rollback.sql') if 'GrantStmt' in n]
        self.assertFalse([g for g in grants if g['objtype'] == 'OBJECT_FUNCTION'])
        self.assertFalse([g for g in grants if g.get('is_grant') and grantees(g) & {'anon', 'PUBLIC'}])
        self.assertIn('P0_H2_ROLLBACK_WOULD_REOPEN_ANON_EXECUTE', (H2 / '01_rollback.sql').read_text(encoding='utf-8'))

    def test_admin_recovery_is_explicit_and_only_for_authenticated(self):
        nodes = stmts('01_recuperacao_funcoes_admin.sql')
        text = (H2 / '01_recuperacao_funcoes_admin.sql').read_text(encoding='utf-8')
        self.assertIn('DoStmt', nodes[2])  # confirmação antes de qualquer GRANT
        self.assertIn("'atos.reabrir_funcoes_internas', true) is distinct from 'authenticated'", text)
        grants = [n['GrantStmt'] for n in nodes if 'GrantStmt' in n]
        self.assertEqual(len(grants), 1)
        self.assertEqual(grantees(grants[0]), {'authenticated'})
        self.assertEqual({strings(o['ObjectWithArgs']['objname'])[-1] for o in grants[0]['objects']}, INTERNAL)
        self.assertLess(text.index('$confirm$'), text.index('grant execute'))

    def test_public_view_is_invoker_barrier_and_lists_only_public_columns(self):
        view = next(n['ViewStmt'] for n in stmts('01_hardening_v1.sql') if 'ViewStmt' in n)
        opts = {o['DefElem']['defname']: o['DefElem']['arg']['String']['sval'] for o in view['options']}
        self.assertEqual(opts, {'security_invoker': 'true', 'security_barrier': 'true'})
        cols = [strings(t['ResTarget']['val']['ColumnRef']['fields'])[-1] for t in view['query']['SelectStmt']['targetList']]
        self.assertEqual(cols, PUBLIC)

    def test_self_v2_is_executor_owned_definer_with_temporary_set_only(self):
        nodes = stmts('01_hardening_v1.sql')
        fn = next(n['CreateFunctionStmt'] for n in nodes if 'CreateFunctionStmt' in n)
        self.assertEqual(strings(fn['funcname']), ['public', 'obter_meu_participante_v2'])
        self.assertNotIn('auth.uid', (H2 / '01_hardening_v1.sql').read_text(encoding='utf-8').split('$self_v2$')[1])
        roles = [n['GrantRoleStmt'] for n in nodes if 'GrantRoleStmt' in n]
        self.assertEqual([r.get('is_grant', False) for r in roles], [True, False])
        opts = {o['DefElem']['defname']: o['DefElem']['arg']['Boolean'].get('boolval', False) for o in roles[0]['opt']}
        self.assertEqual(opts, {'inherit': False, 'set': True})
        self.assertNotIn('opt', roles[1])

    def test_stage_02_grants_only_public_read_and_app_written_columns(self):
        grants = [n['GrantStmt'] for n in stmts('02_revoke_participantes_v1.sql') if 'GrantStmt' in n]
        revokes = [g for g in grants if not g.get('is_grant')]
        self.assertTrue(any(grantees(g) >= {'PUBLIC', 'anon'} and 'privileges' not in g for g in revokes))
        given = {g['privileges'][0]['AccessPriv']['priv_name']: strings(g['privileges'][0]['AccessPriv']['cols'])
                 for g in grants if g.get('is_grant')}
        self.assertEqual(given['select'], PUBLIC)
        self.assertNotIn('pontuacao', given['insert'] + given['update'])
        self.assertNotIn('perfil_id', given['select'] + given['update'])
        self.assertTrue(all(grantees(g) == {'authenticated'} for g in grants if g.get('is_grant')))


if __name__ == '__main__':
    unittest.main()
