/** Proposed read contracts for the participant list. No backend is installed.
 * Operational management state is privileged even though its representation is minimal.
 */
export const MY_PARTICIPANT_READ_V1 = 'obter_meu_participante_v1' as const
export const PARTICIPANT_MANAGEMENT_READ_V1 = 'obter_gestao_participantes_v1' as const
export const MY_PARTICIPANT_V1_FIELDS = ['racha_id', 'participante_id'] as const
export const PARTICIPANT_MANAGEMENT_V1_FIELDS = ['racha_id', 'participante_id', 'nivel_estado'] as const

export type MyParticipantV1 = Readonly<{ racha_id: string; participante_id: string | null }>
export type ParticipantManagementV1 = Readonly<{
  racha_id: string
  participante_id: string
  nivel_estado: 'automatico' | 'congelado'
}>

export class ParticipantContextContractError extends Error {
  constructor() {
    super('INVALID_PARTICIPANT_CONTEXT_V1')
    this.name = 'ParticipantContextContractError'
  }
}
function invalid(): never { throw new ParticipantContextContractError() }
function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid()
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const keys = Reflect.ownKeys(input)
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) invalid()
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field)
    if (!descriptor || !('value' in descriptor)) invalid()
  }
  return input as Record<string, unknown>
}
function uuid(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) invalid()
  return input.toLowerCase()
}
function tenant(row: Record<string, unknown>, expectedRachaId: string): string {
  const value = uuid(row.racha_id)
  if (value !== uuid(expectedRachaId)) invalid()
  return value
}

/** Null means an authorized lookup explicitly found no self-link, never denial. */
export function parseMyParticipantV1(input: unknown, expectedRachaId: string): MyParticipantV1 {
  const row = record(input, MY_PARTICIPANT_V1_FIELDS)
  return Object.freeze({
    racha_id: tenant(row, expectedRachaId),
    participante_id: row.participante_id === null ? null : uuid(row.participante_id),
  })
}

export function parseParticipantManagementV1(input: unknown, expectedRachaId: string): ParticipantManagementV1 {
  const row = record(input, PARTICIPANT_MANAGEMENT_V1_FIELDS)
  if (row.nivel_estado !== 'automatico' && row.nivel_estado !== 'congelado') invalid()
  return Object.freeze({
    racha_id: tenant(row, expectedRachaId), participante_id: uuid(row.participante_id), nivel_estado: row.nivel_estado,
  })
}

/** All-or-nothing lookup, bounded by the same 100-ID batch as the public reader. */
export function parseParticipantManagementBatchV1(
  input: unknown, expectedRachaId: string, participantIds: readonly string[],
): readonly ParticipantManagementV1[] {
  uuid(expectedRachaId)
  if (!Array.isArray(participantIds) || participantIds.length > 100 || !Array.isArray(input)) invalid()
  const ids = [...new Set(participantIds.map(uuid))]
  if (input.length !== ids.length) invalid()
  const rows = input.map(value => parseParticipantManagementV1(value, expectedRachaId))
  const byId = new Map(rows.map(row => [row.participante_id, row]))
  if (byId.size !== ids.length || rows.some(row => !ids.includes(row.participante_id))) invalid()
  return Object.freeze(ids.map(id => byId.get(id)!))
}
