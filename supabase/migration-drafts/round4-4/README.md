# Rascunhos de migrations — NÃO APLICAR

SQL aditivo preparado na Rodada 4.4, sem execução. Fora de `supabase/migrations/` de propósito: ainda faltam revisão do catálogo/definições reais e homologação autorizada. Não copiar para o SQL Editor nem executar com CLI/psql nesta rodada.

1. `prepare_internal_schema.sql`: owner dedicado e schema **vazio**, ACL/defaults mínimos. Não contém dados, tabelas de cálculo, espelho ou memberships.
2. `prepare_participants_public_v1.sql`: view de leitura com allowlist, `security_invoker`, vínculo aprovado do mesmo tenant e SELECT para authenticated. Não altera tabelas, policies ou RPCs existentes.

Os arquivos têm BEGIN/COMMIT e falham em colisões; não são idempotentes por design e não sobrescrevem objetos desconhecidos. Números e promoção para migrations só após aprovação. Roles/ACL de bases, defaults herdados e funções chamadas por RLS precisam ser revisados. Manter rascunhos aqui não fecha a exposição dos endpoints antigos.

Detalhes, riscos e rollback: [entrega 4.4](../../../docs/security/p0-offline-implementation-round4-4.md).
