"""PostgreSQL 17 AST checks only: parse SQL as text, never connect or execute."""
import json
from pathlib import Path
import unittest
from pglast import get_postgresql_version
from pglast.parser import parse_sql_json

ROOT = Path(__file__).resolve().parents[2]
DRAFTS = ROOT / 'supabase/migration-drafts/round4-4'


def statements(name):
    return [s['stmt'] for s in json.loads(parse_sql_json((DRAFTS / name).read_text()))['stmts']]


def roles(grant):
    return {g['RoleSpec'].get('rolename', 'PUBLIC') for g in grant['grantees']}


class MigrationDraftTests(unittest.TestCase):
    def test_parser_is_pg17_and_drafts_are_outside_automatic_migrations(self):
        self.assertEqual(get_postgresql_version()[0], 17)
        self.assertFalse(DRAFTS.is_relative_to(ROOT / 'supabase/migrations'))

    def test_no_data_writes_rpc_definitions_triggers_publications_or_existing_object_changes(self):
        allowed = {'TransactionStmt', 'VariableSetStmt', 'CreateRoleStmt', 'CreateSchemaStmt',
                   'GrantStmt', 'AlterDefaultPrivilegesStmt', 'DoStmt', 'ViewStmt'}
        for file in DRAFTS.glob('*.sql'):
            with self.subTest(file=file.name):
                nodes = statements(file.name)
                self.assertEqual(nodes[0]['TransactionStmt']['kind'], 'TRANS_STMT_BEGIN')
                self.assertEqual(nodes[-1]['TransactionStmt']['kind'], 'TRANS_STMT_COMMIT')
                self.assertTrue(all(set(node) <= allowed for node in nodes))
        # DO body is opaque to the SQL parser: independently restrict its content.
        body = (DRAFTS / 'prepare_participants_public_v1.sql').read_text().split('$guard$')[1]
        self.assertNotRegex(body.lower(), r'\b(insert|update|delete|truncate|execute|perform|create|alter|drop)\b')
        self.assertEqual(body.count('pg_catalog.pg_class'), 2)
        self.assertEqual(body.count('c.relrowsecurity'), 2)

    def test_view_projection_is_explicit_and_invoker(self):
        view = next(n['ViewStmt'] for n in statements('prepare_participants_public_v1.sql') if 'ViewStmt' in n)
        self.assertFalse(view.get('replace', False))
        self.assertEqual(view['view']['schemaname'], 'public')
        self.assertEqual(view['view']['relname'], 'participantes_publicos_v1')
        options = {x['DefElem']['defname']: x['DefElem']['arg']['String']['sval'] for x in view['options']}
        self.assertEqual(options, {'security_invoker': 'true', 'security_barrier': 'true'})
        query = view['query']['SelectStmt']
        columns = [[f['String']['sval'] for f in t['ResTarget']['val']['ColumnRef']['fields']]
                   for t in query['targetList']]
        self.assertEqual(columns, [['p', x] for x in
            ['id', 'racha_id', 'nome', 'apelido', 'foto_url', 'posicao', 'ativo', 'estrelas']])
        self.assertEqual(query['fromClause'][0]['RangeVar']['relname'], 'participantes')

    def test_tenant_identity_and_approved_role_are_conjoined_not_alternatives(self):
        view = next(n['ViewStmt'] for n in statements('prepare_participants_public_v1.sql') if 'ViewStmt' in n)
        guard = view['query']['SelectStmt']['whereClause']['BoolExpr']
        self.assertEqual(guard['boolop'], 'AND_EXPR')
        self.assertEqual(len(guard['args']), 2)
        uid = guard['args'][0]['NullTest']
        self.assertEqual(uid['nulltesttype'], 'IS_NOT_NULL')
        self.assertEqual([x['String']['sval'] for x in uid['arg']['FuncCall']['funcname']], ['auth', 'uid'])
        sub = guard['args'][1]['SubLink']
        self.assertEqual(sub['subLinkType'], 'EXISTS_SUBLINK')
        member = sub['subselect']['SelectStmt']
        self.assertEqual(member['fromClause'][0]['RangeVar']['relname'], 'racha_membros')
        predicate = member['whereClause']['BoolExpr']
        self.assertEqual(predicate['boolop'], 'AND_EXPR')
        self.assertEqual(len(predicate['args']), 3)
        tenant, user, role = [x['A_Expr'] for x in predicate['args']]
        def col(value):
            return [x['String']['sval'] for x in value['ColumnRef']['fields']]
        for expression in (tenant, user, role):
            self.assertEqual(expression['name'][0]['String']['sval'], '=')
        self.assertEqual(col(tenant['lexpr']), ['m', 'racha_id'])
        self.assertEqual(col(tenant['rexpr']), ['p', 'racha_id'])
        self.assertEqual(col(user['lexpr']), ['m', 'perfil_id'])
        self.assertEqual([x['String']['sval'] for x in user['rexpr']['FuncCall']['funcname']], ['auth', 'uid'])
        self.assertEqual(col(role['lexpr']), ['m', 'papel'])
        self.assertEqual(role['kind'], 'AEXPR_IN')
        self.assertEqual([x['TypeCast']['arg']['A_Const']['sval']['sval'] for x in role['rexpr']['List']['items']], ['normal', 'admin'])

    def test_new_view_grants_only_select_and_no_base_grants(self):
        grants = [n['GrantStmt'] for n in statements('prepare_participants_public_v1.sql') if 'GrantStmt' in n]
        self.assertEqual(len(grants), 2)
        revoke, grant = grants
        self.assertFalse(revoke.get('is_grant', False))
        self.assertNotIn('privileges', revoke)  # ALL
        self.assertEqual(roles(revoke), {'PUBLIC', 'anon', 'authenticated'})
        self.assertTrue(grant['is_grant'])
        self.assertEqual(grant['privileges'], [{'AccessPriv': {'priv_name': 'select'}}])
        self.assertEqual(roles(grant), {'authenticated'})
        for item in grants:
            self.assertEqual(item['objects'][0]['RangeVar']['relname'], 'participantes_publicos_v1')

    def test_effective_acl_guard_blocks_inherited_mutation_or_anonymous_read(self):
        body = (DRAFTS / 'prepare_participants_public_v1.sql').read_text().split('$acl_guard$')[1]
        self.assertEqual(body.count('pg_catalog.has_table_privilege('), 3)
        self.assertIn("'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'", body)
        self.assertIn("'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'", body)
        self.assertIn("'SELECT WITH GRANT OPTION'", body)
        self.assertIn("raise exception 'PARTICIPANTS_V1_UNEXPECTED_EFFECTIVE_ACL'", body)

    def test_new_internal_owner_has_no_login_or_bypass_and_no_role_memberships(self):
        nodes = statements('prepare_internal_schema.sql')
        role = next(n['CreateRoleStmt'] for n in nodes if 'CreateRoleStmt' in n)
        self.assertEqual(role['role'], 'atos_internal_owner')
        flags = {x['DefElem']['defname']: x['DefElem']['arg']['Boolean']['boolval'] for x in role['options']}
        self.assertEqual(flags, dict.fromkeys(['canlogin', 'superuser', 'createdb', 'createrole', 'inherit', 'isreplication', 'bypassrls'], False))
        self.assertFalse(any('GrantRoleStmt' in n for n in nodes))
        schema = next(n['CreateSchemaStmt'] for n in nodes if 'CreateSchemaStmt' in n)
        self.assertEqual(schema['schemaname'], 'internal')
        self.assertEqual(schema['authrole']['rolename'], 'atos_internal_owner')
        revoke = next(n['GrantStmt'] for n in nodes if 'GrantStmt' in n)
        self.assertFalse(revoke.get('is_grant', False))
        self.assertEqual(roles(revoke), {'PUBLIC', 'anon', 'authenticated'})

    def test_defaults_are_global_for_new_creator_not_schema_only_or_existing_creators(self):
        defaults = [n['AlterDefaultPrivilegesStmt'] for n in statements('prepare_internal_schema.sql') if 'AlterDefaultPrivilegesStmt' in n]
        self.assertEqual(len(defaults), 5)
        self.assertEqual({d['action']['objtype'] for d in defaults},
                         {'OBJECT_FUNCTION', 'OBJECT_TABLE', 'OBJECT_SEQUENCE', 'OBJECT_TYPE', 'OBJECT_SCHEMA'})
        for default in defaults:
            self.assertFalse(default['action'].get('is_grant', False))
            self.assertEqual(roles(default['action']), {'PUBLIC', 'anon', 'authenticated'})
            self.assertNotIn('privileges', default['action'])
            self.assertEqual(len(default['options']), 1)
            option = default['options'][0]['DefElem']
            self.assertEqual(option['defname'], 'roles')
            self.assertEqual(option['arg']['List']['items'][0]['RoleSpec']['rolename'], 'atos_internal_owner')


if __name__ == '__main__':
    unittest.main()
