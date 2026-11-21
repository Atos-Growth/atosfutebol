// Estado da lista de participantes da pelada ativa e do cartão do membro vinculado.
// Módulo puro e sem imports (testado direto pelo Node em tests/security/participants-roster.test.mjs).

export type RosterStatus = 'loading' | 'ready' | 'error'
export type Roster<T> = Readonly<{ rachaId: string | null; status: RosterStatus; items: readonly T[] }>

/** Troca de pelada (ou nova tentativa): a lista anterior some na hora, nunca fica visível. */
export function startRoster<T>(rachaId: string): Roster<T> {
  return { rachaId, status: 'loading', items: [] }
}

/** Resultado de uma carga. Resposta de outra pelada é descartada; erro nunca mantém itens. */
export function settleRoster<T>(
  current: Roster<T>, rachaId: string, outcome: { ok: true; items: readonly T[] } | { ok: false },
): Roster<T> {
  if (current.rachaId !== rachaId || current.status !== 'loading') return current
  return outcome.ok ? { rachaId, status: 'ready', items: outcome.items } : { rachaId, status: 'error', items: [] }
}

export type SelfStatus = 'local' | 'idle' | 'loading' | 'error' | 'ready'
export type SelfCardState = 'loading' | 'self-error' | 'list-error' | 'missing-self' | 'linked' | 'unlinked'

/** Cartão do membro comum. Falha (da RPC ou da lista) nunca vira "sem vínculo" nem carregamento eterno. */
export function selfCardState(input: {
  rosterStatus: RosterStatus; selfStatus: SelfStatus; selfParticipanteId: string | null; selfInList: boolean
}): SelfCardState {
  if (input.selfStatus === 'error') return 'self-error'
  if (input.selfStatus === 'loading') return 'loading'
  if (input.selfStatus === 'local') return input.selfInList ? 'linked' : 'unlinked'
  if (!input.selfParticipanteId) return 'unlinked'
  if (input.rosterStatus === 'loading') return 'loading'
  if (input.rosterStatus === 'error') return 'list-error'
  return input.selfInList ? 'linked' : 'missing-self'
}
