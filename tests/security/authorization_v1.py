"""Prepared GET-only homologation suite. Import/unit testing never contacts a server.

CLI requires separate explicit authorization. No business RPC, mutation or SQL.
Legacy endpoints are deliberately NOT certified by this suite.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIELDS = ('id', 'racha_id', 'nome', 'apelido', 'foto_url', 'posicao', 'ativo', 'estrelas')
ACTORS = {
    'member_A': {'A': 'normal'}, 'admin_A': {'A': 'admin'},
    'member_B': {'B': 'normal'}, 'admin_B': {'B': 'admin'},
    'pending_A': {'A': 'pendente'}, 'removed_A': {}, 'unrelated': {},
    'admin_AB': {'A': 'admin', 'B': 'admin'},
}
ENDPOINT = '/rest/v1/participantes_publicos_v1'


class ProbeFailure(Exception):
    """Only a fixed case identifier may be reported; never a response body."""


def validate_fixture(fixture):
    if set(fixture['tenants']) != {'A', 'B'} or set(fixture['actors']) != set(ACTORS):
        raise ValueError('INVALID_SYNTHETIC_FIXTURE')
    ids = [fixture['tenants'][t][k] for t in ('A', 'B') for k in ('racha_id', 'participant_id')]
    ids += [fixture['actors'][a]['user_id'] for a in ACTORS]
    if len(set(ids)) != len(ids) or any(str(uuid.UUID(x)) != x for x in ids):
        raise ValueError('INVALID_SYNTHETIC_FIXTURE')


def run_suite(get, fixture):
    """get(actor, path, params) -> (status, JSON); injectable for OFFLINE tests."""
    validate_fixture(fixture)
    passed = []

    def require(condition, case):
        if not condition:
            raise ProbeFailure(case)
        passed.append(case)

    # Positive authentication and actual persisted role controls precede negatives.
    for actor, memberships in ACTORS.items():
        user_id = fixture['actors'][actor]['user_id']
        status, body = get(actor, '/auth/v1/user', {})
        require(status == 200 and isinstance(body, dict) and body.get('id') == user_id,
                f'{actor}:auth-control')
        status, body = get(actor, '/rest/v1/racha_membros', {
            'select': 'racha_id,papel', 'perfil_id': f'eq.{user_id}'})
        expected = {(fixture['tenants'][t]['racha_id'], role) for t, role in memberships.items()}
        valid = status == 200 and isinstance(body, list) and all(isinstance(x, dict) for x in body)
        actual = {(x.get('racha_id'), x.get('papel')) for x in body} if valid else None
        require(valid and actual == expected, f'{actor}:membership-control')

    for actor, memberships in ACTORS.items():
        for tenant in ('A', 'B'):
            target = fixture['tenants'][tenant]
            filters = {'racha_id': f"eq.{target['racha_id']}", 'id': f"eq.{target['participant_id']}"}
            for selection in (','.join(FIELDS), '*'):
                status, body = get(actor, ENDPOINT, {**filters, 'select': selection})
                allowed = memberships.get(tenant) in ('normal', 'admin')
                if allowed:
                    valid = (status == 200 and isinstance(body, list) and len(body) == 1
                             and isinstance(body[0], dict) and set(body[0]) == set(FIELDS)
                             and body[0]['id'] == target['participant_id']
                             and body[0]['racha_id'] == target['racha_id'])
                else:
                    valid = status == 200 and body == []
                require(valid, f'{actor}:{tenant}:read:{selection == "*"}')
        for query in ({'select': 'pontuacao'}, {'select': 'alias:delta'},
                      {'select': 'memoria->private_canary'}, {'select': 'config_estrelas'},
                      {'select': 'id', 'pontuacao': 'eq.0'}, {'select': 'id', 'order': 'delta'}):
            status, body = get(actor, ENDPOINT, query)
            denied = (isinstance(body, dict) and (
                (status == 400 and body.get('code') in ('42703', '42501')) or
                (status == 403 and body.get('code') == '42501')))
            require(denied, f'{actor}:private:{len(passed)}')
    return passed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', required=True, help='External synthetic fixture; NO tokens')
    parser.add_argument('--allow-host', required=True)
    parser.add_argument('--homologation-authorized', required=True, action='store_true')
    parser.add_argument('--authorization-reference', required=True, help='Separate approval reference; not a credential')
    args = parser.parse_args()
    fixture = json.loads(Path(args.fixture).read_text())
    validate_fixture(fixture)
    base = os.environ['ATOS_TEST_URL'].rstrip('/')
    url = urllib.parse.urlsplit(base)
    if (url.scheme != 'https' or url.hostname != args.allow_host or url.port not in (None, 443)
            or url.username or url.password or url.path or url.query or url.fragment
            or fixture.get('environment') != 'homologation'
            or fixture.get('host') != args.allow_host or not args.authorization_reference.strip()):
        raise ValueError('HOMOLOGATION_TARGET_NOT_AUTHORIZED')
    # Reuse existing credential rejection and redirect protections; no old main().
    spec = importlib.util.spec_from_file_location('existing_probe', ROOT / 'docs/security/tests/probe_private_reads.py')
    existing = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(existing)
    api_key = os.environ['ATOS_TEST_API_KEY']
    existing.reject_service_token(api_key)
    tokens = {actor: os.environ['ATOS_TEST_' + actor.upper() + '_TOKEN'] for actor in ACTORS}
    for token in tokens.values():
        existing.reject_service_token(token)
    opener = urllib.request.build_opener(existing.NoRedirect())

    def get(actor, path, params):
        request = urllib.request.Request(base + path + ('?' + urllib.parse.urlencode(params) if params else ''),
            headers={'apikey': api_key, 'Authorization': 'Bearer ' + tokens[actor], 'Accept': 'application/json'},
            method='GET')
        try:
            response = opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ProbeFailure('response-size-limit')
            return response.status, json.loads(raw)

    results = run_suite(get, fixture)
    print(json.dumps({'scope': 'participants-view-v1-only', 'passed': len(results), 'cases': results}))


if __name__ == '__main__':
    try:
        main()
    except ProbeFailure as error:
        print(json.dumps({'status': 'FAIL', 'case': str(error)}))
        raise SystemExit(1) from None
    except Exception:
        # No exception repr/traceback: HTTP errors can contain sensitive details.
        print('{"status":"BLOCKED","reason":"configuration-or-transport"}')
        raise SystemExit(2) from None
