# P0 — primeira implementação offline do backend de contexto de participantes

## Recuperação controlada (Claude Code, 2026-11-19)

O container original do Codex não está acessível; os commits da nuvem (incluindo `e056398`) **não foram reproduzidos**. Com autorização do PO, a branch `security/p0-claude-recovery` parte de `origin/main` `8b59800` e recebe somente os quatro patches exportados, aplicados nesta ordem. Os 29 arquivos resultantes conferem com os hashes de blob declarados nos patches.

| Patch exportado | Entrega original | SHA-256 do patch | Arquivos |
|---|---|---|---|
| `atos-futebol-round4-4-offline-p0.patch` | Rodada 4.4 — arquitetura P0 offline | `b479575f…01ed298` | 14 |
| `atos-futebol-round4-5-safe-reader.patch` | Rodada 4.5 — leitor seguro | `1de0b864…dfeee3` | 4 |
| `atos-futebol-round4-6-participant-list-contracts.patch` | Rodada 4.6 — contratos (commit original `e056398`) | `b07199c5…c77382` (igual ao registrado abaixo) | 7 |
| `atos-futebol-participant-context-backend-v1.patch` | Rascunho não commitado das RPCs (exportado 16:41) | `db94a7d2…19b841` | 4 |

Lacunas: os adendos citados abaixo (`p0-offline-implementation-round4-4.md` como adendo, `p0-legacy-consumer-inventory-r4-5.md`, `p1-sports-rpc-integration-contract.md`) e qualquer trabalho da Rodada 4.7 posterior ao export **não foram recuperados**. A correção de roles PG17 desta branch foi feita do zero sobre o rascunho exportado (seção "Correção PG16+/PG17 de roles").

## Commit autorizado e escopo novo

Rodada 4.6 commitada em **`e056398f10c920958d1959b43f1e0ea7b3922c07`**, pai `9b389b22570c535eb6e365736863819d33482f62`. Os sete arquivos foram comparados byte a byte com a aplicação do patch aprovado em índice temporário; SHA-256 do patch `b07199c5533d94933f2244ab5bf1879a26f3e0eb5eff0bd7e0a2c03276c77382`. O índice real ficou vazio. Os adendos anteriores `p0-offline-implementation-round4-4.md`, `p0-legacy-consumer-inventory-r4-5.md` e `p1-sports-rpc-integration-contract.md` não entraram no commit nem foram alterados.

Esta unidade nova fica **sem commit**, para revisão independente. Contém apenas:

- `supabase/migration-drafts/participant-context-v1/prepare_participant_context_v1.sql`: DDL proposto, fora do diretório de migrations automáticas.
- `supabase/migration-drafts/participant-context-v1/README.md`: instruções offline e aviso de não aplicação.
- `tests/security/test_participant_context_sql.py`: testes estáticos de AST SQL/PLpgSQL, sem banco.
- Este documento: proveniência, permissões, limites e gates específicos.

Não há alteração do DTO, App, leitores/consumidores, migrations existentes ou funções implantadas. Nenhuma consulta, execução SQL/RPC, fixture, ativação, commit desta unidade, push, merge ou deploy.

## Proveniência e informação real ainda ausente

Foram lidos, sem modificar o outro worktree, os documentos em `/workspace/atosfutebol-security-round1/docs/security/`. A afirmação de que as definições reais foram auditadas não permite inferir seus corpos: o protocolo 4.1 registra “nenhuma função foi executada ou definição real incluída”; o plano 4.2 registra que os arquivos tabulares/manifestos e definições reais ainda não foram anexados ao agente. Não foram encontrados esses anexos no workspace atual. Não houve tentativa de recuperar informações via conexão.

| Fonte examinada | Evidência efetivamente usada / limite |
|---|---|
| `001_initial.sql:9` | `participantes.id uuid` PK. Fonte versionada, não confirmação de catálogo real |
| `010_multi_tenant_rachas.sql:37` | `racha_membros(racha_id, perfil_id, papel)`; UNIQUE `(racha_id, perfil_id)`; RLS e papéis `normal/admin/pendente` |
| `010_multi_tenant_rachas.sql:194` | Adição de `perfil_id` e `racha_id` aos participantes, tenant obrigatório. Não reexecutar essa migration destrutiva |
| `013_estrelas_automaticas_mensais.sql:25` | `estrelas_travadas boolean not null default false`; não inventar coluna/tabela interna nova para resolver o contrato |
| Auditorias 4.1/4.2/4.3 no worktree anterior | Direção de mínimo privilégio, autorização atual, `search_path` seguro, ausência de bypass por dono/service_role e gate de definições reais |
| Resumo H/K informado pelo PO | PG17.6, grants amplos, 18 triggers e ausência de publicação esportiva no escopo consultado; não fornece os corpos/ACLs exatos necessários para certificar implantação |

Fingerprints SHA-256 das fontes externas lidas (não copiadas nem modificadas):

```text
p0-round4-1-definition-review.md   24c8b2cbdbd729dfb5ce380f5753c8206b59c575838bf3df7a12edbb3376a223
p0-implementation-plan-round4-2.md b5df76dc75f2f88b0f33fbd732bffb934c78d56b8421e0f363b203c8d1a85880
p0-technical-design-round4-3.md    e28ad89c5cde329d22b2a8182afbf766630a7d0eb659d6b6b383e46fc9495e40
```

O SQL é concreto, porém **condicionado à validação da fonte versionada contra as evidências reais já coletadas**. Não atribuir aos rascunhos status de definição real auditada. Nenhuma estrutura existente foi presumida além das fontes identificadas; a role e as policies de execução são objetos novos explicitamente propostos.

## Implementação e autorização

| Contrato | Guarda e resultado |
|---|---|
| `obter_meu_participante_v1(p_racha_id uuid) returns jsonb` | `auth.uid()` não nulo; exatamente um vínculo atual `normal/admin` em `racha_membros` no tenant. Busca somente `(racha_id, perfil_id=auth.uid())`. Zero participantes → `{racha_id, participante_id:null}` autorizado; um → ID; dois ou mais → erro fechado. Não retorna `perfil_id` |
| `obter_gestao_participantes_v1(p_racha_id uuid, p_participante_ids uuid[]) returns jsonb` | UID e vínculo atual admin no tenant antes de qualquer resultado, inclusive vazio. Até 100 entradas brutas; array unidimensional, base 1, sem null; deduplica preservando a primeira posição. Consulta exata por tenant/IDs; faltantes, estrangeiros ou estados nulos fazem falhar o lote inteiro. Retorna somente `{racha_id, participante_id, nivel_estado}` por ID |

Não há parâmetros de perfil/papel, busca de terceiros por conta, uso de claims de papel, fallback ou helper legado `is_membro_*`. O vínculo vem diretamente da tabela, no snapshot da leitura. O estado é `congelado` para true e `automatico` para false; null não é tratado como false. Esse indicador continua restrito à gestão: o badge do jogador comum depende de decisão separada e o DTO público permanece com oito campos.

O rascunho adiciona a role **nova** `atos_participant_context_reader`, NOLOGIN/NOINHERIT/NOBYPASSRLS, sem superuser, criação de banco/roles, replicação ou memberships próprias (não é membro de nenhuma role; o único registro em que aparece como role concedida é o ADMIN OPTION implícito do criador, ver correção PG16+/PG17). Ela possui SELECT apenas em `racha_membros(racha_id,perfil_id,papel)` e `participantes(id,racha_id,perfil_id,estrelas_travadas)`, USAGE em public/auth e EXECUTE em `auth.uid()`. Não é dona das tabelas. Não recebe grants de pontuação, memória, delta, configuração de cálculo ou escrita. Poderes implícitos por PUBLIC em outros objetos ainda dependem da revisão real; o guard final cobre as duas bases utilizadas, não certifica todo o banco.

Duas policies SELECT se aplicam **somente à nova role**: vínculo próprio aprovado; e participante próprio para membro ou qualquer participante do mesmo tenant para admin. Não são policies adicionais para `authenticated`, anon ou PUBLIC. A role não é concedida ao authenticator, authenticated, service_role ou a usuários. Essas policies atendem o executor sob RLS; não criam uma rota REST alternativa para ler configuração bruta. O corpo de cada RPC ainda aplica explicitamente usuário, tenant e papel.

As funções são `STABLE SECURITY DEFINER`, owner dedicado, `search_path=pg_catalog,pg_temp`, `row_security=on`; objetos de aplicação são qualificados. CREATE no schema public e SET sobre a role executora são concedidos temporariamente apenas para a transferência de owner e revogados na mesma transação. O principal de implantação precisa ter poderes legítimos para criar/transferir (verificados no preflight); o rascunho não o eleva nem lhe dá INHERIT sobre o executor.

**Antes** da transferência, enquanto o principal ainda é dono, REVOKE ALL nas duas novas funções de PUBLIC, anon, authenticated e service_role; somente authenticated recebe EXECUTE, sem grant option. O `ALTER OWNER` reescreve esses grantors para o novo dono. A guarda por vínculo continua obrigatória: papel SQL authenticated não equivale a organizador. Defaults de criadores legados não são alterados aqui. O estado intermediário permanece dentro da transação, sem exposição comprometida por COMMIT parcial.

### Correção PG16+/PG17 de roles

| Problema no rascunho exportado | Correção |
|---|---|
| Criador CREATEROLE não superusuário recebe ADMIN OPTION implícito sobre a role criada; o guard `roleid = v_reader or member = v_reader` abortava sempre | Guard aceita apenas a linha do criador com ADMIN e sem INHERIT/SET (grantor ≠ criador) e recusa qualquer outra; executor continua sem ser membro de nada. `set local createrole_self_grant = ''` impede INHERIT/SET implícitos por configuração do ambiente |
| `ALTER FUNCTION … OWNER TO` exige poder fazer `SET ROLE` para o novo dono; o ADMIN implícito não dá SET | `grant … to current_user with inherit false, set true` imediatamente antes das duas transferências e `revoke` completo imediatamente depois, na mesma transação. Pelo `user.c` do PG17, as linhas de `pg_auth_members` são chaveadas por (role, membro, grantor): a linha implícita tem o bootstrap superuser como grantor, enquanto o GRANT sem `GRANTED BY` registra o próprio principal. O REVOKE completo apaga só essa segunda linha e preserva ADMIN true, INHERIT false e SET false. `REVOKE SET OPTION FOR` foi descartado: manteria uma linha residual sem opções, que o guard rejeita |
| `ALTER DEFAULT PRIVILEGES FOR ROLE` do executor exige `has_privs_of_role` (INHERIT) e só afetaria objetos criados pelo executor, que não cria nenhum | Removido; ACL explícita das funções já cobre os defaults do principal |
| REVOKE/GRANT das funções vinham depois da transferência, quando o principal já não tinha privilégios de dono (REVOKE viraria no-op, GRANT falharia) | Movidos para antes do `ALTER OWNER` |
| Dependências em `auth` (schema gerenciado pelo Supabase) e poderes do principal não eram verificados antes do DDL | Preflight aborta com `PARTICIPANT_CONTEXT_REQUIRES_CREATEROLE`, `PARTICIPANT_CONTEXT_REQUIRES_OBJECT_OWNER` ou `PARTICIPANT_CONTEXT_AUTH_GRANT_UNAVAILABLE` (existência e tipo de `auth.uid()`, USAGE/EXECUTE com grant option) |

Superusuário não é presumido. O mesmo caminho funciona se o principal for superusuário (sem linha implícita; grant/revoke temporários são neutros).

O preflight recusa nomes/overloads/role já existentes, principal sem CREATEROLE, sem posse das tabelas ou sem grant options necessárias, tabelas sem RLS, tipos/nulabilidade incompatíveis, ausência da PK de participante ou da unicidade imediata de vínculo. O guard final recusa memberships da role, flags privilegiadas, CREATE efetivo, leitura de tabela inteira, colunas além da allowlist, escrita, MAINTAIN, grant options, owner inesperado e EXECUTE adicional detectado nas novas funções. Privilégios PUBLIC/herdados incompatíveis abortam o rascunho; não são “corrigidos” por revogar objetos legados às cegas.

Esses guards são parciais por desenho: não verificam todos os objetos do banco, integridade histórica, corpo de `auth.uid()`, RLS transitiva, permissões implícitas de administradores da plataforma ou segurança de funções PUBLIC legadas. A revisão real continua indispensável.

## Revogação, atomicidade e erros

As duas funções são somente leitura, sem DML, locks de negócio, SQL dinâmico, chamadas de cálculo, jobs ou efeitos laterais intencionais. GET/retry é naturalmente repetível, sem registro de idempotência ou resposta persistida. `STABLE` mantém o mesmo snapshot para a autorização e os dados durante a chamada. Não se adiciona lock que bloqueie remoção de membro ou operação esportiva.

Revogação/downgrade já commitado antes de uma **nova requisição e snapshot** deve negar a leitura, mesmo com JWT ainda válido. Uma leitura iniciada antes da revogação pode concluir segundo o snapshot anterior; transação longa em REPEATABLE READ pode conservar snapshot antigo. Não prometer revogação retroativa: homologação deve confirmar transações curtas/READ COMMITTED do caminho PostgREST; consumidor deve cancelar/descartar contexto antigo. O código não guarda cache nem faz exceção para dono, job ou service_role.

Erros emitidos pelo corpo usam códigos fixos: `42501/PARTICIPANT_CONTEXT_DENIED`, `22023/INVALID_PARTICIPANT_CONTEXT_REQUEST`, `P0001/PARTICIPANT_CONTEXT_UNAVAILABLE`. Não retornam IDs conflitantes, SQLERRM, cálculos, DETAIL ou HINT com conteúdo. Inexistente/estrangeiro/oculto compartilham negação de lote. Não se afirma indistinguibilidade de timing. Erros de conversão de UUID anteriores à entrada na função, limites da plataforma, timeout/cancelamento e metadados CONTEXT de PLpgSQL ainda exigem inspeção das respostas reais; o leitor aprovado sanitiza falhas HTTP, mas não pode substituir proteção de erro no servidor.

## Testes locais e gate de homologação

O arquivo novo contém **26 testes estáticos** (20 originais, adaptados à correção PG17, e 6 novos: SET temporário sem INHERIT, ACL antes da transferência, preflight do principal e três sobre um modelo estrutural das regras de `pg_auth_members` do PG17, aplicado à AST: estado final, mutações rejeitadas e ausência de INHERIT durante a transação. O modelo não é execução em banco) com pglast 7.23/gramática PG17.7. Analisa SQL e os quatro blocos PLpgSQL (preflight, duas funções e guard de ACL), sem servidor. Verifica assinatura, projeção JSON contra as constantes TypeScript aprovadas, ordenação das guardas, tenant/ator/papel conjoined, detecção de vínculo ambíguo, lotes/ordem/completude, allowlist de chamadas, ausência de escrita/helpers, RLS da role dedicada, ACLs e falha dos testes ao mutar predicados de autorização.

Comandos locais, sem operações no Supabase:

```sh
python -B tests/security/run_local.py --tsc node_modules/typescript/bin/tsc --parser-path /caminho/pglast-pg17
python -B tests/security/run_participants_reader.py
python -B tests/security/run_participant_context.py
```

Parsing não resolve tipos/objetos no catálogo, não compila a função no servidor e não executa seu controle de fluxo. Os 17 testes do SDK usam HTTP interceptado e atores sintéticos; não são execução dessas funções SQL. A regressão do runner P0 inclui os 20 novos e os 26 anteriores. DTOs/fixtures/relatórios não contêm credenciais ou dados pessoais reais.

**Resultado na recuperação (Windows, Node 24, Python 3.12, pglast 7.23):** runner P0 com 42/42 Python (26 deste SQL + 16 anteriores) e 10/10 Node; leitor seguro 12/12; contratos com SDK 17/17; `npx tsc -b`, `npm run build`, `npm run lint -- --max-warnings 4` (0 erros, 4 avisos preexistentes) e guarda de migrations (122/122, 0 migrations alteradas) passaram. Nenhum teste foi executado em Supabase; nenhum banco local foi iniciado.

| Bloqueio específico | Evidência/ensaio necessário antes de promover o rascunho |
|---|---|
| B-REAL — exports e definições reais ausentes | Receber H/K já coletados e revisão sanitizada de `auth.uid()`, policies efetivas de participantes/membros, helpers transitivos, owners/ACL/defaults e nomes/overloads. Sem repetir consultas nesta tarefa |
| B-IDENTITY — schema/links reais não validados | Confirmar UUIDs, flag NOT NULL, enum, PK de participante, UNIQUE imediato de vínculo e FKs pertinentes. Tratar participantes próprios duplicados por decisão de integridade; não apagar/reatribuir para fazer o endpoint passar |
| B-RLS — políticas adicionais/restritivas e grants indiretos | Demonstrar executor mínimo com RLS ativo e sem chamada privilegiada inesperada. Policy restritiva desconhecida pode ocultar um participante e produzir falso “sem vínculo”; por isso o controle positivo próprio é obrigatório antes de liberar null como elegibilidade de cadastro |
| B-DEPLOY — poderes/schema cache/latência | Rodar o script em homologação como o principal real: o preflight deve passar sem `PARTICIPANT_CONTEXT_REQUIRES_*`/`AUTH_GRANT_UNAVAILABLE` (CREATEROLE, posse das tabelas, CREATE com grant option em public, USAGE/EXECUTE com grant option em `auth`/`auth.uid()`). Se `AUTH_GRANT_UNAVAILABLE`, decidir o caminho com o PO; não contornar. Após COMMIT, conferir `pg_auth_members` (só a linha ADMIN do criador), owner/ACL das funções e ausência de CREATE do executor. Schema API/cache PostgREST compatível com JSONB escalar e GET STABLE; planos e locks DDL |
| B-AUTH — duas comunidades e revogação | REST direto: membros/admins A/B, membro A+admin B, admin A+B, pendente, removido, anônimo e token expirado. Controles positivos por ator; IDs mistos, ausentes, duplicados, null, multidimensionais e 0/1/100/101 entradas; role/tenant alterados entre chamadas. Negativas não podem passar só por erro de autenticação/setup |
| B-ERROR/REVOKE — semântica efetiva | Inspecionar payload HTTP real inclusive falhas de tipo, permissão/owner, timeout e grant options; nova requisição após remoção/downgrade nega, concorrente anterior obedece snapshot documentado. Confirmar ausência de cache antigo no consumidor futuro |
| B-P0 — superfícies legadas abertas | Revisar retorno bruto de leitura/escrita, views/RPCs e privilégios globais; essas novas RPCs não fecham rotas existentes. Nenhuma ampliação de DTO, nenhum acesso de cálculo a admin, nenhuma habilitação de Realtime |

## Impacto, rollback e aprovação

Sem execução, impacto atual limita-se a quatro arquivos novos; App e banco permanecem intactos. Futuramente, CREATE POLICY adquire lock de tabela e DDL atualiza catálogos; timeout de 2 s/15 s limita espera, não garante ausência de interrupção. Não há autorização de indisponibilidade, e a avaliação real pode exigir janela específica. Nenhum dado é copiado, recalculado ou movido.

Falha antes do COMMIT futuro deve reverter a transação inteira. Após eventual implantação autorizada, rollback restrito começa por retirar EXECUTE das **duas novas** funções, verificar consumidores/dependentes, retirar somente funções/policies/grants/role novos sem CASCADE; nunca restaurar grants amplos ou desativar RLS. Não há script de rollback aplicado ou destrutivo nesta entrega. Alteração futura da localização da flag interna exige revisar o SELECT/privileges deste executor, sem espelho ou fallback bruto.

Gate atual: revisão independente do SQL concreto, role/policies mínimas e testes. A nova unidade não será commitada sem autorização. Aplicação e testes de banco exigem outro gate com homologação definida e autorizada. **P0 não está resolvido; exploração efetiva não foi demonstrada.**
