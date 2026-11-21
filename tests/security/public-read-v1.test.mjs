import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const api = await import(pathToFileURL(process.env.ATOS_COMPILED_CONTRACT).href)
const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
const player = { id: '00000000-0000-4000-8000-000000000003', racha_id: A,
  nome: 'Fixture A', apelido: null, foto_url: null, posicao: 'goleiro', ativo: true, estrelas: 3 }
const monthly = { racha_id: A, participante_id: player.id, competencia: '2026-01-01', partidas: 2, gols: 1, assistencias: 0 }
const forbidden = ['pontuacao', 'pontuacao_antes', 'pontuacao_depois', 'memoria', 'delta',
  'calibracao', 'config_estrelas', 'meses_avaliados', 'estrelas_iniciais', 'res_medio',
  'soma_res', 'gols_esperados', 'assistencias_esperadas', 'forca_media', 'perfil_id',
  'estrelas_antes', 'estrelas_depois', 'qualquer_campo_futuro']

test('public participant contract is closed and immutable', () => {
  const value = api.parseParticipantPublicV1(player)
  assert.deepEqual(value, player)
  assert.notEqual(value, player)
  assert.ok(Object.isFrozen(value))
  assert.deepEqual(Object.keys(value), api.PARTICIPANT_PUBLIC_V1_FIELDS)
  assert.equal(api.PARTICIPANT_PUBLIC_V1_SELECT.includes('*'), false)
})

for (const role of ['normal', 'admin', 'self', 'future-owner']) {
  test(`no private-field exception in DTO for ${role}`, () => {
    for (const field of forbidden) {
      for (const [row, parse] of [[player, api.parseParticipantPublicV1], [monthly, api.parseMonthlySportsPublicV1]]) {
        assert.throws(() => parse({ ...row, [field]: { private_canary: 941 } }), api.PublicReadContractError)
      }
    }
  })
}

test('nested aliases, extra keys, executable properties and malformed payloads fail closed', () => {
  for (const input of [null, [], 'value', { ...player, nome: { alias: 941 } },
    { ...player, foto_url: { memoria: 941 } }, { ...player, estrelas: NaN },
    { ...player, estrelas: 3.5 }, { ...player, estrelas: 6 }, { ...player, ativo: 'true' },
    { ...player, posicao: 'admin' }, { ...player, id: 'not-a-uuid' },
    { ...player, [Symbol('extra')]: 1 }, { ...player, get nome() { throw new Error('must not run') } }]) {
    assert.throws(() => api.parseParticipantPublicV1(input), api.PublicReadContractError)
  }
  const missing = { ...player }; delete missing.nome
  assert.throws(() => api.parseParticipantPublicV1(missing), api.PublicReadContractError)
})

test('cross-tenant and duplicate response rows rejected (client consistency, not proof of RLS)', () => {
  assert.equal(api.parseParticipantsPublicV1([player], A).length, 1)
  assert.throws(() => api.parseParticipantsPublicV1([player], B), api.PublicReadContractError)
  assert.throws(() => api.parseParticipantsPublicV1([player, player], A), api.PublicReadContractError)
  assert.throws(() => api.parseParticipantsPublicV1({}, A), api.PublicReadContractError)
})

test('monthly contract accepts only public sports counts', () => {
  assert.deepEqual(api.parseMonthlySportsPublicV1(monthly), monthly)
  assert.deepEqual(Object.keys(api.parseMonthlySportsPublicV1(monthly)), api.MONTHLY_SPORTS_V1_FIELDS)
  for (const patch of [{ competencia: '2026-13-01' }, { competencia: '2026-01-02' },
    { gols: -1 }, { partidas: 1.5 }, { assistencias: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => api.parseMonthlySportsPublicV1({ ...monthly, ...patch }), api.PublicReadContractError)
  }
})

test('contract errors do not echo confidential payloads', () => {
  assert.throws(() => api.parseParticipantPublicV1({ ...player, memoria: 'CONFIDENTIAL_CANARY' }),
    (error) => error.message === 'INVALID_PUBLIC_READ_V1' && !String(error.stack).includes('CONFIDENTIAL_CANARY'))
})

test('SQL projection and TS contract cannot drift silently', () => {
  const sql = readFileSync(resolve('supabase/migration-drafts/round4-4/prepare_participants_public_v1.sql'), 'utf8')
  const projection = sql.match(/select (p\.id,[\s\S]*?)\nfrom public\.participantes as p/i)?.[1]
  assert.ok(projection)
  assert.deepEqual(projection.split(',').map((field) => field.trim().replace(/^p\./, '')), api.PARTICIPANT_PUBLIC_V1_FIELDS)
})
