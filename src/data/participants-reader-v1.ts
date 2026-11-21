import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PARTICIPANTS_READ_V1,
  PARTICIPANT_PUBLIC_V1_SELECT,
  parseParticipantsPublicV1,
} from '../contracts/public-read-v1.js'
import type { ParticipantPublicV1 } from '../contracts/public-read-v1.js'

// Accept the existing user-scoped client; never create a service client here.
type ReadClient = Pick<SupabaseClient, 'from'>
export type ParticipantsCursorV1 = Readonly<{ rachaId: string; afterId: string }>
export type ParticipantsPageV1 = Readonly<{
  items: readonly ParticipantPublicV1[]
  nextCursor: ParticipantsCursorV1 | null
}>
export type ParticipantsReadErrorCode =
  | 'INVALID_REQUEST' | 'CANCELLED' | 'READ_FAILED' | 'INVALID_RESPONSE' | 'PARTICIPANTS_UNAVAILABLE'

export class ParticipantsReadError extends Error {
  readonly code: ParticipantsReadErrorCode
  constructor(code: ParticipantsReadErrorCode) {
    super(code)
    this.name = 'ParticipantsReadError'
    this.code = code
  }
}

function fail(code: ParticipantsReadErrorCode): never { throw new ParticipantsReadError(code) }
function id(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('INVALID_REQUEST')
  return value.toLowerCase()
}
function active(signal?: AbortSignal): void {
  if (signal?.aborted) fail('CANCELLED')
}

async function read(
  query: PromiseLike<{ data: unknown; error: unknown; count?: number | null }>,
  rachaId: string,
  signal?: AbortSignal,
): Promise<{ rows: readonly ParticipantPublicV1[]; count: number | null }> {
  active(signal)
  let response: { data: unknown; error: unknown; count?: number | null }
  try { response = await query } catch { active(signal); fail('READ_FAILED') }
  active(signal)
  if (response.error) fail('READ_FAILED')
  let rows: readonly ParticipantPublicV1[]
  try { rows = parseParticipantsPublicV1(response.data, rachaId) } catch { fail('INVALID_RESPONSE') }
  // Stable ascending IDs are the keyset boundary. Reject malformed/misordered pages.
  if (rows.some((row, i) => i > 0 && row.id.toLowerCase() <= rows[i - 1].id.toLowerCase())) fail('INVALID_RESPONSE')
  return { rows, count: response.count ?? null }
}

/** Prepared replacement for participantes.select('*'). Server RLS still authorizes. */
export async function loadParticipantsPageV1(
  client: ReadClient,
  request: { rachaId: string; pageSize?: number; cursor?: ParticipantsCursorV1; signal?: AbortSignal },
): Promise<ParticipantsPageV1> {
  const tenant = id(request.rachaId)
  const size = request.pageSize ?? 50
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) fail('INVALID_REQUEST')
  const cursor = request.cursor
  if (cursor && id(cursor.rachaId) !== tenant) fail('INVALID_REQUEST')
  const afterId = cursor ? id(cursor.afterId) : null
  active(request.signal)
  let query = client.from(PARTICIPANTS_READ_V1)
    .select(PARTICIPANT_PUBLIC_V1_SELECT, { count: 'exact' })
    .eq('racha_id', tenant).order('id', { ascending: true }).limit(size)
  if (afterId) query = query.gt('id', afterId)
  if (request.signal) query = query.abortSignal(request.signal)
  const { rows, count } = await read(query, tenant, request.signal)
  if (rows.length > size || count === null || !Number.isSafeInteger(count) || count < rows.length) fail('INVALID_RESPONSE')
  if (afterId && rows.some((row) => row.id.toLowerCase() <= afterId)) fail('INVALID_RESPONSE')
  // Count is of the filtered query after the cursor. Handle server page caps without
  // falsely treating a shortened page as end-of-list. Count failure is not empty data.
  if (count > 0 && rows.length === 0) fail('INVALID_RESPONSE')
  const nextCursor = count > rows.length
    ? Object.freeze({ rachaId: tenant, afterId: rows[rows.length - 1].id.toLowerCase() })
    : null
  return Object.freeze({ items: rows, nextCursor })
}

/** Resolve player IDs from an authorized session/lineup response without raw embeds.
 * This verifies participant visibility, NOT whether a player belongs to a session.
 * Missing/hidden IDs fail the entire lookup; never silently alter a lineup.
 */
export async function loadParticipantsByIdsV1(
  client: ReadClient,
  request: { rachaId: string; participantIds: readonly string[]; signal?: AbortSignal },
): Promise<readonly ParticipantPublicV1[]> {
  const tenant = id(request.rachaId)
  if (!Array.isArray(request.participantIds) || request.participantIds.length > 100) fail('INVALID_REQUEST')
  const ids = [...new Set(request.participantIds.map(id))]
  active(request.signal)
  if (!ids.length) return Object.freeze([])
  let query = client.from(PARTICIPANTS_READ_V1).select(PARTICIPANT_PUBLIC_V1_SELECT)
    .eq('racha_id', tenant).in('id', ids).order('id', { ascending: true }).limit(ids.length + 1)
  if (request.signal) query = query.abortSignal(request.signal)
  const { rows } = await read(query, tenant, request.signal)
  if (rows.some((row) => !ids.includes(row.id.toLowerCase()))) fail('INVALID_RESPONSE')
  if (rows.length !== ids.length) fail('PARTICIPANTS_UNAVAILABLE')
  const byId = new Map(rows.map((row) => [row.id.toLowerCase(), row]))
  return Object.freeze(ids.map((participantId) => byId.get(participantId)!))
}
