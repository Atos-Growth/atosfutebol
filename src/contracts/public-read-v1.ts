/** Versioned API boundary. Not yet wired into the application.
 * These decoders validate responses; authorization belongs to PostgreSQL.
 */
export const PARTICIPANTS_READ_V1 = 'participantes_publicos_v1' as const
export const PARTICIPANT_PUBLIC_V1_FIELDS = [
  'id', 'racha_id', 'nome', 'apelido', 'foto_url', 'posicao', 'ativo', 'estrelas',
] as const
export const PARTICIPANT_PUBLIC_V1_SELECT = PARTICIPANT_PUBLIC_V1_FIELDS.join(',')

export type PublicPositionV1 = 'goleiro' | 'zagueiro' | 'meio' | 'atacante' | 'qualquer'
export type ParticipantPublicV1 = Readonly<{
  id: string
  racha_id: string
  nome: string
  apelido: string | null
  foto_url: string | null
  posicao: PublicPositionV1
  ativo: boolean
  estrelas: number
}>

/** Sports facts only. No endpoint or aggregation is deployed by this module. */
export const MONTHLY_SPORTS_V1_FIELDS = [
  'racha_id', 'participante_id', 'competencia', 'partidas', 'gols', 'assistencias',
] as const
export type MonthlySportsPublicV1 = Readonly<{
  racha_id: string
  participante_id: string
  competencia: string
  partidas: number
  gols: number
  assistencias: number
}>

// Fixed message: never include the rejected payload, key, or confidential value.
export class PublicReadContractError extends Error {
  constructor() {
    super('INVALID_PUBLIC_READ_V1')
    this.name = 'PublicReadContractError'
  }
}

function invalid(): never { throw new PublicReadContractError() }

function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid()
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const keys = Reflect.ownKeys(input)
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) invalid()
  // API JSON has data properties, not executable accessors.
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !('value' in descriptor)) invalid()
  }
  return input as Record<string, unknown>
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid()
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid()
  return value
}
function nullableText(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') invalid()
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

export function parseParticipantPublicV1(input: unknown): ParticipantPublicV1 {
  const row = record(input, PARTICIPANT_PUBLIC_V1_FIELDS)
  const positions: readonly unknown[] = ['goleiro', 'zagueiro', 'meio', 'atacante', 'qualquer']
  if (!positions.includes(row.posicao) || typeof row.ativo !== 'boolean') invalid()
  const stars = count(row.estrelas)
  if (stars < 1 || stars > 5) invalid()
  return Object.freeze({
    id: uuid(row.id), racha_id: uuid(row.racha_id), nome: text(row.nome),
    apelido: nullableText(row.apelido), foto_url: nullableText(row.foto_url),
    posicao: row.posicao as PublicPositionV1, ativo: row.ativo, estrelas: stars,
  })
}

/** A client-side consistency check, never a replacement for tenant RLS. */
export function parseParticipantsPublicV1(input: unknown, expectedRachaId: string): readonly ParticipantPublicV1[] {
  const tenant = uuid(expectedRachaId).toLowerCase()
  if (!Array.isArray(input)) invalid()
  const rows = input.map(parseParticipantPublicV1)
  if (rows.some((row) => row.racha_id.toLowerCase() !== tenant)) invalid()
  if (new Set(rows.map((row) => row.id.toLowerCase())).size !== rows.length) invalid()
  return Object.freeze(rows)
}

export function parseMonthlySportsPublicV1(input: unknown): MonthlySportsPublicV1 {
  const row = record(input, MONTHLY_SPORTS_V1_FIELDS)
  if (typeof row.competencia !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])-01$/.test(row.competencia)) invalid()
  return Object.freeze({
    racha_id: uuid(row.racha_id), participante_id: uuid(row.participante_id),
    competencia: row.competencia, partidas: count(row.partidas),
    gols: count(row.gols), assistencias: count(row.assistencias),
  })
}
