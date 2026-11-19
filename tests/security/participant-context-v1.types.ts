import type { ParticipantPublicV1 } from '../../src/contracts/public-read-v1.js'
import type { MyParticipantV1, ParticipantManagementV1 } from '../../src/contracts/participant-context-v1.js'
import type { ParticipantListItemV1 } from '../../src/adapters/participant-list-v1.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
export type PublicKeysUnchanged = Expect<Equal<keyof ParticipantPublicV1,
  'id' | 'racha_id' | 'nome' | 'apelido' | 'foto_url' | 'posicao' | 'ativo' | 'estrelas'>>
export type SelfKeys = Expect<Equal<keyof MyParticipantV1, 'racha_id' | 'participante_id'>>
export type ManagementKeys = Expect<Equal<keyof ParticipantManagementV1, 'racha_id' | 'participante_id' | 'nivel_estado'>>

declare const participant: ParticipantPublicV1
declare const self: MyParticipantV1
declare const management: ParticipantManagementV1
declare const item: ParticipantListItemV1
// @ts-expect-error Profile linkage is not public.
void participant.perfil_id
// @ts-expect-error Freeze configuration is not public.
void participant.estrelas_travadas
// @ts-expect-error Common list items have no management state.
void item.nivelEstado
// @ts-expect-error Self linkage does not disclose operational management state.
void self.nivel_estado
// @ts-expect-error Internal computations never enter management contracts.
void management.delta
// @ts-expect-error Decoded contracts are immutable.
management.nivel_estado = 'automatico'
