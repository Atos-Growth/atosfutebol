import { useEffect, useMemo, useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import toast from 'react-hot-toast'
import {
  ArrowLeftRight, ArrowUpRight, BarChart3, CalendarDays, Check, ChevronRight, CircleStop,
  ClipboardCheck, Clock3, Crown, History, LayoutDashboard, LogOut,
  Menu, MessageCircle, Minus, Pause, Pencil, Play, Plus, RotateCcw, Search, Settings2, Shield,
  Hourglass, Lock, Mail, RefreshCw, Shirt, Sparkles, Star, TimerReset, Trash2, TrendingDown, TrendingUp, Trophy, UserCheck, UserPlus, UserX, Users, X,
} from 'lucide-react'
import { CheckIn, Fechamento, GolEvento, hasSupabase, initials, Papel, Participante, positionLabel, Posicao, Racha, RachaMembro, supabase, Time } from './lib/supabase'

type View = 'inicio' | 'participantes' | 'checkin' | 'sorteio' | 'partida' | 'historico' | 'aprovacoes'
type SessionStatus = 'aguardando_checkin' | 'sorteando' | 'em_andamento' | 'finalizada'
type PerfilPendente = { id: string; email: string | null; criado_em: string }
const RACHA_ATIVO_STORAGE_KEY = 'atos_racha_ativo'
const VIEW_STORAGE_KEY = 'atos_view_ativa'
const validViews: View[] = ['inicio', 'participantes', 'checkin', 'sorteio', 'partida', 'historico', 'aprovacoes']
const pickRachaAtivo = (memberships: RachaMembro[], previous: string | null) => {
  if (previous && memberships.some((m) => m.racha_id === previous)) return previous
  return (memberships.find((m) => m.papel !== 'pendente') ?? memberships[0])?.racha_id ?? null
}
type Match = { id: string; time_a_id: string; time_b_id: string; placar_a: number; placar_b: number; status: 'em_andamento' | 'finalizada'; horario_inicio: string; timer_started_at: string | null; timer_remaining_seconds: number; timer_running: boolean }
type TimeHistorico = { id: string; numero: number; forca_media: number | string | null; times_jogadores: { participantes: { nome: string } | null }[] }
type PartidaHistorica = { id: string; placar_a: number; placar_b: number; horario_inicio: string; time_a: TimeHistorico | null; time_b: TimeHistorico | null }
type SessaoHistorica = { id: string; data: string; horario_fim: string | null; partidas_count: number }

const uid = () => crypto.randomUUID()
const demoPlayers: Participante[] = [
  ['Caio Martins', 5, 'meio'], ['Bruno Lima', 4, 'atacante'], ['Rafael Nunes', 4, 'zagueiro'], ['João Pedro', 3, 'meio'],
  ['Lucas Alves', 5, 'goleiro'], ['Diego Rocha', 3, 'atacante'], ['Marcos Vini', 4, 'zagueiro'], ['André Reis', 2, 'qualquer'],
  ['Felipe Melo', 5, 'atacante'], ['Gustavo Dias', 3, 'meio'], ['Henrique Luz', 4, 'goleiro'], ['Matheus Costa', 2, 'zagueiro'],
  ['Tiago Neves', 4, 'meio'], ['Edu Ramos', 3, 'qualquer'], ['Pedro Ivo', 5, 'atacante'], ['Léo Bahia', 3, 'zagueiro'],
  ['Nando Silva', 4, 'meio'], ['Vitor Sá', 2, 'atacante'], ['Dudu Castro', 3, 'qualquer'], ['Igor Freire', 4, 'zagueiro'],
  ['Samuel Braga', 3, 'meio'], ['Renan Lopes', 2, 'qualquer'],
].map(([nome, estrelas, posicao], index) => ({ id: `p${index + 1}`, perfil_id: null, nome: String(nome), apelido: null, foto_url: null, estrelas: Number(estrelas), posicao: posicao as Posicao, ativo: true }))

const demoCheckins: CheckIn[] = demoPlayers.slice(0, 19).map((p, index) => ({ id: `c${index}`, participante_id: p.id, horario_chegada: new Date(Date.now() - (80 - index * 3) * 60000).toISOString(), alocado: index < 18 }))

const teamColors = ['#ccff33', '#ff7a3d', '#68cfff', '#bd88ff', '#ffd84d']

function Avatar({ player, size = 'md', ring }: { player: Participante; size?: 'sm' | 'md' | 'lg'; ring?: string }) {
  const cls = size === 'sm' ? 'h-9 w-9 text-xs' : size === 'lg' ? 'h-16 w-16 text-lg' : 'h-11 w-11 text-sm'
  return <div className={`avatar ${cls}`} style={{ boxShadow: ring ? `0 0 0 3px ${ring}` : undefined }}>
    {player.foto_url ? <img src={player.foto_url} alt={player.nome} className="h-full w-full object-cover" /> : initials(player.nome)}
  </div>
}

function Stars({ value }: { value: number }) {
  return <span className="inline-flex" aria-label={`${value} estrelas`}>{Array.from({ length: 5 }, (_, i) => <Star key={i} size={12} fill={i < value ? 'currentColor' : 'none'} className={i < value ? 'text-amber-400' : 'text-ink/15'} />)}</span>
}

// Seta do último fechamento mensal. Nunca mostra a pontuação crua: o jogador vê
// estrelas e a direção em que está andando, não o número de 0 a 100.
function Trend({ fechamento }: { fechamento?: Fechamento }) {
  if (!fechamento) return null
  const delta = Number(fechamento.delta)
  const mudanca = fechamento.estrelas_depois - fechamento.estrelas_antes
  const subiu = delta > 0.05
  const caiu = delta < -0.05
  const Icon = subiu ? TrendingUp : caiu ? TrendingDown : Minus
  const tone = subiu ? 'text-turf-700' : caiu ? 'text-red-600' : 'text-ink/35'
  const mes = format(new Date(`${fechamento.competencia}T12:00:00`), 'MMM', { locale: ptBR })
  return <span className={`inline-flex items-center gap-1 text-[10px] font-bold ${tone}`} title={`${delta > 0 ? '+' : ''}${delta.toFixed(2)} no fechamento de ${mes} · ${fechamento.partidas} partidas, ${fechamento.gols} gols, ${fechamento.assistencias} assistências`}>
    <Icon size={12} />{delta > 0 ? '+' : ''}{delta.toFixed(1)}
    {mudanca !== 0 && <span className={`chip !px-1.5 !py-0 ${mudanca > 0 ? 'bg-turf-100 text-turf-700' : 'bg-red-100 text-red-700'}`}>{mudanca > 0 ? '↑' : '↓'} {fechamento.estrelas_depois}★</span>}
  </span>
}

function EmptyState({ icon: Icon, title, text }: { icon: typeof Users; title: string; text: string }) {
  return <div className="grid min-h-52 place-items-center rounded-2xl border border-dashed border-ink/15 p-8 text-center"><div><Icon className="mx-auto mb-3 text-ink/25" size={32} /><p className="font-bold">{title}</p><p className="mt-1 max-w-sm text-sm text-ink/50">{text}</p></div></div>
}

function WaitingSession() {
  return <div className="panel grid min-h-[520px] place-items-center overflow-hidden p-8 text-center"><div className="max-w-md"><div className="mx-auto grid h-20 w-20 place-items-center rounded-[28px] bg-turf-100 text-turf-700"><Clock3 size={34} /></div><span className="chip mt-6 bg-ink/5 text-ink/50"><Shield size={13} /> Acesso somente leitura</span><h2 className="mt-4 text-2xl font-black">Aguardando o organizador começar a sessão</h2><p className="mt-3 text-sm leading-relaxed text-ink/50">Assim que a sessão de hoje for aberta, os times, o placar e o cronômetro aparecerão aqui automaticamente.</p></div></div>
}

function PromoBanner({ text }: { text: string }) {
  return <a href="https://atosgrowth.com.br/" target="_blank" rel="noopener noreferrer" className="group flex h-full min-h-32 w-full items-center justify-between gap-5 rounded-2xl border border-turf-300/60 bg-cream p-5 text-left text-ink shadow-card transition hover:-translate-y-0.5 hover:border-turf-500 hover:shadow-lg focus:outline-none focus:ring-4 focus:ring-turf-300/40"><div><span className="text-[10px] font-black uppercase tracking-[.18em] text-turf-600">Atos Growth</span><p className="mt-2 text-lg font-black leading-snug">{text}</p></div><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ink text-lime transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"><ArrowUpRight size={20} /></span></a>
}

function WhatsAppButton() {
  return <a href="https://wa.me/5582993516093" target="_blank" rel="noopener noreferrer" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-turf-700 px-4 py-3 text-sm font-extrabold text-white transition hover:bg-turf-900 focus:outline-none focus:ring-4 focus:ring-turf-300/50"><MessageCircle size={19} /> Fale com a Atos Growth no WhatsApp</a>
}

function App() {
  const [view, setView] = useState<View>(() => {
    const stored = typeof window === 'undefined' ? null : window.localStorage.getItem(VIEW_STORAGE_KEY)
    return validViews.includes(stored as View) ? (stored as View) : 'inicio'
  })
  useEffect(() => { window.localStorage.setItem(VIEW_STORAGE_KEY, view) }, [view])
  const [players, setPlayers] = useState<Participante[]>(demoPlayers)
  const [checkins, setCheckins] = useState<CheckIn[]>(demoCheckins)
  const [teams, setTeams] = useState<Time[]>([])
  const [events, setEvents] = useState<GolEvento[]>([])
  const [match, setMatch] = useState<Match | null>(null)
  const [sessionMatches, setSessionMatches] = useState<PartidaHistorica[]>([])
  const [pendingDrawMatch, setPendingDrawMatch] = useState<Match | null>(null)
  const [sessionId, setSessionId] = useState('demo-session')
  const [status, setStatus] = useState<SessionStatus>('aguardando_checkin')
  const [teamSize, setTeamSize] = useState(6)
  const [duration, setDuration] = useState(10)
  const [showSettings, setShowSettings] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [loading, setLoading] = useState(hasSupabase)
  const [authEmail, setAuthEmail] = useState<string | null>(hasSupabase ? null : 'Modo demonstração')
  const [userId, setUserId] = useState<string | null>(hasSupabase ? null : 'demo-user')
  const [memberships, setMemberships] = useState<RachaMembro[]>(hasSupabase ? [] : [{ racha_id: 'demo-racha', racha_nome: 'Racha demo', papel: 'admin' }])
  const [rachaAtivoId, setRachaAtivoIdState] = useState<string | null>(() => hasSupabase ? (typeof window === 'undefined' ? null : window.localStorage.getItem(RACHA_ATIVO_STORAGE_KEY)) : 'demo-racha')
  const [sessionReady, setSessionReady] = useState(!hasSupabase)
  const [fechamentos, setFechamentos] = useState<Record<string, Fechamento>>({})

  const setRachaAtivoId = (id: string | null) => {
    setRachaAtivoIdState(id)
    if (id) window.localStorage.setItem(RACHA_ATIVO_STORAGE_KEY, id)
    else window.localStorage.removeItem(RACHA_ATIVO_STORAGE_KEY)
  }

  const papel = memberships.find((m) => m.racha_id === rachaAtivoId)?.papel ?? null

  useEffect(() => {
    if (!supabase) return
    const applySession = (session: { user: { id: string; email?: string } } | null) => {
      setAuthEmail(session?.user.email ?? null)
      setUserId(session?.user.id ?? null)
      if (!session) { setMemberships([]); setRachaAtivoId(null); setLoading(false) }
    }
    supabase.auth.getSession().then(({ data }) => applySession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => applySession(next))
    return () => listener.subscription.unsubscribe()
  }, [])

  const refreshMemberships = async () => {
    if (!supabase || !userId) return
    setLoading(true)
    const { data, error } = await supabase.from('racha_membros').select('racha_id, papel, rachas(nome)').eq('perfil_id', userId)
    if (error) toast.error('Não foi possível verificar seus rachas.')
    const list: RachaMembro[] = (data ?? []).map((row) => {
      const linha = row as unknown as { racha_id: string; papel: Papel; rachas: { nome: string } | null }
      return { racha_id: linha.racha_id, papel: linha.papel, racha_nome: linha.rachas?.nome ?? 'Racha' }
    })
    setMemberships(list)
    setRachaAtivoId(pickRachaAtivo(list, rachaAtivoId))
    setLoading(false)
  }

  useEffect(() => { void refreshMemberships() }, [userId])

  // Vem ordenado do mais recente pro mais antigo: a primeira linha de cada
  // jogador é o fechamento mais novo dele.
  const loadFechamentos = async (targetRachaId: string) => {
    if (!supabase) return
    const { data, error } = await supabase.from('fechamentos_mensais')
      .select('participante_id, competencia, delta, partidas, gols, assistencias, estrelas_antes, estrelas_depois')
      .eq('racha_id', targetRachaId).order('competencia', { ascending: false })
    if (error) { console.error('Falha ao carregar os fechamentos mensais', error); return }
    const ultimos: Record<string, Fechamento> = {}
    for (const linha of (data ?? []) as Fechamento[]) if (!ultimos[linha.participante_id]) ultimos[linha.participante_id] = linha
    setFechamentos(ultimos)
  }

  const loadSessionMatches = async (targetSessionId: string) => {
    if (!supabase) return
    const { data, error } = await supabase.from('partidas').select(`
      id, placar_a, placar_b, horario_inicio,
      time_a:times!partidas_time_a_id_fkey(id, numero, forca_media, times_jogadores(participantes(nome))),
      time_b:times!partidas_time_b_id_fkey(id, numero, forca_media, times_jogadores(participantes(nome)))
    `).eq('sessao_id', targetSessionId).eq('status', 'finalizada').order('horario_inicio')
    if (!error) setSessionMatches((data ?? []) as unknown as PartidaHistorica[])
  }

  const loadSessionEvents = async (targetSessionId: string) => {
    if (!supabase) return
    const { data: partidas } = await supabase.from('partidas').select('id').eq('sessao_id', targetSessionId)
    const ids = (partidas ?? []).map((p) => p.id)
    if (!ids.length) { setEvents([]); return }
    const { data } = await supabase.from('eventos').select('*').in('partida_id', ids).order('criado_em')
    setEvents((data ?? []) as GolEvento[])
  }

  const reloadPendingDraw = async (targetSessionId: string) => {
    if (!supabase) return
    const { data: sessionRow, error } = await supabase.from('sessoes').select('pendente_escolha_partida_id').eq('id', targetSessionId).maybeSingle()
    // Roda em realtime: o id no toast evita empilhar o mesmo aviso a cada evento.
    if (error) { console.error('Falha ao ler a escolha pendente da sessão', error); toast.error(`Não foi possível verificar o empate pendente: ${error.message}`, { id: 'pendente-escolha' }); return }
    const pendingId = sessionRow?.pendente_escolha_partida_id ?? null
    if (!pendingId) { setPendingDrawMatch(null); return }
    const { data: partidaRow, error: partidaError } = await supabase.from('partidas').select('*').eq('id', pendingId).maybeSingle()
    if (partidaError) { console.error('Falha ao carregar a partida pendente', partidaError); toast.error(`Não foi possível carregar a partida do empate: ${partidaError.message}`, { id: 'pendente-escolha' }); return }
    setPendingDrawMatch((partidaRow as Match | null) ?? null)
  }

  const startNewSession = async () => {
    if (!supabase || papel !== 'admin' || !rachaAtivoId) return false
    const created = await supabase.from('sessoes').insert({ racha_id: rachaAtivoId, data: format(new Date(), 'yyyy-MM-dd'), tamanho_time: 6, duracao_partida_minutos: 10 }).select().single()
    if (created.error) { toast.error('Não foi possível abrir uma nova sessão.'); return false }
    const sessionData = created.data
    setSessionId(sessionData.id)
    setStatus(sessionData.status)
    setTeamSize(sessionData.tamanho_time)
    setDuration(sessionData.duracao_partida_minutos)
    setSessionReady(true)
    setTeams([])
    setCheckins([])
    setMatch(null)
    setEvents([])
    setSessionMatches([])
    setPendingDrawMatch(null)
    return true
  }

  useEffect(() => {
    if (!supabase || !authEmail || !papel || papel === 'pendente' || !rachaAtivoId) return
    const db = supabase
    const load = async () => {
      const { data: participantData } = await db.from('participantes').select('*').eq('racha_id', rachaAtivoId).order('nome')
      if (participantData) setPlayers(participantData as Participante[])
      await loadFechamentos(rachaAtivoId)
      const sessionQuery = await db.from('sessoes').select('*').eq('racha_id', rachaAtivoId).neq('status', 'finalizada').order('criado_em', { ascending: false }).limit(1).maybeSingle()
      if (sessionQuery.error) throw sessionQuery.error
      const sessionData = sessionQuery.data
      if (!sessionData && papel === 'admin') {
        await startNewSession()
        return
      }
      if (!sessionData) {
        setSessionReady(false); setSessionId(''); setTeams([]); setMatch(null); setEvents([]); setSessionMatches([]); setPendingDrawMatch(null)
        return
      }
      setSessionReady(true); setSessionId(sessionData.id); setStatus(sessionData.status); setTeamSize(sessionData.tamanho_time); setDuration(sessionData.duracao_partida_minutos)
      const { data: checkData } = await db.from('check_ins').select('*').eq('sessao_id', sessionData.id).order('horario_chegada')
      setCheckins((checkData ?? []) as CheckIn[])
      const { data: teamData } = await db.from('times').select('*, times_jogadores(participantes(*))').eq('sessao_id', sessionData.id).order('posicao_fila')
      if (teamData) setTeams(teamData.map((t) => ({ ...t, jogadores: t.times_jogadores.map((j: { participantes: Participante }) => j.participantes) })) as Time[])
      const { data: matchData } = await db.from('partidas').select('*').eq('sessao_id', sessionData.id).eq('status', 'em_andamento').maybeSingle()
      setMatch((matchData as Match | null) ?? null)
      await loadSessionEvents(sessionData.id)
      await loadSessionMatches(sessionData.id)
      if (sessionData.pendente_escolha_partida_id) {
        const { data: pendingData } = await db.from('partidas').select('*').eq('id', sessionData.pendente_escolha_partida_id).maybeSingle()
        setPendingDrawMatch((pendingData as Match | null) ?? null)
      } else setPendingDrawMatch(null)
    }
    load().catch(() => toast.error('Não foi possível carregar a sessão.'))
  }, [authEmail, papel, rachaAtivoId])

  useEffect(() => {
    if (!supabase || !sessionId || !sessionReady || !papel || papel === 'pendente') return
    const db = supabase
    const reloadTeams = async () => {
      const { data } = await db.from('times').select('*, times_jogadores(participantes(*))').eq('sessao_id', sessionId).order('posicao_fila')
      if (data) setTeams(data.map((t) => ({ ...t, jogadores: t.times_jogadores.map((j: { participantes: Participante }) => j.participantes) })) as Time[])
    }
    const reloadMatch = async () => {
      const { data: matchData } = await db.from('partidas').select('*').eq('sessao_id', sessionId).eq('status', 'em_andamento').maybeSingle()
      setMatch((matchData as Match | null) ?? null)
      await loadSessionEvents(sessionId)
    }
    let channel = db.channel(`sessao:${sessionId}:${match?.id ?? 'sem-partida'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'partidas', filter: `sessao_id=eq.${sessionId}` }, ({ new: next }) => {
        if (!next) return
        const incoming = next as Match
        if (incoming.status === 'em_andamento') {
          setMatch(incoming)
        } else { setMatch((old) => old?.id === incoming.id ? null : old); void loadSessionMatches(sessionId); void reloadPendingDraw(sessionId) }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'times', filter: `sessao_id=eq.${sessionId}` }, () => { void reloadTeams(); void reloadPendingDraw(sessionId) })
    if (match?.id) {
      channel = channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'eventos', filter: `partida_id=eq.${match.id}` }, ({ new: next }) => {
        const incoming = next as GolEvento
        if (incoming.partida_id !== match.id) return
        setEvents((old) => old.some((event) => event.id === incoming.id) ? old : [...old, incoming])
      })
    }
    channel.subscribe((subStatus) => {
      if (subStatus === 'SUBSCRIBED') { void reloadTeams(); void reloadMatch(); void loadSessionMatches(sessionId); void reloadPendingDraw(sessionId) }
    })
    return () => { db.removeChannel(channel) }
  }, [sessionId, sessionReady, match?.id, papel])

  const checkedPlayers = useMemo(() => checkins.map((c) => players.find((p) => p.id === c.participante_id)).filter(Boolean) as Participante[], [checkins, players])

  useEffect(() => {
    if (papel === 'normal' && view !== 'participantes' && view !== 'partida' && view !== 'historico') setView('partida')
  }, [papel, view])

  const navAll: { key: View; label: string; icon: typeof Users }[] = [
    { key: 'inicio', label: 'Visão geral', icon: LayoutDashboard }, { key: 'participantes', label: 'Participantes', icon: Users },
    { key: 'checkin', label: 'Check-in', icon: ClipboardCheck }, { key: 'sorteio', label: 'Sorteio', icon: Sparkles },
    { key: 'partida', label: 'Partida ao vivo', icon: Trophy },
    { key: 'historico', label: 'Histórico', icon: BarChart3 }, { key: 'aprovacoes', label: 'Aprovações', icon: UserCheck },
  ]
  const nav = papel === 'normal' ? navAll.filter((item) => item.key === 'participantes' || item.key === 'partida' || item.key === 'historico') : navAll

  const pageTitle: Record<View, string> = { inicio: 'Hoje é dia de jogo', participantes: 'Participantes', checkin: 'Check-in do dia', sorteio: 'Montar os times', partida: 'Partida ao vivo', historico: 'Estatísticas históricas', aprovacoes: 'Aprovações de acesso' }

  const rachaAtivoNome = memberships.find((m) => m.racha_id === rachaAtivoId)?.racha_nome ?? ''
  const rachasAprovados = memberships.filter((m) => m.papel !== 'pendente')

  if (loading) return <div className="grid min-h-screen place-items-center bg-ink text-white"><div className="text-center"><div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-lime" /><p className="font-bold">Preparando o campo...</p></div></div>
  if (hasSupabase && !authEmail) return <AuthScreen />
  if (hasSupabase && !rachaAtivoId) return <EscolherRacha memberships={memberships} onSolicitado={refreshMemberships} onEntrarEm={(id) => setRachaAtivoId(id)} />
  if (papel === 'pendente') return <PendingApproval email={authEmail} rachaNome={rachaAtivoNome} outrosAprovados={rachasAprovados} onCheck={refreshMemberships} onEntrarEm={(id) => setRachaAtivoId(id)} onEscolherOutro={() => setRachaAtivoId(null)} />

  return <div className="min-h-screen md:flex">
    <aside className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col bg-ink p-5 text-white transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0 ${mobileMenu ? 'translate-x-0' : '-translate-x-full'}`}>
      <button aria-label="Fechar menu" onClick={() => setMobileMenu(false)} className="absolute right-4 top-4 rounded-lg p-2 text-white/60 md:hidden"><X /></button>
      <div className="flex items-center gap-3 px-2 py-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-lime text-ink"><Shirt size={24} strokeWidth={2.5} /></div><div><p className="font-display text-lg font-black uppercase leading-none">Atos</p><p className="text-xs font-semibold tracking-[.24em] text-lime">FUTEBOL</p></div></div>
      <nav className="mt-7 space-y-1">{nav.map((item) => <button key={item.key} onClick={() => { setView(item.key); setMobileMenu(false) }} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-semibold transition ${view === item.key ? 'bg-white text-ink' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}><item.icon size={19} /><span>{item.label}</span>{view === item.key && <ChevronRight className="ml-auto" size={16} />}</button>)}</nav>
      {rachasAprovados.length > 1 && <select className="mt-4 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-sm font-bold text-white" value={rachaAtivoId ?? ''} onChange={(e) => setRachaAtivoId(e.target.value)}>{rachasAprovados.map((m) => <option key={m.racha_id} value={m.racha_id} className="text-ink">{m.racha_nome}</option>)}</select>}
      <div className="mt-auto rounded-2xl bg-white/7 p-4"><div className={`flex items-center gap-2 text-xs font-bold ${sessionReady ? 'text-lime' : 'text-white/45'}`}><span className={`h-2 w-2 rounded-full ${sessionReady ? 'live-dot bg-lime' : 'bg-white/25'}`} /> {sessionReady ? 'SESSÃO ATIVA' : 'AGUARDANDO SESSÃO'}</div><p className="mt-2 text-sm font-bold">{rachaAtivoNome || 'Pelada de hoje'}</p><p className="mt-1 text-xs text-white/45">{format(new Date(), "dd 'de' MMMM", { locale: ptBR })}{sessionReady ? ` · ${checkedPlayers.length} presentes` : ''}</p></div>
      <div className="mt-3 flex items-center justify-between gap-2 px-3 py-2"><button onClick={() => supabase?.auth.signOut()} className="flex min-w-0 items-center gap-2 text-xs text-white/40 hover:text-white"><LogOut size={14} /><span className="truncate">{authEmail}</span></button><span className="chip bg-white/10 text-[10px] uppercase text-white/55">{papel}</span></div>
    </aside>
    {mobileMenu && <button className="fixed inset-0 z-30 bg-ink/50 md:hidden" onClick={() => setMobileMenu(false)} aria-label="Fechar menu" />}

    <main className="min-w-0 flex-1">
      <header className="flex h-20 items-center justify-between border-b border-ink/8 px-4 md:px-8"><div className="flex items-center gap-3"><button className="rounded-xl bg-white p-2.5 shadow-sm md:hidden" onClick={() => setMobileMenu(true)} aria-label="Abrir menu"><Menu size={20} /></button>{view !== 'inicio' && <div><p className="text-[11px] font-extrabold uppercase tracking-[.15em] text-turf-600">Pelada de hoje</p><h1 className="text-lg font-extrabold md:text-xl">{pageTitle[view]}</h1></div>}</div><div className="hidden items-center gap-3 sm:flex"><span className={`chip ${hasSupabase ? 'bg-turf-100 text-turf-700' : 'bg-amber-100 text-amber-800'}`}>{hasSupabase ? <><span className="h-1.5 w-1.5 rounded-full bg-turf-500" /> Sincronizado</> : 'Modo demo'}</span></div></header>
      <div className="mx-auto max-w-[1440px] p-4 pb-24 md:p-8">
        {view === 'inicio' && <Dashboard players={players} checkins={checkins} teams={teams} match={match} setView={setView} />}
        {view === 'participantes' && <Participants players={players} setPlayers={setPlayers} papel={papel} userId={userId} rachaId={rachaAtivoId} fechamentos={fechamentos} />}
        {view === 'checkin' && <Checkin players={players} checkins={checkins} setCheckins={setCheckins} sessionId={sessionId} teamSize={teamSize} rachaId={rachaAtivoId} />}
        {view === 'sorteio' && <Draw players={players} checkins={checkins} setCheckins={setCheckins} teams={teams} setTeams={setTeams} teamSize={teamSize} setTeamSize={setTeamSize} sessionId={sessionId} setStatus={setStatus} status={status} goLive={() => setView('partida')} />}
        {view === 'partida' && (!sessionReady ? <WaitingSession /> : <LiveMatch readOnly={papel === 'normal'} teams={teams} setTeams={setTeams} players={players} match={match} setMatch={setMatch} events={events} setEvents={setEvents} sessionId={sessionId} rachaId={rachaAtivoId} duration={duration} status={status} sessionMatches={sessionMatches} pendingDrawMatch={pendingDrawMatch} setPendingDrawMatch={setPendingDrawMatch} onSessionFinished={() => { setStatus('finalizada'); setView('historico'); void startNewSession() }} onOpenDurationSettings={() => setShowSettings(true)} />)}
        {view === 'historico' && <HistoryPage players={players} rachaId={rachaAtivoId} />}
        {view === 'aprovacoes' && papel === 'admin' && rachaAtivoId && <Approvals rachaId={rachaAtivoId} rachaNome={rachaAtivoNome} />}
      </div>
    </main>
    {showSettings && <SessionSettingsModal duration={duration} sessionId={sessionId} onClose={() => setShowSettings(false)} onSaved={(newDuration) => { setDuration(newDuration); setShowSettings(false) }} />}
  </div>
}

function SessionSettingsModal({ duration, sessionId, onClose, onSaved }: { duration: number; sessionId: string; onClose: () => void; onSaved: (duration: number) => void }) {
  const [newDuration, setNewDuration] = useState(String(duration))
  const [saving, setSaving] = useState(false)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = Number(newDuration)
    if (!Number.isInteger(value) || value < 1 || value > 60) return toast.error('Informe uma duração entre 1 e 60 minutos.')
    setSaving(true)
    if (supabase) {
      const { error } = await supabase.from('sessoes').update({ duracao_partida_minutos: value }).eq('id', sessionId)
      if (error) {
        setSaving(false)
        toast.error(error.message)
        return
      }
    }
    onSaved(value)
    toast.success('Duração atualizada para a próxima partida!')
  }

  return <Modal title="Configurações da sessão" onClose={onClose}><form onSubmit={save}><label className="label" htmlFor="session-duration">Duração da partida (minutos)</label><input id="session-duration" className="input" type="number" inputMode="numeric" min={1} max={60} step={1} value={newDuration} onChange={(e) => setNewDuration(e.target.value)} required /><p className="mt-3 text-xs leading-relaxed text-ink/45">A mudança afeta somente a próxima partida a ser iniciada. A partida que já estiver em andamento mantém o tempo atual.</p><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={onClose} className="btn-soft w-full sm:w-auto">Cancelar</button><button disabled={saving} className="btn-primary w-full sm:w-auto"><Check size={17} /> {saving ? 'Salvando...' : 'Salvar'}</button></div></form></Modal>
}

function AuthScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [submitted, setSubmitted] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true)
    if (mode === 'login') {
      const { error } = await supabase!.auth.signInWithPassword({ email, password })
      setBusy(false)
      if (error) toast.error(error.message)
      else toast.success('Bem-vindo de volta!')
      return
    }
    const { data, error } = await supabase!.auth.signUp({ email, password })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    if (!data.session) {
      setSubmitted(true); setMode('login'); setPassword('')
      toast.success('Confirme seu e-mail e depois entre para escolher seu racha.')
      return
    }
    toast.success('Conta criada! Escolha o racha para pedir acesso.')
  }
  return <div className="grid min-h-screen bg-ink p-5 md:grid-cols-2"><div className="hidden overflow-hidden rounded-[32px] bg-turf-600 p-12 text-white md:flex md:flex-col md:justify-between"><div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-lime text-ink"><Shirt /></div><div><b className="font-display text-xl">ATOS</b><p className="text-xs tracking-[.2em] text-lime">FUTEBOL</p></div></div><div><p className="max-w-lg text-5xl font-black leading-[1.05]">Menos planilha.<br />Mais bola rolando.</p><p className="mt-5 max-w-md text-lg text-white/65">Organize a chegada, equilibre os times e acompanhe cada gol em tempo real.</p></div><p className="text-sm text-white/45">Gestão da pelada, do check-in à resenha.</p></div><div className="grid place-items-center p-4"><div className="w-full max-w-sm"><form onSubmit={submit} className="w-full text-white"><div className="mb-9 md:hidden"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-lime text-ink"><Shirt /></div></div><p className="text-xs font-bold uppercase tracking-[.2em] text-lime">Acesso à pelada</p><h1 className="mt-2 text-3xl font-black">{mode === 'login' ? 'Entre para acompanhar' : 'Crie sua conta'}</h1><p className="mt-2 text-sm text-white/45">{mode === 'login' ? 'Acompanhe a partida e o histórico do grupo.' : 'Depois você escolhe o racha e pede acesso ao organizador.'}</p><div className="mt-7 grid grid-cols-2 rounded-xl bg-white/8 p-1"><button type="button" onClick={() => setMode('login')} className={`rounded-lg px-3 py-2.5 text-sm font-bold transition ${mode === 'login' ? 'bg-white text-ink' : 'text-white/50'}`}>Entrar</button><button type="button" onClick={() => setMode('signup')} className={`rounded-lg px-3 py-2.5 text-sm font-bold transition ${mode === 'signup' ? 'bg-white text-ink' : 'text-white/50'}`}>Criar conta</button></div>{submitted && mode === 'login' && <div className="mt-5 rounded-xl border border-lime/30 bg-lime/10 p-3 text-sm font-semibold text-lime">Cadastro enviado! Confirme seu e-mail e entre para escolher seu racha.</div>}<label className="label mt-6 !text-white/50">E-mail</label><input className="input !border-white/15 !bg-white/10 !text-white" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /><label className="label mt-4 !text-white/50">Senha</label><input className="input !border-white/15 !bg-white/10 !text-white" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} required /><button className="btn-lime mt-6 w-full" disabled={busy}>{busy ? 'Aguarde...' : mode === 'login' ? 'Entrar' : 'Criar conta'} <ChevronRight size={18} /></button></form><div className="mt-5 space-y-3"><PromoBanner text="Quer implementar IA na sua empresa? Clique aqui." /><WhatsAppButton /></div></div></div></div>
}

function EscolherRacha({ memberships, onSolicitado, onEntrarEm }: { memberships: RachaMembro[]; onSolicitado: () => Promise<void>; onEntrarEm: (rachaId: string) => void }) {
  const [rachas, setRachas] = useState<Racha[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase.from('rachas').select('id, nome').order('nome').then(({ data, error }) => {
      if (error) toast.error('Não foi possível carregar os rachas.')
      setRachas((data ?? []) as Racha[])
      setLoading(false)
    })
  }, [])

  const solicitar = async (racha: Racha) => {
    if (!supabase) return
    setBusyId(racha.id)
    const { error } = await supabase.rpc('solicitar_acesso_racha', { p_racha_id: racha.id })
    setBusyId(null)
    if (error) return toast.error(error.message)
    toast.success(`Solicitação enviada para ${racha.nome}!`)
    await onSolicitado()
  }

  const jaVinculados = new Set(memberships.map((m) => m.racha_id))
  const disponiveis = rachas.filter((r) => !jaVinculados.has(r.id) && r.nome.toLowerCase().includes(search.toLowerCase()))

  return <div className="grid min-h-screen place-items-center bg-ink p-5 text-white"><div className="w-full max-w-lg"><div className="text-center"><div className="mx-auto grid h-20 w-20 place-items-center rounded-[28px] bg-lime text-ink"><Shirt size={32} /></div><span className="chip mt-6 bg-white/8 text-white/60">ÚLTIMO PASSO</span><h1 className="mt-4 text-3xl font-black md:text-4xl">Escolha seu racha</h1><p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/50">Pesquise pelo nome da pelada e peça acesso. O organizador libera sua entrada.</p></div>
    {memberships.length > 0 && <div className="mt-6 space-y-2">{memberships.map((m) => <div key={m.racha_id} className="flex items-center justify-between gap-3 rounded-xl bg-white/8 px-4 py-3 text-sm"><span className="font-bold">{m.racha_nome}</span>{m.papel === 'pendente' ? <span className="chip bg-amber-400/20 text-amber-200">Aguardando aprovação</span> : <button onClick={() => onEntrarEm(m.racha_id)} className="btn-lime !min-h-9 !px-4 !py-1.5">Entrar</button>}</div>)}</div>}
    <div className="relative mt-6"><Search className="absolute left-3 top-3.5 text-white/35" size={18} /><input className="input pl-10 !border-white/15 !bg-white/10 !text-white" placeholder="Buscar racha pelo nome..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
    <div className="mt-3 max-h-72 space-y-2 overflow-auto">{loading ? <div className="grid min-h-24 place-items-center"><div className="h-7 w-7 animate-spin rounded-full border-4 border-white/15 border-t-lime" /></div> : disponiveis.length ? disponiveis.map((r) => <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 px-4 py-3 text-sm"><span className="font-bold">{r.nome}</span><button disabled={busyId === r.id} onClick={() => solicitar(r)} className="btn-soft !min-h-9 !bg-white/10 !px-4 !py-1.5 !text-white">{busyId === r.id ? 'Enviando...' : 'Solicitar acesso'}</button></div>) : <p className="py-6 text-center text-sm text-white/40">Nenhum racha encontrado com esse nome.</p>}</div>
    <button onClick={() => supabase?.auth.signOut()} className="btn mt-6 w-full !bg-white/8 !text-white hover:!bg-white/12"><LogOut size={16} /> Sair</button>
  </div></div>
}

function PendingApproval({ email, rachaNome, outrosAprovados, onCheck, onEntrarEm, onEscolherOutro }: { email: string | null; rachaNome: string; outrosAprovados: RachaMembro[]; onCheck: () => Promise<void>; onEntrarEm: (rachaId: string) => void; onEscolherOutro: () => void }) {
  const [checking, setChecking] = useState(false)
  const check = async () => { setChecking(true); await onCheck(); setChecking(false) }
  return <div className="grid min-h-screen place-items-center bg-ink p-5 text-white"><div className="w-full max-w-lg text-center"><div className="mx-auto grid h-24 w-24 place-items-center rounded-[32px] bg-lime/15 text-lime"><Hourglass size={42} /></div><span className="chip mt-7 bg-white/8 text-white/60">CADASTRO RECEBIDO</span><h1 className="mt-4 text-3xl font-black md:text-4xl">Seu acesso a {rachaNome} está em análise</h1><p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-white/50">O organizador recebeu sua solicitação. Quando ela for aprovada, você poderá acompanhar a partida ao vivo e consultar o histórico.</p>{email && <div className="mx-auto mt-6 flex max-w-sm items-center justify-center gap-2 rounded-xl bg-white/5 px-4 py-3 text-sm text-white/60"><Mail size={16} /> {email}</div>}<div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row"><button onClick={check} disabled={checking} className="btn-lime"><RefreshCw className={checking ? 'animate-spin' : ''} size={17} /> {checking ? 'Verificando...' : 'Verificar aprovação'}</button><button onClick={() => supabase?.auth.signOut()} className="btn !bg-white/8 !text-white hover:!bg-white/12"><LogOut size={16} /> Sair</button></div>{outrosAprovados.length > 0 && <button onClick={() => onEntrarEm(outrosAprovados[0].racha_id)} className="mt-4 text-sm font-semibold text-lime underline decoration-dotted underline-offset-4">Usar {outrosAprovados[0].racha_nome} enquanto isso</button>}<button onClick={onEscolherOutro} className="mt-3 block w-full text-xs font-semibold text-white/35 underline decoration-dotted underline-offset-4">Pedir acesso a outro racha</button><div className="mt-6 space-y-3 text-left"><PromoBanner text="Quer implementar IA na sua empresa? Clique aqui." /><WhatsAppButton /></div></div></div>
}

function Approvals({ rachaId, rachaNome }: { rachaId: string; rachaNome: string }) {
  const [profiles, setProfiles] = useState<PerfilPendente[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [roles, setRoles] = useState<Record<string, 'normal' | 'admin'>>({})
  const load = async () => {
    if (!supabase) return
    setLoading(true)
    const { data, error } = await supabase.from('racha_membros').select('perfil_id, criado_em, perfis(email)').eq('racha_id', rachaId).eq('papel', 'pendente').order('criado_em')
    if (error) toast.error('Não foi possível carregar as aprovações.')
    else setProfiles((data ?? []).map((row) => {
      const linha = row as unknown as { perfil_id: string; criado_em: string; perfis: { email: string | null } | null }
      return { id: linha.perfil_id, email: linha.perfis?.email ?? null, criado_em: linha.criado_em }
    }))
    setLoading(false)
  }
  useEffect(() => { void load() }, [rachaId])
  const approve = async (profile: PerfilPendente) => {
    if (!supabase) return
    setBusy(profile.id)
    const papel = roles[profile.id] ?? 'normal'
    const { error } = await supabase.functions.invoke('aprovar-cadastro', { body: { usuario_id: profile.id, racha_id: rachaId, papel } })
    setBusy(null)
    if (error) return toast.error('Não foi possível aprovar este cadastro.')
    setProfiles((old) => old.filter((item) => item.id !== profile.id)); toast.success(`${profile.email ?? 'Usuário'} aprovado!`)
  }
  const reject = async (profile: PerfilPendente) => {
    if (!supabase || !window.confirm(`Rejeitar ${profile.email ?? 'este cadastro'} em ${rachaNome}?`)) return
    setBusy(profile.id)
    const { error } = await supabase.functions.invoke('rejeitar-cadastro', { body: { usuario_id: profile.id, racha_id: rachaId } })
    setBusy(null)
    if (error) return toast.error('Não foi possível rejeitar este cadastro.')
    setProfiles((old) => old.filter((item) => item.id !== profile.id)); toast.success('Solicitação rejeitada.')
  }
  return <div><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-sm text-ink/45">Libere somente as pessoas que fazem parte de {rachaNome}.</p><span className="chip mt-3 bg-amber-100 text-amber-800"><Hourglass size={13} /> {profiles.length} aguardando</span></div><button onClick={load} disabled={loading} className="btn-soft"><RefreshCw className={loading ? 'animate-spin' : ''} size={16} /> Atualizar</button></div><div className="panel mt-5 overflow-hidden"><div className="border-b border-ink/8 p-5"><p className="font-extrabold">Solicitações pendentes</p><p className="mt-1 text-xs text-ink/40">A aprovação libera apenas a visualização da partida e do histórico.</p></div>{loading ? <div className="grid min-h-52 place-items-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-ink/10 border-t-turf-500" /></div> : profiles.length ? <div className="divide-y divide-ink/7">{profiles.map((profile) => <div key={profile.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center"><div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-800"><Mail size={19} /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{profile.email ?? 'E-mail não informado'}</p><p className="mt-1 text-xs text-ink/40">Solicitado {formatDistanceToNow(new Date(profile.criado_em), { addSuffix: true, locale: ptBR })}</p></div><select value={roles[profile.id] ?? 'normal'} onChange={(e) => setRoles((old) => ({ ...old, [profile.id]: e.target.value as 'normal' | 'admin' }))} className="input !min-h-9 !w-auto !py-1 text-xs"><option value="normal">Jogador</option><option value="admin">Administrador</option></select><div className="flex gap-2"><button disabled={busy === profile.id} onClick={() => reject(profile)} className="btn-soft flex-1 text-red-600 sm:flex-none"><UserX size={16} /> Rejeitar</button><button disabled={busy === profile.id} onClick={() => approve(profile)} className="btn-primary flex-1 sm:flex-none"><UserCheck size={16} /> Aprovar</button></div></div>)}</div> : <EmptyState icon={UserCheck} title="Tudo em dia" text="Não há novos cadastros aguardando sua decisão." />}</div></div>
}

function Dashboard({ players, checkins, teams, match, setView }: { players: Participante[]; checkins: CheckIn[]; teams: Time[]; match: Match | null; setView: (v: View) => void }) {
  const cards = [
    { label: 'Presentes hoje', value: checkins.length, detail: `de ${players.filter((p) => p.ativo).length} ativos`, icon: ClipboardCheck, tone: 'bg-turf-100 text-turf-700' },
    { label: 'Times formados', value: teams.length, detail: teams.length ? `${teams.filter((t) => t.posicao_fila > 2).length} na fila` : 'aguardando sorteio', icon: Shirt, tone: 'bg-blue-100 text-blue-700' },
    { label: 'Gols na partida', value: match ? match.placar_a + match.placar_b : 0, detail: match ? `${match.placar_a} × ${match.placar_b}` : 'nenhuma em andamento', icon: Trophy, tone: 'bg-orange/15 text-orange' },
  ]
  return <div><div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]"><section className="relative overflow-hidden rounded-[28px] bg-ink p-6 text-white md:p-10"><div className="absolute -right-12 -top-16 h-64 w-64 rounded-full border-[44px] border-lime/10" /><div className="relative max-w-2xl"><span className="chip bg-lime/15 text-lime"><CalendarDays size={13} /> {format(new Date(), "EEEE, dd 'de' MMMM", { locale: ptBR })}</span><h2 className="mt-5 text-3xl font-black tracking-tight md:text-5xl">Tudo pronto para<br /><span className="text-lime">a bola rolar?</span></h2><p className="mt-4 max-w-lg text-sm leading-relaxed text-white/55 md:text-base">Faça o check-in de quem chegou. Quando der a hora, a gente equilibra os times e organiza a fila.</p><button onClick={() => setView('checkin')} className="btn-lime mt-7">Abrir check-in <ChevronRight size={18} /></button></div></section><PromoBanner text="Quer implementar IA na sua empresa? Clique aqui." /></div>
    <div className="mt-5 grid gap-4 sm:grid-cols-3">{cards.map((card) => <div key={card.label} className="panel flex items-center gap-4 p-5"><div className={`grid h-12 w-12 place-items-center rounded-2xl ${card.tone}`}><card.icon size={22} /></div><div><p className="text-2xl font-black">{card.value}</p><p className="text-sm font-bold">{card.label}</p><p className="text-xs text-ink/40">{card.detail}</p></div></div>)}</div>
    <div className="mt-5 grid gap-5 lg:grid-cols-[1.3fr_.7fr]"><div className="panel p-5 md:p-6"><div className="flex items-center justify-between"><div><p className="text-lg font-extrabold">Próximos passos</p><p className="text-sm text-ink/45">O fluxo de hoje, sem complicação.</p></div><span className="chip bg-ink/5 text-ink/55">{teams.length ? '2 de 3' : '1 de 3'}</span></div><div className="mt-5 space-y-2">{[{ title: 'Confirmar quem chegou', text: `${checkins.length} presenças marcadas`, done: checkins.length >= 12, view: 'checkin' as View }, { title: 'Sortear times equilibrados', text: teams.length ? `${teams.length} times confirmados` : 'Mínimo de dois times', done: teams.length >= 2, view: 'sorteio' as View }, { title: 'Iniciar primeira partida', text: match ? 'Partida em andamento' : 'Times 1 e 2 abrem a rodada', done: Boolean(match), view: 'partida' as View }].map((step, i) => <button onClick={() => setView(step.view)} key={step.title} className="flex w-full items-center gap-4 rounded-2xl p-3 text-left hover:bg-ink/[.035]"><span className={`grid h-9 w-9 place-items-center rounded-full text-sm font-black ${step.done ? 'bg-turf-500 text-white' : 'bg-ink/5 text-ink/45'}`}>{step.done ? <Check size={17} /> : i + 1}</span><span><b className="block text-sm">{step.title}</b><span className="text-xs text-ink/40">{step.text}</span></span><ChevronRight className="ml-auto text-ink/25" size={18} /></button>)}</div></div><div className="panel bg-turf-600 p-6 text-white"><Clock3 className="text-lime" /><p className="mt-8 text-xs font-bold uppercase tracking-[.18em] text-white/50">Horário do sorteio</p><p className="mt-1 text-4xl font-black">18:45</p><p className="mt-2 text-sm text-white/55">Você decide quando disparar. A ordem de chegada define a prioridade.</p><button onClick={() => setView('sorteio')} className="mt-5 text-sm font-bold text-lime">Ir para o sorteio →</button></div></div>
  </div>
}

// Não existe ação manual de fechar o mês, de propósito. Fechar antes da hora
// deixaria os domingos restantes daquele mês gravados mas nunca contados, sem
// aviso nenhum. O fechamento é só automático, na abertura da primeira sessão do
// mês seguinte, e se falhar ele é retentado a cada nova sessão criada.
function Participants({ players, setPlayers, papel, userId, rachaId, fechamentos }: { players: Participante[]; setPlayers: React.Dispatch<React.SetStateAction<Participante[]>>; papel: Papel | null; userId: string | null; rachaId: string | null; fechamentos: Record<string, Fechamento> }) {
  const blank = { nome: '', apelido: '', estrelas: 3, posicao: 'qualquer' as Posicao, foto_url: '', estrelas_travadas: false }
  const [form, setForm] = useState(blank)
  const [photo, setPhoto] = useState<File | null>(null)
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const meuParticipante = userId ? players.find((p) => p.perfil_id === userId) : undefined

  const closeModal = () => { setOpen(false); setEditingId(null); setForm(blank); setPhoto(null) }
  const openNew = () => { setForm(blank); setPhoto(null); setEditingId(null); setOpen(true) }
  const openEdit = (p: Participante) => { setForm({ nome: p.nome, apelido: p.apelido ?? '', estrelas: p.estrelas, posicao: p.posicao, foto_url: p.foto_url ?? '', estrelas_travadas: p.estrelas_travadas ?? false }); setPhoto(null); setEditingId(p.id); setOpen(true) }

  const resolvePhotoUrl = async () => {
    let photoUrl = form.foto_url || null
    if (supabase && photo) {
      const path = `${uid()}-${photo.name.replace(/[^a-zA-Z0-9._-]/g, '')}`
      const upload = await supabase.storage.from('participantes').upload(path, photo, { upsert: false })
      if (upload.error) throw new Error(`Falha na foto: ${upload.error.message}`)
      photoUrl = supabase.storage.from('participantes').getPublicUrl(path).data.publicUrl
    } else if (!supabase && photo) photoUrl = URL.createObjectURL(photo)
    return photoUrl
  }

  const saveAdmin = async (e: React.FormEvent) => {
    e.preventDefault()
    const nome = form.nome.trim()
    if (!nome) return
    try {
      const photoUrl = await resolvePhotoUrl()
      if (editingId) {
        const patch = { nome, apelido: form.apelido || null, estrelas: form.estrelas, posicao: form.posicao, foto_url: photoUrl, estrelas_travadas: form.estrelas_travadas }
        if (supabase) {
          const { data, error } = await supabase.from('participantes').update(patch).eq('id', editingId).select().single()
          if (error) throw new Error(error.message)
          setPlayers((old) => old.map((x) => x.id === editingId ? (data as Participante) : x))
        } else setPlayers((old) => old.map((x) => x.id === editingId ? { ...x, ...patch } : x))
        toast.success('Participante atualizado!')
      } else {
        const player: Participante = { id: uid(), perfil_id: null, nome, apelido: form.apelido || null, estrelas: form.estrelas, posicao: form.posicao, foto_url: photoUrl, ativo: true }
        if (supabase) {
          if (!rachaId) throw new Error('Racha não identificado.')
          const { data, error } = await supabase.from('participantes').insert({ racha_id: rachaId, nome: player.nome, apelido: player.apelido, estrelas: player.estrelas, posicao: player.posicao, foto_url: player.foto_url }).select().single()
          if (error) throw new Error(error.message)
          setPlayers((old) => [...old, data as Participante])
        } else setPlayers((old) => [...old, player])
        toast.success('Participante adicionado!')
      }
      closeModal()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível salvar o participante.')
    }
  }

  const saveSelf = async (e: React.FormEvent) => {
    e.preventDefault()
    if (meuParticipante) return
    if (!userId) return toast.error('Não foi possível identificar o usuário autenticado.')
    const nome = form.nome.trim()
    if (!nome) return
    setSaving(true)
    try {
      const photoUrl = await resolvePhotoUrl()
      const player: Participante = { id: uid(), perfil_id: userId, nome, apelido: form.apelido || null, estrelas: 3, posicao: form.posicao, foto_url: photoUrl, ativo: true }
      if (supabase) {
        if (!rachaId) throw new Error('Racha não identificado.')
        const { data, error } = await supabase.from('participantes').insert({ racha_id: rachaId, nome: player.nome, apelido: player.apelido, posicao: player.posicao, foto_url: player.foto_url, estrelas: 3, perfil_id: userId }).select().single()
        if (error) throw new Error(error.message)
        setPlayers((old) => old.some((p) => p.perfil_id === userId) ? old : [...old, data as Participante])
      } else setPlayers((old) => old.some((p) => p.perfil_id === userId) ? old : [...old, player])
      setForm(blank); setPhoto(null); toast.success('Seu perfil de jogador foi criado!')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível criar seu perfil de jogador.')
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (p: Participante) => { const previous = p.ativo; setPlayers((old) => old.map((x) => x.id === p.id ? { ...x, ativo: !x.ativo } : x)); if (supabase) { const { error } = await supabase.from('participantes').update({ ativo: !p.ativo }).eq('id', p.id); if (error) { setPlayers((old) => old.map((x) => x.id === p.id ? { ...x, ativo: previous } : x)); toast.error(error.message) } } }
  const visible = players.filter((p) => p.nome.toLowerCase().includes(search.toLowerCase()))

  if (papel === 'normal') return <div className="mx-auto max-w-2xl">
    {meuParticipante ? <div className="panel overflow-hidden"><div className="border-b border-ink/8 bg-turf-50 p-5"><p className="text-lg font-extrabold">Seu perfil de jogador</p><p className="mt-1 text-sm text-ink/45">Este é o perfil vinculado à sua conta.</p></div><div className="flex items-center gap-5 p-6"><Avatar player={meuParticipante} size="lg" ring="#1FB8AE" /><div className="min-w-0"><p className="truncate text-xl font-black">{meuParticipante.nome}</p><p className="mt-1 text-sm font-semibold text-ink/50">{positionLabel[meuParticipante.posicao]}</p><div className="mt-2 flex flex-wrap items-center gap-2"><Stars value={meuParticipante.estrelas} />{meuParticipante.estrelas_travadas ? <span className="chip bg-ink/5 text-ink/45"><Lock size={10} /> Congelado</span> : <Trend fechamento={fechamentos[meuParticipante.id]} />}</div><p className="mt-2 text-xs leading-relaxed text-ink/40">Seu nível é recalculado uma vez por mês, com base no desempenho de todos os domingos que você jogou.</p></div></div></div> : <div className="panel overflow-hidden"><div className="border-b border-ink/8 bg-turf-50 p-5"><p className="text-lg font-extrabold">Crie seu perfil de jogador</p><p className="mt-1 text-sm text-ink/45">Preencha seus dados uma única vez para entrar no elenco.</p></div><form onSubmit={saveSelf} className="p-5 md:p-6"><label className="label">Nome completo</label><input autoFocus className="input" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex: Carlos Eduardo" required /><label className="label mt-4">Apelido</label><input className="input" value={form.apelido} onChange={(e) => setForm({ ...form, apelido: e.target.value })} placeholder="Ex: Cadu" required /><p className="mt-1 text-xs text-ink/40">É o nome mostrado no campo durante a partida ao vivo.</p><label className="label mt-4">Posição</label><select className="input" value={form.posicao} onChange={(e) => setForm({ ...form, posicao: e.target.value as Posicao })}>{Object.entries(positionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><label className="label mt-4">Foto <span className="normal-case tracking-normal text-ink/30">(opcional)</span></label><label className="flex min-h-20 cursor-pointer items-center justify-center rounded-xl border border-dashed border-ink/20 bg-ink/[.02] px-4 text-center text-sm font-semibold text-ink/50 hover:bg-turf-50"><input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />{photo ? photo.name : 'Escolher foto do celular'}</label><button disabled={saving} className="btn-primary mt-6 w-full"><Check size={17} /> {saving ? 'Salvando...' : 'Criar meu perfil'}</button></form></div>}
  </div>

  return <div><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-sm text-ink/45">Cadastre e mantenha o elenco da pelada atualizado.</p><div className="mt-3 flex flex-wrap gap-2"><span className="chip bg-turf-100 text-turf-700">{players.filter((p) => p.ativo).length} ativos</span><span className="chip bg-ink/5 text-ink/50">{players.filter((p) => !p.ativo).length} inativos</span><span className="chip bg-amber-100 text-amber-800" title="O nível de cada jogador é recalculado sozinho no fechamento do mês">Níveis automáticos</span></div></div><button onClick={openNew} className="btn-primary"><UserPlus size={18} /> Novo participante</button></div>
    <div className="panel mt-5 overflow-hidden"><div className="flex flex-col gap-3 border-b border-ink/8 p-4 sm:flex-row sm:items-center"><div className="relative max-w-md flex-1"><Search className="absolute left-3 top-3.5 text-ink/35" size={18} /><input className="input pl-10" placeholder="Buscar por nome..." value={search} onChange={(e) => setSearch(e.target.value)} /></div><span className="text-xs font-semibold text-ink/40">{visible.length} participantes</span></div><div className="divide-y divide-ink/7">{visible.map((p) => <div key={p.id} className={`flex items-center gap-3 p-4 transition ${!p.ativo ? 'opacity-45' : 'hover:bg-ink/[.02]'}`}><Avatar player={p} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{p.nome}</p><div className="mt-1 flex flex-wrap items-center gap-2"><span className="text-xs text-ink/45">{positionLabel[p.posicao]}</span><Stars value={p.estrelas} />{p.estrelas_travadas ? <span className="chip bg-ink/5 text-ink/45" title="Nível congelado: o fechamento mensal não mexe nele"><Lock size={10} /> Congelado</span> : <Trend fechamento={fechamentos[p.id]} />}</div></div><span className={`hidden sm:inline-flex chip ${p.ativo ? 'bg-turf-100 text-turf-700' : 'bg-ink/5 text-ink/45'}`}>{p.ativo ? 'Ativo' : 'Inativo'}</span><button onClick={() => openEdit(p)} className="btn-soft !min-h-9 !px-3" title="Editar"><Pencil size={15} /></button><button onClick={() => toggle(p)} className="btn-soft !min-h-9 !px-3" title={p.ativo ? 'Desativar' : 'Reativar'}>{p.ativo ? <Trash2 size={15} /> : <RotateCcw size={15} />}</button></div>)}</div></div>
    {open && <Modal title={editingId ? 'Editar participante' : 'Novo participante'} onClose={closeModal}><form onSubmit={saveAdmin}><label className="label">Nome completo</label><input autoFocus className="input" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex: Carlos Eduardo" required /><label className="label mt-4">Apelido <span className="normal-case tracking-normal text-ink/30">(opcional)</span></label><input className="input" value={form.apelido} onChange={(e) => setForm({ ...form, apelido: e.target.value })} placeholder="Ex: Cadu" /><div className="mt-4 grid grid-cols-2 gap-3"><div><label className="label">Posição</label><select className="input" value={form.posicao} onChange={(e) => setForm({ ...form, posicao: e.target.value as Posicao })}>{Object.entries(positionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div><label className="label">Nível inicial</label><select className="input" value={form.estrelas} onChange={(e) => setForm({ ...form, estrelas: Number(e.target.value) })}>{[1,2,3,4,5].map((n) => <option key={n} value={n}>{'★'.repeat(n)} ({n})</option>)}</select></div></div><p className="mt-2 text-xs leading-relaxed text-ink/45">{editingId ? 'Mudar o nível aqui reposiciona o jogador no meio da nova faixa e descarta o histórico de pontuação dele.' : 'É só o ponto de partida. A partir do primeiro fechamento mensal, o nível sobe ou desce sozinho conforme o desempenho.'}</p><label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-ink/10 bg-ink/[.02] p-3.5"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-turf-500" checked={form.estrelas_travadas} onChange={(e) => setForm({ ...form, estrelas_travadas: e.target.checked })} /><span><span className="block text-sm font-bold">Congelar o nível deste jogador</span><span className="mt-0.5 block text-xs leading-relaxed text-ink/45">O desempenho continua sendo registrado, mas o fechamento mensal não mexe no nível. Útil para quem está voltando de lesão.</span></span></label><label className="label mt-4">Foto <span className="normal-case tracking-normal text-ink/30">(opcional)</span></label><label className="flex min-h-20 cursor-pointer items-center justify-center rounded-xl border border-dashed border-ink/20 bg-ink/[.02] px-4 text-center text-sm font-semibold text-ink/50 hover:bg-turf-50"><input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />{photo ? photo.name : 'Escolher foto do celular'}</label><div className="mt-6 flex justify-end gap-2"><button type="button" className="btn-soft" onClick={closeModal}>Cancelar</button><button className="btn-primary"><Check size={17} /> {editingId ? 'Salvar alterações' : 'Salvar'}</button></div></form></Modal>}
  </div>
}

function Checkin({ players, checkins, setCheckins, sessionId, teamSize, rachaId }: { players: Participante[]; checkins: CheckIn[]; setCheckins: React.Dispatch<React.SetStateAction<CheckIn[]>>; sessionId: string; teamSize: number; rachaId: string | null }) {
  const [search, setSearch] = useState(''); const ids = new Set(checkins.map((c) => c.participante_id))
  const toggle = async (p: Participante) => { const existing = checkins.find((c) => c.participante_id === p.id); if (existing) { setCheckins((old) => old.filter((c) => c.id !== existing.id)); if (supabase) { const { error } = await supabase.from('check_ins').delete().eq('id', existing.id); if (error) { setCheckins((old) => [...old, existing]); return toast.error(error.message) } } toast('Check-in desmarcado') } else { const item = { id: uid(), participante_id: p.id, horario_chegada: new Date().toISOString(), alocado: false }; if (supabase) { if (!rachaId) return toast.error('Racha não identificado.'); const { data, error } = await supabase.from('check_ins').insert({ sessao_id: sessionId, racha_id: rachaId, participante_id: p.id }).select().single(); if (error) return toast.error(error.message); setCheckins((old) => [...old, data as CheckIn]) } else setCheckins((old) => [...old, item]); toast.success(`${p.nome} chegou!`) } }
  const ordered = players.filter((p) => p.ativo && p.nome.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(ids.has(b.id)) - Number(ids.has(a.id)))
  return <div><div className="grid gap-4 sm:grid-cols-3"><div className="panel col-span-2 flex items-center gap-4 p-5"><div className="grid h-14 w-14 place-items-center rounded-2xl bg-turf-100 text-turf-700"><ClipboardCheck size={27} /></div><div><p className="text-3xl font-black">{checkins.length}</p><p className="text-sm font-bold">jogadores presentes</p><p className="text-xs text-ink/40">{Math.floor(checkins.length / teamSize)} times de {teamSize} na linha possíveis</p></div></div><div className="panel hidden items-center gap-3 p-5 sm:flex"><Clock3 className="text-orange" /><div><p className="text-sm font-bold">Ordem de chegada</p><p className="text-xs text-ink/40">Usada como prioridade</p></div></div></div>
    <div className="panel mt-5 overflow-hidden"><div className="border-b border-ink/8 p-4"><div className="relative max-w-md"><Search className="absolute left-3 top-3.5 text-ink/35" size={18} /><input className="input pl-10" placeholder="Quem acabou de chegar?" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div><div className="grid gap-px bg-ink/7 md:grid-cols-2">{ordered.map((p) => { const check = checkins.find((c) => c.participante_id === p.id); return <button key={p.id} onClick={() => toggle(p)} className={`flex items-center gap-3 bg-white p-4 text-left transition hover:bg-turf-50 ${check ? 'ring-2 ring-inset ring-turf-500/20' : ''}`}><Avatar player={p} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{p.nome}</p><p className="mt-1 text-xs text-ink/40">{positionLabel[p.posicao]} · {p.estrelas} estrelas</p></div>{check ? <div className="text-right"><span className="inline-grid h-8 w-8 place-items-center rounded-full bg-turf-500 text-white"><Check size={17} /></span><p className="mt-1 text-[10px] font-bold text-turf-700">{format(new Date(check.horario_chegada), 'HH:mm')}</p></div> : <span className="grid h-8 w-8 place-items-center rounded-full bg-ink/5 text-ink/30"><Plus size={17} /></span>}</button> })}</div></div>
  </div>
}

function selectDrawParticipants(available: Participante[], teamSize: number, count: number) {
  if (!count) return []
  const selected = available.slice(0, count * teamSize)
  for (const player of available.slice(selected.length)) {
    const keeperSlots = Math.min(count, selected.filter((item) => item.posicao === 'goleiro').length)
    const capacity = count * teamSize + keeperSlots
    const opensKeeperSlot = player.posicao === 'goleiro' && keeperSlots < count
    if (selected.length < capacity || opensKeeperSlot) selected.push(player)
    else break
  }
  return selected
}

function shuffleEqualStarGroups(players: Participante[]) {
  const sorted = [...players].sort((a, b) => b.estrelas - a.estrelas)
  const shuffled: Participante[] = []
  let start = 0
  while (start < sorted.length) {
    let end = start + 1
    while (end < sorted.length && sorted[end].estrelas === sorted[start].estrelas) end++
    const group = sorted.slice(start, end)
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[group[i], group[j]] = [group[j], group[i]]
    }
    shuffled.push(...group)
    start = end
  }
  return shuffled
}

function serpentineDraw(available: Participante[], teamSize: number): Time[] {
  const count = Math.floor(available.length / teamSize)
  if (count < 2) return []
  const selected = selectDrawParticipants(available, teamSize, count)
  const result: Time[] = Array.from({ length: count }, (_, i) => ({ id: uid(), numero: i + 1, posicao_fila: i + 1, status: i < 2 ? 'jogando' as const : 'na_fila' as const, forca_media: null, jogadores: [] as Participante[] }))
  const keepers = shuffleEqualStarGroups(selected.filter((p) => p.posicao === 'goleiro'))
  const used = new Set<string>()
  const hasKeeper = result.map(() => false)
  for (let i = 0; i < Math.min(keepers.length, count); i++) { result[i].jogadores.push(keepers[i]); hasKeeper[i] = true; used.add(keepers[i].id) }
  const caps = result.map((_, index) => teamSize + (hasKeeper[index] ? 1 : 0))
  const field = shuffleEqualStarGroups(selected.filter((p) => !used.has(p.id)))
  let index = 0
  let direction = 1
  const advance = () => {
    index += direction
    if (index >= count) { index = count - 1; direction = -1 }
    else if (index < 0) { index = 0; direction = 1 }
  }
  for (const player of field) {
    const visited = new Set<number>()
    while (result[index].jogadores.length >= caps[index] && visited.size < count) { visited.add(index); advance() }
    if (result[index].jogadores.length >= caps[index]) break
    result[index].jogadores.push(player)
    advance()
  }
  result.forEach((team) => { team.forca_media = Number((team.jogadores.reduce((sum, player) => sum + player.estrelas, 0) / team.jogadores.length).toFixed(2)) })
  return result
}

function Draw({ players, checkins, setCheckins, teams, setTeams, teamSize, setTeamSize, sessionId, setStatus, status, goLive }: { players: Participante[]; checkins: CheckIn[]; setCheckins: React.Dispatch<React.SetStateAction<CheckIn[]>>; teams: Time[]; setTeams: React.Dispatch<React.SetStateAction<Time[]>>; teamSize: number; setTeamSize: (n: number) => void; sessionId: string; setStatus: (s: SessionStatus) => void; status: SessionStatus; goLive: () => void }) {
  const available = checkins.filter((c) => !c.alocado).sort((a,b) => +new Date(a.horario_chegada) - +new Date(b.horario_chegada)).map((c) => players.find((p) => p.id === c.participante_id)).filter(Boolean) as Participante[]
  const pool = teams.length ? checkins.map((c) => players.find((p) => p.id === c.participante_id)!).filter(Boolean) : available
  const possible = Math.floor(pool.length / teamSize)
  const reserves = pool.length - selectDrawParticipants(pool, teamSize, possible).length
  const reservePlayers = teams.length ? pool.filter((p) => !teams.some((t) => t.jogadores.some((j) => j.id === p.id))) : []
  const drawLocked = status === 'em_andamento'
  const changeTeamSize = async (n: number) => {
    if (drawLocked || n === teamSize) return
    setTeamSize(n)
    if (supabase) {
      const { error } = await supabase.from('sessoes').update({ tamanho_time: n }).eq('id', sessionId)
      if (error) toast.error(error.message)
    }
  }
  const draw = () => { if (drawLocked) return toast.error('O sorteio desta sessão já foi confirmado.'); const result = serpentineDraw(pool, teamSize); if (result.length < 2) return toast.error(`Faltam ${teamSize * 2 - pool.length} jogadores para formar dois times.`); setTeams(result); setStatus('sorteando'); toast.success(`${result.length} times equilibrados!`) }
  const swap = (teamIndex: number, player: Participante) => { const next = (teamIndex + 1) % teams.length; setTeams((old) => old.map((t, i) => i === teamIndex ? { ...t, jogadores: t.jogadores.filter((p) => p.id !== player.id).concat(old[next].jogadores[0] ? [old[next].jogadores[0]] : []) } : i === next ? { ...t, jogadores: t.jogadores.slice(1).concat(player) } : t)); toast('Jogadores trocados') }
  const confirm = async () => { if (supabase) { const { error } = await supabase.rpc('confirmar_sorteio', { p_sessao_id: sessionId, p_times: teams.map((t) => ({ numero: t.numero, jogadores: t.jogadores.map((p) => p.id) })) }); if (error) return toast.error(error.message); const loaded = await supabase.from('times').select('*, times_jogadores(participantes(*))').eq('sessao_id', sessionId).order('posicao_fila'); if (loaded.error) return toast.error(loaded.error.message); setTeams((loaded.data ?? []).map((t) => ({ ...t, jogadores: t.times_jogadores.map((j: { participantes: Participante }) => j.participantes) })) as Time[]) } setCheckins((old) => old.map((c) => teams.some((t) => t.jogadores.some((p) => p.id === c.participante_id)) ? { ...c, alocado: true } : c)); setStatus('em_andamento'); toast.success('Times confirmados. Bora jogar!'); goLive() }
  return <div><div className="panel flex flex-col justify-between gap-5 p-5 sm:flex-row sm:items-center"><div><p className="text-sm font-bold">Formato dos times</p><p className="mt-1 text-xs text-ink/45">Times de linha — o goleiro entra além do número mostrado, quando houver um disponível.</p></div><div>{drawLocked && <p className="mb-2 max-w-xs text-xs font-semibold leading-relaxed text-amber-700">Sorteio já confirmado para hoje — para mudar o formato, será preciso esperar a próxima sessão.</p>}<div className="flex rounded-xl bg-ink/5 p-1">{[5,6].map((n) => <button key={n} disabled={drawLocked} onClick={() => changeTeamSize(n)} className={`rounded-lg px-5 py-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-45 ${teamSize === n ? 'bg-white shadow-sm' : 'text-ink/40'}`}>{n} × {n}</button>)}</div></div><div className="sm:text-right"><p className="text-2xl font-black">{possible}</p><p className="text-xs text-ink/45">times completos possíveis</p></div></div>
    {!teams.length ? <div className="panel mt-5 grid min-h-[420px] place-items-center overflow-hidden p-6 text-center"><div className="max-w-lg"><div className="mx-auto grid h-20 w-20 place-items-center rounded-[28px] bg-lime text-ink"><Sparkles size={35} /></div><h2 className="mt-6 text-2xl font-black">Equilibre o jogo em segundos</h2><p className="mt-3 text-sm leading-relaxed text-ink/50">Vamos priorizar goleiros, ordenar por nível e distribuir em serpentina. Só entram times completos; quem sobrar continua como reserva.</p><div className="mx-auto mt-6 flex max-w-sm items-center justify-center gap-5 rounded-2xl bg-ink/[.035] p-4"><div><b className="text-xl">{available.length}</b><p className="text-[11px] text-ink/40">disponíveis</p></div><div className="h-8 w-px bg-ink/10" /><div><b className="text-xl">{possible}</b><p className="text-[11px] text-ink/40">times</p></div><div className="h-8 w-px bg-ink/10" /><div><b className="text-xl">{reserves}</b><p className="text-[11px] text-ink/40">reservas</p></div></div><button onClick={draw} disabled={possible < 2 || drawLocked} className="btn-lime mt-7 min-w-48"><Sparkles size={18} /> Sortear agora</button>{possible < 2 && <p className="mt-3 text-xs font-semibold text-orange">São necessários pelo menos {teamSize * 2} presentes.</p>}</div></div> : <><div className="mt-5 flex items-center justify-between"><div><p className="font-extrabold">Prévia dos times</p><p className="text-xs text-ink/45">{drawLocked ? 'Times confirmados para a sessão de hoje.' : 'Toque nas setas para fazer um ajuste rápido.'}</p></div>{!drawLocked && <button onClick={draw} className="btn-soft"><RotateCcw size={16} /> Refazer</button>}</div><div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">{teams.map((team, ti) => <div key={team.id} className="panel overflow-hidden"><div className="flex items-center justify-between p-4 text-white" style={{ background: ti < 2 ? '#0D1B2A' : '#1B3A5C' }}><div className="flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl text-sm font-black text-ink" style={{ background: teamColors[ti % teamColors.length] }}>{team.numero}</span><div><p className="text-sm font-extrabold">Time {team.numero}</p><p className="text-[10px] text-white/45">{team.jogadores.reduce((n,p) => n + p.estrelas, 0)} estrelas no total</p></div></div><span className="chip bg-white/10 text-white/70">{ti < 2 ? 'Joga agora' : `${ti + 1}º na fila`}</span></div><div className="divide-y divide-ink/7">{team.jogadores.map((p) => <div key={p.id} className="flex items-center gap-3 p-3.5"><Avatar player={p} size="sm" ring={p.posicao === 'goleiro' ? teamColors[ti % teamColors.length] : undefined} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{p.nome}</p><div className="flex items-center gap-2"><span className="text-[10px] text-ink/40">{positionLabel[p.posicao]}</span><Stars value={p.estrelas} /></div></div>{!drawLocked && <button onClick={() => swap(ti, p)} className="rounded-lg p-2 text-ink/25 hover:bg-ink/5 hover:text-ink" title="Trocar com próximo time"><ArrowLeftRight size={16} /></button>}</div>)}</div></div>)}</div>{reservePlayers.length > 0 && <div className="panel mt-4 overflow-hidden"><div className="flex items-center justify-between p-4"><div><p className="text-sm font-extrabold">Reservas</p><p className="text-xs text-ink/45">Ficaram de fora dos times completos desta prévia.</p></div><span className="chip bg-ink/5 text-ink/50">{reservePlayers.length}</span></div><div className="divide-y divide-ink/7">{reservePlayers.map((p) => <div key={p.id} className="flex items-center gap-3 p-3.5"><Avatar player={p} size="sm" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{p.nome}</p><div className="flex items-center gap-2"><span className="text-[10px] text-ink/40">{positionLabel[p.posicao]}</span><Stars value={p.estrelas} /></div></div></div>)}</div></div>}{!drawLocked && <div className="sticky bottom-4 mt-6 flex justify-end"><button onClick={confirm} className="btn-lime shadow-xl"><Check size={18} /> Confirmar times e iniciar</button></div>}</>}
  </div>
}

function LiveMatch({ readOnly, teams, setTeams, players, match, setMatch, events, setEvents, sessionId, rachaId, duration, status, sessionMatches, pendingDrawMatch, setPendingDrawMatch, onSessionFinished, onOpenDurationSettings }: { readOnly: boolean; teams: Time[]; setTeams: React.Dispatch<React.SetStateAction<Time[]>>; players: Participante[]; match: Match | null; setMatch: React.Dispatch<React.SetStateAction<Match | null>>; events: GolEvento[]; setEvents: React.Dispatch<React.SetStateAction<GolEvento[]>>; sessionId: string; rachaId: string | null; duration: number; status: SessionStatus; sessionMatches: PartidaHistorica[]; pendingDrawMatch: Match | null; setPendingDrawMatch: React.Dispatch<React.SetStateAction<Match | null>>; onSessionFinished: () => void; onOpenDurationSettings: () => void }) {
  const playing = teams.filter((t) => t.posicao_fila <= 2).sort((a,b) => a.posicao_fila - b.posicao_fila); const [seconds, setSeconds] = useState(duration * 60); const [assistFor, setAssistFor] = useState<{ player: Participante; team: Time; event: GolEvento } | null>(null); const [confirmEnd, setConfirmEnd] = useState(false)
  const [endSessionStep, setEndSessionStep] = useState<0 | 1 | 2>(0)
  const [endingSession, setEndingSession] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [awaitingDrawChoice, setAwaitingDrawChoice] = useState(false)
  const [drawChoice, setDrawChoice] = useState<string[]>([])
  useEffect(() => { if (!match) { setSeconds(duration * 60); return } const calc = () => { const elapsed = match.timer_running && match.timer_started_at ? Math.floor((Date.now() - +new Date(match.timer_started_at)) / 1000) : 0; setSeconds(Math.max(0, match.timer_remaining_seconds - elapsed)) }; calc(); const id = setInterval(calc, 500); return () => clearInterval(id) }, [match, duration])
  const patchMatch = async (patch: Partial<Match>): Promise<boolean> => { if (readOnly) return false; const previous = match; setMatch((old) => old ? { ...old, ...patch } : old); if (supabase && match) { const { error } = await supabase.from('partidas').update(patch).eq('id', match.id); if (error) { setMatch(previous); toast.error(error.message); return false } } return true }
  const start = async () => { if (readOnly) return; if (playing.length < 2) return toast.error('Confirme ao menos dois times no sorteio.'); if (!match) { const item: Match = { id: uid(), time_a_id: playing[0].id, time_b_id: playing[1].id, placar_a: 0, placar_b: 0, status: 'em_andamento', horario_inicio: new Date().toISOString(), timer_started_at: new Date().toISOString(), timer_remaining_seconds: duration * 60, timer_running: true }; if (supabase) { if (!rachaId) return toast.error('Racha não identificado.'); const { data, error } = await supabase.from('partidas').insert({ sessao_id: sessionId, racha_id: rachaId, time_a_id: item.time_a_id, time_b_id: item.time_b_id, horario_inicio: item.horario_inicio, timer_started_at: item.timer_started_at, timer_remaining_seconds: item.timer_remaining_seconds, timer_running: true }).select().single(); if (error) return toast.error(error.message); setMatch(data as Match) } else setMatch(item); toast.success('Partida iniciada!') } else if (!match.timer_running) patchMatch({ timer_running: true, timer_started_at: new Date().toISOString(), timer_remaining_seconds: seconds }) }
  const pause = () => { if (!readOnly) patchMatch({ timer_running: false, timer_started_at: null, timer_remaining_seconds: seconds }) }
  const reset = () => { if (readOnly) return; setSeconds(duration * 60); patchMatch({ timer_running: false, timer_started_at: null, timer_remaining_seconds: duration * 60 }) }

  const computeAutomaticRotation = (alvo: Match): Time[] => {
    const queue = [...teams].sort((a,b) => a.posicao_fila - b.posicao_fila)
    const aWon = alvo.placar_a > alvo.placar_b
    const bWon = alvo.placar_b > alvo.placar_a
    let next: Time[]
    if (aWon || bWon) {
      const winner = aWon ? playing[0] : playing[1]
      const loser = aWon ? playing[1] : playing[0]
      const waiting = queue.filter((t) => !playing.some((p) => p.id === t.id))
      next = [winner, ...waiting, loser]
    } else {
      const waiting = queue.filter((t) => !playing.some((p) => p.id === t.id))
      next = [...waiting, playing[0], playing[1]]
    }
    return next.map((t, i) => ({ ...t, posicao_fila: i + 1, status: i < 2 ? 'jogando' as const : 'na_fila' as const }))
  }
  const computeManualDrawRotation = (alvo: Match, escolhaA: string, escolhaB: string): Time[] => {
    const queue = [...teams].sort((a,b) => a.posicao_fila - b.posicao_fila)
    const chosen = queue.filter((t) => t.id === escolhaA || t.id === escolhaB)
    const relegados = queue.filter((t) => (t.id === alvo.time_a_id || t.id === alvo.time_b_id) && t.id !== escolhaA && t.id !== escolhaB)
    const resto = queue.filter((t) => t.id !== escolhaA && t.id !== escolhaB && t.id !== alvo.time_a_id && t.id !== alvo.time_b_id)
    const next = [...chosen, ...resto, ...relegados]
    return next.map((t, i) => ({ ...t, posicao_fila: i + 1, status: i < 2 ? 'jogando' as const : 'na_fila' as const }))
  }
  const finalizarPartida = async (alvo: Match, proximo?: [string, string]) => {
    if (readOnly || finishing) return
    setFinishing(true)
    if (supabase) {
      const { error } = await supabase.rpc('finalizar_partida_e_girar_fila', { p_partida_id: alvo.id, p_proximo_time_a_id: proximo?.[0] ?? null, p_proximo_time_b_id: proximo?.[1] ?? null })
      if (error) { setFinishing(false); toast.error(error.message); return }
      const { data } = await supabase.from('times').select('*, times_jogadores(participantes(*))').eq('sessao_id', sessionId).order('posicao_fila')
      if (data) setTeams(data.map((t) => ({ ...t, jogadores: t.times_jogadores.map((j: { participantes: Participante }) => j.participantes) })) as Time[])
    } else {
      setTeams(proximo ? computeManualDrawRotation(alvo, proximo[0], proximo[1]) : computeAutomaticRotation(alvo))
    }
    setFinishing(false)
    setMatch(null)
    setPendingDrawMatch(null)
    setConfirmEnd(false)
    setAwaitingDrawChoice(false)
    setDrawChoice([])
    setSeconds(duration * 60)
    toast.success('Partida encerrada. Próximos times em campo!')
  }
  const attemptFinish = (alvo: Match) => {
    if (readOnly || playing.length < 2 || finishing) return
    if (alvo.placar_a === alvo.placar_b && teams.length >= 3) {
      setDrawChoice([])
      setAwaitingDrawChoice(true)
      setConfirmEnd(false)
      return
    }
    void finalizarPartida(alvo)
  }
  const drawTarget = match ?? pendingDrawMatch
  useEffect(() => { if (pendingDrawMatch && !match) { setDrawChoice([]); setAwaitingDrawChoice(true) } }, [pendingDrawMatch, match])
  const eligibleForDrawChoice = drawTarget ? (teams.length === 3 ? teams : teams.filter((t) => t.id !== drawTarget.time_a_id && t.id !== drawTarget.time_b_id)) : []
  const toggleDrawChoice = (teamId: string) => { setDrawChoice((old) => old.includes(teamId) ? old.filter((id) => id !== teamId) : old.length >= 2 ? old : [...old, teamId]) }
  const drawChoiceValid = drawChoice.length === 2 && !(drawTarget && drawChoice.includes(drawTarget.time_a_id) && drawChoice.includes(drawTarget.time_b_id))
  const confirmDrawChoice = () => { if (drawTarget && drawChoiceValid) void finalizarPartida(drawTarget, [drawChoice[0], drawChoice[1]]) }
  const goal = async (player: Participante, team: Time) => {
    if (readOnly) return
    if (!match) return toast.error('Inicie a partida antes de marcar gols.')
    if (supabase && !rachaId) return toast.error('Racha não identificado.')
    const side = match.time_a_id === team.id ? 'placar_a' : 'placar_b'
    const novoPlacar = match[side] + 1
    const next = { [side]: novoPlacar }
    // Se o placar não gravou, não registra o gol nem encerra: o estado do banco não mudou.
    if (!(await patchMatch(next))) return
    if (supabase) {
      const { data, error } = await supabase.from('eventos').insert({ partida_id: match.id, racha_id: rachaId, jogador_id: player.id, time_id: team.id }).select().single()
      // O placar já subiu no banco: o evento é só a autoria do gol. Se falhar,
      // avisa e segue — senão a partida trava em 2 × 0 sem nunca encerrar.
      if (error) toast.error(`Gol contado, mas não foi possível registrar o autor: ${error.message}`)
      else { setEvents((old) => [...old, data as GolEvento]); setAssistFor({ player, team, event: data as GolEvento }) }
    } else {
      const ev: GolEvento = { id: uid(), partida_id: match.id, jogador_id: player.id, assistente_id: null, time_id: team.id, criado_em: new Date().toISOString() }
      setEvents((old) => [...old, ev])
      setAssistFor({ player, team, event: ev })
    }
    toast.success(`Gol de ${player.nome}! ⚽`)
    if (novoPlacar >= 2) void finalizarPartida({ ...match, ...next })
  }
  const assist = async (p: Participante | null) => { if (readOnly || !assistFor) return; if (p) { setEvents((old) => old.map((e) => e.id === assistFor.event.id ? { ...e, assistente_id: p.id } : e)); if (supabase) await supabase.from('eventos').update({ assistente_id: p.id }).eq('id', assistFor.event.id); toast.success(`Assistência de ${p.nome}`) } setAssistFor(null) }
  useEffect(() => { if (readOnly || !match || !match.timer_running || seconds > 0 || finishing || awaitingDrawChoice) return; attemptFinish(match) }, [seconds])
  const finishSession = async () => {
    if (readOnly || endingSession) return
    setEndingSession(true)
    if (supabase) {
      // A RPC encerra a sessão e registra o desempenho do dia na mesma
      // transação. O ajuste de estrelas só acontece no fechamento do mês.
      const { data, error } = await supabase.rpc('finalizar_sessao', { p_sessao_id: sessionId })
      if (error || !data) {
        setEndingSession(false)
        toast.error(`Não foi possível finalizar a sessão${error ? `: ${error.message}` : '.'}`)
        return
      }
    }
    setEndingSession(false)
    setEndSessionStep(0)
    onSessionFinished()
    toast.success('Sessão finalizada e salva!')
  }
  if (teams.length < 2) return <EmptyState icon={Shirt} title="Ainda não há dois times" text={readOnly ? 'Aguardando o organizador formar e confirmar os times.' : 'Vá até Sorteio, forme e confirme os times para abrir a partida ao vivo.'} />
  const displayTeams = drawTarget ? [teams.find((t) => t.id === drawTarget.time_a_id), teams.find((t) => t.id === drawTarget.time_b_id)].filter(Boolean) as Time[] : playing
  return <div>{readOnly && <div className="mb-4 flex items-center gap-2 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-800"><Shield size={17} /> Você está acompanhando esta partida em modo somente leitura.</div>}<div className="mb-5 grid gap-4 xl:grid-cols-[1fr_auto_1fr]"><TeamScore team={displayTeams[0]} score={drawTarget?.placar_a ?? 0} color={teamColors[0]} align="left" /><div className="panel flex min-w-64 flex-col items-center justify-center px-6 py-4"><span className={`chip ${awaitingDrawChoice ? 'bg-amber-100 text-amber-800' : match?.timer_running ? 'bg-red-100 text-red-700' : 'bg-ink/5 text-ink/50'}`}>{match?.timer_running && !awaitingDrawChoice && <span className="live-dot h-1.5 w-1.5 rounded-full bg-red-500" />}{awaitingDrawChoice ? 'EMPATE · ESCOLHA A SEGUIR' : match ? (match.timer_running ? 'AO VIVO' : 'PAUSADO') : 'PRONTO'}</span><p className={`mt-2 font-mono text-5xl font-black tracking-tight ${seconds === 0 ? 'text-red-600' : ''}`}>{String(Math.floor(seconds / 60)).padStart(2,'0')}:{String(seconds % 60).padStart(2,'0')}</p>{!readOnly && !awaitingDrawChoice && <div className="mt-3 flex gap-2">{!match?.timer_running ? <button onClick={start} className="btn-lime !min-h-10"><Play size={16} fill="currentColor" /> {match ? 'Retomar' : 'Iniciar'}</button> : <button onClick={pause} className="btn-soft !min-h-10"><Pause size={16} fill="currentColor" /> Pausar</button>}<button onClick={reset} className="btn-soft !min-h-10 !px-3" title="Zerar cronômetro"><TimerReset size={17} /></button><button onClick={onOpenDurationSettings} className="btn-soft !min-h-10 !px-3" title="Ajustar duração da partida"><Settings2 size={17} /></button></div>}</div><TeamScore team={displayTeams[1]} score={drawTarget?.placar_b ?? 0} color={teamColors[1]} align="right" /></div>
    <div className="grid gap-5 xl:grid-cols-[1fr_310px]"><div className="field-grid field-lines relative min-h-[500px] overflow-hidden rounded-[28px] border-[6px] border-white shadow-card"><div className="pointer-events-none absolute left-1/2 top-1/2 h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/55" /><div className="relative z-10 grid min-h-[500px] grid-cols-2 gap-4 p-3 sm:gap-6 sm:p-5 md:gap-12 md:p-10">{displayTeams.map((team, ti) => <div key={team.id} className="grid content-around gap-4">{team.jogadores.map((p, pi) => <button key={p.id} disabled={readOnly} onClick={() => goal(p, team)} className={`group mx-auto flex w-20 flex-col items-center sm:w-24 ${readOnly ? 'cursor-default' : ''} ${pi % 2 && team.jogadores.length > 4 ? (ti ? 'md:translate-x-12' : 'md:-translate-x-12') : ''}`}><div className="relative"><Avatar player={p} size="lg" ring={teamColors[ti]} />{!readOnly && <span className="absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full bg-white text-base shadow-md transition group-active:scale-125">⚽</span>}</div><span className="mt-2 max-w-20 truncate rounded-full bg-ink/80 px-2 py-1 text-[10px] font-bold text-white backdrop-blur sm:max-w-24">{p.apelido || p.nome.split(' ')[0]}</span></button>)}</div>)}</div></div>
      <aside className="space-y-4"><div className="panel p-5"><div className="flex items-center justify-between"><p className="font-extrabold">Próximos na fila</p><span className="chip bg-ink/5 text-ink/50">{teams.filter((t) => t.posicao_fila > 2).length}</span></div><div className="mt-4 space-y-2">{teams.filter((t) => t.posicao_fila > 2).sort((a,b) => a.posicao_fila-b.posicao_fila).map((t, i) => <div key={t.id} className="flex items-center gap-3 rounded-xl bg-ink/[.035] p-3"><span className="grid h-8 w-8 place-items-center rounded-lg font-black text-ink" style={{ background: teamColors[(i+2)%teamColors.length] }}>{t.posicao_fila}</span><div className="flex-1"><p className="text-sm font-bold">Time {t.numero}</p><p className="text-[10px] text-ink/40">{t.jogadores.length} jogadores</p></div>{i === 0 && <span className="text-[10px] font-extrabold text-turf-600">A SEGUIR</span>}</div>)}{teams.length <= 2 && <p className="py-5 text-center text-xs text-ink/35">Sem times na espera.</p>}</div></div><div className="panel p-5"><div className="flex items-center justify-between"><p className="font-extrabold">Últimos gols</p><History size={16} className="text-ink/30" /></div><div className="mt-4 space-y-3">{events.slice(-4).reverse().map((e) => { const p = players.find((x) => x.id === e.jogador_id); const a = players.find((x) => x.id === e.assistente_id); return p && <div key={e.id} className="flex gap-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-turf-100">⚽</span><div><p className="text-xs font-bold">{p.nome}</p><p className="text-[10px] text-ink/40">{a ? `Assistência: ${a.nome}` : 'Sem assistência'} · {format(new Date(e.criado_em), 'HH:mm')}</p></div></div>})}{!events.length && <p className="py-4 text-center text-xs text-ink/35">O primeiro gol aparece aqui.</p>}</div></div>{!readOnly && <button disabled={!match} onClick={() => setConfirmEnd(true)} className="btn-primary w-full">Encerrar partida</button>}</aside></div>
    <section className="mt-8"><div className="mb-4"><p className="text-xl font-black">Estatísticas de hoje</p><p className="mt-1 text-sm text-ink/45">Artilheiro, garçom e a linha do tempo de gols desta sessão.</p></div><Stats players={players} events={events} /></section>
    {sessionMatches.length > 0 && <section className="mt-8"><div className="mb-4 flex items-center justify-between"><div><p className="text-xl font-black">Partidas de hoje</p><p className="mt-1 text-sm text-ink/45">Placares já fechados nesta sessão, sem sair desta tela.</p></div><span className="chip bg-ink/5 text-ink/50">{sessionMatches.length}</span></div><div className="space-y-3">{[...sessionMatches].reverse().map((m, i) => <MatchResultCard key={m.id} match={m} label={`Partida ${sessionMatches.length - i} · ${format(new Date(m.horario_inicio), 'HH:mm')}`} />)}</div></section>}
    {!readOnly && assistFor && <Modal title="Foi golaço! ⚽" onClose={() => setAssistFor(null)}><p className="text-sm text-ink/55"><b className="text-ink">{assistFor.player.nome}</b> marcou. Alguém deu a assistência?</p><div className="mt-4 max-h-72 space-y-2 overflow-auto">{assistFor.team.jogadores.filter((p) => p.id !== assistFor.player.id).map((p) => <button key={p.id} onClick={() => assist(p)} className="flex w-full items-center gap-3 rounded-xl border border-ink/8 p-3 text-left hover:bg-turf-50"><Avatar player={p} size="sm" /><span className="text-sm font-bold">{p.nome}</span><ChevronRight className="ml-auto text-ink/25" size={16} /></button>)}</div><button onClick={() => assist(null)} className="btn-soft mt-3 w-full">Sem assistência</button></Modal>}
    {!readOnly && confirmEnd && <Modal title="Encerrar a partida?" onClose={() => setConfirmEnd(false)}><p className="text-sm leading-relaxed text-ink/55">O placar final será <b className="text-ink">{match?.placar_a ?? 0} × {match?.placar_b ?? 0}</b>. Se não for empate, a fila é atualizada automaticamente; em caso de empate com 3 times ou mais, você escolhe o próximo confronto.</p><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button onClick={() => setConfirmEnd(false)} className="btn-soft w-full sm:w-auto">Continuar jogando</button><button onClick={() => match && attemptFinish(match)} className="btn-primary w-full sm:w-auto">Confirmar encerramento</button></div></Modal>}
    {!readOnly && awaitingDrawChoice && drawTarget && <Modal title="Empate — escolha o próximo confronto" onClose={() => { if (match) setAwaitingDrawChoice(false) }}><p className="text-sm leading-relaxed text-ink/55">Placar final <b className="text-ink">{drawTarget.placar_a} × {drawTarget.placar_b}</b>. {teams.length === 3 ? 'Escolha quem joga com o time que estava de fora.' : 'Os dois times que empataram foram para o fim da fila — escolha dois times entre quem estava esperando.'}{!match && <> A partida já havia terminado sozinha — escolha pra liberar a fila.</>}</p><div className="mt-4 max-h-72 space-y-2 overflow-auto">{eligibleForDrawChoice.map((t) => { const selected = drawChoice.includes(t.id); const disabled = !selected && drawChoice.length >= 2; return <button key={t.id} disabled={disabled} onClick={() => toggleDrawChoice(t.id)} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${selected ? 'border-turf-500 bg-turf-50' : 'border-ink/8 hover:bg-ink/[.02]'}`}><span className="grid h-9 w-9 place-items-center rounded-lg text-sm font-black text-ink" style={{ background: teamColors[(t.numero - 1) % teamColors.length] }}>{t.numero}</span><span className="flex-1 text-sm font-bold">Time {t.numero}</span>{selected && <Check size={17} className="text-turf-600" />}</button> })}</div><button disabled={!drawChoiceValid} onClick={confirmDrawChoice} className="btn-lime mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50"><Check size={17} /> Confirmar próximo confronto</button></Modal>}
    {!readOnly && <div className="mt-12 flex justify-center border-t border-dashed border-ink/10 pt-6">{status === 'finalizada' ? <span className="chip bg-ink/5 text-ink/40">Sessão encerrada</span> : <button onClick={() => setEndSessionStep(1)} className="text-xs font-semibold text-ink/35 underline decoration-dotted underline-offset-4 transition hover:text-ink/60">Finalizar sessão de hoje (encerra a pelada inteira)</button>}</div>}
    {!readOnly && endSessionStep === 1 && <Modal title="Finalizar a sessão de hoje?" onClose={() => setEndSessionStep(0)}><p className="text-sm leading-relaxed text-ink/55">Isso encerra a pelada de hoje. Nenhuma partida poderá ser iniciada depois disso.</p><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button onClick={() => setEndSessionStep(0)} className="btn-soft w-full sm:w-auto">Cancelar</button><button onClick={() => setEndSessionStep(2)} className="btn-soft w-full sm:w-auto">Continuar</button></div></Modal>}
    {!readOnly && endSessionStep === 2 && <Modal title="Confirmação final" onClose={() => setEndSessionStep(0)}><p className="text-sm leading-relaxed text-ink/55">Essa ação não pode ser desfeita: a pelada de hoje será encerrada e nenhuma nova partida poderá começar.</p><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button onClick={() => setEndSessionStep(0)} className="btn-soft w-full sm:w-auto">Cancelar</button><button disabled={endingSession} onClick={finishSession} className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-3 text-sm font-extrabold text-white transition hover:bg-red-700 disabled:opacity-60 sm:w-auto"><CircleStop size={17} /> {endingSession ? 'Finalizando...' : 'Sim, finalizar definitivamente'}</button></div></Modal>}
  </div>
}

function TeamScore({ team, score, color, align }: { team?: Time; score: number; color: string; align: 'left' | 'right' }) { return <div className={`panel flex items-center gap-4 p-4 ${align === 'right' ? 'xl:flex-row-reverse xl:text-right' : ''}`}><span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-xl font-black" style={{ background: color }}>{team?.numero ?? '?'}</span><div className="min-w-0 flex-1"><p className="text-sm font-extrabold">Time {team?.numero ?? '—'}</p></div><p className="text-5xl font-black">{score}</p></div> }

function rankings(players: Participante[], events: GolEvento[]) { return players.map((p) => ({ ...p, gols: events.filter((e) => e.jogador_id === p.id).length, assistencias: events.filter((e) => e.assistente_id === p.id).length })).filter((p) => p.gols || p.assistencias).sort((a,b) => (b.gols + b.assistencias) - (a.gols + a.assistencias)) }
function Stats({ players, events }: { players: Participante[]; events: GolEvento[] }) { const stats = rankings(players, events); const scorer = [...stats].sort((a,b) => b.gols-a.gols)[0]; const waiter = [...stats].sort((a,b) => b.assistencias-a.assistencias)[0]; return <div><div className="grid gap-4 md:grid-cols-2"><PodiumCard title="Artilheiro do dia" player={scorer} value={scorer?.gols ?? 0} unit="gols" color="bg-orange" icon={Trophy} /><PodiumCard title="Garçom do dia" player={waiter} value={waiter?.assistencias ?? 0} unit="assistências" color="bg-blue-400" icon={Crown} /></div><div className="panel mt-5 overflow-hidden"><div className="border-b border-ink/8 p-5"><p className="font-extrabold">Linha do tempo</p><p className="text-xs text-ink/40">Todos os gols registrados nesta sessão.</p></div><div className="divide-y divide-ink/7">{events.slice().reverse().map((e) => { const p = players.find((x) => x.id === e.jogador_id); const a = players.find((x) => x.id === e.assistente_id); return p && <div key={e.id} className="flex items-center gap-4 p-4"><span className="grid h-10 w-10 place-items-center rounded-full bg-turf-100">⚽</span><div className="flex-1"><p className="text-sm font-bold">Gol de {p.nome}</p><p className="text-xs text-ink/40">{a ? `Assistência de ${a.nome}` : 'Sem assistência'}</p></div><time className="text-xs font-semibold text-ink/35">{format(new Date(e.criado_em), 'HH:mm')}</time></div>})}{!events.length && <EmptyState icon={Trophy} title="Nenhum evento registrado" text="Os gols marcados durante as partidas vão aparecer nesta linha do tempo." />}</div></div></div> }
function PodiumCard({ title, player, value, unit, color, icon: Icon }: { title: string; player?: Participante; value: number; unit: string; color: string; icon: typeof Trophy }) { return <div className="panel relative overflow-hidden p-6"><div className={`absolute right-0 top-0 h-full w-2 ${color}`} /><div className="flex items-center gap-4">{player ? <Avatar player={player} size="lg" /> : <div className="avatar h-16 w-16">?</div>}<div className="flex-1"><p className="text-xs font-bold uppercase tracking-[.14em] text-ink/40">{title}</p><p className="mt-1 text-lg font-black">{player?.nome ?? 'Ainda indefinido'}</p><p className="text-sm text-ink/45">{value} {unit}</p></div><Icon size={32} className="text-amber-400" /></div></div> }

const teamPlayerNames = (team: TimeHistorico | null) => team?.times_jogadores.map((link) => link.participantes?.nome).filter(Boolean).join(', ') || 'Jogadores não encontrados'
const teamStrength = (team: TimeHistorico | null) => team?.forca_media == null ? '—' : Number(team.forca_media).toFixed(2)

function MatchResultCard({ match, label }: { match: PartidaHistorica; label: string }) {
  return <div className="rounded-2xl border border-ink/8 bg-white p-4"><p className="mb-4 text-center text-[10px] font-extrabold uppercase tracking-[.14em] text-ink/35">{label}</p><div className="grid items-center gap-4 md:grid-cols-[1fr_auto_1fr]"><HistoricalTeam team={match.time_a} names={teamPlayerNames(match.time_a)} strength={teamStrength(match.time_a)} /><div className="rounded-xl bg-ink px-4 py-2 text-center text-xl font-black text-white">{match.placar_a} × {match.placar_b}</div><HistoricalTeam team={match.time_b} names={teamPlayerNames(match.time_b)} strength={teamStrength(match.time_b)} right /></div></div>
}

function HistoryPage({ players, rachaId }: { players: Participante[]; rachaId: string | null }) {
  const [allEvents, setAllEvents] = useState<GolEvento[]>([])
  const demoEvents = hasSupabase ? allEvents : [...Array(35)].map((_, i) => ({ id: `de${i}`, partida_id: 'old', jogador_id: players[i % 12].id, assistente_id: i % 3 ? players[(i + 3) % 12].id : null, time_id: 'old', criado_em: new Date().toISOString() }))
  const stats = rankings(players, demoEvents)
  const [sessions, setSessions] = useState<SessaoHistorica[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(hasSupabase)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loadingSession, setLoadingSession] = useState<string | null>(null)
  const [matchesBySession, setMatchesBySession] = useState<Record<string, PartidaHistorica[]>>({})
  const [eventsBySession, setEventsBySession] = useState<Record<string, GolEvento[]>>({})

  useEffect(() => {
    if (!supabase || !rachaId) { setSessionsLoading(false); return }
    const db = supabase
    const load = async () => {
      const [sessionsResult, matchesResult, eventsResult] = await Promise.all([
        db.from('sessoes').select('id,data,horario_fim,status').eq('racha_id', rachaId).eq('status', 'finalizada').order('data', { ascending: false }),
        db.from('partidas').select('sessao_id').eq('racha_id', rachaId).eq('status', 'finalizada'),
        db.from('eventos').select('*').eq('racha_id', rachaId).order('criado_em'),
      ])
      if (sessionsResult.error || matchesResult.error) {
        toast.error('Não foi possível carregar as sessões anteriores.'); setSessionsLoading(false); return
      }
      const counts = new Map<string, number>()
      for (const match of matchesResult.data ?? []) counts.set(match.sessao_id, (counts.get(match.sessao_id) ?? 0) + 1)
      setSessions((sessionsResult.data ?? []).map((session) => ({ id: session.id, data: session.data, horario_fim: session.horario_fim, partidas_count: counts.get(session.id) ?? 0 })))
      if (!eventsResult.error) setAllEvents((eventsResult.data ?? []) as GolEvento[])
      setSessionsLoading(false)
    }
    void load()
  }, [rachaId])

  const toggleSession = async (sessionId: string) => {
    if (expanded === sessionId) { setExpanded(null); return }
    setExpanded(sessionId)
    if (!supabase || matchesBySession[sessionId]) return
    setLoadingSession(sessionId)
    const { data, error } = await supabase.from('partidas').select(`
      id, placar_a, placar_b, horario_inicio,
      time_a:times!partidas_time_a_id_fkey(
        id, numero, forca_media,
        times_jogadores(participantes(nome))
      ),
      time_b:times!partidas_time_b_id_fkey(
        id, numero, forca_media,
        times_jogadores(participantes(nome))
      )
    `).eq('sessao_id', sessionId).eq('status', 'finalizada').order('horario_inicio')
    if (error) { setLoadingSession(null); toast.error('Não foi possível carregar as partidas desta sessão.'); return }
    const matches = (data ?? []) as unknown as PartidaHistorica[]
    setMatchesBySession((old) => ({ ...old, [sessionId]: matches }))
    const partidaIds = matches.map((m) => m.id)
    if (partidaIds.length) {
      const { data: eventData } = await supabase.from('eventos').select('*').in('partida_id', partidaIds).order('criado_em')
      setEventsBySession((old) => ({ ...old, [sessionId]: (eventData ?? []) as GolEvento[] }))
    } else {
      setEventsBySession((old) => ({ ...old, [sessionId]: [] }))
    }
    setLoadingSession(null)
  }

  return <div><div className="grid gap-4 sm:grid-cols-3"><div className="panel p-5"><p className="text-xs font-bold uppercase tracking-[.13em] text-ink/40">Sessões realizadas</p><p className="mt-2 text-3xl font-black">{hasSupabase ? sessions.length : 24}</p><p className="mt-1 text-xs text-turf-600">sessões finalizadas</p></div><div className="panel p-5"><p className="text-xs font-bold uppercase tracking-[.13em] text-ink/40">Gols registrados</p><p className="mt-2 text-3xl font-black">{demoEvents.length}</p><p className="mt-1 text-xs text-ink/40">eventos carregados</p></div><div className="panel p-5"><p className="text-xs font-bold uppercase tracking-[.13em] text-ink/40">Jogadores no ranking</p><p className="mt-2 text-3xl font-black">{stats.length}</p><p className="mt-1 text-xs text-ink/40">histórico acumulado</p></div></div><div className="panel mt-5 overflow-hidden"><div className="flex items-center justify-between gap-3 border-b border-ink/8 p-5"><div><p className="font-extrabold">Ranking geral</p><p className="text-xs text-ink/40">Gols e assistências acumulados de todas as sessões.</p></div><span className="chip shrink-0 bg-turf-100 text-turf-700">Temporada 2026</span></div><div className="divide-y divide-ink/7 md:hidden">{stats.map((p,i) => <div key={p.id} className="flex items-center gap-3 p-4"><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-black ${i < 3 ? 'bg-lime' : 'bg-ink/5 text-ink/45'}`}>{i+1}</span><Avatar player={p} size="sm" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{p.nome}</p><p className="text-[10px] text-ink/40">{positionLabel[p.posicao]}</p><div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-bold"><span className="chip bg-ink/5 text-ink/55">{p.gols} gols</span><span className="chip bg-ink/5 text-ink/55">{p.assistencias} assist.</span><span className="chip bg-turf-100 text-turf-700">{p.gols+p.assistencias} particip.</span></div></div></div>)}</div><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[600px] text-left"><thead><tr className="bg-ink/[.025] text-[10px] font-extrabold uppercase tracking-[.13em] text-ink/40"><th className="px-5 py-3">#</th><th className="px-3 py-3">Jogador</th><th className="px-3 py-3 text-center">Gols</th><th className="px-3 py-3 text-center">Assist.</th><th className="px-5 py-3 text-right">Participações</th></tr></thead><tbody className="divide-y divide-ink/7">{stats.map((p,i) => <tr key={p.id} className="hover:bg-turf-50"><td className="px-5 py-4"><span className={`grid h-8 w-8 place-items-center rounded-lg text-xs font-black ${i < 3 ? 'bg-lime' : 'bg-ink/5 text-ink/45'}`}>{i+1}</span></td><td className="px-3 py-4"><div className="flex items-center gap-3"><Avatar player={p} size="sm" /><div><p className="text-sm font-bold">{p.nome}</p><p className="text-[10px] text-ink/40">{positionLabel[p.posicao]}</p></div></div></td><td className="px-3 py-4 text-center text-lg font-black">{p.gols}</td><td className="px-3 py-4 text-center text-lg font-black">{p.assistencias}</td><td className="px-5 py-4 text-right"><span className="chip bg-turf-100 text-turf-700">{p.gols+p.assistencias}</span></td></tr>)}</tbody></table></div></div>

    <section className="mt-8"><div><p className="text-xl font-black">Sessões anteriores</p><p className="mt-1 text-sm text-ink/45">Placares, escalações e força média de cada time.</p></div><div className="mt-4 space-y-3">{sessionsLoading ? <div className="panel grid min-h-48 place-items-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-ink/10 border-t-turf-500" /></div> : sessions.length ? sessions.map((session) => { const isOpen = expanded === session.id; const matches = matchesBySession[session.id]; return <article key={session.id} className="panel overflow-hidden"><button onClick={() => toggleSession(session.id)} className="flex w-full items-center gap-4 p-5 text-left hover:bg-ink/[.025]"><div className="grid h-11 w-11 place-items-center rounded-xl bg-turf-100 text-turf-700"><CalendarDays size={20} /></div><div className="min-w-0 flex-1"><p className="font-extrabold">{format(new Date(`${session.data}T12:00:00`), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}</p><p className="mt-1 text-xs text-ink/40">{session.partidas_count} {session.partidas_count === 1 ? 'partida' : 'partidas'}{session.horario_fim ? ` · encerrada às ${format(new Date(session.horario_fim), 'HH:mm')}` : ''}</p></div><ChevronRight className={`text-ink/35 transition-transform ${isOpen ? 'rotate-90' : ''}`} size={20} /></button>{isOpen && <div className="border-t border-ink/8 bg-ink/[.018] p-4 md:p-5">{loadingSession === session.id ? <div className="grid min-h-28 place-items-center"><div className="h-7 w-7 animate-spin rounded-full border-4 border-ink/10 border-t-turf-500" /></div> : matches?.length ? <div className="space-y-5"><Stats players={players} events={eventsBySession[session.id] ?? []} /><div className="space-y-3">{matches.map((match, index) => <MatchResultCard key={match.id} match={match} label={`Partida ${index + 1} · ${format(new Date(match.horario_inicio), 'HH:mm')}`} />)}</div></div> : <p className="py-8 text-center text-sm text-ink/40">Nenhuma partida finalizada nesta sessão.</p>}</div>}</article> }) : <div className="panel"><EmptyState icon={History} title="Nenhuma sessão finalizada" text="Depois que a primeira sessão for encerrada, os placares, times e jogadores aparecerão aqui." /></div>}</div></section>
  </div>
}

function HistoricalTeam({ team, names, strength, right = false }: { team: TimeHistorico | null; names: string; strength: string; right?: boolean }) {
  return <div className={right ? 'md:text-right' : ''}><div className={`flex items-center gap-2 ${right ? 'md:justify-end' : ''}`}><span className="grid h-8 w-8 place-items-center rounded-lg bg-lime text-xs font-black">{team?.numero ?? '?'}</span><p className="text-sm font-extrabold">Time {team?.numero ?? '—'}</p><span className="chip bg-amber-100 text-amber-800">★ {strength}</span></div><p className="mt-2 text-xs leading-relaxed text-ink/45">{names}</p></div>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="fixed inset-0 z-50 grid place-items-center bg-ink/65 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div role="dialog" aria-modal="true" className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-[24px] bg-white p-5 shadow-2xl md:p-6"><div className="mb-5 flex items-center justify-between"><h3 className="text-lg font-black">{title}</h3><button onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ink/5 text-ink/45 hover:text-ink" aria-label="Fechar"><X size={18} /></button></div>{children}</div></div> }

export default App
