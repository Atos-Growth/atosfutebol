"""Offline tests of the prepared probe: never proof of actual database RLS."""
import unittest
from unittest.mock import patch
from authorization_v1 import ACTORS, ENDPOINT, FIELDS, ProbeFailure, run_suite


def synthetic_fixture():
    def uid(n):
        return f'00000000-0000-4000-8000-{n:012d}'
    return {'tenants': {'A': {'racha_id': uid(1), 'participant_id': uid(2)},
                        'B': {'racha_id': uid(3), 'participant_id': uid(4)}},
            'actors': {actor: {'user_id': uid(i + 10)} for i, actor in enumerate(ACTORS)}}


def mock_transport(fixture, fault=None):
    def get(actor, path, params):
        if fault:
            response = fault(actor, path, params)
            if response is not None:
                return response
        if path == '/auth/v1/user':
            return 200, {'id': fixture['actors'][actor]['user_id']}
        if path == '/rest/v1/racha_membros':
            return 200, [{'racha_id': fixture['tenants'][t]['racha_id'], 'papel': role}
                         for t, role in ACTORS[actor].items()]
        if path == ENDPOINT:
            if 'racha_id' not in params:
                return 400, {'code': '42703'}
            tenant = next(t for t in ('A', 'B') if params['racha_id'] == 'eq.' + fixture['tenants'][t]['racha_id'])
            if ACTORS[actor].get(tenant) not in ('admin', 'normal'):
                return 200, []
            target = fixture['tenants'][tenant]
            return 200, [dict(zip(FIELDS, [target['participant_id'], target['racha_id'],
                'Synthetic fixture', None, None, 'goleiro', True, 3]))]
        raise AssertionError('Unexpected endpoint')
    return get


class AuthorizationProbeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = synthetic_fixture()
        self.network = patch('urllib.request.OpenerDirector.open', side_effect=AssertionError('NO NETWORK'))
        self.network.start()
        self.addCleanup(self.network.stop)

    def test_matrix_has_positive_controls_and_eight_personas_two_tenants(self):
        results = run_suite(mock_transport(self.fixture), self.fixture)
        self.assertEqual(len(results), 96)
        for actor in ACTORS:
            for tenant in ('A', 'B'):
                self.assertIn(f'{actor}:{tenant}:read:True', results)

    def assert_probe_fails(self, fault):
        with self.assertRaises(ProbeFailure):
            run_suite(mock_transport(self.fixture, fault), self.fixture)

    def test_invalid_token_cannot_pass_negative_checks(self):
        self.assert_probe_fails(lambda a, p, q: (401, {}) if p == '/auth/v1/user' else None)

    def test_fake_admin_label_is_rejected_by_membership_control(self):
        self.assert_probe_fails(lambda a, p, q: (200, []) if a == 'admin_A' and p.endswith('racha_membros') else None)

    def test_missing_fixture_or_5xx_is_not_success(self):
        for response in ((200, []), (503, {})):
            with self.subTest(response=response):
                self.assert_probe_fails(lambda a, p, q: response if a == 'member_A' and p == ENDPOINT and q.get('racha_id') == 'eq.' + self.fixture['tenants']['A']['racha_id'] else None)

    def test_cross_tenant_pending_and_removed_leaks_fail(self):
        for actor in ('member_A', 'admin_A', 'pending_A', 'removed_A', 'unrelated'):
            with self.subTest(actor=actor):
                self.assert_probe_fails(lambda a, p, q: (200, [{'id': 'leak'}]) if a == actor and p == ENDPOINT and q.get('racha_id') == 'eq.' + self.fixture['tenants']['B']['racha_id'] else None)

    def test_private_keys_even_on_positive_admin_response_fail(self):
        original = mock_transport(self.fixture)
        def fault(a, p, q):
            if a == 'admin_A' and p == ENDPOINT and q.get('racha_id') == 'eq.' + self.fixture['tenants']['A']['racha_id']:
                status, body = original(a, p, q)
                body[0]['memoria'] = {'synthetic': 941}
                return status, body
        self.assert_probe_fails(fault)

    def test_private_filter_success_empty_or_server_failure_is_not_denial(self):
        for response in ((200, []), (500, {}), (401, {}), (400, {'code': 'PGRST100'})):
            with self.subTest(response=response):
                self.assert_probe_fails(lambda a, p, q: response if p == ENDPOINT and 'racha_id' not in q else None)

    def test_transport_failure_is_not_a_pass(self):
        def unavailable(a, p, q):
            raise TimeoutError('synthetic')
        with self.assertRaises(TimeoutError):
            run_suite(unavailable, self.fixture)


if __name__ == '__main__':
    unittest.main()
