"""Offline PG17 SQL/PLpgSQL AST review. No driver, socket, server or SQL execution.

These checks constrain the draft itself; they cannot certify deployed RLS/ACLs.
"""
import json
from pathlib import Path
import re
import unittest

from pglast import get_postgresql_version
from pglast.parser import parse_sql_json, parse_plpgsql_json

ROOT = Path(__file__).resolve().parents[2]
DRAFT = ROOT / 'supabase/migration-drafts/participant-context-v1/prepare_participant_context_v1.sql'
SQL = DRAFT.read_text()
READER = 'atos_participant_context_reader'
SELF = 'obter_meu_participante_v1'
MANAGEMENT = 'obter_gestao_participantes_v1'


def walk(value, key):
    if isinstance(value, dict):
        if key in value:
            yield value[key]
        for child in value.values():
            yield from walk(child, key)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child, key)


def statements(text):
    return [item['stmt'] for item in json.loads(parse_sql_json(text))['stmts']]


def strings(items):
    return [item['String']['sval'] for item in items]


def options(function):
    return {item['DefElem']['defname']: item['DefElem']['arg'] for item in function['options']
            if item['DefElem']['defname'] != 'set'}


def pl_body(function):
    source = options(function)['as']['List']['items'][0]['String']['sval']
    # Parse the full definition so parameter declarations are understood, without a DB.
    start = SQL.index('create function public.' + strings(function['funcname'])[-1])
    tail = SQL[start:]
    delimiter = '$self$' if strings(function['funcname'])[-1] == SELF else '$management$'
    end = tail.index(delimiter, tail.index(delimiter) + len(delimiter)) + len(delimiter) + 1
    parsed = json.loads(parse_plpgsql_json(tail[:end]))[0]['PLpgSQL_function']
    body = parsed['action']['PLpgSQL_stmt_block']['body']
    # PL/pgSQL wraps an exception-handling block in an implicit outer return.
    if 'PLpgSQL_stmt_block' in body[0]:
        body = body[0]['PLpgSQL_stmt_block']['body']
    return source, body, parsed


def expressions(parsed):
    for expr in walk(parsed, 'PLpgSQL_expr'):
        query, mode = expr['query'], expr['parseMode']
        if mode == 0:
            yield statements(query)[0]
        elif mode == 2:
            yield statements('select ' + query)[0]
        elif mode == 3:  # variable assignment, not SQL/DML
            yield statements('select ' + query.split(':=', 1)[1])[0]
        else:
            raise AssertionError(f'Unexpected parse mode {mode}')


def read_queries(body):
    return [statements(item['sqlstmt']['PLpgSQL_expr']['query'])[0]['SelectStmt']
            for item in walk(body, 'PLpgSQL_stmt_execsql')]


def column(value):
    return strings(value['ColumnRef']['fields'])


def assert_membership(test, query, admin_only):
    relation = query['fromClause'][0]['RangeVar']
    test.assertEqual((relation['schemaname'], relation['relname']), ('public', 'racha_membros'))
    predicate = query['whereClause']['BoolExpr']
    test.assertEqual(predicate['boolop'], 'AND_EXPR')
    test.assertEqual(len(predicate['args']), 2)
    for node, left, right in zip(predicate['args'], [['m', 'racha_id'], ['m', 'perfil_id']], [['p_racha_id'], ['v_uid']]):
        expr = node['A_Expr']
        test.assertEqual(strings(expr['name']), ['='])
        test.assertEqual(column(expr['lexpr']), left)
        test.assertEqual(column(expr['rexpr']), right)
    result = query['targetList'][0]['ResTarget']['val']['BoolExpr']
    test.assertEqual(result['boolop'], 'AND_EXPR')
    count, role = result['args']
    test.assertEqual(count['A_Expr']['rexpr']['A_Const']['ival']['ival'], 1)
    test.assertEqual(strings(count['A_Expr']['lexpr']['FuncCall']['funcname']), ['pg_catalog', 'count'])
    role_fn = role['FuncCall']
    test.assertEqual(strings(role_fn['funcname']), ['pg_catalog', 'bool_and'])
    role_expr = role_fn['args'][0]['A_Expr']
    test.assertEqual(column(role_expr['lexpr']), ['m', 'papel'])
    test.assertEqual(role_expr['kind'], 'AEXPR_OP' if admin_only else 'AEXPR_IN')
    test.assertEqual(strings(role_expr['name']), ['='])
    constants = [n['sval']['sval'] for n in walk(role_expr['rexpr'], 'A_Const')]
    test.assertEqual(constants, ['admin'] if admin_only else ['normal', 'admin'])


BOOTSTRAP = '<bootstrap superuser>'
DEPLOYER = 'postgres'


def simulate_memberships(nodes, superuser, session_self_grant='', trace=None):
    """Structural model of PG17 src/backend/commands/user.c over the draft's AST.

    NOT database execution. Rules modelled (REL_17_STABLE):
    - CreateRole by a non-superuser adds (role, creator, grantor=BOOTSTRAP) with
      admin=true, inherit=false, set=false; if createrole_self_grant is non-empty it also
      adds (role, creator, grantor=creator) with those options and admin=false.
    - check_role_grantor without GRANTED BY: superuser -> BOOTSTRAP; otherwise
      select_best_admin, i.e. the current user when it holds ADMIN directly.
    - Rows are keyed by (role, member, grantor); GRANT updates only specified options of
      an existing row; REVOKE <opt> OPTION FOR only clears that option (row kept); a full
      REVOKE deletes only the row with the resolved grantor.
    - ALTER ... OWNER TO requires the current user to be able to SET ROLE to the owner.
    """
    rows, self_grant = {}, session_self_grant
    for node in nodes:
        kind, stmt = next(iter(node.items()))
        if kind == 'VariableSetStmt' and stmt['name'] == 'createrole_self_grant':
            self_grant = stmt['args'][0]['A_Const']['sval']['sval']
        elif kind == 'CreateRoleStmt' and not superuser:
            rows[(stmt['role'], DEPLOYER, BOOTSTRAP)] = {'admin': True, 'inherit': False, 'set': False}
            if self_grant:
                chosen = {item.strip() for item in self_grant.split(',')}
                rows[(stmt['role'], DEPLOYER, DEPLOYER)] = {
                    'admin': False, 'inherit': 'inherit' in chosen, 'set': 'set' in chosen}
        elif kind == 'GrantRoleStmt':
            if 'grantor' in stmt:
                raise AssertionError('GRANTED BY is not modelled')
            role = stmt['granted_roles'][0]['AccessPriv']['priv_name']
            spec = stmt['grantee_roles'][0]['RoleSpec']
            member = DEPLOYER if spec['roletype'] == 'ROLESPEC_CURRENT_USER' else spec['rolename']
            if superuser:
                grantor = BOOTSTRAP
            elif any(r == role and m == DEPLOYER and o['admin'] for (r, m, _), o in rows.items()):
                grantor = DEPLOYER
            else:
                raise PermissionError('no possible grantors')
            opts = {o['DefElem']['defname']: o['DefElem']['arg']['Boolean'].get('boolval', False)
                    for o in stmt.get('opt', [])}
            key = (role, member, grantor)
            if stmt.get('is_grant', False):
                row = rows.setdefault(key, {'admin': False, 'inherit': True, 'set': True})
                row.update({name: value for name, value in opts.items() if name in row})
            elif key in rows:
                if opts:
                    for name in opts:
                        rows[key][name] = False
                else:
                    del rows[key]
        elif kind == 'AlterOwnerStmt' and not superuser:
            owner = stmt['newowner']['rolename']
            if not any(r == owner and m == DEPLOYER and o['set'] for (r, m, _), o in rows.items()):
                raise PermissionError('must be able to SET ROLE ' + owner)
        if trace is not None:
            trace.append((kind, {key: dict(value) for key, value in rows.items()}))
    return rows


def guard_accepts(rows):
    """Python mirror of the $acl_guard$ membership predicate (asserted textually elsewhere)."""
    if any(member == READER for (_, member, _) in rows):
        return False
    return all(member == DEPLOYER and grantor != DEPLOYER and o['admin'] and not o['inherit'] and not o['set']
               for (role, member, grantor), o in rows.items() if role == READER)


class ParticipantContextSQLTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.nodes = statements(SQL)
        cls.functions = {strings(f['funcname'])[-1]: f for f in walk(cls.nodes, 'CreateFunctionStmt')}

    def test_pg17_sql_and_all_four_plpgsql_units_parse_offline(self):
        self.assertEqual(get_postgresql_version()[0], 17)
        self.assertEqual(len(json.loads(parse_plpgsql_json(SQL))), 4)
        self.assertFalse(DRAFT.is_relative_to(ROOT / 'supabase/migrations'))
        self.assertEqual(self.nodes[0]['TransactionStmt']['kind'], 'TRANS_STMT_BEGIN')
        self.assertEqual(self.nodes[-1]['TransactionStmt']['kind'], 'TRANS_STMT_COMMIT')

    def test_ddl_is_additive_and_does_not_touch_legacy_functions_or_data(self):
        allowed = {'TransactionStmt', 'VariableSetStmt', 'DoStmt', 'CreateRoleStmt', 'GrantRoleStmt',
                   'GrantStmt', 'CreatePolicyStmt', 'CreateFunctionStmt', 'AlterOwnerStmt'}
        self.assertTrue(all(set(node) <= allowed for node in self.nodes))
        # ALTER DEFAULT PRIVILEGES FOR ROLE needs has_privs_of_role (INHERIT) in PG16+ and
        # would only affect objects the executor creates; it creates none.
        self.assertFalse(list(walk(self.nodes, 'AlterDefaultPrivilegesStmt')))
        self.assertEqual(set(self.functions), {SELF, MANAGEMENT})
        for function in self.functions.values():
            self.assertFalse(function.get('replace', False))
        owners = list(walk(self.nodes, 'AlterOwnerStmt'))
        self.assertEqual(len(owners), 2)
        for owner in owners:
            self.assertEqual(owner['objectType'], 'OBJECT_FUNCTION')
            self.assertEqual(owner['newowner']['rolename'], READER)
        # DO blocks must inspect catalogs only, not invoke application routines.
        for body in [SQL.split('$preflight$')[1], SQL.split('$acl_guard$')[1]]:
            self.assertNotRegex(body.lower(), r'\b(insert|update|delete|truncate|execute|perform|create|alter|drop)\s+(?!with\b)[a-z_]')

    def test_rpc_signatures_match_approved_client_and_have_scalar_json_returns(self):
        for name, function in self.functions.items():
            params = [p['FunctionParameter'] for p in function['parameters']]
            self.assertEqual([p['name'] for p in params], ['p_racha_id'] if name == SELF else ['p_racha_id', 'p_participante_ids'])
            self.assertTrue(all(strings(p['argType']['names']) == ['uuid'] for p in params))
            self.assertEqual(bool(params[-1]['argType'].get('arrayBounds')), name == MANAGEMENT)
            self.assertEqual(strings(function['returnType']['names']), ['jsonb'])
            self.assertFalse(function['returnType'].get('setof', False))
            self.assertTrue(all('defexpr' not in p for p in params))

    def test_security_definer_has_stable_snapshot_safe_path_and_rls_on(self):
        for function in self.functions.values():
            opts = options(function)
            self.assertEqual(opts['language']['String']['sval'], 'plpgsql')
            self.assertEqual(opts['volatility']['String']['sval'], 'stable')
            self.assertTrue(opts['security']['Boolean']['boolval'])
            settings = {v['name']: [a['A_Const']['sval']['sval'] for a in v['args']]
                        for v in walk(function, 'VariableSetStmt')}
            self.assertEqual(settings, {'search_path': ['pg_catalog', 'pg_temp'], 'row_security': ['on']})

    def test_current_membership_tenant_actor_and_role_are_conjoined(self):
        for name, function in self.functions.items():
            _, body, _ = pl_body(function)
            assert_membership(self, read_queries(body)[0], name == MANAGEMENT)

    def test_authorization_precedes_payload_and_empty_batch_return_and_fails_on_null(self):
        for function in self.functions.values():
            _, body, _ = pl_body(function)
            self.assertEqual(body[0]['PLpgSQL_stmt_assign']['expr']['PLpgSQL_expr']['query'].strip(), 'v_uid := auth.uid()')
            first_if = body[1]['PLpgSQL_stmt_if']
            self.assertEqual(first_if['cond']['PLpgSQL_expr']['query'], 'v_uid is null or p_racha_id is null')
            self.assertIn('PLpgSQL_stmt_raise', first_if['then_body'][0])
            self.assertIn('PLpgSQL_stmt_execsql', body[2])
            guard = body[3]['PLpgSQL_stmt_if']
            self.assertEqual(guard['cond']['PLpgSQL_expr']['query'], 'v_authorized is distinct from true')
            self.assertIn('PLpgSQL_stmt_raise', guard['then_body'][0])

    def test_self_lookup_scopes_profile_and_tenant_and_detects_duplicate_link(self):
        _, body, _ = pl_body(self.functions[SELF])
        query = read_queries(body)[1]['fromClause'][0]['RangeSubselect']['subquery']['SelectStmt']
        self.assertEqual(query['limitCount']['A_Const']['ival']['ival'], 2)
        self.assertEqual(column(query['targetList'][0]['ResTarget']['val']), ['p', 'id'])
        where = query['whereClause']['BoolExpr']
        self.assertEqual(where['boolop'], 'AND_EXPR')
        for expr, left, right in zip(where['args'], [['p', 'racha_id'], ['p', 'perfil_id']], [['p_racha_id'], ['v_uid']]):
            self.assertEqual(column(expr['A_Expr']['lexpr']), left)
            self.assertEqual(column(expr['A_Expr']['rexpr']), right)
            self.assertEqual(strings(expr['A_Expr']['name']), ['='])
        self.assertEqual(body[5]['PLpgSQL_stmt_if']['cond']['PLpgSQL_expr']['query'], 'v_count > 1')

    def test_batch_raw_limit_nulls_dimensions_and_empty_result_are_explicit(self):
        _, body, _ = pl_body(self.functions[MANAGEMENT])
        conds = [n['cond']['PLpgSQL_expr']['query'] for n in walk(body, 'PLpgSQL_stmt_if')]
        self.assertIn('p_participante_ids is null or pg_catalog.cardinality(p_participante_ids) > 100', conds)
        self.assertIn('pg_catalog.cardinality(p_participante_ids) = 0', conds)
        array_guard = conds[4]
        for expected in ['pg_catalog.array_ndims(p_participante_ids) <> 1',
                         'pg_catalog.array_lower(p_participante_ids, 1) <> 1']:
            self.assertIn(expected, array_guard)
        self.assertEqual(conds[5], 'pg_catalog.array_position(p_participante_ids, null) is not null')
        self.assertEqual(body[5]['PLpgSQL_stmt_if']['then_body'][0]['PLpgSQL_stmt_return']['expr']['PLpgSQL_expr']['query'], "'[]'::jsonb")

    def test_batch_matches_all_ids_in_one_tenant_and_rejects_missing_or_null_state(self):
        _, body, _ = pl_body(self.functions[MANAGEMENT])
        query = read_queries(body)[2]
        where = query['whereClause']['BoolExpr']
        self.assertEqual(where['boolop'], 'AND_EXPR')
        tenant, ids = [n['A_Expr'] for n in where['args']]
        self.assertEqual((column(tenant['lexpr']), column(tenant['rexpr'])), (['p', 'racha_id'], ['p_racha_id']))
        self.assertEqual(strings(tenant['name']), ['='])
        self.assertEqual(ids['kind'], 'AEXPR_OP_ANY')
        self.assertEqual((column(ids['lexpr']), column(ids['rexpr'])), (['p', 'id'], ['v_ids']))
        self.assertEqual(strings(ids['name']), ['='])
        check = body[-2]['PLpgSQL_stmt_if']
        self.assertEqual(check['cond']['PLpgSQL_expr']['query'], 'v_count <> pg_catalog.cardinality(v_ids) or v_valid is distinct from true')
        self.assertIn('PLpgSQL_stmt_raise', check['then_body'][0])

    def test_dedup_preserves_first_request_order_without_silent_truncation(self):
        _, body, _ = pl_body(self.functions[MANAGEMENT])
        dedup = read_queries(body)[1]
        nested = dedup['fromClause'][0]['RangeSubselect']['subquery']['SelectStmt']
        self.assertTrue(nested['fromClause'][0]['RangeFunction']['ordinality'])
        self.assertEqual(column(nested['groupClause'][0]), ['item', 'id'])
        functions = list(walk(dedup, 'FuncCall'))
        self.assertIn(['pg_catalog', 'min'], [strings(f['funcname']) for f in functions])
        self.assertTrue(functions[0]['agg_order'])
        self.assertFalse(list(walk(dedup, 'limitCount')))

    def test_json_allowlists_match_typescript_contract_and_never_expand_rows(self):
        ts = (ROOT / 'src/contracts/participant-context-v1.ts').read_text()
        for name, const in [(SELF, 'MY_PARTICIPANT_V1_FIELDS'), (MANAGEMENT, 'PARTICIPANT_MANAGEMENT_V1_FIELDS')]:
            _, _, parsed = pl_body(self.functions[name])
            builders = [f for expr in expressions(parsed) for f in walk(expr, 'FuncCall')
                        if strings(f['funcname']) == ['pg_catalog', 'jsonb_build_object']]
            self.assertEqual(len(builders), 1)
            keys = [arg['A_Const']['sval']['sval'] for arg in builders[0]['args'][::2]]
            ts_keys = re.findall(r"'([^']+)'", re.search(const + r' = \[(.*?)\]', ts).group(1))
            self.assertEqual(keys, ts_keys)
            self.assertNotRegex(options(self.functions[name])['as']['List']['items'][0]['String']['sval'],
                                r'\b(pontuacao|memoria|delta|config_estrelas|to_jsonb|row_to_json)\b|\w+\.\*')

    def test_function_bodies_only_read_and_call_allowlisted_functions(self):
        allowed_calls = {('auth', 'uid')} | {('pg_catalog', name) for name in
            ['count', 'bool_and', 'array_agg', 'jsonb_build_object', 'cardinality', 'array_ndims',
             'array_lower', 'array_position', 'unnest', 'min', 'jsonb_agg']}
        allowed_pl = {'PLpgSQL_stmt_block', 'PLpgSQL_stmt_assign', 'PLpgSQL_stmt_if',
                      'PLpgSQL_stmt_execsql', 'PLpgSQL_stmt_raise', 'PLpgSQL_stmt_return'}
        for function in self.functions.values():
            _, _, parsed = pl_body(function)
            for key in re.findall(r'"(PLpgSQL_stmt_\w+)"', json.dumps(parsed)):
                self.assertIn(key, allowed_pl)
            for expr in expressions(parsed):
                self.assertEqual(set(expr), {'SelectStmt'})
                self.assertFalse(list(walk(expr, 'lockingClause')))
                for call in walk(expr, 'FuncCall'):
                    self.assertIn(tuple(strings(call['funcname'])), allowed_calls)
                for relation in walk(expr, 'RangeVar'):
                    self.assertIn((relation['schemaname'], relation['relname']),
                                  {('public', 'participantes'), ('public', 'racha_membros')})

    def test_errors_are_fixed_literals_with_no_payload_details_or_sqlerrm(self):
        allowed = {"'42501'", "'22023'", "'P0001'", "'PARTICIPANT_CONTEXT_DENIED'",
                   "'PARTICIPANT_CONTEXT_UNAVAILABLE'", "'INVALID_PARTICIPANT_CONTEXT_REQUEST'"}
        for function in self.functions.values():
            source, _, parsed = pl_body(function)
            self.assertNotRegex(source.lower(), r'\b(sqlerrm|sqlstate|detail|hint|notice|log)\b')
            for raised in walk(parsed, 'PLpgSQL_stmt_raise'):
                for option in raised['options']:
                    self.assertIn(option['PLpgSQL_raise_option']['expr']['PLpgSQL_expr']['query'], allowed)

    def test_executor_is_nonlogin_nonbypass_and_has_no_memberships(self):
        role = next(walk(self.nodes, 'CreateRoleStmt'))
        self.assertEqual(role['role'], READER)
        flags = {item['DefElem']['defname']: item['DefElem']['arg']['Boolean']['boolval'] for item in role['options']}
        self.assertEqual(flags, dict.fromkeys(['canlogin', 'superuser', 'createdb', 'createrole', 'inherit', 'isreplication', 'bypassrls'], False))
        guard = SQL.split('$acl_guard$')[1]
        # Executor is a member of nothing; only the implicit PG16+ ADMIN row of the creator
        # (no INHERIT/SET, not self-granted) may name it as the granted role.
        self.assertIn('where am.member = v_reader', guard)
        for part in ['am.roleid = v_reader', 'am.member = v_creator', 'am.grantor <> v_creator',
                     'am.admin_option and not am.inherit_option and not am.set_option']:
            self.assertIn(part, guard)

    def test_pg17_creator_never_inherits_and_set_role_is_only_temporary(self):
        kinds = [next(iter(node)) for node in self.nodes]
        settings = {n['VariableSetStmt']['name']: (i, n['VariableSetStmt'])
                    for i, n in enumerate(self.nodes) if 'VariableSetStmt' in n}
        self_grant_at, self_grant = settings['createrole_self_grant']
        self.assertTrue(self_grant['is_local'])
        self.assertEqual([a['A_Const']['sval']['sval'] for a in self_grant['args']], [''])
        self.assertLess(self_grant_at, kinds.index('CreateRoleStmt'))
        role_stmts = [(i, n['GrantRoleStmt']) for i, n in enumerate(self.nodes) if 'GrantRoleStmt' in n]
        self.assertEqual(len(role_stmts), 2)
        (grant_at, grant), (revoke_at, revoke) = role_stmts
        for stmt in (grant, revoke):
            self.assertEqual([r['AccessPriv']['priv_name'] for r in stmt['granted_roles']], [READER])
            self.assertEqual([r['RoleSpec']['roletype'] for r in stmt['grantee_roles']], ['ROLESPEC_CURRENT_USER'])
            self.assertNotIn('grantor', stmt)
        self.assertTrue(grant['is_grant'])
        opts = {o['DefElem']['defname']: o['DefElem']['arg']['Boolean']['boolval'] for o in grant['opt']}
        self.assertEqual(opts, {'inherit': False, 'set': True})
        self.assertFalse(revoke.get('is_grant', False))
        self.assertNotIn('opt', revoke)  # full revoke of the temporary row, not just one option
        owners = [i for i, kind in enumerate(kinds) if kind == 'AlterOwnerStmt']
        self.assertTrue(grant_at < min(owners) and max(owners) < revoke_at)
        self.assertEqual(revoke_at, max(owners) + 1)

    def test_final_pg_auth_members_keeps_only_implicit_admin_row(self):
        # Structural evidence only: modelled PG17 rules over the draft's AST, no database.
        expected = {(READER, DEPLOYER, BOOTSTRAP): {'admin': True, 'inherit': False, 'set': False}}
        for session_value in ['', 'set, inherit']:  # session default is overridden by SET LOCAL
            final = simulate_memberships(self.nodes, superuser=False, session_self_grant=session_value)
            self.assertEqual(final, expected)
            self.assertTrue(guard_accepts(final))
        final = simulate_memberships(self.nodes, superuser=True)
        self.assertEqual(final, {})
        self.assertTrue(guard_accepts(final))

    def test_membership_model_rejects_wrong_revoke_or_missing_steps(self):
        temporary_revoke = 'revoke atos_participant_context_reader from current_user;'
        self.assertEqual(SQL.count(temporary_revoke), 1)
        # REVOKE SET OPTION FOR keeps an option-less self-granted row the guard must reject.
        option_only = statements(SQL.replace(temporary_revoke,
            'revoke set option for atos_participant_context_reader from current_user;'))
        residual = simulate_memberships(option_only, superuser=False)
        self.assertEqual(residual[(READER, DEPLOYER, DEPLOYER)], {'admin': False, 'inherit': False, 'set': False})
        self.assertFalse(guard_accepts(residual))
        # Forgetting the revoke leaves SET on the executor.
        self.assertFalse(guard_accepts(simulate_memberships(statements(SQL.replace(temporary_revoke, '')), superuser=False)))
        # Without the temporary SET grant the ownership transfer is refused.
        no_grant = statements(SQL.replace(
            'grant atos_participant_context_reader to current_user with inherit false, set true;', ''))
        with self.assertRaises(PermissionError):
            simulate_memberships(no_grant, superuser=False)
    def test_deployer_never_inherits_executor_during_the_transaction(self):
        def inherits(snapshot):
            return any(r == READER and m == DEPLOYER and o['inherit'] for (r, m, _), o in snapshot.items())

        def set_window(trace):
            return [kind for kind, snapshot in trace
                    if any(r == READER and m == DEPLOYER and o['set'] for (r, m, _), o in snapshot.items())]

        trace = []
        simulate_memberships(self.nodes, superuser=False, session_self_grant='set, inherit', trace=trace)
        self.assertFalse(any(inherits(snapshot) for _, snapshot in trace))
        # SET exists only from the temporary GRANT through both ownership transfers.
        self.assertEqual(set_window(trace), ['GrantRoleStmt', 'AlterOwnerStmt', 'AlterOwnerStmt'])
        # Without the SET LOCAL pin, an environment default would let the deployer inherit
        # the executor right after CREATE ROLE (final state alone would not reveal it).
        unpinned = [n for n in self.nodes
                    if n.get('VariableSetStmt', {}).get('name') != 'createrole_self_grant']
        trace = []
        simulate_memberships(unpinned, superuser=False, session_self_grant='set, inherit', trace=trace)
        self.assertTrue(inherits(next(snapshot for kind, snapshot in trace if kind == 'CreateRoleStmt')))

    def test_rpc_acl_is_set_while_deployer_still_owns_functions(self):
        kinds = [next(iter(node)) for node in self.nodes]
        first_owner = kinds.index('AlterOwnerStmt')
        function_acl = [i for i, n in enumerate(self.nodes)
                        if 'GrantStmt' in n and n['GrantStmt']['objtype'] == 'OBJECT_FUNCTION'
                        and strings(n['GrantStmt']['objects'][0]['ObjectWithArgs']['objname'])[0] == 'public']
        self.assertEqual(len(function_acl), 4)
        last_function = max(i for i, kind in enumerate(kinds) if kind == 'CreateFunctionStmt')
        self.assertTrue(all(last_function < i < first_owner for i in function_acl))

    def test_preflight_requires_deployer_privileges_without_assuming_superuser(self):
        preflight = SQL.split('$preflight$')[1]
        for part in ['r.rolcreaterole or r.rolsuper', 'PARTICIPANT_CONTEXT_REQUIRES_CREATEROLE',
                     "pg_has_role(current_user, c.relowner, 'USAGE')",
                     "has_schema_privilege(current_user, 'public', 'CREATE WITH GRANT OPTION')",
                     'PARTICIPANT_CONTEXT_REQUIRES_OBJECT_OWNER',
                     "to_regprocedure('auth.uid()') is null", "p.prorettype = 'uuid'::pg_catalog.regtype",
                     "has_schema_privilege(current_user, 'auth', 'USAGE WITH GRANT OPTION')",
                     "'EXECUTE WITH GRANT OPTION'", 'PARTICIPANT_CONTEXT_AUTH_GRANT_UNAVAILABLE',
                     "to_regrole('atos_participant_context_reader') is not null"]:
            self.assertIn(part, preflight)
        # Existence is checked in its own IF before privilege functions that would error.
        units = json.loads(parse_plpgsql_json(SQL))
        conds = [n['cond']['PLpgSQL_expr']['query'] for n in walk(units[0], 'PLpgSQL_stmt_if')]
        exists_at = next(i for i, c in enumerate(conds) if "to_regnamespace('auth') is null" in c)
        privs_at = next(i for i, c in enumerate(conds) if "'auth', 'USAGE WITH GRANT OPTION'" in c)
        self.assertLess(exists_at, privs_at)
        self.assertNotIn('USAGE WITH GRANT OPTION', conds[exists_at])

    def test_only_executor_gets_column_grants_and_policy_changes(self):
        table_grants = [g for g in walk(self.nodes, 'GrantStmt') if g['objtype'] == 'OBJECT_TABLE']
        self.assertEqual(len(table_grants), 2)
        expected = {'racha_membros': ['racha_id', 'perfil_id', 'papel'],
                    'participantes': ['id', 'racha_id', 'perfil_id', 'estrelas_travadas']}
        for grant in table_grants:
            self.assertTrue(grant['is_grant'])
            self.assertEqual([r['RoleSpec']['rolename'] for r in grant['grantees']], [READER])
            name = grant['objects'][0]['RangeVar']['relname']
            privilege = grant['privileges'][0]['AccessPriv']
            self.assertEqual(privilege['priv_name'], 'select')
            self.assertEqual(strings(privilege['cols']), expected[name])
        policies = list(walk(self.nodes, 'CreatePolicyStmt'))
        self.assertEqual(len(policies), 2)
        for policy in policies:
            self.assertEqual(policy['cmd_name'], 'select')
            self.assertEqual([r['RoleSpec']['rolename'] for r in policy['roles']], [READER])
            self.assertFalse(policy.get('with_check'))
            self.assertEqual(policy['qual']['BoolExpr']['boolop'], 'AND_EXPR')

    def test_rpc_acl_removes_defaults_and_grants_execute_only_to_authenticated(self):
        grants = [g for g in walk(self.nodes, 'GrantStmt') if g['objtype'] == 'OBJECT_FUNCTION']
        for name in [SELF, MANAGEMENT]:
            matching = [g for g in grants if strings(g['objects'][0]['ObjectWithArgs']['objname']) == ['public', name]]
            self.assertEqual(len(matching), 2)
            revoke, grant = matching
            self.assertFalse(revoke.get('is_grant', False))
            self.assertNotIn('privileges', revoke)
            self.assertEqual({r['RoleSpec'].get('rolename', 'PUBLIC') for r in revoke['grantees']},
                             {'PUBLIC', 'anon', 'authenticated', 'service_role'})
            self.assertTrue(grant['is_grant'])
            self.assertEqual(grant['privileges'], [{'AccessPriv': {'priv_name': 'execute'}}])
            self.assertEqual([r['RoleSpec']['rolename'] for r in grant['grantees']], ['authenticated'])
        self.assertIn("acl.grantee not in (v_reader, v_authenticated)", SQL)
        self.assertIn("has_function_privilege('anon', p.oid, 'EXECUTE')", SQL)
        self.assertIn("has_function_privilege('service_role', p.oid, 'EXECUTE')", SQL)

    def test_executor_rls_links_actor_and_same_tenant_without_legacy_helpers(self):
        policies = list(walk(self.nodes, 'CreatePolicyStmt'))
        for policy in policies:
            for call in walk(policy['qual'], 'FuncCall'):
                self.assertEqual(strings(call['funcname']), ['auth', 'uid'])
        participant = next(p for p in policies if p['table']['relname'] == 'participantes')
        query = next(walk(participant['qual'], 'SubLink'))['subselect']['SelectStmt']
        predicate = query['whereClause']['BoolExpr']
        self.assertEqual(predicate['boolop'], 'AND_EXPR')
        tenant, actor, role = predicate['args']
        self.assertEqual(column(tenant['A_Expr']['lexpr']), ['m', 'racha_id'])
        self.assertEqual(column(tenant['A_Expr']['rexpr']), ['participantes', 'racha_id'])
        self.assertEqual(column(actor['A_Expr']['lexpr']), ['m', 'perfil_id'])
        self.assertEqual(strings(actor['A_Expr']['rexpr']['FuncCall']['funcname']), ['auth', 'uid'])
        self.assertEqual(role['BoolExpr']['boolop'], 'OR_EXPR')
        admin, normal_self = role['BoolExpr']['args']
        self.assertEqual(admin['A_Expr']['rexpr']['TypeCast']['arg']['A_Const']['sval']['sval'], 'admin')
        self.assertEqual(normal_self['BoolExpr']['boolop'], 'AND_EXPR')
        self.assertEqual(column(normal_self['BoolExpr']['args'][1]['A_Expr']['lexpr']), ['participantes', 'perfil_id'])

    def test_effective_privilege_guard_checks_table_column_schema_and_grant_options(self):
        guard = SQL.split('$acl_guard$')[1]
        for part in ['c.relowner = v_reader', "has_schema_privilege(v_reader, 'public', 'CREATE')",
                     'has_column_privilege', 'has_table_privilege', 'SELECT WITH GRANT OPTION',
                     'EXECUTE WITH GRANT OPTION', 'rolbypassrls', 'MAINTAIN']:
            self.assertIn(part, guard)
        grants = [(i, n['GrantStmt']) for i, n in enumerate(self.nodes) if 'GrantStmt' in n
                  and n['GrantStmt']['objtype'] == 'OBJECT_SCHEMA'
                  and n['GrantStmt'].get('privileges') == [{'AccessPriv': {'priv_name': 'create'}}]]
        self.assertEqual([g.get('is_grant', False) for _, g in grants], [True, False])
        owners = [i for i, n in enumerate(self.nodes) if 'AlterOwnerStmt' in n]
        self.assertTrue(grants[0][0] < min(owners) and max(owners) < grants[1][0])

    def test_schema_and_name_collision_guards_are_present_without_silent_replacement(self):
        preflight = SQL.split('$preflight$')[1]
        for part in ['c.relrowsecurity', 'a.atttypid = pg_catalog.to_regtype',
                     'a.attnotnull', "c.contype = 'p'", 'not c.condeferrable',
                     'c.conkey @> array[tenant.attnum, actor.attnum]', 'PARTICIPANT_CONTEXT_NAME_COLLISION']:
            self.assertIn(part, preflight)
        self.assertNotRegex(SQL.lower(), r'\bcreate\s+or\s+replace\b|\bif\s+not\s+exists\s+public\.')

    def test_mutating_tenant_or_role_predicates_is_detected_by_structural_checks(self):
        for name, function in self.functions.items():
            _, body, _ = pl_body(function)
            query = read_queries(body)[0]
            changed = json.loads(json.dumps(query))
            changed['whereClause']['BoolExpr']['boolop'] = 'OR_EXPR'
            with self.assertRaises(AssertionError):
                assert_membership(self, changed, name == MANAGEMENT)
            changed = json.loads(json.dumps(query))
            changed['whereClause']['BoolExpr']['args'][0]['A_Expr']['rexpr']['ColumnRef']['fields'][0]['String']['sval'] = 'v_uid'
            with self.assertRaises(AssertionError):
                assert_membership(self, changed, name == MANAGEMENT)


if __name__ == '__main__':
    unittest.main()
