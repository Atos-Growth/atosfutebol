import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MY_PARTICIPANT_READ_V1, MY_PARTICIPANT_READ_V2, PARTICIPANT_MANAGEMENT_READ_V1,
  parseMyParticipantV1, parseMyParticipantV2, parseParticipantManagementBatchV1,
} from '../contracts/participant-context-v1.js'
import type { MyParticipantV1, MyParticipantV2, ParticipantManagementV1 } from '../contracts/participant-context-v1.js'
import { ParticipantsReadError } from './participants-reader-v1.js'

// Supplied user-session client. Role/profile identifiers are never RPC parameters.
type ReadClient = Pick<SupabaseClient, 'rpc'>
type Request = Readonly<{ rachaId: string; signal?: AbortSignal }>
function id(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ParticipantsReadError('INVALID_REQUEST')
  }
  return value.toLowerCase()
}
function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ParticipantsReadError('CANCELLED')
}
async function read<T>(
  query: PromiseLike<{ data: unknown; error: unknown }>,
  decode: (input: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  active(signal)
  let response: { data: unknown; error: unknown }
  try { response = await query } catch { active(signal); throw new ParticipantsReadError('READ_FAILED') }
  active(signal)
  if (response.error) throw new ParticipantsReadError('READ_FAILED')
  try { return decode(response.data) } catch { throw new ParticipantsReadError('INVALID_RESPONSE') }
}

/** Future read-only RPC: the server derives auth.uid() and verifies current membership.
 * No caching; errors and missing endpoints never become a successful unlinked state.
 */
export async function loadMyParticipantV1(client: ReadClient, request: Request): Promise<MyParticipantV1> {
  const tenant = id(request.rachaId)
  active(request.signal)
  let query = client.rpc(MY_PARTICIPANT_READ_V1, { p_racha_id: tenant }, { get: true })
  if (request.signal) query = query.abortSignal(request.signal)
  return read(query, data => parseMyParticipantV1(data, tenant), request.signal)
}

/** Self-link plus the caller's own level state (regular member card). Same guarantees as v1. */
export async function loadMyParticipantV2(client: ReadClient, request: Request): Promise<MyParticipantV2> {
  const tenant = id(request.rachaId)
  active(request.signal)
  let query = client.rpc(MY_PARTICIPANT_READ_V2, { p_racha_id: tenant }, { get: true })
  if (request.signal) query = query.abortSignal(request.signal)
  return read(query, data => parseMyParticipantV2(data, tenant), request.signal)
}

/** Future organizer-only RPC. A client-side enum/tenant check does NOT authorize.
 * Fetch only IDs already requested for the list; missing/hidden IDs reject the batch.
 */
export async function loadParticipantManagementV1(
  client: ReadClient, request: Request & Readonly<{ participantIds: readonly string[] }>,
): Promise<readonly ParticipantManagementV1[]> {
  const tenant = id(request.rachaId)
  if (!Array.isArray(request.participantIds) || request.participantIds.length > 100) throw new ParticipantsReadError('INVALID_REQUEST')
  const ids = [...new Set(request.participantIds.map(id))]
  active(request.signal)
  if (!ids.length) return Object.freeze([]) // no request, no assertion of authorization
  let query = client.rpc(PARTICIPANT_MANAGEMENT_READ_V1, {
    p_racha_id: tenant, p_participante_ids: ids,
  }, { get: true })
  if (request.signal) query = query.abortSignal(request.signal)
  return read(query, data => parseParticipantManagementBatchV1(data, tenant, ids), request.signal)
}
