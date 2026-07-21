App em React, Vite, Tailwind e Supabase para administrar a pelada.

## Executar

```bash
npm install
npm run dev
```

Sem variáveis de ambiente, o app abre em modo demonstração.

## Supabase

1. Execute inteiro `supabase/migrations/001_initial.sql` no SQL Editor.
2. Crie um usuário em Authentication.
3. Copie `.env.example` para `.env.local` e preencha URL e chave anon.
4. Reinicie o app.

Se a migração inicial foi executada em trechos e as funções RPC não foram
criadas, execute **inteiro** `supabase/migrations/002_repair_rpc_functions.sql`
em uma nova consulta. A consulta final deve listar `confirmar_sorteio` e
`finalizar_partida_e_girar_fila`.

## Papéis de acesso

Depois das migrações anteriores, execute inteiro
`supabase/migrations/003_access_roles_and_realtime.sql`. Em seguida, crie
manualmente o primeiro perfil admin no SQL Editor, substituindo o UUID pelo id
do usuário criado em Authentication:

```sql
insert into public.perfis (id, papel, nome)
values ('UUID_DO_AUTH_USERS', 'admin', 'Organizador');
```

Não existe policy de INSERT em `perfis` pelo app. Isso é intencional para
impedir autopromoção. Usuários com papel `normal` veem apenas a partida ao vivo
e o histórico, ambos em modo de leitura.

## Autocadastro e aprovação

Execute inteiro `supabase/migrations/004_self_signup_approval.sql`. Novas contas
passam a receber automaticamente um perfil `pendente`; somente o trigger em
`auth.users` insere esse registro. Cadastros pendentes não conseguem ler as
tabelas do produto.

Faça o deploy das funções:

```bash
supabase functions deploy notificar-cadastro --no-verify-jwt
supabase functions deploy aprovar-cadastro
supabase functions deploy rejeitar-cadastro
```

Configure os secrets da notificação:

```bash
supabase secrets set RESEND_API_KEY=SUA_CHAVE
supabase secrets set ADMIN_NOTIFICATION_EMAIL=admin@exemplo.com
supabase secrets set RESEND_FROM_EMAIL="Atos Futebol <cadastros@seudominio.com>"
supabase secrets set WEBHOOK_SHARED_SECRET=SEU_SEGREDO_ALEATORIO
```

Gere `WEBHOOK_SHARED_SECRET` com um valor longo e imprevisível, por exemplo:

```bash
openssl rand -hex 32
```

No Dashboard do Supabase, crie um Database Webhook para `INSERT` em
`public.perfis`, com condição `papel = pendente`, apontando para:

```text
https://SEU_PROJECT_REF.supabase.co/functions/v1/notificar-cadastro
```

No mesmo Database Webhook, adicione o header customizado abaixo usando
exatamente o mesmo valor configurado no secret da função:

```text
x-webhook-secret: SEU_SEGREDO_ALEATORIO
```

A função de notificação também ignora silenciosamente qualquer registro que não
esteja pendente. Requisições sem o header correto recebem `401` antes que o
corpo seja lido ou que a API do Resend seja chamada. `aprovar-cadastro` e
`rejeitar-cadastro` exigem JWT válido e
confirmam no banco que o chamador é admin antes de usar a service role.

Depois de atualizar o secret, o header e fazer novo deploy, confirme o bloqueio:

```bash
curl -i -X POST \
  https://SEU_PROJECT_REF.supabase.co/functions/v1/notificar-cadastro \
  -H "Content-Type: application/json" \
  -d '{}'
```

A resposta esperada é `HTTP 401`. O teste positivo deve ser feito cadastrando
uma conta pelo app, para confirmar o fluxo completo do Database Webhook.

## Força dos times e histórico por sessão

Execute inteiro `supabase/migrations/005_team_strength_and_session_history.sql`.
A migração adiciona `times.forca_media`, `sessoes.horario_fim` e atualiza a RPC
de sorteio para calcular a média diretamente das estrelas persistidas em
`participantes`. O encerramento da sessão passa a ser confirmado no banco antes
da navegação para o histórico.