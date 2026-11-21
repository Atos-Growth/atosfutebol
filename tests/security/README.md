# Testes P0 da unidade 4.4

## Apenas local nesta rodada

Na raiz do worktree, com Node/TypeScript do projeto e Python/pglast 7.23 já instalados:

```bash
python -B tests/security/run_local.py --tsc /caminho/typescript/bin/tsc --parser-path /caminho/pglast-pg17
```

O runner não instala dependências, não lê `.env`, não executa SQL e não inicia cliente Supabase. TypeScript emite em pasta temporária removida ao final. Os testes de autorização usam transporte simulado e bloqueiam `urllib` de abrir conexões. Os testes SQL analisam a AST com parser PG17; não substituem validação no banco. Não chamar `authorization_v1.py` durante esta rodada.

## Sondas preparadas para homologação, ainda não autorizadas

O CLI GET-only exige TODOS os argumentos abaixo; não existe destino padrão. Este comando é referência para uma tarefa futura, **não executar agora**:

```text
python -B tests/security/authorization_v1.py
  --fixture /caminho/restrito/fixture-sintetica.json
  --allow-host HOST_EXATO_DA_HOMOLOGACAO
  --homologation-authorized
  --authorization-reference REFERENCIA_DA_AUTORIZACAO_ESPECIFICA
```

Pré-requisitos: aplicação autorizada da view no ambiente de homologação, fontes/policies/roles equivalentes e fixtures sintéticas já criadas pelo responsável. Fixture é externa, não pode conter tokens nem dados reais: `environment: homologation`, `host`, `tenants.A/B` com `racha_id` e `participant_id`; `actors` com `user_id` para `member_A`, `admin_A`, `member_B`, `admin_B`, `pending_A`, `removed_A`, `unrelated`, `admin_AB`. Dois membros/admins de tenants diferentes devem ser identidades independentes. Todos os IDs são UUIDs sintéticos distintos; `removed_A` tem token ainda válido, mas vínculo já removido; `pending_A` tem vínculo pendente. Não confundir isso com teste de revogação concorrente.

Credenciais somente em armazenamento/ambiente de execução autorizado: `ATOS_TEST_URL`, `ATOS_TEST_API_KEY` e `ATOS_TEST_<ACTOR_EM_MAIUSCULAS>_TOKEN`. Nunca usar service_role ou secret key; o runner reutiliza a rejeição de credencial de serviço e bloqueio de redirects de `docs/security/tests/probe_private_reads.py`. Não enviar tokens no chat nem colocá-los em fixtures/ZIP/Git. Sem owner real no modelo, não criar persona falsa de dono com service role.

Controles: cada JWT deve passar `/auth/v1/user`; cada papel deve corresponder ao vínculo persistido; membro/admin A e B precisam enxergar a fixture permitida. Só depois se aceitam listas vazias nas leituras negadas por tenant/papel. Acesso a campo privado, alias, JSON/filtro/order na view deve retornar erro esperado de coluna/permissão; token inválido, erro de sintaxe genérico, 5xx, timeout ou fixture ausente não são PASS. Wildcard da view deve retornar exatamente a allowlist, também para admin A+B.

Exportação: stdout contém somente identificadores de casos, quantidade e resultado; sem corpos, headers, tokens ou dados de jogadores. Falhas de transporte/configuração retornam BLOCKED (exit 2), violação retorna FAIL (exit 1). Sucesso (exit 0) cobre **somente a view v1**: nunca comprova proteção das tabelas/RPCs legadas, Storage, Realtime ou regras esportivas. Os flags e host são barreiras operacionais, não verificação independente de que o projeto seja homologação; operador precisa conferir o destino e a autorização fora do script.
