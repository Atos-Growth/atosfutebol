# CI — Fase A

O workflow [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) valida
Pull Requests para `main` e cada push na `main`. Ele **não** faz deploy, **não**
publica imagem, **não** usa secrets e **não** conecta em nenhum projeto
Supabase.

## O que roda

| Check (nome do job) | O que faz | Quando |
|---|---|---|
| `Frontend (lint, tipos, testes, build)` | `npm ci --ignore-scripts`, lint com teto de 4 avisos, `tsc -b`, `npm run test --if-present` (transitório, ver abaixo), `npm run build` | Sempre |
| `Guarda de migrations` | Testes da guarda e da política dos workflows + análise estática das migrations novas e do histórico | Sempre (sai em segundos se nada mudou em `supabase/migrations`) |
| `Docker (build sem publicar)` | `docker build` com valores fictícios + smoke test do nginx (index, cache, rota SPA, asset imutável) | Sempre |
| `Revisão de dependências` | Bloqueia dependência nova com vulnerabilidade alta ou crítica | Só em PR |
| `Lint dos workflows` | `actionlint` (binário oficial com checksum fixado) + `shellcheck` | Sempre |

Permissões: `permissions: {}` no topo e `contents: read` em cada job. O
checkout usa `persist-credentials: false`, então o token nem fica no `.git` do
runner. Todas as actions são do próprio GitHub e estão fixadas por SHA.

Node: a versão vem do [`.nvmrc`](../../.nvmrc) (24 LTS). O Dockerfile usa a
mesma (`node:24-alpine`).

## Testes da aplicação: `--if-present` é transitório

Hoje a `main` não tem script `test`; o Vitest existe nas branches do motor e na
`integration/fundacao-rodada-1`. Por isso o passo usa
`npm run test --if-present`, que tem dois comportamentos:

- **sem script `test`:** o passo passa sem rodar nada;
- **com script `test`:** os testes rodam e uma falha reprova o job.

O risco é o primeiro caso continuar valendo por engano: se alguém apagar ou
renomear o script, os testes param de rodar e o CI continua verde.

**Condição para trocar por execução obrigatória.** Assim que a `main` tiver o
script `test` (merge da `integration/fundacao-rodada-1` ou de qualquer branch
que o traga) **e** o primeiro run do CI na `main` mostrar os testes rodando e
passando, a Janela 5 abre um PR trocando o passo para:

```yaml
- name: Testes
  run: npm test
```

A partir daí a ausência do script reprova o CI. A troca não entra junto com o
merge da integração para não deixar a `main` vermelha entre um merge e outro.
Se o script `test:motor` ou outro subconjunto precisar ser obrigatório em
separado, ele entra no mesmo PR.

## Rodar localmente

Os mesmos passos do job `Frontend`, com Node 24:

```bash
npm ci --ignore-scripts
npm run lint -- --max-warnings 4
npx tsc -b
npm run test --if-present
npm run build
```

A guarda de migrations e a política dos workflows:

```bash
node --test "scripts/ci/*.test.mjs"
node scripts/ci/check-migrations.mjs --base origin/main
```

Para analisar arquivos específicos sem diff (por exemplo, o que a guarda diria
das migrations legadas, sem reprovar nada):

```bash
node scripts/ci/check-migrations.mjs --report-only --files supabase/migrations/*.sql
```

> No Windows, rode a partir de uma pasta fora do OneDrive. Dentro dele o
> `vite build` chegou a ficar mais de 5 minutos sem saída; fora, leva ~6 s.

## Guarda de migrations

[`scripts/ci/check-migrations.mjs`](../../scripts/ci/check-migrations.mjs), sem
dependências, só Node.

**Por que é estática.** As migrations 001–016 foram aplicadas à mão em
produção e ainda não há baseline validado. Aplicar a cadeia num banco do CI
provaria uma história que não é a de produção, e a 010 trunca todas as tabelas
esportivas. Por isso o CI não aplica nenhuma migration: ele só lê o diff e o
texto dos arquivos.

### Regras estruturais — sempre reprovam

| Regra | Reprova quando |
|---|---|
| `historico-imutavel` | Um arquivo que já existe na base do PR é editado, apagado ou renomeado. Vale para 001–016 e para toda migration futura. Correção sempre em arquivo novo. |
| `nome-invalido` | Arquivo novo fora de `<AAAAMMDDHHMMSS>_<nome_em_snake_case>.sql` (formato do `supabase migration new`). |
| `versao-fora-de-ordem` | Versão menor ou igual à última existente, ou repetida no mesmo PR. |
| `arquivo-invalido` | Arquivo que não é `.sql` dentro de `supabase/migrations/`. |
| `marcador-invalido` | Marcador em regra que não aceita marcador, sem motivo ou com regra desconhecida. |

### Regras críticas — sempre reprovam, sem exceção por comentário

Destruir dados, desligar RLS, ampliar privilégios ou mexer em Realtime.

| Regra | Exemplo |
|---|---|
| `realtime-esportivo` | Tabela esportiva em publicação (`add/set table`, `for table`, `for all tables`, `tables in schema`, inclusive em SQL dinâmico) |
| `realtime` | Qualquer outra alteração de publicação, incluindo remover tabela |
| `truncate`, `drop-table`, `drop-column`, `drop-objeto` | `TRUNCATE`, `DROP TABLE`, `ALTER TABLE … DROP [COLUMN]`, `DROP SCHEMA/TYPE/VIEW/…` |
| `delete`, `update-sem-where` | `DELETE` executado pela migration, `UPDATE` sem `WHERE` |
| `disable-rls` | `DISABLE` / `NO FORCE ROW LEVEL SECURITY` |
| `grant-anon` | `GRANT … TO anon` ou `TO public` |
| `grant-dado-interno` | Qualquer `GRANT` que alcance dado interno (DEP-03/INV-05): coluna `participantes.pontuacao`, tabela inteira de `participantes` sem lista de colunas, `fechamentos_mensais`, `avaliacoes_sessao`, ou `ALL TABLES IN SCHEMA`. Ex.: `GRANT SELECT (pontuacao, memoria) ON public.participantes TO authenticated` |
| `privilegios` | `ALTER DEFAULT PRIVILEGES`, `CREATE/ALTER ROLE`, `BYPASSRLS`, `OWNER TO`, concessão de papel (`GRANT service_role TO …`), `WITH GRANT OPTION`, `CREATE` em schema, `ALTER FUNCTION … SECURITY DEFINER` |
| `policy-aberta` | Policy aberta com certeza: sem `TO` (vale para public), `TO public/anon`, ou expressão tautológica — `true`, `(true)`, `not false`, `1 = 1`, `'a' = 'a'`, `… OR true`, `auth.uid() IS NOT NULL`, `auth.role() = 'authenticated'` (num app multi-racha, "qualquer autenticado" atravessa rachas) |
| `drop-policy` | `DROP POLICY` sem recriar a policy de mesmo nome no mesmo arquivo, ou com nome montado dinamicamente. Sem ver o banco não dá para saber se ela era `RESTRICTIVE`; se era, removê-la amplia o acesso |
| `disable-trigger` | `ALTER TABLE … DISABLE TRIGGER/RULE`, `ENABLE REPLICA TRIGGER`, `session_replication_role`, `ALTER/DROP EVENT TRIGGER` |
| `drop-trigger` | `DROP TRIGGER` sem recriar o trigger de mesmo nome no mesmo arquivo |
| `drop-cascade` | `DROP … CASCADE` / `TRUNCATE … CASCADE` (leva policies, triggers e FKs dependentes junto). `ON DELETE CASCADE` não conta |
| `security-definer` | `SECURITY DEFINER` com search_path inseguro: ausente, `FROM CURRENT`, com `$user`, ou sem terminar em `pg_temp`. Seguro é `''` com nomes qualificados ou lista terminando em `pg_temp` |
| `definer-sql-dinamico` | `EXECUTE` com concatenação (`\|\|`) ou `format(… %s …)` no corpo de função `SECURITY DEFINER`, mesmo que a migration não a chame |
| `view-definer` | View sem `security_invoker` (roda com o dono e ignora a RLS de quem consulta), `security_invoker = false`, `ALTER VIEW … RESET/SET (security_invoker = off)`, e toda materialized view (não aplica RLS) |
| `tabela-sem-rls` | `CREATE TABLE` em `public` sem `ALTER TABLE … ENABLE ROW LEVEL SECURITY` para a mesma tabela no mesmo arquivo (o Supabase concede acesso padrão a anon/authenticated) |

**Um marcador escrito pelo autor do PR não é aprovação.** Por isso as regras
críticas recusam o marcador: o arquivo continua reprovado e o marcador gera um
erro `marcador-invalido` a mais, explicando que é preciso aprovação fora do CI.
Os testes provam isso para cada regra crítica e sensível e para variações de grafia
(maiúsculas, espaços), posição (fim de linha, bloco `/* */`), marcadores
acumulados e marcador escondido dentro de string ou de corpo de função.

**Enquanto não existir aprovação independente, uma operação crítica não passa
por este CI.** Ela exige autorização explícita fora do pipeline, como
combinado para a Janela 1. Mecanismo proposto para o futuro, ainda não
implementado: um arquivo de aprovações protegido por CODEOWNERS (por exemplo
`supabase/migration-approvals.json`), em que cada entrada liga o caminho da
migration ao **hash do conteúdo** e à pessoa que aprovou. A guarda só aceitaria
a operação crítica se o hash bater, e o ruleset exigiria revisão do code owner
nesse arquivo. Assim, quem aprova é diferente de quem escreve, e qualquer
mudança no SQL depois da aprovação invalida a aprovação.

### Regras sensíveis — reprovam até existir aprovação independente

Nem todo `GRANT` ou policy é vulnerabilidade: os contratos P0 vão precisar de
permissões mínimas. Mas só uma aprovação independente do autor pode dizer
quais são as aprovadas. Enquanto ela não existir, estas regras **também
reprovam o CI** e **também recusam marcador**, com mensagem própria ("exige
aprovação independente, que ainda não existe"), separada de "crítico":

| Regra | O que cobre |
|---|---|
| `grant` | `GRANT` de tabela, colunas, sequence ou schema para papel do app sem tocar dado interno. Ex.: `GRANT SELECT (nome, apelido) ON public.participantes TO authenticated` |
| `grant-execute` | `GRANT EXECUTE` de função para papel do app (RPC exposta) |
| `policy` | Toda criação, alteração, renomeação ou recriação de policy que não seja aberta com certeza. **Uma expressão diferente de `true` não torna a policy segura**: `racha_id IS NOT NULL` ou uma função auxiliar mal escrita abrem tanto quanto `true` |
| `trigger` | Criação, substituição ou drop+recriação de trigger |
| `definer` | Função `SECURITY DEFINER` com search_path seguro. O search_path fixo não basta: a função roda com os privilégios do dono, e o que ela faz precisa bater com o contrato |
| `view` | View com `security_invoker` ligado, ou alteração das opções de view: o que importa passa a ser quais colunas ela expõe |

`GRANT` para `service_role`, `postgres` ou `supabase_admin` não é acusado (não
amplia o acesso do app). `REVOKE` não é acusado.

**Contrato P0 da Janela 1 ainda não conferido.** O documento
`docs/security/p0-technical-design-round4-3.md` não está disponível para a
Janela 5. Os critérios acima são conservadores e as listas de
[`migration-guard.config.json`](../../scripts/ci/migration-guard.config.json)
(`sportsTables`, `internalData`) precisam ser conferidas contra ele quando a
cópia sanitizada chegar.

### Regras de compatibilidade — aceitam marcador, que vira aviso

`drop-function` e `rename`. Elas quebram o frontend que está no ar (RPC some,
coluna muda de nome), mas não destroem dados nem ampliam acesso. O autor pode
sinalizar a intenção no próprio arquivo:

```sql
-- ci-guard:allow drop-function a assinatura de fechar_mes muda de (uuid) para (uuid, date)
drop function if exists public.fechar_mes(uuid);
```

O marcador transforma o erro em **aviso** no PR e numa tabela no resumo do job
("exige revisão humana"). Ele vale só para a regra citada e só naquele arquivo,
e só é lido em comentário de linha (`--`) de verdade.

### Função definida e chamada pela própria migration

O corpo de `CREATE FUNCTION` normalmente é ignorado, porque só roda quando a
função for chamada; um `delete` dentro de uma RPC não é uma operação da
migration. A exceção: se a própria migration **invoca** a função (por `SELECT`,
`PERFORM`, `CALL`, dentro de `DO`, ligada a trigger por `EXECUTE FUNCTION`, ou
chamada por outra função invocada), o corpo dela é analisado como parte da
migration. Sem isso, bastaria embrulhar um `TRUNCATE` numa função e chamá-la.
`GRANT`/`REVOKE`/`COMMENT`/`ALTER`/`DROP FUNCTION` não contam como chamada.

### O que a guarda ignora de propósito

- Comentários.
- `DROP CONSTRAINT`, `DROP DEFAULT` e `DROP NOT NULL` (sem `CASCADE`).
- `REVOKE` e `GRANT` para papéis privilegiados.
- Tabela temporária e tabela fora de `public`.

`DROP POLICY` deixou de ser ignorado: é crítico sem recriação e sensível com
recriação.

### Limites conhecidos

É análise estática; ela não substitui a revisão. Não detecta:

- SQL montado por concatenação (`'trun' || 'cate'`) ou vindo de tabela;
- chamada de função que já existe no banco e cujo corpo não está no arquivo;
- o **estado atual do banco**: se a policy removida era `RESTRICTIVE`, o que
  fazia a função ou o trigger substituído, quais colunas uma view já expunha;
  por isso todo drop/recriação é tratado como risco, sem comparação;
- policy que abre acesso por uma **função auxiliar** (`using (public.pode_ler())`):
  a expressão parece restrita e é classificada como `policy` (sensível, reprova),
  mas a guarda não avalia o corpo da função;
- tautologias fora da lista conhecida (por exemplo `coalesce(x, true)`): também
  caem em `policy` (sensível), nunca em "seguro";
- `CREATE OR REPLACE FUNCTION` que esvazia uma função de trigger já existente
  (o trigger continua ligado, mas não faz mais nada);
- dado interno em tabela que não está em `internalData`;
- alteração da própria guarda (`scripts/ci/`) ou do workflow no mesmo PR.

O último item é o mais importante: quem consegue editar a guarda consegue
desligá-la. Por isso `scripts/ci/` e `.github/` precisam de CODEOWNERS e de
revisão obrigatória ([protecao-da-main.md](protecao-da-main.md)).

### Resultado sobre as legadas (só leitura)

`--report-only` nas 16 legadas acusa 201 pontos: 65 críticos, 4 de
compatibilidade sem marcador e 132 sensíveis. Os que não são sensíveis:

| Achado | Onde |
|---|---|
| `security-definer` (34) | Todas as funções definer usam `search_path = public` sem `pg_temp` no fim |
| `drop-policy` (13) | 003 e 010; cinco com nome montado dinamicamente (laço sobre `pg_policies` na 010) |
| `policy-aberta` (10) | `using (true)` em 001, 003 e 010 (inclui `rachas` legível por qualquer autenticado) |
| `drop-function` (4) | `009:173`, `010:573`, `010:574`, `012:48` (troca de assinatura) |
| `view-definer` (3) | `ranking_historico` sem `security_invoker` em `001:158`, `010:582`, `016:391` |
| `grant-dado-interno` (1) | `013:618`: `grant select on public.avaliacoes_sessao, public.fechamentos_mensais to authenticated` — exatamente a exposição do DEP-03 |
| `drop-cascade` (1), `truncate` (1), `drop-column` (1) | `010:200`, `010:197`, `010:158` |
| `realtime-esportivo` (1) | `001:189` (partidas, eventos, times) |

Os sensíveis são 105 `policy`, 19 `grant-execute` e 8 `trigger`.

Como elas já existem na base, a guarda não as reavalia em PR: só garante que
continuem intocadas.

## Arquivos gerados no versionamento

### Ignorar não é o mesmo que deixar de rastrear

O `.gitignore` só vale para arquivo **não rastreado**. Um arquivo que já está no
Git continua rastreado mesmo casando com um padrão ignorado: alterações nele
continuam aparecendo no `git status` e entrando em commit. Conferido nesta
branch:

```bash
git ls-files -ci --exclude-standard   # rastreados que casam com o .gitignore
```

lista 13 arquivos: `supabase/.temp/*` (9), `tsconfig.app.tsbuildinfo`,
`tsconfig.node.tsbuildinfo`, `vite.config.d.ts` e `vite.config.js`. Um
`*.tsbuildinfo` **novo** fica de fora do `git status`; o `tsconfig.node.tsbuildinfo`
rastreado, alterado pelo `tsc -b`, continua aparecendo.

Por isso esta branch só **prepara**: o `.gitignore` já cobre os arquivos para
que não voltem depois de removidos, e a remoção em si fica para um **commit
separado**, depois da revisão desta branch.

### `vite.config.js` precisa sair do diretório, não só do Git

O Vite procura o arquivo de configuração nesta ordem (Vite 6.4.3,
`node_modules/vite/dist/node/constants.js`):

```
vite.config.js → vite.config.mjs → vite.config.ts → …
```

O `vite.config.js` versionado é uma saída antiga do `tsc -b` e **ganha** do
`vite.config.ts`. Hoje os dois são equivalentes, mas qualquer edição no `.ts`
é ignorada sem aviso, no `npm run dev`, no `npm run build` e no build Docker
(o `COPY . .` leva o `.js` junto). Por isso ele é removido com `git rm` (que
apaga do disco), e não com `git rm --cached`. Se alguém continuar com uma cópia
local depois do pull, precisa apagá-la à mão. O `tsconfig.node.json` atual tem
`noEmit: true`, então o arquivo não volta a ser gerado.

### Commit separado (a fazer depois da revisão)

```bash
# Apaga do Git E do disco: o .js sombreia o vite.config.ts.
git rm vite.config.js vite.config.d.ts

# Sai do Git, fica no disco de quem fez o commit.
git rm --cached tsconfig.app.tsbuildinfo tsconfig.node.tsbuildinfo
git rm -r --cached supabase/.temp

git commit -m "Remove arquivos gerados do versionamento"
```

| Arquivo | Por que sai |
|---|---|
| `vite.config.js`, `vite.config.d.ts` | Saída antiga do `tsc -b`; o `.js` sombreia o `.ts`. |
| `*.tsbuildinfo` | Cache incremental do TypeScript; cada build local gera diff. |
| `supabase/.temp/` | Estado local da CLI: project ref de produção, id da organização, host do pooler. Não é senha, mas é informação de reconhecimento num repositório público, e muda a cada versão da CLI. |

Efeitos para quem já tem o repositório:

- ao fazer pull desse commit, o Git **apaga** do disco os arquivos removidos,
  inclusive o `supabase/.temp/`. Quem usa a Supabase CLI localmente precisa
  rodar `supabase link` de novo;
- branches antigas que ainda alteram esses arquivos vão ter conflito de
  "modificado × removido"; a resolução é aceitar a remoção.

## Fora da Fase A

- Deploy de homologação e de produção.
- Qualquer conexão com Supabase, inclusive `supabase start`/`db reset` no CI.
  Isso só entra depois do baseline validado (ver
  [protecao-da-main.md](protecao-da-main.md#ativação-por-etapas)).
- Checagem das Edge Functions com Deno.
- Mecanismo de aprovação independente para operações críticas.
