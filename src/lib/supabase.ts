import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const hasSupabase = Boolean(url && anonKey && !url.includes('seu-projeto'))
export const supabase = hasSupabase ? createClient(url!, anonKey!, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } },
}) : null

export type Posicao = 'goleiro' | 'zagueiro' | 'meio' | 'atacante' | 'qualquer'
export type Papel = 'admin' | 'normal' | 'pendente'
export type Racha = { id: string; nome: string }
export type RachaMembro = { racha_id: string; racha_nome: string; papel: Papel }
export type Participante = { id: string; perfil_id: string | null; nome: string; apelido: string | null; foto_url: string | null; estrelas: number; posicao: Posicao; ativo: boolean; estrelas_travadas?: boolean }
// Último fechamento mensal de cada jogador: alimenta a seta de tendência.
export type Fechamento = { participante_id: string; competencia: string; delta: number; partidas: number; gols: number; assistencias: number; estrelas_antes: number; estrelas_depois: number }
export type CheckIn = { id: string; participante_id: string; horario_chegada: string; alocado: boolean }
export type Time = { id: string; numero: number; posicao_fila: number; status: 'na_fila' | 'jogando' | 'finalizado_no_dia'; forca_media: number | null; jogadores: Participante[] }
export type GolEvento = { id: string; partida_id: string; jogador_id: string; assistente_id: string | null; time_id: string; criado_em: string }

export const initials = (name: string) => name.split(' ').slice(0, 2).map((word) => word[0]).join('').toUpperCase()
export const positionLabel: Record<Posicao, string> = { goleiro: 'Goleiro', zagueiro: 'Zagueiro', meio: 'Meio', atacante: 'Atacante', qualquer: 'Qualquer' }
