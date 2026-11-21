import type { ParticipantPublicV1, MonthlySportsPublicV1 } from '../../src/contracts/public-read-v1'

type Assert<T extends true> = T
type Equal<A, B> = [A, B] extends [B, A] ? true : false
export type ParticipantKeysAreClosed = Assert<Equal<keyof ParticipantPublicV1,
  'id' | 'racha_id' | 'nome' | 'apelido' | 'foto_url' | 'posicao' | 'ativo' | 'estrelas'>>
export type MonthlyKeysAreClosed = Assert<Equal<keyof MonthlySportsPublicV1,
  'racha_id' | 'participante_id' | 'competencia' | 'partidas' | 'gols' | 'assistencias'>>

function checkTypes(player: ParticipantPublicV1, monthly: MonthlySportsPublicV1) {
  // @ts-expect-error private metric is absent, including for admin callers
  void player.pontuacao
  // @ts-expect-error raw memory is never public
  void monthly.memoria
  // @ts-expect-error monthly sports has no confidential delta
  void monthly.delta
  // @ts-expect-error DTO fields cannot be mutated after validation
  player.estrelas = 5
}
void checkTypes
