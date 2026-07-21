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
    const record = payload?.record as { id?: string; email?: string; criado_em?: string; papel?: string } | undefined
    if (!record || record.papel !== 'pendente' || !record.email) return json({ ok: true })

    const apiKey = Deno.env.get('RESEND_API_KEY')
    const adminEmail = Deno.env.get('ADMIN_NOTIFICATION_EMAIL')
    const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') ?? 'Atos Futebol <onboarding@resend.dev>'
    if (!apiKey || !adminEmail) {
      console.error('Secrets RESEND_API_KEY ou ADMIN_NOTIFICATION_EMAIL ausentes')
      return json({ ok: false }, 500)
    }

    const email = escapeHtml(record.email)
    const createdAt = record.criado_em ? new Date(record.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'agora'
    const resend = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromEmail,
        to: [adminEmail],
        subject: 'Novo cadastro aguardando aprovação · Atos Futebol',
        html: `<div style="font-family:Arial,sans-serif;color:#071812;line-height:1.5"><h2>Novo cadastro no Atos Futebol</h2><p><strong>${email}</strong> solicitou acesso em ${escapeHtml(createdAt)}.</p><p>Entre no app como administrador e abra <strong>Aprovações</strong> para aprovar ou rejeitar.</p></div>`,
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
