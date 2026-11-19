# Proteção da `main` e configuração do repositório

Hoje `Atos-Growth/atosfutebol` é **público**, a `main` **não tem proteção**, as
Actions aceitam qualquer action e não exigem SHA fixo. Nada disto foi aplicado
ainda: este documento é a proposta para revisão.

## Ruleset da `main`

Arquivo pronto: [`ruleset-main.json`](ruleset-main.json). Ele usa ruleset (e
não a proteção de branch clássica) porque é versionável e auditável.

| Regra | Valor | Por quê |
|---|---|---|
| Alvo | branch padrão (`~DEFAULT_BRANCH`) | Só a `main`. As branches das janelas ficam livres. |
| Bloquear exclusão | sim | — |
| Bloquear force push | sim | Protege o histórico das migrations. |
| Histórico linear | sim | Combina com squash; facilita o revert de um PR inteiro. |
| PR obrigatório | sim | Nenhum push direto na `main`. |
| Aprovações | **1** (ver decisão abaixo) | — |
| Descartar aprovação após novo push | sim | A aprovação vale para o código que foi revisado. |
| Aprovação do último push por outra pessoa | sim | Quem empurrou por último não aprova o próprio push. |
| Conversas resolvidas | sim | — |
| Método de merge | só squash | Um commit por PR na `main`. |
| Checks obrigatórios | os 5 jobs do CI, vindos do app GitHub Actions (`integration_id` 15368) | Impede que outro app publique um status com o mesmo nome. |
| Branch atualizada antes do merge | sim | O CI precisa ter rodado contra a `main` atual. |
| Bypass | ninguém | Nem administrador. |

**Decisão pendente: aprovações.** Com uma só pessoa no repositório, uma
aprovação obrigatória trava todo merge (o GitHub não deixa aprovar o próprio
PR). As opções:

1. Definir um segundo revisor e manter `1` (recomendado).
2. Usar `0` por enquanto. Os checks continuam obrigatórios e o PR continua
   necessário, mas sem revisão humana.

Não recomendo dar bypass ao administrador: o bypass também pula os checks.

**CODEOWNERS (proposta, não criado).** Quando houver os donos definidos, criar
`.github/CODEOWNERS` cobrindo `.github/`, `scripts/ci/`, `supabase/migrations/`
e `supabase/functions/`, e ligar `require_code_owner_review`. O arquivo não foi
criado porque os responsáveis de cada área ainda não estão definidos.

Isto não é detalhe: a guarda de migrations recusa marcadores em operações
críticas, então o caminho óbvio para contorná-la passa a ser editar a própria
guarda (`scripts/ci/`) ou o workflow no mesmo PR. Sem revisão obrigatória de um
code owner nesses caminhos, a guarda vale tanto quanto a boa vontade do autor.
É também o pré-requisito do futuro mecanismo de aprovação independente
(arquivo de aprovações com hash do SQL, ver [README](README.md#regras-críticas--sempre-reprovam-sem-exceção-por-comentário)).

### Aplicar (depois da aprovação)

Requer admin no repositório. Não faz parte desta rodada.

```bash
gh api repos/Atos-Growth/atosfutebol/rulesets --method POST --input docs/ci/ruleset-main.json
```

## Configurações de Actions

| Configuração | Hoje | Proposta |
|---|---|---|
| Actions permitidas | todas | Só as do GitHub (`allowed_actions: selected`, `github_owned_allowed: true`, sem padrões extras). O CI não usa nenhuma de terceiro. |
| Exigir SHA fixo | não | Sim (`sha_pinning_required: true`). |
| Permissão padrão do `GITHUB_TOKEN` | conferir | Somente leitura. |
| Actions podem criar e aprovar PR | conferir | Não. |
| PR de fork | conferir | Exigir aprovação para **todos** os colaboradores externos antes de rodar workflow. |
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

## Segurança do repositório

- **Secret scanning com push protection:** ligar (gratuito em repositório
  público). Bloqueia o push de chave conhecida antes que ela chegue ao GitHub.
- **Dependabot alerts:** ligar.
- **Dependabot version updates para `github-actions`:** opcional, para manter
  os SHAs fixados atualizados. Ele abre PRs sozinho, por isso fica como decisão.
- **Excluir branch após merge:** **manter desligado.** Várias janelas trabalham
  em branches longas; a exclusão automática pode apagar uma branch ainda em uso.

## Ativação por etapas

| Etapa | O que | Pré-requisito |
|---|---|---|
| A1 | Revisar e mergear o PR desta branch. O próprio PR já roda o CI (o gatilho `pull_request` usa o workflow do PR). | Revisão deste diff |
| A2 | Aplicar as configurações de Actions (seção acima). | A1 |
| A3 | Aplicar o ruleset com `enforcement: evaluate` por alguns PRs, para ver o que bloquearia, e depois mudar para `active`. | A1, decisão sobre aprovações |
| A4 | Commit separado removendo os arquivos gerados ([README](README.md#arquivos-gerados-no-versionamento)). | A1 |
| A5 | Avisar as janelas: PRs abertos passam a precisar de CI verde e de branch atualizada. As branches com Vitest já passam (224 testes ok em Node 24, 10 falhas esperadas marcadas pelos autores). | A3 |
| B | Job de banco no CI (`supabase start` + `db reset` + pgTAP) só **depois** do baseline validado e com 001–016 fora da cadeia executável. | Baseline da Janela 1 |
| C | Homologação e produção (deploy). | Aprovação arquitetural própria |

O `enforcement: evaluate` existe em rulesets de repositórios de organização com
GitHub Team/Enterprise. Se o plano não oferecer, pule direto para `active`
depois de conferir que os 5 checks aparecem verdes no PR da etapa A1.
