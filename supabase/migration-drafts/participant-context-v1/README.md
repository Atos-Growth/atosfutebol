# Rascunho offline — contexto da lista de participantes

**Não executar. Não copiar para `supabase/migrations` nem para o SQL Editor.**

`prepare_participant_context_v1.sql` contém DDL proposto para as duas RPCs já contratadas na Rodada 4.6. Não é inventário somente leitura: se fosse aplicado, criaria role, policies SELECT exclusivas dessa role, funções e grants. A autorização desta rodada cobre apenas arquivos e testes locais, sem executar SQL em qualquer banco.

Base do diff: `e056398f10c920958d1959b43f1e0ea7b3922c07`. Não depende de aplicar o schema interno vazio da Rodada 4.4; usa somente colunas existentes nas migrations 001/010/013. A correspondência com o banco real e o principal autorizado a transferir ownership ainda são bloqueios. Não cria tabela de cálculo, espelho, dados, job ou publicação Realtime.

Pré-condições, contratos, ACLs, riscos e homologação: [revisão do backend](../../../docs/security/p0-participant-context-backend.md).

Teste isolado, usando parser local já instalado (sem servidor PostgreSQL):

```sh
PYTHONPATH=/tmp/atos-p0-pg17-parser python -B -m unittest discover -s tests/security -p test_participant_context_sql.py -v
```

Executar o comando a partir da raiz deste worktree. `pglast` analisa os textos SQL e PL/pgSQL; não executa as instruções. Não substituir o comando por `psql`, Supabase CLI ou um banco temporário nesta rodada. O teste também entra na descoberta do runner P0 `tests/security/run_local.py`.

O script é transacional, com colisões recusadas e sem `CREATE OR REPLACE`; não é idempotente e não substitui funções desconhecidas. Seus guards recusam divergências mínimas de schema/ACL, mas não substituem revisão do catálogo, políticas transitivas, `auth.uid()` e dependências reais. Não existe aprovação de disponibilidade/produção implícita nestes guards.
