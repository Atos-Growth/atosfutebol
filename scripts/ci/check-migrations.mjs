#!/usr/bin/env node
// Guarda estática de migrations do Supabase.
//
// Não conecta em banco nenhum e não executa SQL: só lê o diff do Git e o texto
// dos arquivos. Existe porque as migrations 001–016 foram aplicadas à mão em
// produção e ainda não há baseline validado, então o CI não pode "provar" uma
// migration aplicando a cadeia inteira. O que dá para garantir sem banco:
//
//   1. Histórico imutável: arquivo de migration que já existe na base do PR não
//      pode ser editado, apagado nem renomeado. Correção sempre em arquivo novo.
//   2. Nome e ordem: arquivo novo segue <AAAAMMDDHHMMSS>_<nome>.sql e tem versão
//      maior que todas as existentes.
//   3. Operações críticas — destruir dados, desligar RLS, ampliar privilégios,
//      mexer em publicação Realtime — reprovam o PR SEMPRE. Não existe
//      comentário que libere: um marcador escrito pelo próprio autor do PR não
//      é aprovação. Enquanto não houver um mecanismo de aprovação independente
//      do autor, a única saída para uma operação crítica é fora deste CI, com
//      autorização explícita.
//   4. Alterações sensíveis — GRANT para usuários do app, criar/alterar/remover
//      policy, trigger, função SECURITY DEFINER, view — nem sempre são erro: os
//      contratos P0 vão precisar de algumas. Mas só uma aprovação independente
//      do autor pode dizer quais. Enquanto ela não existir, também reprovam,
//      com mensagem própria ("exige aprovação independente"), e também recusam
//      marcador.
//   5. Só duas regras de compatibilidade (DROP FUNCTION e RENAME, que quebram o
//      frontend no ar mas não destroem dados nem ampliam acesso) aceitam o
//      marcador abaixo. Mesmo assim ele não aprova nada: só transforma o erro
//      em aviso visível no PR, para a revisão humana decidir.
//
//        -- ci-guard:allow <regra> <motivo com pelo menos 10 caracteres>
//
// Limites conhecidos (análise estática): SQL montado por concatenação, chamada
// de função que já existe no banco, o estado atual do banco (se a policy
// removida era restritiva, o que a função substituída fazia) e alteração da
// própria guarda não são detectáveis aqui. Por isso scripts/ci/ e .github/
// precisam de CODEOWNERS e revisão obrigatória (docs/ci/protecao-da-main.md).
//
// Uso:
//   node scripts/ci/check-migrations.mjs --base origin/main
//   node scripts/ci/check-migrations.mjs --files supabase/migrations/x.sql --report-only

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

// kind:
//   estrutura   — forma do diff/arquivo; sempre reprova.
//   critica     — destrói dados, desliga RLS ou trigger, amplia privilégio,
//                 expõe dado interno ou mexe em Realtime; sempre reprova,
//                 marcador é recusado.
//   sensivel    — pode ser legítimo (contrato P0), mas muda quem acessa o quê;
//                 reprova até existir aprovação independente; marcador recusado.
//   compat      — quebra compatibilidade com o frontend no ar; aceita marcador,
//                 que vira aviso para revisão humana.
export const RULES = {
  'historico-imutavel': { kind: 'estrutura', title: 'Migration existente alterada' },
  'nome-invalido': { kind: 'estrutura', title: 'Nome de migration fora do padrão' },
  'versao-fora-de-ordem': { kind: 'estrutura', title: 'Versão de migration fora de ordem' },
  'arquivo-invalido': { kind: 'estrutura', title: 'Arquivo que não é .sql na pasta de migrations' },
  'marcador-invalido': { kind: 'estrutura', title: 'Marcador ci-guard recusado' },

  'realtime-esportivo': { kind: 'critica', title: 'Realtime em tabela esportiva' },
  realtime: { kind: 'critica', title: 'Alteração de publicação Realtime' },
  truncate: { kind: 'critica', title: 'TRUNCATE' },
  'drop-table': { kind: 'critica', title: 'DROP TABLE' },
  'drop-column': { kind: 'critica', title: 'DROP COLUMN' },
  'drop-objeto': { kind: 'critica', title: 'DROP de schema, type, domain, view, sequence ou extension' },
  delete: { kind: 'critica', title: 'DELETE executado na migration' },
  'update-sem-where': { kind: 'critica', title: 'UPDATE sem WHERE' },
  'disable-rls': { kind: 'critica', title: 'RLS desligada' },
  'grant-anon': { kind: 'critica', title: 'GRANT para anon ou public' },
  'grant-dado-interno': { kind: 'critica', title: 'GRANT que expõe dado interno (pontuação, fechamentos, avaliações)' },
  privilegios: { kind: 'critica', title: 'Alteração de papel, dono, privilégio padrão ou GRANT com repasse' },
  'policy-aberta': { kind: 'critica', title: 'Policy aberta (tautologia, qualquer autenticado, ou sem TO / TO public/anon)' },
  'drop-policy': { kind: 'critica', title: 'DROP POLICY sem recriar no mesmo arquivo (se era restritiva, amplia acesso)' },
  'disable-trigger': { kind: 'critica', title: 'Trigger ou regra desativada' },
  'drop-trigger': { kind: 'critica', title: 'DROP TRIGGER sem recriar no mesmo arquivo' },
  'drop-cascade': { kind: 'critica', title: 'DROP ... CASCADE (remove dependentes, inclusive policies e triggers)' },
  'security-definer': { kind: 'critica', title: 'SECURITY DEFINER sem search_path seguro' },
  'definer-sql-dinamico': { kind: 'critica', title: 'SQL dinâmico concatenado em função SECURITY DEFINER' },
  'view-definer': { kind: 'critica', title: 'View sem security_invoker (roda com o dono e ignora a RLS de quem consulta)' },
  'tabela-sem-rls': { kind: 'critica', title: 'Tabela criada sem habilitar RLS no mesmo arquivo' },

  grant: { kind: 'sensivel', title: 'GRANT para usuários do app' },
  'grant-execute': { kind: 'sensivel', title: 'GRANT EXECUTE para usuários do app' },
  policy: { kind: 'sensivel', title: 'Criação ou alteração de policy' },
  trigger: { kind: 'sensivel', title: 'Criação ou substituição de trigger' },
  definer: { kind: 'sensivel', title: 'Função SECURITY DEFINER (search_path fixo não basta)' },
  view: { kind: 'sensivel', title: 'Criação ou alteração de view' },

  'drop-function': { kind: 'compat', title: 'DROP FUNCTION (RPC usada pelo app pode sumir)' },
  rename: { kind: 'compat', title: 'RENAME (quebra o frontend que já está no ar)' },
}

export const acceptsMarker = (rule) => RULES[rule]?.kind === 'compat'

const KIND_LABEL = {
  estrutura: 'estrutural',
  critica: 'crítica',
  sensivel: 'sensível (exige aprovação independente, que ainda não existe)',
  compat: 'de compatibilidade',
}

export function loadConfig(file = path.join(SCRIPT_DIR, 'migration-guard.config.json')) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  return {
    migrationsDir: raw.migrationsDir,
    newFilePattern: new RegExp(raw.newFilePattern),
    sportsTables: new Set(raw.sportsTables.map((t) => t.toLowerCase())),
    internalData: new Map(Object.entries(raw.internalData ?? {}).map(([t, cols]) => [t.toLowerCase(), cols.map((c) => c.toLowerCase())])),
    privilegedRoles: new Set((raw.privilegedRoles ?? []).map((r) => r.toLowerCase())),
  }
}

// ─── Mascaramento do SQL ──────────────────────────────────────────────────
// Devolve um texto do MESMO tamanho do original (quebras de linha no lugar,
// então offsets continuam valendo para calcular a linha), com:
//   - comentários trocados por espaço (e guardados em `comments`, que é de onde
//     os marcadores são lidos — um "-- ci-guard" dentro de string não conta);
//   - corpo de CREATE FUNCTION/PROCEDURE trocado por espaço, porque só roda
//     quando a função é chamada. Exceção: funções em `keepBodies`, que são as
//     chamadas pela própria migration (ver analyzeSql).
// O corpo de DO $$ ... $$ é sempre mantido: ele executa durante a migration.
// Strings entre aspas simples são mantidas: `execute 'truncate ...'` precisa
// continuar sendo detectado.
export function maskSql(sql, { keepBodies = new Set() } = {}) {
  const out = sql.split('')
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '
  }
  const statements = []
  const comments = []
  let stmtStart = 0
  let dollarBodies = []
  let i = 0
  let line = 1
  const n = sql.length
  const isIdent = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c)
  const countLines = (from, to) => {
    for (let k = from; k < to; k++) if (sql[k] === '\n') line++
  }

  const closeStatement = (end) => {
    statements.push({ start: stmtStart, end, dollarBodies })
    stmtStart = end + 1
    dollarBodies = []
  }

  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      comments.push({ line, text: sql.slice(i + 2, stop).replace(/\r$/, '') })
      blank(i, stop)
      i = stop
    } else if (c === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2 } else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2 } else j++
      }
      blank(i, j)
      countLines(i, j)
      i = j
    } else if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !isIdent(sql[i - 2])
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          break
        }
        j++
      }
      countLines(i, j + 1)
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue }
          break
        }
        j++
      }
      countLines(i, j + 1)
      i = j + 1
    } else if (c === '$' && !isIdent(sql[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (!m) { i++; continue }
      const tag = m[0]
      const bodyStart = i + tag.length
      const close = sql.indexOf(tag, bodyStart)
      const bodyEnd = close === -1 ? n : close
      dollarBodies.push([bodyStart, bodyEnd])
      const stop = close === -1 ? n : close + tag.length
      countLines(i, stop)
      i = stop
    } else if (c === ';') {
      closeStatement(i)
      i++
    } else {
      if (c === '\n') line++
      i++
    }
  }
  if (stmtStart < n) closeStatement(n)

  // Comentários já foram apagados em `out`, então o cabeçalho do statement
  // pode ser lido de lá sem se confundir com um comentário antes do CREATE.
  const functions = []
  for (const st of statements) {
    const raw = out.slice(st.start, Math.min(st.end, st.start + 600)).join('')
    const head = raw.trimStart().toLowerCase()
    const m = /^create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)\s*\(/.exec(head)
    if (!m) continue
    const name = m[1].split('.').pop().replace(/"/g, '').trim()
    const fn = { name, start: st.start, end: st.end, bodies: st.dollarBodies, kept: keepBodies.has(name) }
    functions.push(fn)
    if (!fn.kept) for (const [a, b] of st.dollarBodies) blank(a, b)
  }

  return { masked: out.join(''), statements, functions, comments }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Nomes de funções definidas na migration que a própria migration invoca
// (SELECT/PERFORM/CALL, dentro de DO, de outra função invocada, ou ligadas a
// trigger com EXECUTE FUNCTION). Referências em GRANT/REVOKE/COMMENT/ALTER/
// DROP FUNCTION não contam como chamada.
function invokedFunctions(masked, functions) {
  if (!functions.length) return new Set()
  // Cabeçalho e atributos das definições não são chamadas; só o corpo mantido.
  const text = masked.toLowerCase().split('')
  for (const fn of functions) {
    const keep = fn.kept ? fn.bodies : []
    for (let k = fn.start; k < fn.end; k++) {
      if (keep.some(([a, b]) => k >= a && k < b)) continue
      if (text[k] !== '\n') text[k] = ' '
    }
  }
  const search = text.join('')
  const called = new Set()
  for (const name of new Set(functions.map((f) => f.name))) {
    const re = new RegExp(`(^|[^\\w$."])((?:(?:"[^"]+"|[\\w$]+)\\s*\\.\\s*)?"?${escapeRe(name)}"?)\\s*\\(`, 'g')
    let m
    while ((m = re.exec(search))) {
      const before = search.slice(Math.max(0, m.index - 80), m.index + m[1].length)
      const isReference = /\b(function|procedure|routine)\s*$/.test(before) && !/\bexecute\s+(function|procedure)\s*$/.test(before)
      if (!isReference) { called.add(name); break }
    }
  }
  return called
}

export function parseMarkers(sql) {
  const markers = new Map()
  const problems = []
  for (const { line, text } of maskSql(sql).comments) {
    const m = /^\s*ci-guard:allow\b\s*(\S*)\s*(.*)$/i.exec(text)
    if (!m) continue
    const rule = m[1].toLowerCase()
    const reason = m[2].trim()
    if (!RULES[rule]) problems.push({ line, message: `regra desconhecida no marcador: "${rule || '(vazia)'}"` })
    else if (!acceptsMarker(rule)) problems.push({ line, message: `a regra "${rule}" é ${KIND_LABEL[RULES[rule].kind]} e não aceita marcador; precisa de aprovação fora do CI` })
    else if (reason.length < 10) problems.push({ line, message: `marcador de "${rule}" sem motivo (mínimo 10 caracteres)` })
    else markers.set(rule, { line, reason })
  }
  return { markers, problems }
}

function lineAt(text, offset) {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

function identifiersIn(fragment) {
  const names = []
  const re = /(?:"([^"]+)"|([a-z_][a-z0-9_$]*))/gi
  let m
  while ((m = re.exec(fragment))) names.push((m[1] ?? m[2]).toLowerCase())
  return names
}

// Conteúdo entre parênteses balanceados a partir do primeiro "(" depois de
// `from` (ignorando parênteses dentro de strings). null se não houver.
function balancedAfter(text, from) {
  const open = text.indexOf('(', from)
  if (open < 0 || text.slice(from, open).trim() !== '') return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'") {
      const close = text.indexOf("'", i + 1)
      i = close < 0 ? text.length : close
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return null
}

// Expressão de policy que libera tudo (ou todo usuário autenticado, o que num
// app multi-racha significa atravessar rachas). Não é a única forma de abrir
// uma policy — por isso toda policy é no mínimo "sensível" —, mas estas são
// abertas com certeza.
export function openPolicyReason(expr) {
  let e = expr.toLowerCase().replace(/\s+/g, ' ').trim()
  e = e.replace(/\(\s*select\s+(auth\.\w+\(\s*\))\s*\)/g, '$1')
  for (;;) {
    const inner = e.startsWith('(') ? balancedAfter(e, 0) : null
    if (inner === null || inner.length !== e.length - 2) break
    e = inner.trim()
  }
  if (/^(true|not false|'t'|'true'|1 = 1)$/.test(e)) return 'expressão sempre verdadeira'
  if (/^(\d+|'[^']*') = \1$/.test(e)) return 'comparação de literal com ele mesmo'
  if (/\bor\s+(true|1 = 1)\b|\b(true|1 = 1)\s+or\b/.test(e)) return 'OR com verdadeiro'
  if (/^auth\.uid\(\) is not null$/.test(e)) return 'qualquer usuário autenticado (atravessa rachas)'
  if (/^auth\.role\(\) = 'authenticated'$/.test(e)) return 'qualquer usuário autenticado (atravessa rachas)'
  if (/^auth\.jwt\(\) is not null$/.test(e)) return 'qualquer usuário autenticado (atravessa rachas)'
  if (/^(current_user|session_user) is not null$/.test(e)) return 'qualquer sessão'
  return null
}

// search_path de função SECURITY DEFINER. Seguro: vazio ('') com nomes
// qualificados (recomendação do Supabase) ou lista terminando em pg_temp
// (recomendação do Postgres). Qualquer outra coisa deixa o schema temporário
// ser pesquisado antes — ou um schema alterável — e permite sombrear objetos.
export function searchPathProblem(attrs) {
  const m = /\bset\s+search_path\s*(=|\bto\b|\bfrom\s+current\b)\s*((?:"[^"]*"|'[^']*'|[\w$]+)(?:\s*,\s*(?:"[^"]*"|'[^']*'|[\w$]+))*)?/.exec(attrs)
  if (!m) return 'sem SET search_path'
  if (/from\s+current/.test(m[1])) return 'search_path FROM CURRENT herda o de quem cria'
  const items = (m[2] ?? '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
  if (items.length === 1 && /^''$/.test(items[0])) return null
  if (items.some((s) => s.includes('$user'))) return 'search_path com $user'
  const tempAt = items.findIndex((s) => s === 'pg_temp')
  if (tempAt >= 0 && tempAt === items.length - 1) return null
  if (tempAt >= 0) return 'pg_temp fora da última posição'
  return `search_path "${items.join(', ')}" sem pg_temp no fim: o schema temporário é pesquisado antes; use '' com nomes qualificados ou termine em pg_temp`
}

// Nome normalizado (sem aspas, minúsculo) depois de uma palavra-chave.
function nameAfter(text, re) {
  const m = re.exec(text)
  if (!m) return null
  const raw = m[1]
  if (/%[a-z]/i.test(raw)) return '%dinamico%'
  return raw.replace(/"/g, '').toLowerCase()
}

const objectNameRe = '((?:"[^"]+"|[\\w$%]+)(?:\\s*\\.\\s*(?:"[^"]+"|[\\w$%]+))?)'

// Analisa o texto de UMA migration e devolve os achados (sem decidir ainda se
// um marcador transforma o achado em aviso).
export function analyzeSql(sql, config) {
  // Ponto fixo: desmascara o corpo das funções que a migration invoca, porque
  // esse corpo RODA durante a migration. Repete até estabilizar, para pegar
  // função chamada por outra função chamada.
  let pass = maskSql(sql)
  for (let round = 0; round < 10; round++) {
    const called = invokedFunctions(pass.masked, pass.functions)
    const kept = new Set(pass.functions.filter((f) => f.kept).map((f) => f.name))
    if ([...called].every((c) => kept.has(c))) break
    pass = maskSql(sql, { keepBodies: new Set([...kept, ...called]) })
  }
  const { masked, statements, functions } = pass
  const keptBodies = functions.filter((f) => f.kept).flatMap((f) => f.bodies.map(([a, b]) => ({ a, b, name: f.name })))

  const findings = []
  const add = (rule, offset, detail) => {
    const inside = keptBodies.find(({ a, b }) => offset >= a && offset < b)
    const where = inside ? `dentro de ${inside.name}(), que esta migration invoca` : ''
    findings.push({ rule, line: lineAt(sql, offset), detail: [detail, where].filter(Boolean).join('; ') })
  }

  const lowerAll = masked.toLowerCase()

  // Avaliado por statement: SECURITY DEFINER (o atributo vive fora do corpo),
  // views e tabelas novas.
  for (const st of statements) {
    const fn = functions.find((f) => f.start === st.start)
    let text = masked.slice(st.start, st.end).toLowerCase()
    if (fn?.kept) {
      // Atributos ficam fora do corpo; o corpo mantido não pode "emprestar" um
      // `set search_path` que só aparece dentro dele.
      text = text.split('').map((ch, k) => (fn.bodies.some(([a, b]) => st.start + k >= a && st.start + k < b) ? ' ' : ch)).join('')
    }
    const head = text.trimStart()
    const at = st.start + (text.length - head.length)

    if (fn && /\bsecurity\s+definer\b/.test(text)) {
      const problem = searchPathProblem(text)
      if (problem) add('security-definer', at, problem)
      // O corpo de definer é lido mesmo sem invocação: SQL dinâmico concatenado
      // ali é injeção com os privilégios do dono, toda vez que alguém chamar.
      const body = fn.bodies.map(([a, b]) => sql.slice(a, b)).join('\n').toLowerCase().replace(/--[^\n]*/g, '')
      const dynamic = [...body.matchAll(/\bexecute\b([^;]*)/g)].some(([, rest]) => /\|\||format\s*\([^;]*%s/.test(rest))
      if (dynamic) add('definer-sql-dinamico', at, 'use format() com %I/%L ou EXECUTE ... USING')
      if (!problem && !dynamic) add('definer', at, 'search_path seguro, mas a função roda com os privilégios do dono')
    }

    if (/^create\s+materialized\s+view\b/.test(head)) {
      add('view-definer', at, 'materialized view não aplica RLS')
    } else if (/^create\s+(or\s+replace\s+)?(recursive\s+)?view\b/.test(head)) {
      const options = head.split(/\bas\b/)[0]
      const invoker = /\bsecurity_invoker\b\s*(=\s*(true|on|1|yes|'true'|'on'))?\s*[,)]/.test(options) &&
        !/\bsecurity_invoker\s*=\s*(false|off|0|no|'false'|'off')/.test(options)
      if (invoker) add('view', at, 'security_invoker ligado; confira quais colunas a view expõe')
      else add('view-definer', at, 'crie com WITH (security_invoker = true)')
    }

    const table = /^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)/.exec(head)
    if (table) {
      const parts = table[1].split('.').map((s) => s.trim().replace(/"/g, ''))
      const [schema, name] = parts.length === 2 ? parts : ['public', parts[0]]
      if (schema === 'public') {
        const rls = new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:"?public"?\\s*\\.\\s*)?"?${escapeRe(name)}"?\\s+enable\\s+row\\s+level\\s+security\\b`)
        if (!rls.test(lowerAll)) add('tabela-sem-rls', at, `public.${name} fica exposta pela API (o Supabase concede acesso padrão a anon/authenticated)`)
      }
    }
  }

  // O resto é avaliado por trecho entre ponto e vírgula, inclusive dentro de
  // blocos DO e de corpos de função invocados.
  const lower = masked.toLowerCase()
  const chunks = []
  let start = 0
  for (let i = 0; i <= lower.length; i++) {
    if (i === lower.length || lower[i] === ';') {
      chunks.push({ start, text: lower.slice(start, i) })
      start = i + 1
    }
  }

  for (const { start: base, text } of chunks) {
    const at = (re) => {
      const m = re.exec(text)
      return m ? base + m.index : -1
    }
    let pos

    if ((pos = at(/\btruncate\b/)) >= 0) add('truncate', pos)
    // "alter publication ... drop table x" tira a tabela do Realtime, não apaga
    // a tabela: é tratado pela regra de publicação logo abaixo.
    if (!/\balter\s+publication\b/.test(text) && (pos = at(/\bdrop\s+table\b/)) >= 0) add('drop-table', pos)
    if ((pos = at(/\bdrop\s+(schema|type|domain|view|materialized\s+view|sequence|extension)\b/)) >= 0) add('drop-objeto', pos)
    if ((pos = at(/\bdrop\s+(function|procedure|routine)\b/)) >= 0) add('drop-function', pos)
    if ((pos = at(/\bdelete\s+from\b/)) >= 0) add('delete', pos)
    if ((pos = at(/\b(disable|no\s+force)\s+row\s+level\s+security\b/)) >= 0) add('disable-rls', pos)
    if ((pos = at(/\balter\s+default\s+privileges\b|\b(create|alter|drop)\s+(role|user|group)\b|\bbypassrls\b|\bsuperuser\b|\bowner\s+to\b|\balter\s+(function|procedure|routine)\b[\s\S]*\bsecurity\s+definer\b/)) >= 0) add('privilegios', pos)
    else if ((pos = at(/\balter\s+(function|procedure|routine)\b[\s\S]*\b(set|reset)\s+search_path\b/)) >= 0) add('definer', pos, 'search_path de função existente alterado')

    // ── GRANT ──
    // Não existe GRANT "inofensivo" para usuário do app sem saber o contrato
    // aprovado: tudo que concede a quem não é papel privilegiado é no mínimo
    // sensível. anon/public, repasse (WITH GRANT OPTION), concessão de papel e
    // qualquer acesso a dado interno são críticos.
    const grantAt = /\bgrant\b/.exec(text)
    if (grantAt && !/\balter\s+default\s+privileges\b/.test(text)) {
      const stmt = text.slice(grantAt.index).trim()
      const p = base + grantAt.index
      const g = /^grant\s+([\s\S]*?)\s+on\s+([\s\S]*?)\s+to\s+([\s\S]*)$/.exec(stmt)
      if (!g) {
        if (/^grant\s+[\s\S]+?\s+to\s+/.test(stmt)) add('privilegios', p, 'concessão de papel')
      } else {
        const [, privs, obj, rest] = g
        const grantees = identifiersIn(rest.replace(/\bwith\s+grant\s+option\b|\bgranted\s+by\b[\s\S]*/g, '')).filter((r) => r !== 'group')
        if (/\bwith\s+grant\s+option\b/.test(rest)) add('privilegios', p, 'WITH GRANT OPTION permite repassar o acesso')
        else if (grantees.some((r) => r === 'anon' || r === 'public')) add('grant-anon', p)
        else if (grantees.length && grantees.every((r) => config.privilegedRoles.has(r))) {
          // Conceder a papel privilegiado não amplia o acesso do app.
        } else if (/^(function|procedure|routine|all\s+(functions|procedures|routines)\s+in\s+schema)\b/.test(obj)) {
          add('grant-execute', p, 'RPC exposta a usuários do app')
        } else if (/^schema\b/.test(obj)) {
          if (/\b(create|all)\b/.test(privs)) add('privilegios', p, 'CREATE em schema permite criar objetos')
          else add('grant', p, 'acesso a schema')
        } else if (/^(sequence|all\s+sequences|large\s+object|database|tablespace|foreign|language|type|domain)\b/.test(obj)) {
          add('grant', p)
        } else {
          const allTables = /^all\s+tables\s+in\s+schema\b/.test(obj)
          const tables = allTables ? [] : identifiersIn(obj.replace(/^table\s+/, '')).filter((t) => !['public', 'only'].includes(t))
          const cols = [...privs.matchAll(/\(([^)]*)\)/g)].flatMap(([, list]) => identifiersIn(list))
          const exposed = []
          for (const [t, internal] of config.internalData) {
            if (!allTables && !tables.includes(t)) continue
            if (internal.includes('*')) exposed.push(t)
            else if (!cols.length) exposed.push(`${t} (tabela inteira, inclui ${internal.join(', ')})`)
            else for (const c of cols.filter((c) => internal.includes(c))) exposed.push(`${t}.${c}`)
          }
          if (exposed.length) add('grant-dado-interno', p, exposed.join('; '))
          else add('grant', p, allTables ? 'todas as tabelas do schema' : `${tables.join(', ')}${cols.length ? ` (${cols.join(', ')})` : ''}`)
        }
      }
    }

    // ── Policies ──
    // Nenhuma policy é considerada segura só porque a expressão não é `true`:
    // criar, alterar ou remover policy é no mínimo sensível. Abertas com certeza
    // (tautologia, qualquer autenticado, sem TO, TO public/anon) são críticas.
    const policyAt = /\b(create|alter)\s+policy\b/.exec(text)
    if (policyAt) {
      const stmt = text.slice(policyAt.index)
      const p = base + policyAt.index
      const isCreate = policyAt[1] === 'create'
      let reason = null
      if (!/\brename\s+to\b/.test(stmt)) {
        const to = /\bto\s+([\s\S]*?)(?=\busing\b|\bwith\s+check\b|$)/.exec(stmt)
        if (isCreate && !to) reason = 'sem TO: a policy vale para public, inclusive anon'
        else if (to && identifiersIn(to[1]).some((r) => r === 'anon' || r === 'public')) reason = 'TO public/anon'
        for (const kw of [/\busing\b/, /\bwith\s+check\b/]) {
          const k = kw.exec(stmt)
          const expr = k ? balancedAfter(stmt, k.index + k[0].length) : null
          const open = expr !== null ? openPolicyReason(expr) : null
          if (open) reason = reason ?? open
        }
      }
      if (reason) add('policy-aberta', p, reason)
      else add('policy', p, 'confira a expressão contra o contrato de acesso aprovado')
    }

    if (/\bdrop\s+policy\b/.test(text)) {
      const p = at(/\bdrop\s+policy\b/)
      const name = nameAfter(text, new RegExp(`\\bdrop\\s+policy\\s+(?:if\\s+exists\\s+)?("[^"]+"|[\\w$%]+)`))
      const recreated = name && name !== '%dinamico%' &&
        new RegExp(`\\bcreate\\s+policy\\s+"?${escapeRe(name)}"?\\s+on\\b`).test(lowerAll)
      if (recreated) add('policy', p, `"${name}" removida e recriada: a nova expressão substitui a anterior sem comparação`)
      else add('drop-policy', p, name === '%dinamico%' ? 'nome montado dinamicamente' : `"${name ?? '?'}" não é recriada neste arquivo`)
    }

    // ── Triggers ──
    if ((pos = at(/\b(disable)\s+(trigger|rule)\b|\benable\s+replica\s+(trigger|rule)\b/)) >= 0) add('disable-trigger', pos)
    if ((pos = at(/\bsession_replication_role\b/)) >= 0) add('disable-trigger', pos, 'session_replication_role desliga triggers e FKs da sessão')
    if ((pos = at(/\b(alter|drop)\s+event\s+trigger\b/)) >= 0) add('disable-trigger', pos, 'event trigger')
    if (/\bdrop\s+trigger\b/.test(text)) {
      const p = at(/\bdrop\s+trigger\b/)
      const name = nameAfter(text, new RegExp(`\\bdrop\\s+trigger\\s+(?:if\\s+exists\\s+)?("[^"]+"|[\\w$%]+)`))
      const recreated = name && name !== '%dinamico%' &&
        new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+"?${escapeRe(name)}"?\\s`).test(lowerAll)
      if (recreated) add('trigger', p, `"${name}" removido e recriado`)
      else add('drop-trigger', p, name === '%dinamico%' ? 'nome montado dinamicamente' : `"${name ?? '?'}" não é recriado neste arquivo`)
    }
    if ((pos = at(/\bcreate\s+(or\s+replace\s+)?(constraint\s+)?trigger\b/)) >= 0) add('trigger', pos)

    // ── CASCADE ──
    for (const c of text.matchAll(/\bcascade\b/g)) {
      const before = text.slice(0, c.index)
      if (/\bon\s+(delete|update)\s+$/.test(before)) continue
      if (/\b(drop|truncate)\b/.test(before)) { add('drop-cascade', base + c.index); break }
    }

    // ── ALTER VIEW ──
    const alterView = /\balter\s+(materialized\s+)?view\b/.exec(text)
    if (alterView) {
      const tail = text.slice(alterView.index)
      if (/\breset\s*\([^)]*\bsecurity_invoker\b/.test(tail) || /\bsecurity_invoker\s*=\s*(false|off|0|no|'false'|'off')/.test(tail)) {
        add('view-definer', base + alterView.index, 'security_invoker desligado')
      } else if (/\bset\s*\(/.test(tail)) {
        add('view', base + alterView.index, 'opções da view alteradas')
      }
    }

    const alterTable = /\balter\s+table\b/.exec(text)
    if (alterTable) {
      const tail = text.slice(alterTable.index)
      if (/\brename\b/.test(tail)) add('rename', base + alterTable.index)
      // ALTER TABLE ... DROP [COLUMN] [IF EXISTS] x — a palavra COLUMN é
      // opcional no Postgres. DROP CONSTRAINT/DEFAULT/NOT NULL são permitidos.
      const dropRe = /\bdrop\s+(?:if\s+exists\s+)?("?[a-z_][\w$]*"?)/g
      let d
      while ((d = dropRe.exec(tail))) {
        const word = d[1].replace(/"/g, '')
        if (['constraint', 'default', 'not', 'identity', 'expression'].includes(word)) continue
        add('drop-column', base + alterTable.index + d.index)
        break
      }
    }

    const update = /\bupdate\s+(?:only\s+)?[a-z_"][\w."$]*\s+set\b/.exec(text)
    if (update && !/\bwhere\b/.test(text.slice(update.index))) add('update-sem-where', base + update.index)

    const pub = /\b(alter|create)\s+publication\b/.exec(text)
    if (pub) {
      const tail = text.slice(pub.index)
      const p = base + pub.index
      if (/\bfor\s+all\s+tables\b/.test(tail) || /\btables\s+in\s+schema\b/.test(tail)) {
        add('realtime-esportivo', p, 'publicação de todas as tabelas inclui as esportivas')
      } else {
        const tableList = /\b(?:add|set|for)\s+table\b([\s\S]*)$/.exec(tail)
        const hits = tableList ? identifiersIn(tableList[1]).filter((t) => config.sportsTables.has(t)) : []
        if (hits.length) add('realtime-esportivo', p, `tabelas esportivas: ${[...new Set(hits)].join(', ')}`)
        else add('realtime', p)
      }
    }
  }
  return findings
}

// Aplica marcadores: só regra de compatibilidade com marcador válido vira
// aviso; qualquer outra coisa é erro.
export function evaluateFile(file, sql, config) {
  const { markers, problems } = parseMarkers(sql)
  const errors = problems.map((p) => ({ file, rule: 'marcador-invalido', line: p.line, detail: p.message }))
  const flagged = []
  for (const f of analyzeSql(sql, config)) {
    const marker = acceptsMarker(f.rule) ? markers.get(f.rule) : undefined
    if (marker) flagged.push({ file, ...f, reason: marker.reason })
    else errors.push({ file, ...f })
  }
  return { errors, flagged }
}

// Classifica o `git diff --name-status` da pasta de migrations.
export function classifyChanges(nameStatusLines, existingFiles, config) {
  const errors = []
  const added = []
  const versionOf = (f) => path.basename(f).split('_')[0]
  const existingVersions = existingFiles
    .map(versionOf)
    .filter((v) => /^\d+$/.test(v))
    .map((v) => BigInt(v))
  const maxExisting = existingVersions.reduce((a, b) => (b > a ? b : a), -1n)
  const seen = new Map()

  for (const line of nameStatusLines) {
    if (!line.trim()) continue
    const [status, ...paths] = line.split('\t')
    const file = paths[paths.length - 1]
    const code = status[0]
    if (code !== 'A') {
      const verb = { M: 'editada', D: 'apagada', R: 'renomeada', C: 'copiada', T: 'com tipo alterado' }[code] ?? `alterada (${status})`
      errors.push({ file: paths[0], rule: 'historico-imutavel', line: 1, detail: `migration existente ${verb}; corrija com um arquivo novo` })
      continue
    }
    const name = path.basename(file)
    if (!name.endsWith('.sql')) {
      errors.push({ file, rule: 'arquivo-invalido', line: 1, detail: 'só arquivos .sql na pasta de migrations' })
      continue
    }
    if (!config.newFilePattern.test(name)) {
      errors.push({ file, rule: 'nome-invalido', line: 1, detail: 'use <AAAAMMDDHHMMSS>_<nome_em_snake_case>.sql (supabase migration new)' })
      continue
    }
    const version = BigInt(versionOf(name))
    if (version <= maxExisting) {
      errors.push({ file, rule: 'versao-fora-de-ordem', line: 1, detail: `versão ${version} não é maior que a última existente (${maxExisting})` })
      continue
    }
    if (seen.has(version)) {
      errors.push({ file, rule: 'versao-fora-de-ordem', line: 1, detail: `versão repetida com ${seen.get(version)}` })
      continue
    }
    seen.set(version, file)
    added.push(file)
  }
  return { errors, added }
}

// ─── Execução ─────────────────────────────────────────────────────────────
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function escapeAnnotation(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function escapeProperty(s) {
  return escapeAnnotation(s).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

function parseArgs(argv) {
  const args = { base: process.env.GUARD_BASE || 'origin/main', files: null, reportOnly: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i]
    else if (argv[i] === '--report-only') args.reportOnly = true
    else if (argv[i] === '--files') {
      args.files = []
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.files.push(argv[++i])
    } else throw new Error(`argumento desconhecido: ${argv[i]}`)
  }
  // Push que cria a branch traz `before` zerado: compara com a main.
  if (!args.base || /^0+$/.test(args.base)) args.base = 'origin/main'
  return args
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const config = loadConfig()
  const errors = []
  const flagged = []
  let analyzed = []

  if (args.files) {
    analyzed = args.files
    for (const f of args.files) {
      const r = evaluateFile(f, readFileSync(f, 'utf8'), config)
      errors.push(...r.errors)
      flagged.push(...r.flagged)
    }
  } else {
    const mergeBase = git(['merge-base', args.base, 'HEAD']).trim()
    const dir = config.migrationsDir
    const existing = git(['ls-tree', '--name-only', mergeBase, `${dir}/`]).split('\n').filter(Boolean)
    const diff = git(['diff', '--name-status', '-M', mergeBase, 'HEAD', '--', `${dir}/`]).split('\n')
    const classified = classifyChanges(diff, existing, config)
    errors.push(...classified.errors)
    analyzed = classified.added
    for (const f of classified.added) {
      const r = evaluateFile(f, git(['show', `HEAD:${f}`]), config)
      errors.push(...r.errors)
      flagged.push(...r.flagged)
    }
    console.log(`Base: ${args.base} (merge-base ${mergeBase.slice(0, 7)})`)
  }

  const inActions = process.env.GITHUB_ACTIONS === 'true'
  for (const e of errors) {
    const sensitive = RULES[e.rule].kind === 'sensivel'
    const msg = `[${e.rule}] ${RULES[e.rule].title}${e.detail ? ` — ${e.detail}` : ''}${sensitive ? ' (exige aprovação independente, que ainda não existe)' : ''}`
    const title = sensitive ? 'Exige aprovação independente' : 'Guarda de migrations'
    if (inActions) console.log(`::error file=${escapeProperty(e.file)},line=${e.line},title=${escapeProperty(title)}::${escapeAnnotation(msg)}`)
    else console.log(`${sensitive ? 'SENSIVEL' : 'ERRO'} ${e.file}:${e.line} ${msg}`)
  }
  for (const a of flagged) {
    const msg = `[${a.rule}] ${RULES[a.rule].title} — sinalizado pelo autor, exige revisão humana: ${a.reason}`
    if (inActions) console.log(`::warning file=${escapeProperty(a.file)},line=${a.line},title=${escapeProperty('Exige revisão humana')}::${escapeAnnotation(msg)}`)
    else console.log(`AVISO ${a.file}:${a.line} ${msg}`)
  }

  const summary = [
    '### Guarda de migrations',
    '',
    `Arquivos novos analisados: ${analyzed.length ? analyzed.map((f) => `\`${f}\``).join(', ') : 'nenhum'}`,
    '',
    `Erros: **${errors.length}** (dos quais exigem aprovação independente: **${errors.filter((e) => RULES[e.rule].kind === 'sensivel').length}**) · Sinalizados para revisão humana: **${flagged.length}**`,
  ]
  if (flagged.length) {
    summary.push('', '| Arquivo | Linha | Regra | Motivo declarado pelo autor |', '|---|---|---|---|')
    for (const a of flagged) summary.push(`| \`${a.file}\` | ${a.line} | ${a.rule} | ${a.reason.replace(/\|/g, '\\|')} |`)
    summary.push('', '> O marcador é declaração do autor, não aprovação. Quem revisa decide.')
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`)
  console.log(`\n${errors.length} erro(s), ${flagged.length} sinalizado(s) para revisão, ${analyzed.length} arquivo(s) analisado(s).`)

  return errors.length && !args.reportOnly ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run()
  } catch (err) {
    console.error(`Falha na guarda de migrations: ${err.message}`)
    process.exitCode = 2
  }
}
