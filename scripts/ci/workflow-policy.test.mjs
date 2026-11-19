// Política dos workflows da Fase A, verificada sem dependências.
//
// Complementa o actionlint (que roda no job "Lint dos workflows"): o
// actionlint confere sintaxe e expressões; este teste confere as REGRAS do
// projeto — nada de deploy, secret, action sem SHA ou permissão sobrando.
// Rodar com: node --test "scripts/ci/*.test.mjs"
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WF_DIR = path.join(REPO, '.github', 'workflows')
const workflows = readdirSync(WF_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(path.join(WF_DIR, f), 'utf8').replace(/\r\n/g, '\n') }))

// Owners cujas actions são permitidas. Mantém em sincronia com a configuração
// "Actions permitidas" do repositório (docs/ci/protecao-da-main.md).
const ALLOWED_OWNERS = new Set(['actions'])

// Linhas que não são comentário, com o número original.
const codeLines = (text) => text.split('\n').map((t, i) => ({ t, n: i + 1 })).filter(({ t }) => !/^\s*#/.test(t))

// Blocos de jobs: { id, lines } a partir da indentação (2 espaços sob `jobs:`).
function jobs(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  assert.ok(start >= 0, 'workflow sem jobs')
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^\S/.test(l)) break
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l)
    if (m) out.push({ id: m[1], lines: [] })
    else if (out.length) out[out.length - 1].lines.push(l)
  }
  return out
}

describe('política dos workflows (Fase A)', () => {
  it('existe pelo menos o ci.yml', () => {
    assert.ok(workflows.some((w) => w.file === 'ci.yml'))
  })

  for (const { file, text } of workflows) {
    describe(file, () => {
      it('não usa gatilhos privilegiados', () => {
        assert.doesNotMatch(text, /^\s*(pull_request_target|workflow_run)\s*:/m)
      })

      it('zera as permissões no topo', () => {
        assert.match(text, /^permissions:\s*\{\}\s*$/m)
      })

      it('declara permissões em cada job, só com leitura', () => {
        for (const job of jobs(text)) {
          const body = job.lines.join('\n')
          assert.match(body, /^ {4}permissions:/m, `job ${job.id} sem permissions`)
          const perms = [...body.matchAll(/^ {6}([a-z-]+):\s*(\S+)/gm)].filter((m) => ['read', 'write', 'none'].includes(m[2]))
          for (const [, scope, level] of perms) {
            assert.notEqual(level, 'write', `job ${job.id} pede ${scope}: write`)
          }
        }
      })

      it('fixa toda action por SHA completo e só usa owners permitidos', () => {
        for (const { t, n } of codeLines(text)) {
          const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(t)
          if (!m) continue
          const ref = m[1]
          if (ref.startsWith('./')) continue
          assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `linha ${n}: ${ref} não está fixada por SHA`)
          assert.ok(ALLOWED_OWNERS.has(ref.split('/')[0]), `linha ${n}: owner não permitido em ${ref}`)
          assert.match(t, /#\s*v\d/, `linha ${n}: falta o comentário com a versão`)
        }
      })

      it('não persiste credenciais no checkout', () => {
        const lines = text.split('\n')
        lines.forEach((l, i) => {
          if (!/uses:\s*actions\/checkout@/.test(l)) return
          const block = []
          for (let j = i + 1; j < lines.length && !/^\s*-\s/.test(lines[j]) && !/^ {0,4}\S/.test(lines[j]); j++) block.push(lines[j])
          assert.match(block.join('\n'), /persist-credentials:\s*false/, `linha ${i + 1}: checkout sem persist-credentials: false`)
        })
      })

      it('não referencia secrets nem ambientes de deploy', () => {
        const code = codeLines(text).map(({ t }) => t).join('\n')
        assert.doesNotMatch(code, /\bsecrets\./)
        assert.doesNotMatch(code, /secrets:\s*inherit/)
        assert.doesNotMatch(code, /^\s*environment:/m)
      })

      it('não publica, não faz deploy e não toca no Supabase', () => {
        const code = codeLines(text).map(({ t }) => t).join('\n')
        for (const re of [
          /docker\s+push/, /--push\b/, /docker\/login-action/, /npm\s+publish/,
          /supabase\s+(db|migration|link|functions|secrets|projects)\b/, /\bssh\s/, /\bscp\s/, /\brsync\s/,
          /packages:\s*write/, /id-token:\s*write/,
        ]) {
          assert.doesNotMatch(code, re, `padrão proibido na Fase A: ${re}`)
        }
      })

      it('não interpola expressões do GitHub dentro de scripts run', () => {
        const lines = text.split('\n')
        let blockIndent = -1
        lines.forEach((l, i) => {
          const indent = l.search(/\S/)
          if (blockIndent >= 0 && l.trim() && indent <= blockIndent) blockIndent = -1
          const run = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(l)
          if (run) {
            const rest = run[2]
            if (/^[|>]-?\s*$/.test(rest)) blockIndent = indent
            else assert.doesNotMatch(rest, /\$\{\{/, `linha ${i + 1}: use env: em vez de \${{ }} no run`)
            return
          }
          if (blockIndent >= 0 && !/^\s*#/.test(l)) {
            assert.doesNotMatch(l, /\$\{\{/, `linha ${i + 1}: use env: em vez de \${{ }} no run`)
          }
        })
      })

      it('limita o tempo de cada job', () => {
        for (const job of jobs(text)) {
          assert.match(job.lines.join('\n'), /^ {4}timeout-minutes:\s*\d+/m, `job ${job.id} sem timeout-minutes`)
        }
      })
    })
  }
})

describe('coerência entre arquivos', () => {
  it('os checks do ruleset são exatamente os nomes dos jobs do ci.yml', () => {
    const ci = workflows.find((w) => w.file === 'ci.yml').text
    const names = jobs(ci).map((j) => {
      const m = /^ {4}name:\s*(.+)$/m.exec(j.lines.join('\n'))
      assert.ok(m, `job ${j.id} sem name`)
      return m[1].trim()
    })
    const ruleset = JSON.parse(readFileSync(path.join(REPO, 'docs', 'ci', 'ruleset-main.json'), 'utf8'))
    const checks = ruleset.rules
      .find((r) => r.type === 'required_status_checks')
      .parameters.required_status_checks.map((c) => c.context)
    assert.deepEqual([...checks].sort(), [...names].sort())
  })

  it('o Dockerfile usa a mesma versão maior de Node do .nvmrc', () => {
    const nvmrc = readFileSync(path.join(REPO, '.nvmrc'), 'utf8').trim()
    const docker = readFileSync(path.join(REPO, 'Dockerfile'), 'utf8')
    const m = /^FROM\s+node:(\d+)/m.exec(docker)
    assert.ok(m, 'Dockerfile sem FROM node:<versão>')
    assert.equal(m[1], nvmrc.split('.')[0])
  })
})
