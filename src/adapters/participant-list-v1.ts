import { parseParticipantPublicV1 } from '../contracts/public-read-v1.js'
import type { ParticipantPublicV1 } from '../contracts/public-read-v1.js'
import {
  parseMyParticipantV1, parseParticipantManagementV1, ParticipantContextContractError,
} from '../contracts/participant-context-v1.js'
import type { ParticipantManagementV1 } from '../contracts/participant-context-v1.js'

export type ParticipantListItemV1 = Readonly<{ participant: ParticipantPublicV1; isSelf: boolean }>
export type ManagedParticipantListItemV1 = Readonly<{
  participant: ParticipantPublicV1
  isSelf: boolean
  nivelEstado: ParticipantManagementV1['nivel_estado']
}>

/** Pure presentation adapter. No profile ID, privileged flag or legacy DTO synthesis.
 * isSelf is display context only, never permission to write or proof of authentication.
 */
export function toParticipantListItemV1(input: unknown, selfContext: unknown): ParticipantListItemV1 {
  const participant = parseParticipantPublicV1(input)
  const self = parseMyParticipantV1(selfContext, participant.racha_id)
  return Object.freeze({ participant, isSelf: self.participante_id === participant.id.toLowerCase() })
}

/** Caller must obtain management state through the separately authorized contract.
 * This adapter cannot prove server authorization or freshness of those responses.
 */
export function toManagedParticipantListItemV1(
  input: unknown, selfContext: unknown, managementContext: unknown,
): ManagedParticipantListItemV1 {
  const item = toParticipantListItemV1(input, selfContext)
  const management = parseParticipantManagementV1(managementContext, item.participant.racha_id)
  if (management.participante_id !== item.participant.id.toLowerCase()) throw new ParticipantContextContractError()
  return Object.freeze({ participant: item.participant, isSelf: item.isSelf, nivelEstado: management.nivel_estado })
}
