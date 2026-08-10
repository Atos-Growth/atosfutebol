import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
}

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')

// Dispara com um Database Webhook em INSERT na tabela racha_membros
// (reconfigurar no painel do Supabase: antes apontava para "perfis").
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false }, 405)

  const configuredSecret = Deno.env.get('WEBHOOK_SHARED_SECRET')
  const receivedSecret = req.headers.get('x-webhook-secret')
  if (!configuredSecret || receivedSecret !== configuredSecret) {
    return json({ ok: false }, 401)
  }

  try {
    const payload = await req.json()
    const record = payload?.record as { racha_id?: string; perfil_id?: string; papel?: string; criado_em?: string } | undefined
    if (!record || record.papel !== 'pendente' || !record.racha_id || !record.perfil_id) return json({ ok: true })

    const apiKey = Deno.env.get('RESEND_API_KEY')
    const fallbackAdminEmail = Deno.env.get('ADMIN_NOTIFICATION_EMAIL')
    const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') ?? 'Atos Futebol <onboarding@resend.dev>'
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!apiKey || !url || !serviceKey) {
      console.error('Secrets RESEND_API_KEY, SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes')
      return json({ ok: false }, 500)
    }

    const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const [{ data: solicitante }, { data: racha }, { data: admins }] = await Promise.all([
      service.from('perfis').select('email').eq('id', record.perfil_id).maybeSingle(),
      service.from('rachas').select('nome').eq('id', record.racha_id).maybeSingle(),
      service.from('racha_membros').select('perfis(email)').eq('racha_id', record.racha_id).eq('papel', 'admin'),
    ])

    const adminEmails = (admins ?? [])
      .map((row) => (row as unknown as { perfis: { email: string | null } | null }).perfis?.email)
      .filter((email): email is string => Boolean(email))
    const destinatarios = adminEmails.length ? adminEmails : fallbackAdminEmail ? [fallbackAdminEmail] : []
    if (!destinatarios.length) {
      console.error('Nenhum admin com e-mail para notificar neste racha e nenhum ADMIN_NOTIFICATION_EMAIL configurado')
      return json({ ok: false }, 500)
    }

    const email = escapeHtml(solicitante?.email ?? 'e-mail não informado')
    const rachaNome = escapeHtml(racha?.nome ?? 'seu racha')
    const createdAt = record.criado_em ? new Date(record.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'agora'
    const resend = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromEmail,
        to: destinatarios,
        subject: `Novo cadastro aguardando aprovação · ${rachaNome}`,
        html: `<div style="font-family:Arial,sans-serif;color:#071812;line-height:1.5"><h2>Novo cadastro em ${rachaNome}</h2><p><strong>${email}</strong> solicitou acesso em ${escapeHtml(createdAt)}.</p><p>Entre no app como administrador de <strong>${rachaNome}</strong> e abra <strong>Aprovações</strong> para aprovar ou rejeitar.</p></div>`,
      }),
    })

    if (!resend.ok) {
      console.error('Resend recusou o envio', resend.status)
      return json({ ok: false }, 502)
    }
    return json({ ok: true })
  } catch (error) {
    console.error('Falha ao processar webhook de cadastro', error instanceof Error ? error.message : 'erro desconhecido')
    return json({ ok: false }, 400)
  }
})
