// Real Supabase/PostgREST query builder, intercepted HTTP. NO backend or RLS proof.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

globalThis.fetch = async () => { throw new Error('NETWORK_DISABLED_IN_OFFLINE_SUITE') }
const { createClient } = await import(pathToFileURL(process.env.ATOS_SUPABASE_SDK).href)
const api = await import(pathToFileURL(process.env.ATOS_COMPILED_READER).href)
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = uuid(1), B = uuid(2)
const row = (n, tenant = A) => ({ id: uuid(n), racha_id: tenant, nome: `Fixture ${n}`, apelido: null,
  foto_url: null, posicao: 'meio', ativo: true, estrelas: 3 })
const SELECT = 'id,racha_id,nome,apelido,foto_url,posicao,ativo,estrelas'

function response(body, count = null, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json', ...(count === null ? {} : { 'content-range': `0-0/${count}` }),
  } })
}
function fixture(handler) {
  const requests = []
  const client = createClient('https://p0-offline-fixture.invalid', 'synthetic-public-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => 'synthetic-user-session',
    global: { fetch: async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.host, 'p0-offline-fixture.invalid')
      assert.equal(url.pathname, '/rest/v1/participantes_publicos_v1')
      assert.equal(init.method, 'GET')
      assert.equal(url.searchParams.get('select'), SELECT)
      requests.push({ url, headers: new Headers(init.headers) })
      return handler(url, init, requests.length)
    } },
  })
  return { client, requests }
}
const errorCode = (code) => (error) => error instanceof api.ParticipantsReadError && error.code === code

test('SDK selects only the safe view, allowlist and requested tenant', async () => {
  const { client, requests } = fixture((url) => {
    assert.equal(url.searchParams.get('racha_id'), `eq.${A}`)
    assert.equal(url.searchParams.get('order'), 'id.asc')
    assert.equal(url.searchParams.get('limit'), '50')
    return response([row(10)], 1)
  })
  const page = await api.loadParticipantsPageV1(client, { rachaId: A })
  assert.deepEqual(page, { items: [row(10)], nextCursor: null })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].headers.get('prefer'), 'count=exact')
  assert.ok(Object.isFrozen(page) && Object.isFrozen(page.items) && Object.isFrozen(page.items[0]))
})

test('keyset cursor stays tenant-bound and continues when server caps a page', async () => {
  const { client } = fixture((url, init, call) => {
    if (call === 1) return response([row(10)], 3) // requested 50, server returned 1
    assert.equal(url.searchParams.get('id'), `gt.${uuid(10)}`)
    return response([row(11), row(12)], 2)
  })
  const first = await api.loadParticipantsPageV1(client, { rachaId: A })
  assert.deepEqual(first.nextCursor, { rachaId: A, afterId: uuid(10) })
  const second = await api.loadParticipantsPageV1(client, { rachaId: A, cursor: first.nextCursor })
  assert.equal(second.nextCursor, null)
  assert.deepEqual(second.items.map(p => p.id), [uuid(11), uuid(12)])
})

test('invalid ID, query injection, page size and cross-tenant cursor never send HTTP', async () => {
  const { client, requests } = fixture(() => { throw new Error('must not send') })
  for (const request of [{ rachaId: 'id),or=(true)' }, { rachaId: A, pageSize: 0 },
    { rachaId: A, pageSize: 101 }, { rachaId: A, pageSize: 1.5 },
    { rachaId: A, cursor: { rachaId: B, afterId: uuid(10) } }]) {
    await assert.rejects(api.loadParticipantsPageV1(client, request), errorCode('INVALID_REQUEST'))
  }
  assert.equal(requests.length, 0)
})

test('private fields, mixed tenants, duplicate IDs and unsorted pages fail closed', async () => {
  for (const rows of [[{ ...row(10), memoria: { canary: 1 } }], [{ ...row(10), delta: 1 }],
    [row(10, B)], [row(10), row(10)], [row(11), row(10)]]) {
    const { client } = fixture(() => response(rows, rows.length))
    await assert.rejects(api.loadParticipantsPageV1(client, { rachaId: A }), errorCode('INVALID_RESPONSE'))
  }
})

test('invalid count, empty-but-nonzero count, oversized page and stale cursor cannot truncate silently', async () => {
  for (const [rows, count] of [[[row(10)], null], [[], 1], [[row(10)], 0], [[row(10), row(11)], 2]]) {
    const { client } = fixture(() => response(rows, count))
    await assert.rejects(api.loadParticipantsPageV1(client, { rachaId: A, pageSize: 1 }), errorCode('INVALID_RESPONSE'))
  }
  const { client } = fixture(() => response([row(10)], 1))
  await assert.rejects(api.loadParticipantsPageV1(client, { rachaId: A, cursor: { rachaId: A, afterId: uuid(10) } }), errorCode('INVALID_RESPONSE'))
})

test('missing view / expired session / denied read never falls back to legacy tables', async () => {
  for (const status of [401, 403, 404, 500]) {
    const { client, requests } = fixture(() => response({ code: 'synthetic', message: 'CONFIDENTIAL_CANARY', details: 'internal' }, null, status))
    await assert.rejects(api.loadParticipantsPageV1(client, { rachaId: A }), (error) => {
      assert.equal(error.code, 'READ_FAILED')
      assert.equal(JSON.stringify(error).includes('CONFIDENTIAL_CANARY'), false)
      assert.equal(String(error.stack).includes('CONFIDENTIAL_CANARY'), false)
      assert.equal(error.cause, undefined)
      return true
    })
    assert.equal(requests.length, 1)
  }
})

test('network rejection is a sanitized failure, not an empty roster', async () => {
  const { client } = fixture(() => { throw new Error('CONFIDENTIAL_CANARY') })
  await assert.rejects(api.loadParticipantsPageV1(client, { rachaId: A }), errorCode('READ_FAILED'))
})

test('abort before or during a response prevents stale tenant data being returned', async () => {
  const controller = new AbortController()
  const { client, requests } = fixture(() => response([row(10)], 1))
  controller.abort()
  await assert.rejects(api.loadParticipantsPageV1(client, { rachaId: A, signal: controller.signal }), errorCode('CANCELLED'))
  assert.equal(requests.length, 0)
  const pending = new AbortController()
  const second = fixture(() => { pending.abort(); return response([row(10)], 1) })
  await assert.rejects(api.loadParticipantsPageV1(second.client, { rachaId: A, signal: pending.signal }), errorCode('CANCELLED'))
})

test('ID lookup deduplicates the request, scopes tenant and restores requested order', async () => {
  const { client } = fixture((url) => {
    assert.equal(url.searchParams.get('racha_id'), `eq.${A}`)
    assert.equal(url.searchParams.get('id'), `in.(${uuid(11)},${uuid(10)})`)
    return response([row(10), row(11)])
  })
  const result = await api.loadParticipantsByIdsV1(client, { rachaId: A, participantIds: [uuid(11), uuid(10), uuid(11)] })
  assert.deepEqual(result.map(p => p.id), [uuid(11), uuid(10)])
  assert.ok(Object.isFrozen(result))
})

test('missing or hidden lineup participant aborts whole lookup; unrelated rows are rejected', async () => {
  const missing = fixture(() => response([row(10)]))
  await assert.rejects(api.loadParticipantsByIdsV1(missing.client, { rachaId: A, participantIds: [uuid(10), uuid(11)] }), errorCode('PARTICIPANTS_UNAVAILABLE'))
  const other = fixture(() => response([row(12)]))
  await assert.rejects(api.loadParticipantsByIdsV1(other.client, { rachaId: A, participantIds: [uuid(10)] }), errorCode('INVALID_RESPONSE'))
})

test('bounded and empty ID lookup never creates a broad query', async () => {
  const { client, requests } = fixture(() => { throw new Error('must not send') })
  assert.deepEqual(await api.loadParticipantsByIdsV1(client, { rachaId: A, participantIds: [] }), [])
  for (const participantIds of [["id'),or=(true)"], Array.from({ length: 101 }, (_, i) => uuid(i + 10))]) {
    await assert.rejects(api.loadParticipantsByIdsV1(client, { rachaId: A, participantIds }), errorCode('INVALID_REQUEST'))
  }
  assert.equal(requests.length, 0)
})

test('subsequent reads do not reuse previously allowed data after access denial', async () => {
  const { client, requests } = fixture((url, init, call) => call === 1 ? response([row(10)], 1) : response({ code: '42501' }, null, 403))
  await api.loadParticipantsPageV1(client, { rachaId: A })
  await assert.rejects(api.loadParticipantsPageV1(client, { rachaId: A }), errorCode('READ_FAILED'))
  assert.equal(requests.length, 2) // transport behavior, not a proof of actual RLS revocation
})
