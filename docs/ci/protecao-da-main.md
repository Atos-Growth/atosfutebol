# Proteção da `main` e configuração do repositório

`Atos-Growth/atosfutebol` é **público**. Desde 19/11/2026 a `main` está
protegida pelo ruleset **Proteção da main** (id
[27656091](https://github.com/Atos-Growth/atosfutebol/rules/27656091),
`active`). As configurações de Actions e de segurança das seções seguintes
continuam como **proposta**, salvo onde está marcado como aplicado.

## Ruleset da `main` (aplicado)

O arquivo [`ruleset-main.json`](ruleset-main.json) é exatamente o que foi
enviado na ativação. Ruleset (e não a proteção de branch clássica) porque é
versionável e auditável.

| Regra | Valor | Por quê |
|---|---|---|
| Alvo | branch padrão (`~DEFAULT_BRANCH`) | Só a `main`. As branches das janelas ficam livres. |
| Bloquear exclusão | sim | — |
| Bloquear force push | sim | Protege o histórico das migrations. |
| Histórico linear | sim | Sem merge commit; facilita o revert de um PR inteiro. |
| PR obrigatório | sim | Nenhum push direto na `main`, para ninguém. |
| Aprovações | **0, temporário** | Não há segundo revisor confirmado; com 1 aprovação, todo merge travaria (o GitHub não deixa aprovar o próprio PR). Ver [Revisão obrigatória](#revisão-obrigatória-e-codeowners-próximo-passo). |
| Descartar aprovação após novo push | sim | Sem efeito com 0 aprovações; já fica pronto para quando houver revisão. |
| Aprovação do último push por outra pessoa | **não** | Ligado, pode exigir aprovação de outra pessoa mesmo com contagem 0. Liga junto com a revisão obrigatória. |
| Revisão de code owner | não | Ainda não há CODEOWNERS. |
| Conversas resolvidas | sim | Comentário de revisão aberto bloqueia o merge. |
| Métodos de merge | squash e rebase | Squash: um commit por PR. Rebase: preserva os commits de cada janela (por exemplo, na branch de integração). Merge commit fica de fora pelo histórico linear. |
| Checks obrigatórios | os 5 jobs do CI, vindos do app GitHub Actions (`integration_id` 15368) | Impede que outro app publique um status com o mesmo nome. |
| Branch atualizada antes do merge | sim | O CI precisa ter rodado contra a `main` atual. |
| Bypass | ninguém | Nem administrador: o bypass também pularia os checks. |

Os 5 checks, com os nomes exatos dos jobs do
[`ci.yml`](../../.github/workflows/ci.yml):

1. `Frontend (lint, tipos, testes, build)`
2. `Guarda de migrations`
3. `Docker (build sem publicar)`
4. `Revisão de dependências`
5. `Lint dos workflows`

O GitHub acrescenta por padrão
`require_extra_approval_for_unattributed_changes: true` (uma aprovação a mais
em PR aberto pelo Copilot sob a identidade dele). Sem efeito enquanto as
aprovações forem 0.

Renomear ou remover um job do `ci.yml` deixa os PRs esperando um check que
nunca chega. Mudar o nome de um job exige atualizar o ruleset ativo e este
arquivo no mesmo momento; o teste `workflow-policy.test.mjs` reprova o PR se
os nomes do `ci.yml` e deste arquivo divergirem.

### Repositório (aplicado)

- **Sugestão de atualizar a branch do PR** (`allow_update_branch`): ligada. O
  PR mostra o botão "Update branch" quando a `main` anda, o que a regra de
  branch atualizada exige.
- **Dependency graph:** ligado. É pré-requisito do check
  `Revisão de dependências`; **se for desligado, todo merge trava**.
- Squash, rebase e merge commit continuam habilitados no repositório; o
  ruleset limita a squash e rebase na `main`.

### Alterar ou desligar o ruleset

Requer admin no repositório.

```bash
# Conferir o que vale na main
gh api repos/Atos-Growth/atosfutebol/rules/branches/main

# Atualizar a partir deste arquivo
gh api repos/Atos-Growth/atosfutebol/rulesets/27656091 --method PUT --input docs/ci/ruleset-main.json
```

**Emergência.** Não há bypass. Se algo travar todos os merges (por exemplo, um
check que deixou de existir), um administrador muda o `enforcement` do ruleset
para `disabled` (interface ou API), corrige a causa e volta para `active`. A
mudança fica no log de auditoria da organização. Não usar isso para fazer
passar um PR com check vermelho.

## Revisão obrigatória e CODEOWNERS (próximo passo)

A guarda de migrations recusa marcadores em operações críticas e sensíveis,
então o caminho óbvio para contorná-la passa a ser editar a própria guarda
(`scripts/ci/`) ou o workflow no mesmo PR. Sem revisão obrigatória de um code
owner nesses caminhos, a guarda vale tanto quanto a boa vontade do autor. É
também o pré-requisito do futuro mecanismo de aprovação independente (arquivo
de aprovações com hash do SQL, ver
[README](README.md#regras-críticas--sempre-reprovam-sem-exceção-por-comentário)).

Ordem para ligar sem travar o repositório:

1. Dar acesso de escrita ao segundo responsável.
2. Abrir um PR (sob o ruleset atual) criando `.github/CODEOWNERS` para
   `.github/`, `scripts/ci/`, `docs/ci/`, `supabase/migrations/` e
   `supabase/functions/`, incluindo o próprio `.github/CODEOWNERS`.
3. Depois do merge, conferir que o GitHub leu o arquivo sem erros:
   `gh api repos/Atos-Growth/atosfutebol/codeowners/errors` deve voltar com a
   lista vazia.
4. Só então atualizar este arquivo e o ruleset com
   `required_approving_review_count: 1`, `require_code_owner_review: true` e
   `require_last_push_approval: true`.

Fazer o passo 4 sem o segundo responsável trava todo merge.

## Configurações de Actions (proposta, não aplicada)

| Configuração | Hoje | Proposta |
|---|---|---|
| Actions permitidas | todas | Só as do GitHub (`allowed_actions: selected`, `github_owned_allowed: true`, sem padrões extras). O CI não usa nenhuma de terceiro. |
| Exigir SHA fixo | não | Sim (`sha_pinning_required: true`). |
| Permissão padrão do `GITHUB_TOKEN` | conferir | Somente leitura. |
| Actions podem criar e aprovar PR | conferir | Não. |
| PR de fork | conferir | Exigir aprovação para **todos** os colaboradores externos antes de rodar workflow. Até a aprovação, os checks de um PR de fork ficam pendentes. |
| Runner self-hosted | nenhum | Continuar sem. Num repositório público, um PR de fork poderia rodar código na máquina. |

Comandos (depois da aprovação):

```bash
gh api repos/Atos-Growth/atosfutebol/actions/permissions --method PUT \
  -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
gh api repos/Atos-Growth/atosfutebol/actions/permissions/selected-actions --method PUT \
  -F github_owned_allowed=true -F verified_allowed=false
gh api repos/Atos-Growth/atosfutebol/actions/permissions/workflow --method PUT \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

## Segurança do repositório (proposta, não aplicada)

- **Secret scanning com push protection:** ligar (gratuito em repositório
  público). Bloqueia o push de chave conhecida antes que ela chegue ao GitHub.
- **Dependabot alerts:** ligar.
- **Dependabot version updates para `github-actions`:** opcional, para manter
  os SHAs fixados atualizados. Ele abre PRs sozinho, por isso fica como decisão.
- **Excluir branch após merge:** **manter desligado.** Várias janelas trabalham
  em branches longas; a exclusão automática pode apagar uma branch ainda em uso.

## Ativação por etapas

| Etapa | O que | Situação |
|---|---|---|
| A1 | PR #1 com o CI; o próprio PR roda o CI (o gatilho `pull_request` usa o workflow do PR). | 5 checks verdes; aguardando autorização de merge |
| A3 | Ruleset da `main`. | **Aplicado** em 19/11/2026, direto em `active` (o PR #1 já cumpria todas as regras) |
| A2 | Configurações de Actions (seção acima). | Proposta |
| A4 | Commit separado removendo os arquivos gerados ([README](README.md#arquivos-gerados-no-versionamento)). | Depois do merge do PR #1 |
| A5 | Avisar as janelas: toda integração na `main` passa a ser por PR com os 5 checks verdes e branch atualizada; push direto não funciona mais, para ninguém. As branches com Vitest já passam (224 testes ok em Node 24, 10 falhas esperadas marcadas pelos autores). | A fazer |
| R | Revisão obrigatória e CODEOWNERS (seção acima). | Aguardando segundo responsável |
| B | Job de banco no CI (`supabase start` + `db reset` + pgTAP) só **depois** do baseline validado e com 001–016 fora da cadeia executável. | Baseline da Janela 1 |
| C | Homologação e produção (deploy). | Aprovação arquitetural própria |
