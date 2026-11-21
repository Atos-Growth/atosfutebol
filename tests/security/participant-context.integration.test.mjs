// Real SDK, synthetic actors, intercepted HTTP only. These are NOT RLS tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

globalThis.fetch = async () => { throw new Error('NETWORK_DISABLED_IN_OFFLINE_SUITE') }
const { createClient } = await import(pathToFileURL(process.env.ATOS_SUPABASE_SDK).href)
const compiled = (path) => import(pathToFileURL(`${process.env.ATOS_CONTEXT_OUT}/${path}.js`).href)
const api = await compiled('src/data/participant-context-reader-v1')
const contract = await compiled('src/contracts/participant-context-v1')
const adapters = await compiled('src/adapters/participant-list-v1')
const publicContract = await compiled('src/contracts/public-read-v1')
const { ParticipantsReadError } = await compiled('src/data/participants-reader-v1')
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = uuid(1), B = uuid(2), P = uuid(10), Q = uuid(11)
const self = (tenant = A, id = P) => ({ racha_id: tenant, participante_id: id })
const management = (id = P, tenant = A, state = 'automatico') => ({ ...self(tenant, id), nivel_estado: state })
const participant = (id = P, tenant = A) => ({ id, racha_id: tenant, nome: 'Synthetic player', apelido: null,
  foto_url: null, posicao: 'meio', ativo: true, estrelas: 3 })
const SELF_PATH = '/rest/v1/rpc/obter_meu_participante_v1'
const MANAGEMENT_PATH = '/rest/v1/rpc/obter_gestao_participantes_v1'
const SELF_V2_PATH = '/rest/v1/rpc/obter_meu_participante_v2'
const selfV2 = (tenant = A, id = P, state = id === null ? null : 'automatico') => ({ ...self(tenant, id), nivel_estado: state })
const actors = {
  memberA: 'synthetic-member-A', memberB: 'synthetic-member-B',
  adminA: 'synthetic-admin-A', adminB: 'synthetic-admin-B',
  pendingA: 'synthetic-pending-A', outsider: 'synthetic-outsider',
}
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})
function fixture(handler, actor = actors.memberA) {
  const requests = []
  const client = createClient('https://p0-offline-fixture.invalid', 'synthetic-public-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => actor,
    global: { fetch: async (input, init) => {
      const request = { url: new URL(String(input)), method: init.method, headers: new Headers(init.headers) }
      requests.push(request) // record even unexpected requests: SDK may catch fetch errors
      assert.equal(request.url.host, 'p0-offline-fixture.invalid')
      assert.ok([SELF_PATH, MANAGEMENT_PATH, SELF_V2_PATH].includes(request.url.pathname))
      assert.equal(init.method, 'GET')
      return handler(request, requests.length)
    } },
  })
  return { client, requests }
}
function onlyRpc(requests, path, actor) {
  assert.ok(requests.length > 0)
  for (const request of requests) {
    assert.equal(request.url.pathname, path)
    assert.equal(request.method, 'GET')
    assert.equal(request.headers.get('authorization'), `Bearer ${actor}`)
  }
}
const errorCode = code => error => error instanceof ParticipantsReadError && error.code === code
const loadManagement = (client, rachaId = A, participantIds = [P]) => api.loadParticipantManagementV1(client, { rachaId, participantIds })

test('self contract accepts explicit linked/unlinked results and freezes only its two fields', () => {
  for (const id of [P, null]) {
    const value = contract.parseMyParticipantV1(self(A, id), A)
    assert.deepEqual(value, self(A, id))
    assert.ok(Object.isFrozen(value))
  }
})

test('self contract rejects private/profile/management fields, malformed shapes and foreign tenants', () => {
  for (const value of [null, [], [self()], {}, { ...self(), participante_id: 0 }, self(B),
    ...['perfil_id', 'pontuacao', 'memoria', 'delta', 'calibracao', 'configuracao', 'estrelas_travadas', 'nivel_estado']
      .map(key => ({ ...self(), [key]: 'CONFIDENTIAL_CANARY' }))]) {
    assert.throws(() => contract.parseMyParticipantV1(value, A), contract.ParticipantContextContractError)
  }
})

test('contracts reject accessors, prototypes and symbol extras without invoking getters', () => {
  let invoked = false
  const getter = { racha_id: A, get participante_id() { invoked = true; return P } }
  for (const value of [getter, Object.assign(Object.create({ extra: true }), self()), { ...self(), [Symbol('extra')]: true }]) {
    assert.throws(() => contract.parseMyParticipantV1(value, A), contract.ParticipantContextContractError)
  }
  assert.equal(invoked, false)
})

test('management contract has exactly two states and no calculations or raw configuration', () => {
  for (const state of ['automatico', 'congelado']) {
    const value = contract.parseParticipantManagementV1(management(P, A, state), A)
    assert.deepEqual(value, management(P, A, state))
    assert.ok(Object.isFrozen(value))
  }
  for (const value of [management(P, B), ...[null, false, 0, 'unknown', {}].map(state => management(P, A, state)),
    ...['perfil_id', 'pontuacao', 'memoria', 'delta', 'calibracao', 'configuracao', 'estrelas_travadas']
      .map(key => ({ ...management(), [key]: 'CONFIDENTIAL_CANARY' }))]) {
    assert.throws(() => contract.parseParticipantManagementV1(value, A), contract.ParticipantContextContractError)
  }
})

test('common list adapter preserves public allowlist and uses self ID without exposing profile or management state', () => {
  const item = adapters.toParticipantListItemV1(participant(), self())
  assert.deepEqual(item, { participant: participant(), isSelf: true })
  assert.deepEqual(Object.keys(item.participant), [...publicContract.PARTICIPANT_PUBLIC_V1_FIELDS])
  assert.deepEqual(Object.keys(item), ['participant', 'isSelf'])
  assert.ok(Object.isFrozen(item) && Object.isFrozen(item.participant))
  assert.equal(adapters.toParticipantListItemV1(participant(), self(A, Q)).isSelf, false)
  assert.equal(adapters.toParticipantListItemV1(participant(), self(A, null)).isSelf, false)
  for (const context of [null, self(B), { ...self(), perfil_id: P }]) {
    assert.throws(() => adapters.toParticipantListItemV1(participant(), context))
  }
  assert.throws(() => adapters.toParticipantListItemV1({ ...participant(), estrelas_travadas: true }, self()))
})

test('management adapter requires matching tenant and participant with no default state on missing data', () => {
  assert.deepEqual(adapters.toManagedParticipantListItemV1(participant(), self(), management()), {
    participant: participant(), isSelf: true, nivelEstado: 'automatico',
  })
  for (const context of [null, {}, management(P, B), management(Q), { ...management(), delta: 1 }]) {
    assert.throws(() => adapters.toManagedParticipantListItemV1(participant(), self(), context))
  }
})

test('self SDK request uses only tenant parameter and the actual supplied session context', async () => {
  for (const [tenant, actor] of [[A, actors.memberA], [B, actors.memberB]]) {
    const { client, requests } = fixture(({ url }) => {
      assert.deepEqual([...url.searchParams.entries()], [['p_racha_id', tenant]])
      return response(self(tenant))
    }, actor)
    assert.deepEqual(await api.loadMyParticipantV1(client, { rachaId: tenant }), self(tenant))
    assert.equal(requests.length, 1)
    onlyRpc(requests, SELF_PATH, actor)
  }
})

test('self v2 contract carries only the caller own level state, consistent with the link', () => {
  for (const value of [selfV2(A, P, 'automatico'), selfV2(A, P, 'congelado'), selfV2(A, null, null)]) {
    const parsed = contract.parseMyParticipantV2(value, A)
    assert.deepEqual(parsed, value)
    assert.ok(Object.isFrozen(parsed))
  }
  for (const value of [selfV2(A, P, null), selfV2(A, null, 'automatico'), selfV2(A, P, 'travado'), selfV2(B),
    self(), { ...selfV2(), perfil_id: 'CONFIDENTIAL_CANARY' }, { ...selfV2(), estrelas_travadas: true }, null, []]) {
    assert.throws(() => contract.parseMyParticipantV2(value, A), contract.ParticipantContextContractError)
  }
})

test('self v2 SDK request sends only the tenant; denial and malformed bodies never become unlinked', async () => {
  const { client, requests } = fixture(({ url }) => {
    assert.deepEqual([...url.searchParams.entries()], [['p_racha_id', A]])
    return response(selfV2(A, P, 'congelado'))
  })
  assert.deepEqual(await api.loadMyParticipantV2(client, { rachaId: A }), selfV2(A, P, 'congelado'))
  onlyRpc(requests, SELF_V2_PATH, actors.memberA)
  const unlinked = fixture(() => response(selfV2(A, null, null)))
  assert.deepEqual(await api.loadMyParticipantV2(unlinked.client, { rachaId: A }), selfV2(A, null, null))
  for (const [body, status] of [[{ message: 'PARTICIPANT_CONTEXT_DENIED' }, 403], [null, 200], [selfV2(A, null, 'congelado'), 200]]) {
    const denied = fixture(() => response(body, status))
    await assert.rejects(api.loadMyParticipantV2(denied.client, { rachaId: A }),
      errorCode(status === 200 ? 'INVALID_RESPONSE' : 'READ_FAILED'))
  }
  await assert.rejects(api.loadMyParticipantV2(client, { rachaId: 'bad' }), errorCode('INVALID_REQUEST'))
})

test('explicit authorized unlinked response is distinct from null envelope or HTTP denial', async () => {
  const allowed = fixture(() => response(self(A, null)))
  assert.deepEqual(await api.loadMyParticipantV1(allowed.client, { rachaId: A }), self(A, null))
  for (const body of [null, [], [self()], {}, self(B), { ...self(), memoria: 1 }]) {
    const { client, requests } = fixture(() => response(body))
    await assert.rejects(api.loadMyParticipantV1(client, { rachaId: A }), errorCode('INVALID_RESPONSE'))
    assert.equal(requests.length, 1)
    onlyRpc(requests, SELF_PATH, actors.memberA)
  }
})

test('management SDK lookup deduplicates IDs, returns input order and never sends a role/profile claim', async () => {
  const { client, requests } = fixture(({ url }) => {
    assert.deepEqual([...url.searchParams.keys()].sort(), ['p_participante_ids', 'p_racha_id'])
    assert.equal(url.searchParams.get('p_racha_id'), A)
    assert.equal(url.searchParams.get('p_participante_ids'), `{${Q},${P}}`)
    return response([management(P), management(Q, A, 'congelado')])
  }, actors.adminA)
  const result = await loadManagement(client, A, [Q, P, Q])
  assert.deepEqual(result, [management(Q, A, 'congelado'), management(P)])
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result[0]))
  assert.equal(requests.length, 1)
  onlyRpc(requests, MANAGEMENT_PATH, actors.adminA)
})

test('ID batches are bounded at 100; invalid requests and empty batches never issue broad queries', async () => {
  const { client, requests } = fixture(() => { throw new Error('must not send') })
  for (const participantIds of [Array.from({ length: 101 }, (_, i) => uuid(i + 10)), ['id),or=(true)'], null]) {
    await assert.rejects(loadManagement(client, A, participantIds), errorCode('INVALID_REQUEST'))
  }
  await assert.rejects(loadManagement(client, 'bad', []), errorCode('INVALID_REQUEST'))
  await assert.rejects(api.loadMyParticipantV1(client, { rachaId: 'bad' }), errorCode('INVALID_REQUEST'))
  assert.deepEqual(await loadManagement(client, A, []), [])
  assert.equal(requests.length, 0)
  const ids = Array.from({ length: 100 }, (_, i) => uuid(i + 10))
  const maximum = fixture(() => response(ids.map(id => management(id))), actors.adminA)
  assert.equal((await loadManagement(maximum.client, A, ids)).length, 100)
  assert.equal(maximum.requests.length, 1)
})

test('missing, duplicate, unrequested, cross-tenant and private management rows fail the entire lookup', async () => {
  for (const body of [null, {}, [], [management(P)], [management(P), management(P)],
    [management(P), management(uuid(12))], [management(P), management(Q, B)],
    [management(P), { ...management(Q), pontuacao: 1 }],
    [management(P), management(Q), management(uuid(12))]]) {
    const { client, requests } = fixture(() => response(body), actors.adminA)
    await assert.rejects(loadManagement(client, A, [P, Q]), errorCode('INVALID_RESPONSE'))
    assert.equal(requests.length, 1)
    onlyRpc(requests, MANAGEMENT_PATH, actors.adminA)
  }
})

test('simulated authorization denies members, pending users, outsiders and opposite-tenant admins', async () => {
  for (const tenant of [A, B]) {
    const authorized = tenant === A ? actors.adminA : actors.adminB
    for (const actor of Object.values(actors)) {
      const { client, requests } = fixture(({ headers, url }) => {
        const permitted = headers.get('authorization') === `Bearer ${authorized}` && url.searchParams.get('p_racha_id') === tenant
        return permitted ? response([management(P, tenant)]) : response({ code: '42501' }, 403)
      }, actor)
      if (actor === authorized) assert.deepEqual(await loadManagement(client, tenant), [management(P, tenant)])
      else await assert.rejects(loadManagement(client, tenant), errorCode('READ_FAILED'))
      assert.equal(requests.length, 1)
      onlyRpc(requests, MANAGEMENT_PATH, actor)
    }
  }
})

test('simulated self authorization checks current membership instead of accepting a requested tenant', async () => {
  for (const actor of Object.values(actors)) {
    const { client, requests } = fixture(({ headers, url }) => {
      const allowed = [actors.memberA, actors.adminA].some(value => headers.get('authorization') === `Bearer ${value}`)
        && url.searchParams.get('p_racha_id') === A
      return allowed ? response(self()) : response({ code: '42501' }, 403)
    }, actor)
    if ([actors.memberA, actors.adminA].includes(actor)) await api.loadMyParticipantV1(client, { rachaId: A })
    else await assert.rejects(api.loadMyParticipantV1(client, { rachaId: A }), errorCode('READ_FAILED'))
    assert.equal(requests.length, 1)
    onlyRpc(requests, SELF_PATH, actor)
  }
})

test('simulated revocation fails the next read, with no cached data, default state or raw-table fallback', async () => {
  for (const managed of [false, true]) {
    const actor = managed ? actors.adminA : actors.memberA
    const { client, requests } = fixture((request, call) => call === 1
      ? response(managed ? [management()] : self()) : response({ code: '42501' }, 403), actor)
    const read = () => managed ? loadManagement(client) : api.loadMyParticipantV1(client, { rachaId: A })
    await read()
    await assert.rejects(read(), errorCode('READ_FAILED'))
    assert.equal(requests.length, 2)
    onlyRpc(requests, managed ? MANAGEMENT_PATH : SELF_PATH, actor)
  }
})

test('401, 403, absent RPC and server errors are sanitized for both contracts, without fallback', async () => {
  for (const managed of [false, true]) {
    for (const status of [401, 403, 404, 500]) {
      const { client, requests } = fixture(() => response({ code: 'synthetic', message: 'CONFIDENTIAL_CANARY', details: 'private' }, status))
      const call = managed ? loadManagement(client) : api.loadMyParticipantV1(client, { rachaId: A })
      await assert.rejects(call, error => {
        assert.ok(errorCode('READ_FAILED')(error))
        assert.equal(`${error.stack}${JSON.stringify(error)}`.includes('CONFIDENTIAL_CANARY'), false)
        assert.equal(error.cause, undefined)
        return true
      })
      assert.equal(requests.length, 1)
      onlyRpc(requests, managed ? MANAGEMENT_PATH : SELF_PATH, actors.memberA)
    }
  }
})

test('transport exceptions are sanitized; any SDK retries stay on the same safe RPC', async () => {
  for (const managed of [false, true]) {
    const { client, requests } = fixture(() => { throw new Error('CONFIDENTIAL_CANARY') })
    await assert.rejects(managed ? loadManagement(client) : api.loadMyParticipantV1(client, { rachaId: A }), errorCode('READ_FAILED'))
    onlyRpc(requests, managed ? MANAGEMENT_PATH : SELF_PATH, actors.memberA)
  }
})

test('cancellation before HTTP or during a response prevents stale context for either endpoint', async () => {
  for (const managed of [false, true]) {
    const cancelled = new AbortController()
    cancelled.abort()
    const first = fixture(() => { throw new Error('must not send') })
    const read = (client, signal) => managed
      ? api.loadParticipantManagementV1(client, { rachaId: A, participantIds: [P], signal })
      : api.loadMyParticipantV1(client, { rachaId: A, signal })
    await assert.rejects(read(first.client, cancelled.signal), errorCode('CANCELLED'))
    assert.equal(first.requests.length, 0)
    const pending = new AbortController()
    const second = fixture(() => { pending.abort(); return response(managed ? [management()] : self()) })
    await assert.rejects(read(second.client, pending.signal), errorCode('CANCELLED'))
    assert.equal(second.requests.length, 1)
    onlyRpc(second.requests, managed ? MANAGEMENT_PATH : SELF_PATH, actors.memberA)
  }
})
