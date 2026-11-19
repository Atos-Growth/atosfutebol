# P0 — contratos isolados para a lista de participantes (Rodada 4.6)

Base: `9b389b22570c535eb6e365736863819d33482f62`, branch `security/round4-4-offline-p0`.
Entrega offline, sem commit e sem ativação no aplicativo. Os nomes de RPC abaixo são **contratos propostos**, não funções existentes ou implantadas. Nenhum SQL foi executado nem preparado nesta unidade. Não há alteração de migrations, RLS, RPCs, App, consumidores legados ou código das outras janelas.

## Consumidores conferidos e classificação dos campos

Referência: inventário anterior `p0-legacy-consumer-inventory-r4-5.md`, itens L01/L03/L04/L14/L15, conferidos no código desta base. Esse inventário e os adendos P0/P1 anteriores permanecem intactos e fora do diff desta unidade. O App deste checkout deriva de f42e27f; integração futura exige reconciliar o código consolidado das outras janelas.

| Campos / finalidade | Evidência no App | Contrato e autorização necessária |
|---|---|---|
| `id`, `racha_id` — identidade do jogador e comunidade | carga :216, edição :513, criação :522/:546 | DTO público v1 existente; comunidade e pertencimento validados no servidor. IDs não são permissões |
| `nome`, `apelido`, `foto_url`, `posicao`, `ativo`, `estrelas` — cadastro e apresentação | formulário :480/:491, busca :559, cartões :562/:566 | DTO público aprovado, sem alteração. Público significa visível a membros aprovados do tenant, não API anônima. Estrelas de apresentação não autorizam devolver pontuação ou histórico de cálculo. Nomes/fotos ainda exigem tratamento de dados pessoais no produto |
| `perfil_id` — localizar o próprio participante, impedir duplicação local | :487/:543/:546/:548 | Substituir futuramente pela consulta de vínculo próprio derivado de `auth.uid()`, sem retornar perfil/auth UUID ou permitir busca por outro usuário. Autocadastro continua bloqueado até comando seguro e unicidade no servidor; o indicador local não evita corrida |
| `estrelas_travadas` — edição administrativa e badge | :491/:511/:567; **também no cartão do próprio jogador em :562**, além de :566 | Estado mínimo `nivel_estado`, exclusivo do contrato de gestão, com autorização atual de administrador. Nenhum booleano/configuração adicionado ao DTO público. O badge do jogador comum depende de decisão específica; não se amplia acesso por compatibilidade |
| `delta`, `estrelas_antes/depois`, valores derivados — `Trend` usado nos cartões | `Trend` :54–66, carga :151, cartões :562/:566 | Fora de todos os novos contratos. Nenhum indicador de tendência reconstruído. Substituição do resumo mensal e dessa exibição é dependência separada, sem implementação nesta unidade |
| `pontuacao`, `memoria`, calibração, pesos, razões de cálculo e configuração interna | potencial transporte pelo wildcard :216 e retornos amplos :513/:522/:546 | Proibidos para membro, próprio jogador e organizador/dono por estas APIs. Decoders rejeitam campos extras; segurança efetiva exige banco sem rotas alternativas |

Outros usos de `perfil_id` na regra de pares (:618) ficam explicitamente fora desta unidade: não devolver identificadores de perfis para manter essa regra. Upload/getPublicUrl (:497/:499), ativação (:558), gravações e retornos `.select().single()` não foram substituídos. Nenhum comando de escrita foi criado.

`nivel_estado` comunica apenas se a configuração operacional está congelada ou automática. **Renomear o booleano não o torna confidencial**: trata-se de divulgação mínima, separada e restrita ao organizador, sem motivos, parâmetros ou efeitos calculados. Ausência/negação nunca é convertida para `automatico`. A equivalência semântica proposta é `true → congelado`, `false → automatico`; valores nulos/anômalos exigem diagnóstico no banco, não coalesce silencioso. A interface própria atual não será alimentada com o contrato de gestão.

## Código entregue e contratos fechados

| Arquivo novo | Responsabilidade |
|---|---|
| `src/contracts/participant-context-v1.ts` | DTOs separados, allowlists exatas, UUIDs/tenant, enum fechado, rejeição de extras/accessors, projeção imutável e lote completo |
| `src/data/participant-context-reader-v1.ts` | Chamadas GET às duas futuras RPCs pelo cliente autenticado fornecido, sem parâmetros de papel/perfil, cache ou fallback |
| `src/adapters/participant-list-v1.ts` | Composição de apresentação separada para membro e organizador; verifica tenant/ID, sem sintetizar o tipo legado |
| `tests/security/participant-context-v1.types.ts` | Invariantes compiladas: oito campos públicos inalterados, contextos fechados, imutabilidade e acessos proibidos |
| `tests/security/participant-context.integration.test.mjs` | Testes de contrato/adaptador e SDK real com HTTP interceptado, atores/IDs sintéticos |
| `tests/security/run_participant_context.py` | Compilação temporária e execução local, sem instalar dependências ou inicializar aplicação |
| Este documento | Evidências, classificação, limites e gates de backend/integração |

O arquivo `public-read-v1.ts` permanece byte a byte inalterado. `ParticipantPublicV1` continua contendo apenas `id, racha_id, nome, apelido, foto_url, posicao, ativo, estrelas`. Não há cast para `Participante`, `perfil_id:null` artificial ou spread de payload bruto. O adaptador comum produz `{participant, isSelf}`; o de gestão produz `{participant, isSelf, nivelEstado}`. `isSelf` serve à apresentação, não autoriza gravação. Os adaptadores puros não comprovam a origem ou atualidade de dados; não são barreiras de autorização.

### Vínculo próprio — `obter_meu_participante_v1`

- Entrada de contrato: apenas `p_racha_id: uuid`; SDK usa GET. O chamador não escolhe usuário, papel ou proprietário.
- Resposta JSON escalar e exata: `{racha_id: uuid, participante_id: uuid | null}`. Não é array, objeto de perfil nem envelope opcional.
- Futuro servidor: `auth.uid()` obrigatório, vínculo aprovado atual na comunidade; procurar exclusivamente participante ligado a esse usuário e tenant. Administradores podem consultar seu próprio vínculo, sem selecionar terceiros.
- `participante_id: null` somente após autorização bem-sucedida e ausência real do vínculo. Usuário pendente/removido, tenant inexistente ou proibido devem produzir negação, nunca esse objeto de sucesso. Vínculo duplicado/inconsistente deve falhar integralmente, sem escolher arbitrariamente o primeiro registro.
- HTTP 401/403/404/500, falha de transporte ou RPC ausente geram `READ_FAILED`. HTTP de sucesso com shape errado ou tenant diferente gera `INVALID_RESPONSE`. Não converter erro em opção de criar jogador.

### Estado de gestão — `obter_gestao_participantes_v1`

- Entrada: `p_racha_id: uuid`, `p_participante_ids: uuid[]` (no máximo 100 elementos antes de deduplicar). Sem filtro aberto, seleção de colunas, perfil ou papel. O cliente valida IDs, normaliza/deduplica e preserva a ordem pedida na resposta.
- Resposta JSON array exata, uma linha por ID: `{racha_id: uuid, participante_id: uuid, nivel_estado: 'automatico' | 'congelado'}`. Nenhum campo de cálculo ou configuração bruta.
- Futuro servidor deve verificar administrador atual na comunidade a cada chamada, limitar o lote também server-side e validar pertencimento de **todos** os IDs. ID ausente, oculto ou estrangeiro falha o lote inteiro com erro indistinguível; não divulgar qual ID existe em outro tenant. Não executar consultas de escrita/efeitos colaterais.
- Cliente rejeita linhas a mais, faltantes, duplicadas, com campo extra, outro tenant/ID ou enum inválido. Uma resposta parcial não pode preencher estados com valores padrão.
- Lote vazio retorna `[]` localmente sem HTTP; isso **não comprova autorização**, nem libera controles administrativos. O futuro endpoint direto também precisa autorizar antes de responder a qualquer lote, inclusive vazio.
- O limite serve às páginas já obtidas pelo leitor público; não existe novo endpoint de listagem irrestrita ou paginação administrativa paralela. O leitor público preserva paginação por ID e limites de 1–100 da unidade anterior. Quem integrar deverá buscar todos os lotes necessários, cancelar leituras antigas e manter a ordenação visual por nome sem fingir completude.

## Matriz de permissões proposta por comunidade

| Ator em A | Cadastro público A | Vínculo próprio A | Gestão A | Dados B / cálculos internos |
|---|---|---|---|---|
| Anônimo/sem sessão válida | Negado | Negado | Negado | Negado |
| Pendente, removido ou sem vínculo | Negado | Negado | Negado | Negado |
| Membro aprovado | Permitido conforme contrato público | Apenas o próprio, ou null autorizado | Negado, inclusive do próprio jogador | Negado |
| Administrador atual | Permitido | Apenas o próprio, ou null autorizado | Apenas IDs pertencentes a A | Negado |
| Administrador em B, sem vínculo em A | Negado | Negado | Negado | Apenas permissões independentes em B; cálculos sempre negados |
| Membro em A e administrador em B | Público/próprio A | Próprio A | Negado em A | Gestão somente em B, mediante autorização B |

O modelo atual utiliza `admin`, `normal` e `pendente`. Não inventar papel de dono para conceder bypass; caso exista no banco real, sua equivalência precisa de revisão explícita. Nenhum ator de produto recebe cálculos internos por ser administrador/proprietário.

## Backend pendente e gate de integração

1. Revisar catálogo/definições reais já coletados e dependências antes de implementar funções. Verificar colisão de nomes/assinaturas, nulabilidade de `estrelas_travadas`, unicidade `(racha_id, perfil_id)` para vínculo não nulo e relações entre tenants. Não tratar contrato proposto como endpoint disponível.
2. Implementação futura autorizada deve garantir `auth.uid()` e membership/role atuais em transação de leitura consistente. Nunca confiar em `papel` da UI/JWT customizado desatualizado. A consulta de vínculo/gestão e a autorização devem compartilhar snapshot consistente; não prometer invalidação retroativa de resposta cuja leitura já se iniciou antes da revogação.
3. Se `SECURITY DEFINER` for necessário para ler a configuração interna sem abrir a tabela, revisar owner com privilégio mínimo, `search_path` fixo seguro, referências qualificadas, ausência de SQL dinâmico e ACL explícita. Remover EXECUTE implícito de PUBLIC/anon antes da exposição; `authenticated` pode executar apenas com guarda interna por tenant/papel. Não resolver isto concedendo a coluna/configuração bruta a todos os `authenticated`. Funções GET devem ser genuinamente somente leitura e declaradas com volatilidade adequada; não reutilizar RPCs de negócio para esse fim.
4. Proteção real ainda exige separação interna, contratos públicos, grants/RLS/ACLs/retornos de escrita e revisão de views/RPCs/triggers/jobs segundo P0. DTOs e rejeição client-side não impedem vazamento já entregue pela rede. Não habilitar Realtime esportivo; revisar superfícies existentes sem inventar publicação.
5. Antes de integrar: aprovar o destino do badge comum; preparar comandos seguros de cadastro/edição/ativação e retornos mínimos; resolver Storage e `Trend` separadamente. Não ativar apenas esta unidade enquanto a página ainda depender de wildcards/retornos brutos. Não implementar resumo mensal, sessões ou escalações aqui.
6. Consumidor futuro deve vincular a carga à geração de usuário/comunidade, cancelar e limpar estado na troca de conta, logout, negação ou perda de papel. O leitor não mantém cache e verifica abort antes/depois da resposta; não invalida sozinho dados já entregues ao componente. Uma resposta válida pode ficar obsoleta, logo não deve autorizar comandos futuros.

## Validação local e homologação necessária

Execução local desta unidade, com TypeScript 5.7.3 e Supabase JS 2.110.8 já instalados:

```sh
python -B tests/security/run_participant_context.py --tsc /workspace/atosfutebol/node_modules/typescript/bin/tsc --supabase-package /workspace/atosfutebol/node_modules/@supabase/supabase-js
python -B tests/security/run_participants_reader.py --tsc /workspace/atosfutebol/node_modules/typescript/bin/tsc --supabase-package /workspace/atosfutebol/node_modules/@supabase/supabase-js
python -B tests/security/run_local.py --tsc /workspace/atosfutebol/node_modules/typescript/bin/tsc --parser-path /tmp/atos-p0-pg17-parser
```

O runner novo usa compilação temporária, SDK real e fetch interceptado; o fetch global está bloqueado, o domínio é `.invalid`, tokens/IDs são sintéticos. Não há credenciais, pessoas reais ou resultados do Supabase. O parser SQL dos testes P0 existentes apenas analisa arquivos locais, sem executar SQL.

| Cobertura local | Limite da evidência |
|---|---|
| 17 testes novos: contratos fechados, getters/protótipos, adaptadores, vínculo null explícito, contexto Authorization, lote até 100, completude, ID/tenant cruzados, erros sanitizados, cancelamento, revogação simulada e ausência de fallback | Valida SDK/HTTP e reação a fixtures; fixtures não exercitam RLS/ACL nem a guarda real de uma RPC |
| Invariantes TypeScript e regressão dos 12 testes do leitor e 26 P0 locais | Compatibilidade offline; nenhuma alegação de isolamento efetivo em produção |

**Resultado local:** 17/17 testes novos, 12/12 do leitor existente e 26/26 P0 anteriores passaram (55 testes no total), além da compilação TypeScript estrita. Nenhum teste foi executado contra Supabase.

Homologação somente após autorização e implementação revisada do backend, com pessoas fictícias A/B e credenciais vinculadas com segurança, nunca em logs/relatórios:

| Caso futuro | Resultado exigido |
|---|---|
| REST direto público e duas RPCs, sem depender da UI, com membros/admins A/B, pendentes, removidos e anônimo | Matriz de permissões aplicada realmente; controle positivo por ator evita falso PASS de autenticação quebrada |
| Vínculo próprio inexistente, existente e duplicado; tentativa de indicar perfil alheio | null apenas autorizado; vínculo do ator correto; duplicidade falha; assinatura não aceita perfil/papel; nenhum perfil alheio exposto |
| Gestão por membro/pendente, admin de outro tenant, membro A + admin B, ID estrangeiro/misto, lote >100 e vazio | Negação conforme papel/comunidade, erro sem oráculo por ID e limite no servidor, sem resultado parcial |
| Revogação entre páginas/lotes e durante troca de conta/comunidade | Próxima leitura/novo snapshot negado; consumidor descarta geração antiga. Verificar também downgrade de admin para membro com token ainda válido |
| Payloads via REST/views/RPCs e retornos de escrita legados | Nenhum cálculo interno ou configuração bruta acessível, inclusive ao admin; estado mínimo somente pela superfície autorizada |
| Endpoint ausente, 401/403/500 e anomalias de schema | Falha explícita, sem fallback ou preenchimento automático. Confirmar status/shape reais PostgREST para as assinaturas escolhidas |

A melhoria FUT-AUTH-CONTEXT do inventário ganhou cobertura parcial de header, cancelamento e atores sintéticos. Renovação/logout/troca de conta no consumidor integrado e FUT-EMPTY do leitor público continuam pendentes; não alterar o inventário anterior para aparentar conclusão.

Critério desta revisão: aprovar os contratos separados, os sete arquivos novos e os testes, sem ativar a lista. Próximo gate exige autorização de backend/homologação e integração coordenada. Riscos atuais permanecem: tabelas brutas, ACLs e rotas legadas não foram fechadas; **P0 não está resolvido**. Rollback desta preparação consiste em não integrar/remover somente os sete arquivos após decisão, sem tocar dados ou restaurar acesso amplo. Nenhum commit está autorizado nesta rodada.
