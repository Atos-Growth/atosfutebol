# Rodada 4.4 — primeira unidade P0 implementada offline

**Para revisão técnica, sem commit ou aplicação.** Branch `security/round4-4-offline-p0`, worktree `/workspace/atosfutebol-security-round4-4`, base `43d203a9a177fdcfd3a2e31d46f0a736fd83c108`. Código de aplicação/migrations 001–016 na base f42e27f. O worktree `security/round1-inventory` e seus documentos não commitados foram preservados. O desenho 4.3 foi lido naquele worktree; seu SHA-256 é `e28ad89c5cde329d22b2a8182afbf766630a7d0eb659d6b6b383e46fc9495e40`.

Não houve conexão, SQL executado em banco, RPC ou teste Supabase. Os arquivos SQL são rascunhos de migrations, fora da descoberta automática da CLI. A única análise de SQL foi parsing local como texto. Não há espelhamento, cópia de dados, nova função SECURITY DEFINER, alteração de RPC existente, RLS existente, frontend ativo ou publicação Realtime.

## 1. Código entregue e contrato fechado

| Arquivo | Implementação |
|---|---|
| [public-read-v1.ts](../../src/contracts/public-read-v1.ts) | Tipos imutáveis, allowlists, SELECT explícito, decoders de participante/lista/resumo esportivo; erro fixo sem eco de entrada |
| [prepare_participants_public_v1.sql](../../supabase/migration-drafts/round4-4/prepare_participants_public_v1.sql) | View nova `public.participantes_publicos_v1`, invoker/barrier, campos explícitos, vínculo atual aprovado do mesmo tenant, grants de leitura apenas |
| [prepare_internal_schema.sql](../../supabase/migration-drafts/round4-4/prepare_internal_schema.sql) | Schema vazio `internal`, owner dedicado NOLOGIN/NOBYPASSRLS, sem grants a usuários e defaults globais restritos apenas desse novo criador |
| [tests/security/](../../tests/security/) | Compilação dos tipos, testes de runtime/AST, runner de sondas GET futuro e testes offline desse runner |

Contrato de participante: `id, racha_id, nome, apelido, foto_url, posicao, ativo, estrelas`. Rota preparada: `GET /rest/v1/participantes_publicos_v1` com `select` explícito e filtro `racha_id=eq.<comunidade>`. `select=*` nessa **view** só possui as oito colunas aprovadas. O filtro do cliente não autoriza acesso: a view verifica `auth.uid()`, vínculo na mesma comunidade e papel `normal/admin`, além de usar RLS/permissões do invocador nas bases.

Não há `perfil_id`, pontuação, memória, delta, calibração, configuração, força interna ou expansão automática de campos. Próprio jogador e organizador recebem o mesmo contrato. Acesso de proprietário futuro não ganha exceção; o papel ainda não existe no modelo atual. `sou_eu`/vínculo próprio demandam contrato separado, não exposição de identificadores de outros perfis. A URL da foto mantém dependência do modelo de Storage já existente; esta unidade não certifica buckets/URLs assinadas.

Decoders rejeitam campos extras, inclusive desconhecidos futuros, tipos inválidos, aliases aninhados e propriedades executáveis; não espalham linha bruta em DTO. Validação de lista rejeita tenant divergente e duplicatas. Isso é defesa de contrato no consumidor, **não autorização**: o dado não pode sair do servidor por outra rota. Nenhum módulo novo foi importado pelo aplicativo nesta rodada.

## 2. Decisões funcionais incorporadas

**Resumo mensal:** `MonthlySportsPublicV1` contém somente `racha_id, participante_id, competencia, partidas, gols, assistencias`. Competência representa primeiro dia do mês. Não contém delta, memória, estrelas antes/depois ou direção de cálculo. Fonte futura é partida/evento esportivo elegível; não leitura de `fechamentos_mensais` bruto. Agregação/endpoint mensal e migração da tela não foram implementados. Antes da integração, definir timezone de competência e regra de elegibilidade/finalização, preservando gol contra sem crédito ao autor/assistência. O contrato não autoriza expor cálculo sob nome de estatística.

**Goleiros excedentes permanecem na reserva.** A decisão substitui a pendência da 4.3 sobre usar goleiro excedente como jogador de linha: não fazê-lo automaticamente. Para N=5/6, uma vaga adicional de goleiro por time quando a regra de disponibilidade permitir; excedentes não completam vaga de linha nem justificam N+2. A RPC real e a prévia ainda precisam de revisão/compatibilização futura. Nenhuma alteração em `confirmar_sorteio` nesta rodada. Testes futuros: N de linha+1 goleiro aceito; 2 goleiros de função ou excesso na linha rejeitados; excedente permanece não alocado como reserva; composição incompleta rejeitada; nenhuma redistribuição histórica. Política de escassez e eleição entre goleiros disponíveis ainda precisa ser fechada com Janela 3.

**Exclusão direta de times entra explicitamente no corte de escritas.** A fonte [010:273](../../supabase/migrations/010_multi_tenant_rachas.sql#L273) contém policy DELETE admin em `times`; :278 permite exclusão de associação. Não foi localizada chamada `from('times').delete()` neste frontend base; a superfície REST/SDK existe independentemente de botão e depende das ACLs reais. Não afirmar que foi explorada. A exclusão de time pode apagar escalações em cascata ([001:48](../../supabase/migrations/001_initial.sql#L48)) ou ser bloqueada por FKs de partidas; FK sozinha não é autorização nem protocolo de histórico.

Futuro comando de remoção/cancelamento, se o produto o permitir: autorização por comunidade, mesmo mutex de sessão/início/correção/finalização, versão esperada, idempotência e rejeição de time com qualquer participação histórica. Sem remoção administrativa genérica de histórico. No corte futuro, negar DELETE direto em `times` e `times_jogadores`, incluindo caminhos indiretos por exclusão/cascata do pai; preservar os fluxos legítimos por comando. Testes em homologação incluem membro/admin A/admin B/admin A+B, time virgem e histórico, DELETE×início e DELETE×confirmação, ausência de cascata parcial e replay. Não implementar nem ensaiar essa exclusão agora.

## 3. Migrations preparadas e limites da proteção

Os dois arquivos em `supabase/migration-drafts/round4-4/` são SQL concreto, transacional e versionável, **não scripts de inventário**. Não têm número definitivo e não foram colocados em `supabase/migrations/`; isso impede aplicação acidental pelo fluxo normal de migrations, mas não impede execução manual indevida. Não executar nesta rodada.

| Rascunho | Pré-requisitos antes de futura promoção | Efeito/rollback seguro |
|---|---|---|
| Schema interno | Confirmar ausência de colisão de schema/role e poder do principal de implantação para criar role/schema/default ACL. Confirmar exclusão do schema das APIs expostas | Cria infraestrutura vazia. Não recebe dados, funções ou memberships. Em erro a transação reverte; após êxito pode permanecer vazia/restrita. Não fazer DROP CASCADE para rollback |
| View v1 | PG17; tabelas esperadas com RLS; revisão dos helpers usados pelas policies reais, ACL/herança, owner e bases. Authenticated precisa ter os SELECTs necessários nas colunas das bases e EXECUTE de auth.uid | Nova rota de leitura, sem revogar permissões existentes. Em erro reverte; desativação futura pode retirar SELECT da nova view preservando dados. Não ampliar base/EXECUTE como fallback |

Podem ser avaliados independentemente; nenhum lê o schema interno. Ordem sugerida de preparação: schema, view, homologação e integração de consumidores por autorização própria. CREATE sem OR REPLACE/IF NOT EXISTS falha em colisão; não sobrescreve objeto desconhecido. Valores de timeout (2 s para lock, 15 s por statement) são limites conservadores propostos, sujeitos a ensaio, não autorização de janela.

A view utiliza `security_invoker=true`, portanto não herda leitura privilegiada de seu owner. `security_barrier=true` é complementar e não substitui RLS. Predicate explícito usa o vínculo atual, não claims de papel enviados pelo navegador. DOs somente inspecionam catálogos/permissões e abortam se faltarem RLS ou se houver grants efetivos inesperados para anon/authenticated na **nova** view. Não chamam funções de negócio. Revisão de RLS transitiva permanece obrigatória: `racha_membros` e `participantes` usam helpers existentes não modificados.

Os defaults do owner interno são **globais para a role nova**. REVOKE de EXECUTE apenas por schema não cancela o default global PUBLIC do PostgreSQL; o rascunho evita esse falso fechamento. Objetos futuros criados por postgres/outro criador não recebem esses defaults automaticamente. Não concedemos memberships, não criamos executor de cálculo nem fixamos novos owners de RPC sem a revisão real. O owner de tabelas futuro não deve virar executor público; RLS das tabelas e grants específicos ainda pertencem a outra unidade.

**Risco residual P0 permanece:** adicionar a view/DTO não fecha SELECT direto de participantes, avaliações, fechamentos, RPCs/views legadas ou leitura explícita de delta. O aplicativo continua usando os consumidores abaixo. Não há claim de contenção implantada, proteção integral do banco ou exploração demonstrada. Revogações reais exigem mapa de consumidores e regressão para evitar indisponibilidade não autorizada.

## 4. Consumidores legados registrados na fonte

Linhas referem-se ao código base deste worktree. O mapa registra dependências para a próxima integração, não implica que todas as colunas retornadas sejam atualmente mostradas pela UI.

| Consumidor | Fonte | Dependência / substituição necessária |
|---|---|---|
| Lista de participantes | [App.tsx:216](../../src/App.tsx#L216) | `participantes.select('*')`; consumir view v1 + decoder; resolver vínculo próprio por contrato separado |
| Escalações iniciais e recarga | [App.tsx:233](../../src/App.tsx#L233), :251 | `times.select('*, times_jogadores(participantes(*))')`; DTO de sessão/time com participante seguro, sem embed bruto |
| Confirmação e pós-finalização | [App.tsx:712](../../src/App.tsx#L712), :761 | Mesmos embeds após RPC; alterar leitura não autoriza modificar RPC sem revisão |
| Resumo mensal | [App.tsx:151](../../src/App.tsx#L151), seleção :154; renderização :57–65 | Delta explícito, valores de estrelas antes/depois e tooltip de cálculo. Substituir pelo resumo de fatos esportivos; não mapear delta para apelido público |
| Tipo mensal antigo | [supabase.ts:18](../../src/lib/supabase.ts#L18) | `Fechamento` contém delta/estrelas antes/depois; permanece legado até integração. Novo tipo não é alias desse tipo |
| Cadastro/edição de participante | [App.tsx:513](../../src/App.tsx#L513), :522/:546 | `.select().single()` sem projeção retorna representação ampla; futuro comando deve retornar DTO seguro; próprio jogador não tem exceção de confidencialidade |
| Sessões/check-ins | [App.tsx:195](../../src/App.tsx#L195), :219/:231/:573 | `select()`/`select('*')` inclusive retorno de escrita; inventariar campos e criar comandos conforme hardening |
| Partidas | [App.tsx:188](../../src/App.tsx#L188), :235/:240/:255/:727 | Wildcards/retorno amplo; início ainda INSERT direto, timer UPDATE. Substituição transacional pendente |
| Eventos | [App.tsx:177](../../src/App.tsx#L177), :812/:898/:933 | Wildcards/representação de INSERT. Gol ainda separa placar e evento; tratar em unidade esportiva futura |
| Callbacks Realtime | [App.tsx:259](../../src/App.tsx#L259) | Disparam recargas HTTP amplas; corrigir leitura HTTP sem habilitar publicação de tabela esportiva |
| Exclusão de times/escalações | [010:273](../../supabase/migrations/010_multi_tenant_rachas.sql#L273), :278 | Superfície RLS/REST a proteger; consumidor frontend de DELETE de times não encontrado nesta base |

`src/App.tsx`, `src/lib/supabase.ts`, componentes, estilos e package.json não foram alterados. Não revogar grants com base apenas na nova lista de campos: cliente antigo e retornos de escrita precisam de adaptação coordenada.

## 5. Testes executados localmente e testes preparados

Comando local (usa instalações já existentes, sem instalar dependências):

```bash
python -B tests/security/run_local.py \
  --tsc /workspace/atosfutebol/node_modules/typescript/bin/tsc \
  --parser-path /tmp/atos-p0-pg17-parser
```

O runner compila em diretório temporário, não altera dist/package.json; roda Node tests e unittest, sem chamar o CLI das sondas remotas. Parser `pglast 7.23` usa gramática PostgreSQL 17.7, mesma versão principal do PG17.6 informado pelo PO; parsing não valida catálogo, resolução de função, ACL em runtime ou instalação Supabase. PL/pgSQL dos DOs recebe inspeção estática, não execução/compilação no servidor.

- Tipos: chaves fechadas, campos privados ausentes e DTO readonly verificados pelo TypeScript.
- Runtime: 10 testes de DTO/allowlist, novos campos/aliases, validação de tenant, rejeição de privados para todas as personas e erros sem eco de payload. Persona `future-owner` aqui significa apenas ausência de exceção no decoder; não simula papel real nem certifica autorização dele.
- Python: 16 testes offline de parsing/estrutura/ACL e robustez das sondas. Matriz simulada tem 96 verificações, oito personas e dois tenants, com controles positivos antes dos negativos; **não são 96 testes executados contra Supabase**.
- Casos de regressão do runner impedem falso PASS por JWT inválido, papel incorreto, fixture ausente, timeout/5xx, erro de sintaxe, retorno privado a admin e leitura cruzada indevida.

Runner futuro [authorization_v1.py](../../tests/security/authorization_v1.py) usa somente GET, endpoint fixo da view, verificação real de `/auth/v1/user` e vínculos persistidos para membro/admin A/B, pendente, removido, sem vínculo e admin A+B. Não chama RPC, não escreve fixture e não lê internos reais. Somente após autorização específica e fixtures sintéticas, poderá testar essas personas com tokens do ambiente. `tests/security/README.md` descreve execução/exportação. Dono real, revogação concorrente, views/RPCs legadas, Storage e testes esportivos continuam fora da certificação desta unidade.

## 6. Bloqueios, riscos e gate de revisão

| Severidade / estado | Dependência ou risco | Condição para avançar |
|---|---|---|
| P0 residual confirmado por configuração informada pelo PO | Rotas/grants legados ainda amplos; frontend ainda usa campos privados | Não declarar correção implantada; próxima unidade coordena leitores e corte no banco |
| P0 pendente de revisão real | Helpers de RLS, SECURITY DEFINER, views transitivas, triggers/jobs e owners/ACL efetivos | Incorporar exportações H/K existentes e definições sanitizadas autorizadas; não modificar RPC nesta unidade |
| Alta / operacional | Nova view invoker pode falhar se faltar SELECT de coluna base ou EXECUTE/helper; exposição por schema cache e herança precisa ensaio | Homologação equivalente, matriz positiva/negativa; não conceder acesso integral para resolver erro |
| Alta / futuro fluxo de dados | Schema vazio e defaults da nova role não protegem dados ainda em public | Não mover dados nem adicionar espelho; separar unidade de migração após autorização |
| Alta / histórico | DELETE direto de times pode contornar protocolo se ACL/RLS permitirem | Incluir DELETE e cascatas no futuro corte de comandos, sem teste destrutivo em produção |
| Média / compatibilidade | DTO omite perfil_id e delta usados por consumidores antigos | Adaptar vínculo próprio e resumo mensal antes de substituir leitura ativa; nenhum corte agora |
| Bloqueio de implantação | Não existe ambiente de homologação definido/autorizado nesta tarefa | Revisão técnica primeiro; depois autorização separada de testes/implementação complementar, nunca aplicação automática |

Aceite desta unidade: código e SQL revisáveis; allowlists coerentes entre TS e view; testes locais verdes; nenhuma modificação de aplicativo ativo/RPC/dados; documentação das decisões e DELETE; diff disponível; nenhum segredo/conta real em fixtures. Aceite de banco **não** foi atingido nem alegado. Não criar commit até revisão técnica. Não há push, merge, deploy ou autorização de indisponibilidade.
