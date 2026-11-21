// H2.1 — falha da lista de participantes: nunca mostra jogadores de outra pelada, sempre
// oferece erro + nova tentativa e o cartão do membro vinculado nunca carrega para sempre.
// Uso: node --test tests/security/participants-roster.test.mjs  (Node 24 carrega o .ts puro)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const roster = await import('../../src/lib/participants-roster.ts')
const A = 'racha-A', B = 'racha-B'
const jogadorA = { id: 'pA' }, jogadorB = { id: 'pB' }

test('troca de pelada limpa a lista na hora, antes de qualquer resposta', () => {
  const started = roster.startRoster(B)
  assert.deepEqual(started, { rachaId: B, status: 'loading', items: [] })
})

test('erro na carga nunca mantém jogadores (nem os da pelada anterior)', () => {
  const comItensAntigos = { rachaId: B, status: 'loading', items: [jogadorA] }
  assert.deepEqual(roster.settleRoster(comItensAntigos, B, { ok: false }), { rachaId: B, status: 'error', items: [] })
})

test('resposta atrasada de outra pelada é descartada (sucesso ou erro)', () => {
  const carregandoB = roster.startRoster(B)
  assert.equal(roster.settleRoster(carregandoB, A, { ok: true, items: [jogadorA] }), carregandoB)
  assert.equal(roster.settleRoster(carregandoB, A, { ok: false }), carregandoB)
  assert.deepEqual(roster.settleRoster(carregandoB, B, { ok: true, items: [jogadorB] }).items, [jogadorB])
})

test('resultado repetido depois de concluída não reabre nem troca a lista', () => {
  const pronta = roster.settleRoster(roster.startRoster(B), B, { ok: true, items: [jogadorB] })
  assert.equal(roster.settleRoster(pronta, B, { ok: false }), pronta)
})

test('nova tentativa sai do erro para carregando e depois para pronta', () => {
  const erro = roster.settleRoster(roster.startRoster(A), A, { ok: false })
  const retry = roster.startRoster(A)
  assert.equal(erro.status, 'error')
  assert.deepEqual(roster.settleRoster(retry, A, { ok: true, items: [jogadorA] }), { rachaId: A, status: 'ready', items: [jogadorA] })
})

test('cartão do membro vinculado: falha da lista vira erro com nova tentativa, nunca carregamento eterno', () => {
  const vinculado = { selfStatus: 'ready', selfParticipanteId: 'pA' }
  assert.equal(roster.selfCardState({ ...vinculado, rosterStatus: 'error', selfInList: false }), 'list-error')
  assert.equal(roster.selfCardState({ ...vinculado, rosterStatus: 'loading', selfInList: false }), 'loading')
  assert.equal(roster.selfCardState({ ...vinculado, rosterStatus: 'ready', selfInList: false }), 'missing-self')
  assert.equal(roster.selfCardState({ ...vinculado, rosterStatus: 'ready', selfInList: true }), 'linked')
})

test('cartão: erro da RPC nunca vira "sem vínculo"; sem vínculo confirmado independe da lista', () => {
  for (const rosterStatus of ['loading', 'ready', 'error']) {
    assert.equal(roster.selfCardState({ rosterStatus, selfStatus: 'error', selfParticipanteId: null, selfInList: false }), 'self-error')
    assert.equal(roster.selfCardState({ rosterStatus, selfStatus: 'loading', selfParticipanteId: null, selfInList: false }), 'loading')
    assert.equal(roster.selfCardState({ rosterStatus, selfStatus: 'ready', selfParticipanteId: null, selfInList: false }), 'unlinked')
  }
})

test('App usa o estado da lista e não tem mais o carregamento sem saída do cartão', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')
  assert.ok(!app.includes('selfParticipanteId && !meuParticipante'))
  assert.match(app, /setRoster\(startRoster<Participante>\(rachaId\)\)/)
  assert.match(app, /settleRoster\(r, rachaId, \{ ok: false \}\)/)
  assert.match(app, /if \(rosterStatus === 'error'\) return errorPanel\(/)
  assert.match(app, /card === 'list-error' \? errorPanel\(/)
  assert.ok(!/useState<Participante\[\]>\(demoPlayers\)/.test(app), 'com Supabase a lista não começa com jogadores de demonstração')
})
