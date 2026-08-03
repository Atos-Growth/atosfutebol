import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Não autorizado' }, 401)
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return json({ error: 'Configuração indisponível' }, 500)

  try {
    const token = authorization.slice(7)
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } })
    const { data: authData, error: authError } = await userClient.auth.getUser(token)
    if (authError || !authData.user) return json({ error: 'Não autorizado' }, 401)
    const { data: caller } = await userClient.from('perfis').select('papel').eq('id', authData.user.id).maybeSingle()
    if (caller?.papel !== 'admin') return json({ error: 'Não autorizado' }, 401)

    const { usuario_id: usuarioId, papel: papelSolicitado } = await req.json()
    if (!isUuid(usuarioId)) return json({ error: 'Usuário inválido' }, 400)
    const papel = papelSolicitado === 'admin' ? 'admin' : 'normal'
    const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await service.from('perfis').update({ papel }).eq('id', usuarioId).eq('papel', 'pendente').select('id').maybeSingle()
    if (error) throw error
    if (!data) return json({ error: 'Cadastro pendente não encontrado' }, 404)
    return json({ ok: true })
  } catch (error) {
    console.error('Falha ao aprovar cadastro', error instanceof Error ? error.message : 'erro desconhecido')
    return json({ error: 'Não foi possível aprovar o cadastro' }, 500)
  }
})
