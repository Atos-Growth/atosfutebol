# Unidade P0 — leitor de participantes para substituir consultas legadas

**Implementado offline, ainda sem commit ou integração ao App.** Base aprovada: `34c03104a5bf1232860e96ec3e107ab805f17c22`, branch `security/round4-4-offline-p0`. Esse commit contém exatamente os 14 arquivos do patch 4.4, SHA-256 `b479575fe0d661f02d9ef08e57913b7fe470c283344a6c60fc0d82f6901ed298`. O adendo posterior no relatório 4.4 e o documento P1 ficaram fora do commit e foram preservados no worktree.

## Código concreto

[participants-reader-v1.ts](../../src/data/participants-reader-v1.ts) recebe o cliente Supabase autenticado já existente e oferece:

- `loadParticipantsPageV1`: view `participantes_publicos_v1`, allowlist explícita, tenant obrigatório, ordenação por ID e cursor vinculado à comunidade. Contagem exata permite continuar mesmo se o servidor limitar a página abaixo do tamanho pedido; ausência/inconsistência de contagem falha em vez de simular fim da lista.
- `loadParticipantsByIdsV1`: resolve até 100 IDs pela view segura, substituindo a necessidade de embedding bruto de participantes. IDs repetidos da requisição são deduplicados; IDs ocultos/ausentes, inesperados, duplicados na resposta ou de outro tenant impedem retorno parcial. A ordem solicitada é preservada. Não prova vínculo com sessão: IDs da escalação devem vir de contrato autorizado próprio.
- Ambos validam respostas com os DTOs da 4.4, aceitam cancelamento, não mantêm cache e não retornam erro bruto do SDK. View ausente, sessão expirada, negação ou erro de rede nunca geram fallback para `participantes` ou `fechamentos_mensais`.

| Consumidor legado a substituir após homologação | Uso do módulo / integração restante |
|---|---|
| `App.tsx:216`, lista `participantes.select('*')` | Páginas seguras, descarte/cancelamento ao trocar comunidade e tratamento explícito de erro. Ordenação técnica é por ID; apresentação alfabética precisa ser preservada conscientemente na integração |
| `App.tsx:233/251/712/761`, embeds `participantes(*)` | Carregar primeiro IDs de escalação autorizada; resolver participantes por lotes seguros. Não omitir silenciosamente jogador que ficou indisponível |
| Retornos de cadastro e resumo mensal | Continuam pendentes: comandos seguros e estatísticas esportivas públicas. Não converter delta em DTO nem ativar rota bruta como compatibilidade |

O módulo não foi importado no `App.tsx` e não altera código consolidado de outras janelas. As rotas legadas continuam ativas; **P0 não está resolvido**. Paginação HTTP não oferece snapshot transacional entre páginas; alterações concorrentes de elenco demandam recarga/contrato de sessão, sem enfraquecer a autorização de cada requisição.

## Testes e evidências

```bash
python -B tests/security/run_participants_reader.py \
  --tsc /workspace/atosfutebol/node_modules/typescript/bin/tsc \
  --supabase-package /workspace/atosfutebol/node_modules/@supabase/supabase-js
```

Compilação TypeScript estrita e **12 testes de integração offline** passaram com `@supabase/supabase-js 2.110.8`. Usam o SDK/PostgREST real e HTTP interceptado; fetch de rede é bloqueado e não há projeto Supabase. Cobrem allowlist/tenant, paginação limitada pelo servidor, cursor cruzado, privados na resposta, erro sem eco, ausência de fallback, cancelamento, consulta por IDs e negação após leitura anteriormente permitida. Artefatos de compilação ficam em diretório temporário; nenhuma dependência/package.json foi alterada.

Os **26 testes da unidade 4.4** também foram executados antes do commit aprovado e passaram. Nem esses testes nem os 12 novos demonstram aplicação de RLS no banco real.

## Homologação futura e limite desta unidade

Já está preparado o runner GET-only [authorization_v1.py](../../tests/security/authorization_v1.py), com controles de identidade/vínculo e oito personas A/B; instruções em [tests/security/README.md](../../tests/security/README.md). Só executar depois de autorização específica, view instalada em homologação e fixtures sintéticas. Nenhuma execução desse runner contra Supabase foi feita nesta tarefa.

Antes da ativação do consumidor: repetir controles reais com membro/admin A/B, pendente, removido e admin A+B; verificar que `count=exact` respeita RLS; consultar lote de IDs A+B, membro revogado entre páginas e durante resolução de escalação, respostas/erros sem privados e troca de comunidade durante carregamento. Confirmar SDK efetivo do checkout integrado e limites do PostgREST. Testar view ausente/negação sem fallback e ausência de perda silenciosa de participantes; 401/5xx/fixture ausente não são PASS de isolamento.

Dependências bloqueadas: homologação autorizada, revisão das permissões/helpers reais da view, contrato seguro de sessão/vínculo próprio e coordenação da integração dos consumidores. Nenhuma revogação, migration, RPC privilegiada, espelhamento ou implementação P1 foi feita. A divergência P1 permanece com a Janela 3 e não bloqueia a revisão deste leitor P0.
