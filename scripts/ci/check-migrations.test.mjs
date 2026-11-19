// Testes da guarda de migrations. Rodar com: node --test "scripts/ci/*.test.mjs"
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { RULES, acceptsMarker, analyzeSql, classifyChanges, evaluateFile, loadConfig, maskSql, parseMarkers } from './check-migrations.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(HERE, 'check-migrations.mjs')
const config = loadConfig()
const rules = (sql) => analyzeSql(sql, config).map((f) => f.rule).sort()
const errorRules = (sql) => evaluateFile('m.sql', sql, config).errors.map((e) => e.rule).sort()

// Um exemplo mínimo que dispara cada regra de conteúdo crítica.
const CRITICAL_SAMPLES = {
  'realtime-esportivo': 'alter publication supabase_realtime add table public.partidas;',
  realtime: 'alter publication supabase_realtime add table public.posts;',
  truncate: 'truncate table public.eventos;',
  'drop-table': 'drop table public.sessoes;',
  'drop-column': 'alter table public.perfis drop column papel;',
  'drop-objeto': 'drop schema auditoria cascade;',
  delete: 'delete from public.participantes where racha_id is null;',
  'update-sem-where': 'update public.participantes set pontuacao = 0;',
  'disable-rls': 'alter table public.participantes disable row level security;',
  'grant-anon': 'grant select on public.participantes to anon;',
  privilegios: 'alter default privileges in schema public grant all on tables to authenticated;',
  'policy-aberta': 'create policy "tudo" on public.participantes for select to authenticated using (true);',
  'security-definer': 'create function public.f() returns void language sql security definer as $$ select 1 $$;',
  'grant-dado-interno': 'GRANT SELECT (pontuacao, memoria) ON public.participantes TO authenticated;',
  'drop-policy': 'drop policy if exists "membros leem só o próprio racha" on public.participantes;',
  'disable-trigger': 'alter table public.participantes disable trigger bloquear_autoalteracao_estrelas;',
  'drop-trigger': 'drop trigger if exists on_auth_user_created on auth.users;',
  'drop-cascade': 'drop function public.is_admin() cascade;',
  'definer-sql-dinamico': "create function public.f(t text) returns void language plpgsql security definer set search_path = '' as $$ begin execute 'delete from ' || t; end; $$;",
  'view-definer': 'create view public.resumo as select id, pontuacao from public.participantes;',
  'tabela-sem-rls': 'create table public.convites (id uuid primary key);',
}

// Um exemplo mínimo de cada regra sensível: pode ser legítimo, mas reprova até
// existir aprovação independente.
const SENSITIVE_SAMPLES = {
  grant: 'grant select (nome, apelido) on public.participantes to authenticated;',
  'grant-execute': 'grant execute on function public.confirmar_sorteio(uuid, jsonb) to authenticated;',
  policy: 'create policy "leitura do racha" on public.participantes for select to authenticated using (racha_id = public.meu_racha());',
  trigger: 'create trigger auditar after update on public.participantes for each row execute function public.auditar();',
  definer: "create function public.f() returns void language sql security definer set search_path = '' as $$ select 1 $$;",
  view: 'create view public.resumo with (security_invoker = true) as select id, nome from public.participantes;',
}

describe('classificação das regras', () => {
  it('toda regra crítica e sensível tem exemplo, e só compat aceita marcador', () => {
    const of = (kind) => Object.keys(RULES).filter((r) => RULES[r].kind === kind).sort()
    assert.deepEqual(Object.keys(CRITICAL_SAMPLES).sort(), of('critica'))
    assert.deepEqual(Object.keys(SENSITIVE_SAMPLES).sort(), of('sensivel'))
    assert.deepEqual(Object.keys(RULES).filter(acceptsMarker).sort(), ['drop-function', 'rename'])
  })

  for (const [rule, sql] of Object.entries(CRITICAL_SAMPLES)) {
    it(`o exemplo de ${rule} dispara a regra`, () => {
      assert.ok(rules(sql).includes(rule), `${rule}: ${rules(sql)}`)
    })
  }

  for (const [rule, sql] of Object.entries(SENSITIVE_SAMPLES)) {
    it(`o exemplo sensível de ${rule} dispara só regras sensíveis e reprova`, () => {
      const found = rules(sql)
      assert.ok(found.includes(rule), `${rule}: ${found}`)
      assert.ok(found.every((r) => RULES[r].kind === 'sensivel'), `${rule} não deveria ser crítico: ${found}`)
      assert.ok(errorRules(sql).includes(rule), 'sensível também reprova o CI')
    })
  }
})

describe('maskSql', () => {
  it('apaga comentários e mantém o tamanho do texto', () => {
    const sql = '-- truncate table x;\nselect 1; /* drop table y */\n'
    const { masked } = maskSql(sql)
    assert.equal(masked.length, sql.length)
    assert.doesNotMatch(masked, /truncate|drop/)
  })

  it('apaga o corpo de CREATE FUNCTION, mas mantém o de DO', () => {
    const fn = 'create or replace function f() returns void language plpgsql as $fn$ begin delete from t; end; $fn$;'
    const doBlock = 'do $b$ begin delete from t; end; $b$;'
    assert.doesNotMatch(maskSql(fn).masked, /delete/)
    assert.match(maskSql(doBlock).masked, /delete/)
  })

  it('não confunde parâmetros $1 com dollar quote', () => {
    const sql = "create function f(int) returns int language sql as 'select $1';\ntruncate t;"
    assert.deepEqual(rules(sql), ['truncate'])
  })

  it('guarda os comentários de linha com o número correto', () => {
    const { comments } = maskSql("select 'a\nb';\n-- um\n/* x\ny */ -- dois\n")
    assert.deepEqual(comments, [{ line: 3, text: ' um' }, { line: 5, text: ' dois' }])
  })
})

describe('analyzeSql', () => {
  it('detecta as regras de compatibilidade', () => {
    assert.deepEqual(rules('alter table public.perfis drop papel;'), ['drop-column'])
    assert.deepEqual(rules('drop function if exists public.f(uuid);'), ['drop-function'])
    assert.deepEqual(rules('alter table public.t rename column a to b;'), ['rename'])
  })

  it('não reprova padrões seguros e comuns', () => {
    for (const sql of [
      'alter table public.sessoes drop constraint sessoes_tamanho_check;',
      'alter table public.t alter column c drop not null, alter column d drop default;',
      'update public.times set status = 1 where id = 2;',
      'create table t (id uuid references x(id) on delete cascade);\nalter table t enable row level security;',
      'revoke all on function public.f(uuid) from public, anon;',
      'revoke select (pontuacao) on public.participantes from authenticated;',
      'alter table public.participantes add column if not exists apelido text;',
      'grant insert on public.eventos to service_role;',
      'alter table public.participantes enable trigger bloquear_autoalteracao_estrelas;',
      'create temp table rascunho (id int);',
      'create table auditoria.registro (id int);',
    ]) {
      assert.deepEqual(rules(sql), [], sql)
    }
  })

  it('o que a 2.1 aceitava como seguro agora exige aprovação ou reprova', () => {
    assert.deepEqual(rules('grant execute on function public.f(uuid) to authenticated;'), ['grant-execute'])
    assert.deepEqual(rules('grant usage on schema public to authenticated;'), ['grant'])
    assert.deepEqual(rules('drop policy if exists "p" on public.t;'), ['drop-policy'])
    assert.deepEqual(rules('create policy "p" on public.t for select to authenticated using (racha_id = public.meu_racha());'), ['policy'])
    assert.deepEqual(rules('create function f() returns void language sql security definer set search_path = public as $$ select 1 $$;'), ['security-definer'])
  })

  it('detecta comando destrutivo em SQL dinâmico dentro de DO', () => {
    assert.deepEqual(rules("do $x$ begin execute 'truncate table public.eventos'; end; $x$;"), ['truncate'])
  })

  it('bloqueia Realtime em tabela esportiva em todas as grafias', () => {
    for (const sql of [
      'alter publication supabase_realtime add table public.partidas;',
      'alter publication supabase_realtime add table "eventos";',
      'alter publication supabase_realtime add table public.rachas, public.times;',
      'alter publication supabase_realtime set table public.participantes;',
      'create publication p for table public.check_ins;',
      'create publication p for all tables;',
      'alter publication supabase_realtime add tables in schema public;',
      "do $r$ begin execute 'alter publication supabase_realtime add table public.sessoes'; end; $r$;",
    ]) {
      assert.deepEqual(rules(sql), ['realtime-esportivo'], sql)
    }
  })

  it('trata qualquer outra mudança de publicação como crítica', () => {
    assert.deepEqual(rules('alter publication supabase_realtime add table public.posts;'), ['realtime'])
    assert.deepEqual(rules('alter publication supabase_realtime drop table public.partidas;'), ['realtime'])
  })

  it('detecta ampliação de privilégio por papel, dono e definer', () => {
    for (const sql of [
      'create role leitor;',
      'alter role authenticated bypassrls;',
      'alter table public.participantes owner to postgres;',
      'grant service_role to authenticated;',
      'alter function public.f() security definer;',
    ]) {
      assert.ok(rules(sql).includes('privilegios'), sql)
    }
  })

  it('informa a linha correta', () => {
    assert.equal(analyzeSql('select 1;\n\n-- comentário\ntruncate t;\n', config)[0].line, 4)
  })
})

describe('função definida e invocada pela própria migration', () => {
  const destrutiva = 'create or replace function public.limpar() returns void language plpgsql as $f$ begin truncate public.eventos; end; $f$;\n'

  it('analisa o corpo quando a função é chamada por SELECT, PERFORM ou CALL', () => {
    assert.ok(rules(`${destrutiva}select public.limpar();`).includes('truncate'))
    assert.ok(rules(`${destrutiva}do $d$ begin perform limpar(); end; $d$;`).includes('truncate'))
    const proc = 'create procedure p() language plpgsql as $p$ begin delete from public.partidas; end; $p$;\ncall p();'
    assert.ok(rules(proc).includes('delete'))
  })

  it('analisa o corpo de função ligada a trigger', () => {
    const sql = `${destrutiva}create trigger t after insert on public.x for each row execute function public.limpar();`
    assert.ok(rules(sql).includes('truncate'))
  })

  it('segue cadeia de chamadas', () => {
    const sql = 'create function a() returns void language plpgsql as $a$ begin perform b(); end; $a$;\n' +
      'create function b() returns void language plpgsql as $b$ begin truncate public.times; end; $b$;\n' +
      'select a();'
    const f = analyzeSql(sql, config).find((x) => x.rule === 'truncate')
    assert.ok(f)
    assert.match(f.detail, /dentro de b\(\)/)
  })

  it('não considera GRANT/COMMENT/ALTER/DROP FUNCTION como chamada', () => {
    const sql = `${destrutiva}grant execute on function public.limpar() to authenticated;\n` +
      'comment on function public.limpar() is \'x\';\nalter function public.limpar() set search_path = public;\n' +
      'revoke execute on function limpar() from anon;'
    assert.ok(!rules(sql).includes('truncate'), rules(sql).join())
  })

  it('não aceita search_path que só aparece dentro do corpo invocado', () => {
    const sql = "create function f() returns void language plpgsql security definer as $f$ begin execute 'set search_path = public'; end; $f$;\nselect f();"
    assert.ok(rules(sql).includes('security-definer'))
  })
})

describe('GRANT para usuários do app', () => {
  it('expõe dado interno: crítico em todas as formas', () => {
    for (const sql of [
      'GRANT SELECT (pontuacao, memoria) ON public.participantes TO authenticated;',
      'grant select on public.participantes to authenticated;',
      'grant select on table participantes to authenticated;',
      'grant update (pontuacao) on public.participantes to authenticated;',
      'grant select on public.fechamentos_mensais to authenticated;',
      'grant select (soma_res) on public.avaliacoes_sessao to authenticated;',
      'grant all on all tables in schema public to authenticated;',
      "do $g$ begin execute 'grant select on public.fechamentos_mensais to authenticated'; end; $g$;",
    ]) {
      assert.ok(rules(sql).includes('grant-dado-interno'), sql)
    }
  })

  it('detalha o campo interno exposto', () => {
    const f = analyzeSql('GRANT SELECT (pontuacao, memoria) ON public.participantes TO authenticated;', config)[0]
    assert.match(f.detail, /participantes\.pontuacao/)
  })

  it('concessão sem dado interno é sensível, não crítica, e ainda reprova', () => {
    for (const [sql, rule] of [
      ['grant select (nome, apelido) on public.participantes to authenticated;', 'grant'],
      ['grant select on public.rachas to authenticated;', 'grant'],
      ['grant insert, update on public.eventos to authenticated;', 'grant'],
      ['grant usage on sequence public.s to authenticated;', 'grant'],
      ['grant execute on all functions in schema public to authenticated;', 'grant-execute'],
    ]) {
      assert.deepEqual(rules(sql), [rule], sql)
      assert.deepEqual(errorRules(sql), [rule], sql)
    }
  })

  it('repasse, papel e CREATE em schema são críticos', () => {
    assert.deepEqual(rules('grant select on public.rachas to authenticated with grant option;'), ['privilegios'])
    assert.deepEqual(rules('grant authenticated to anon;'), ['privilegios'])
    assert.deepEqual(rules('grant service_role to authenticated;'), ['privilegios'])
    assert.deepEqual(rules('grant create on schema public to authenticated;'), ['privilegios'])
  })

  it('anon e public continuam críticos', () => {
    assert.deepEqual(rules('grant select (nome) on public.participantes to anon;'), ['grant-anon'])
    assert.deepEqual(rules('grant execute on function public.f() to public;'), ['grant-anon'])
  })
})

describe('policies RLS', () => {
  it('DROP POLICY sem recriar é crítico (se for restritiva, amplia acesso)', () => {
    assert.deepEqual(rules('drop policy "bloqueia pendentes" on public.participantes;'), ['drop-policy'])
    assert.deepEqual(rules("do $p$ declare pol record; begin for pol in select policyname from pg_policies loop execute format('drop policy %I on public.perfis', pol.policyname); end loop; end; $p$;"), ['drop-policy'])
  })

  it('DROP e recriação no mesmo arquivo continuam sensíveis', () => {
    const sql = 'drop policy if exists "leitura" on public.participantes;\ncreate policy "leitura" on public.participantes for select to authenticated using (racha_id = public.meu_racha());'
    assert.deepEqual(rules(sql), ['policy', 'policy'])
  })

  it('não confia em expressão só porque não é literalmente true', () => {
    for (const expr of [
      '1 = 1', "'a' = 'a'", 'racha_id = public.meu_racha() or true', 'auth.uid() is not null',
      '(select auth.uid()) is not null', "auth.role() = 'authenticated'", '(true)', 'not false',
    ]) {
      const sql = `create policy "p" on public.participantes for select to authenticated using (${expr});`
      assert.deepEqual(rules(sql), ['policy-aberta'], expr)
    }
    assert.deepEqual(rules('create policy "p" on public.t for insert to authenticated with check (true);'), ['policy-aberta'])
  })

  it('policy sem TO, ou TO public/anon, é aberta', () => {
    assert.deepEqual(rules('create policy "p" on public.t for select using (racha_id = public.meu_racha());'), ['policy-aberta'])
    assert.deepEqual(rules('create policy "p" on public.t for select to public using (racha_id = public.meu_racha());'), ['policy-aberta'])
    assert.deepEqual(rules('alter policy "p" on public.t to anon;'), ['policy-aberta'])
  })

  it('expressão restrita continua sensível (reprova), nunca segura', () => {
    for (const sql of [
      'create policy "p" on public.t for select to authenticated using (auth.uid() is not null and racha_id = public.meu_racha());',
      'create policy "p" on public.t for select to authenticated using (racha_id is not null);',
      'create policy "p" on public.t as restrictive for all to authenticated using (racha_id = public.meu_racha());',
      'alter policy "p" on public.t using (racha_id = public.meu_racha());',
      'alter policy "p" on public.t rename to "q";',
    ]) {
      assert.deepEqual(rules(sql), ['policy'], sql)
      assert.deepEqual(errorRules(sql), ['policy'], sql)
    }
  })
})

describe('triggers', () => {
  it('desativação é crítica em todas as formas', () => {
    for (const sql of [
      'alter table public.participantes disable trigger all;',
      'alter table public.participantes disable trigger user;',
      'alter table only public.participantes disable trigger bloquear_autoalteracao_estrelas;',
      'alter table public.t disable rule r;',
      'alter table public.t enable replica trigger x;',
      'set session_replication_role = replica;',
      "select set_config('session_replication_role', 'replica', false);",
      'alter event trigger auditoria disable;',
      'drop event trigger auditoria;',
    ]) {
      assert.ok(rules(sql).includes('disable-trigger'), sql)
    }
  })

  it('DROP TRIGGER sem recriar é crítico; recriado é sensível', () => {
    assert.deepEqual(rules('drop trigger if exists on_auth_user_created on auth.users;'), ['drop-trigger'])
    const sql = 'drop trigger if exists on_auth_user_created on auth.users;\ncreate trigger on_auth_user_created after insert on auth.users for each row execute function public.criar_perfil_pendente();'
    assert.deepEqual(rules(sql), ['trigger', 'trigger'])
  })

  it('reativar trigger não é acusado', () => {
    assert.deepEqual(rules('alter table public.t enable trigger x;'), [])
    assert.deepEqual(rules('alter table public.t enable always trigger x;'), [])
  })
})

describe('CASCADE', () => {
  it('DROP ... CASCADE é crítico; ON DELETE CASCADE não', () => {
    assert.deepEqual(rules('drop function public.is_admin() cascade;'), ['drop-cascade', 'drop-function'])
    assert.deepEqual(rules('drop type public.papel cascade;'), ['drop-cascade', 'drop-objeto'])
    assert.ok(rules('alter table public.t drop constraint fk cascade;').includes('drop-cascade'))
    assert.deepEqual(rules('alter table public.t add constraint fk foreign key (a) references public.x(id) on delete cascade;'), [])
  })
})

describe('SECURITY DEFINER', () => {
  const fn = (attrs, body = 'select 1') => `create function public.f() returns void language plpgsql security definer ${attrs} as $$ ${body} $$;`

  it('search_path presente não basta: caminhos inseguros são críticos', () => {
    for (const attrs of [
      '', 'set search_path = public', 'set search_path to public', 'set search_path = "$user", public',
      'set search_path = pg_temp, public', 'set search_path from current',
    ]) {
      assert.deepEqual(rules(fn(attrs)), ['security-definer'], attrs || '(sem search_path)')
    }
  })

  it("caminho seguro ('' ou terminando em pg_temp) ainda é sensível", () => {
    assert.deepEqual(rules(fn("set search_path = ''")), ['definer'])
    assert.deepEqual(rules(fn('set search_path = public, pg_temp')), ['definer'])
  })

  it('SQL dinâmico concatenado no corpo é crítico, mesmo sem a função ser chamada', () => {
    assert.ok(rules(fn("set search_path = ''", "begin execute 'select * from ' || t; end;")).includes('definer-sql-dinamico'))
    assert.ok(rules(fn("set search_path = ''", "begin execute format('select * from %s', t); end;")).includes('definer-sql-dinamico'))
    assert.deepEqual(rules(fn("set search_path = ''", "begin execute format('select * from %I', t); end;")), ['definer'])
    assert.deepEqual(rules(fn("set search_path = ''", "begin execute 'select $1' using t; end;")), ['definer'])
  })

  it('função comum (invoker) não é acusada', () => {
    assert.deepEqual(rules('create function public.f() returns int language sql stable as $$ select 1 $$;'), [])
  })

  it('alterar search_path de função existente é sensível', () => {
    assert.deepEqual(rules('alter function public.f() set search_path = public;'), ['definer'])
  })
})

describe('views', () => {
  it('sem security_invoker é crítica', () => {
    for (const sql of [
      'create view public.v as select 1;',
      'create or replace view public.ranking_historico as select * from public.eventos;',
      'create view public.v with (security_barrier) as select 1;',
      'create view public.v with (security_invoker = false) as select 1;',
      'create materialized view public.mv as select 1;',
      'alter view public.v set (security_invoker = off);',
      'alter view public.v reset (security_invoker);',
    ]) {
      assert.deepEqual(rules(sql), ['view-definer'], sql)
    }
  })

  it('com security_invoker é sensível', () => {
    for (const sql of [
      'create view public.v with (security_invoker = true) as select 1;',
      'create view public.v with (security_invoker) as select 1;',
      'create or replace view public.v with (security_barrier, security_invoker = on) as select 1;',
      'alter view public.v set (security_invoker = true);',
    ]) {
      assert.deepEqual(rules(sql), ['view'], sql)
    }
  })
})

describe('tabela nova sem RLS', () => {
  it('é crítica quando não habilita RLS no mesmo arquivo', () => {
    assert.deepEqual(rules('create table public.convites (id uuid);'), ['tabela-sem-rls'])
    assert.deepEqual(rules('create table if not exists convites (id uuid);'), ['tabela-sem-rls'])
    assert.deepEqual(rules('create table public.convites (id uuid);\nalter table public.outra enable row level security;'), ['tabela-sem-rls'])
  })

  it('passa quando habilita', () => {
    assert.deepEqual(rules('create table public.convites (id uuid);\nalter table public.convites enable row level security;'), [])
    assert.deepEqual(rules('create table convites (id uuid);\nalter table if exists only "convites" enable row level security;'), [])
  })
})

describe('marcadores escritos pelo autor', () => {
  const MOTIVO = 'aprovado pela equipe, operação necessária para o P0'

  for (const [rule, sql] of Object.entries(SENSITIVE_SAMPLES)) {
    it(`não contornam a regra sensível ${rule}`, () => {
      const r = evaluateFile('m.sql', `-- ci-guard:allow ${rule} ${MOTIVO}\n${sql}`, config)
      const got = r.errors.map((e) => e.rule)
      assert.ok(got.includes(rule), `${rule} deveria continuar como erro: ${got}`)
      assert.ok(got.includes('marcador-invalido'))
      assert.equal(r.flagged.length, 0)
    })
  }

  for (const [rule, sql] of Object.entries(CRITICAL_SAMPLES)) {
    it(`não contornam a regra crítica ${rule}`, () => {
      const r = evaluateFile('m.sql', `-- ci-guard:allow ${rule} ${MOTIVO}\n${sql}`, config)
      const got = r.errors.map((e) => e.rule)
      assert.ok(got.includes(rule), `${rule} deveria continuar como erro: ${got}`)
      assert.ok(got.includes('marcador-invalido'), 'o marcador em regra crítica deve ser recusado explicitamente')
      assert.equal(r.flagged.length, 0)
    })
  }

  it('não contornam regras estruturais', () => {
    for (const rule of ['historico-imutavel', 'nome-invalido', 'versao-fora-de-ordem', 'arquivo-invalido', 'marcador-invalido']) {
      assert.equal(parseMarkers(`-- ci-guard:allow ${rule} ${MOTIVO}`).problems.length, 1, rule)
    }
  })

  it('não contornam nada em nenhuma variação de grafia ou posição', () => {
    const variacoes = [
      `-- CI-GUARD:ALLOW TRUNCATE ${MOTIVO}\ntruncate public.eventos;`,
      `--ci-guard:allow   truncate   ${MOTIVO}\ntruncate public.eventos;`,
      `truncate public.eventos; -- ci-guard:allow truncate ${MOTIVO}`,
      `/* ci-guard:allow truncate ${MOTIVO} */\ntruncate public.eventos;`,
      `-- ci-guard:allow truncate ${MOTIVO}\n-- ci-guard:allow delete ${MOTIVO}\ntruncate public.eventos;\ndelete from public.partidas;`,
      `-- ci-guard:allow realtime-esportivo ${MOTIVO}\n-- ci-guard:allow realtime ${MOTIVO}\nalter publication supabase_realtime add table public.partidas;`,
    ]
    for (const sql of variacoes) {
      const r = evaluateFile('m.sql', sql, config)
      assert.equal(r.flagged.length, 0, sql)
      assert.ok(r.errors.some((e) => RULES[e.rule].kind === 'critica'), sql)
    }
  })

  it('um marcador de compat não libera uma regra crítica no mesmo arquivo', () => {
    const sql = `-- ci-guard:allow drop-function ${MOTIVO}\ndrop function public.f(uuid);\ntruncate public.eventos;`
    const r = evaluateFile('m.sql', sql, config)
    assert.deepEqual(r.errors.map((e) => e.rule), ['truncate'])
    assert.deepEqual(r.flagged.map((f) => f.rule), ['drop-function'])
  })

  it('transformam regra de compat em aviso, nunca em silêncio', () => {
    const r = evaluateFile('m.sql', `-- ci-guard:allow drop-function a assinatura de fechar_mes muda\ndrop function public.fechar_mes(uuid);`, config)
    assert.equal(r.errors.length, 0)
    assert.equal(r.flagged[0].rule, 'drop-function')
    assert.match(r.flagged[0].reason, /assinatura/)
    assert.deepEqual(errorRules('drop function public.fechar_mes(uuid);'), ['drop-function'])
  })

  it('exigem motivo e regra conhecida', () => {
    assert.equal(parseMarkers('-- ci-guard:allow drop-function curto').problems.length, 1)
    assert.equal(parseMarkers(`-- ci-guard:allow tudo ${MOTIVO}`).problems.length, 1)
    assert.equal(parseMarkers('-- ci-guard:allow').problems.length, 1)
  })

  it('dentro de string ou de corpo de função não são marcadores', () => {
    const naString = `select '\n-- ci-guard:allow drop-function ${MOTIVO}\n';\ndrop function public.f(uuid);`
    assert.deepEqual(errorRules(naString), ['drop-function'])
    const noCorpo = `create function g() returns text language sql as $g$ select '-- ci-guard:allow rename ${MOTIVO}' $g$;\n-- só comentário comum\nalter table public.t rename column a to b;`
    assert.deepEqual(errorRules(noCorpo), ['rename'])
  })
})

describe('classifyChanges', () => {
  const existing = ['supabase/migrations/001_initial.sql', 'supabase/migrations/016_gol_contra.sql']

  it('bloqueia edição, remoção e renomeação de migration existente', () => {
    const r = classifyChanges([
      'M\tsupabase/migrations/001_initial.sql',
      'D\tsupabase/migrations/016_gol_contra.sql',
      'R100\tsupabase/migrations/016_gol_contra.sql\tsupabase/migrations/20261119000000_gol_contra.sql',
    ], existing, config)
    assert.deepEqual(r.errors.map((e) => e.rule), ['historico-imutavel', 'historico-imutavel', 'historico-imutavel'])
    assert.equal(r.added.length, 0)
  })

  it('aceita arquivo novo no padrão e rejeita nome, extensão e ordem inválidos', () => {
    const r = classifyChanges([
      'A\tsupabase/migrations/20261119120000_p0_pontuacao.sql',
      'A\tsupabase/migrations/017_nova.sql',
      'A\tsupabase/migrations/LEIAME.md',
      'A\tsupabase/migrations/20261119120000_repetida.sql',
    ], existing, config)
    assert.deepEqual(r.added, ['supabase/migrations/20261119120000_p0_pontuacao.sql'])
    assert.deepEqual(r.errors.map((e) => e.rule), ['nome-invalido', 'arquivo-invalido', 'versao-fora-de-ordem'])
  })

  it('rejeita versão menor que a última existente', () => {
    const r = classifyChanges(['A\tsupabase/migrations/20250101000000_antiga.sql'],
      [...existing, 'supabase/migrations/20261001000000_x.sql'], config)
    assert.deepEqual(r.errors.map((e) => e.rule), ['versao-fora-de-ordem'])
  })
})

describe('regressão com as migrations legadas reais', () => {
  const legacy = (f) => readFileSync(path.join(REPO, 'supabase', 'migrations', f), 'utf8')

  it('pega o TRUNCATE e o DROP COLUMN da 010', () => {
    const found = rules(legacy('010_multi_tenant_rachas.sql'))
    assert.ok(found.includes('truncate'))
    assert.ok(found.includes('drop-column'))
  })

  it('pega o Realtime esportivo da 001', () => {
    assert.ok(rules(legacy('001_initial.sql')).includes('realtime-esportivo'))
  })
})

describe('execução de ponta a ponta num repositório Git temporário', () => {
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  const guard = (cwd) => {
    try {
      execFileSync(process.execPath, [SCRIPT, '--base', 'main'], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' } })
      return 0
    } catch (err) {
      return err.status
    }
  }

  const setup = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guarda-migrations-'))
    sh(dir, 'init', '-q', '-b', 'main')
    sh(dir, 'config', 'user.email', 'ci@example.invalid')
    sh(dir, 'config', 'user.name', 'CI')
    sh(dir, 'config', 'commit.gpgsign', 'false')
    sh(dir, 'config', 'core.autocrlf', 'false')
    mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true })
    writeFileSync(path.join(dir, 'supabase', 'migrations', '001_initial.sql'), 'create table t (id int);\n')
    sh(dir, 'add', '.')
    sh(dir, 'commit', '-q', '-m', 'base')
    sh(dir, 'checkout', '-q', '-b', 'pr')
    return dir
  }
  const addMigration = (dir, name, sql) => {
    writeFileSync(path.join(dir, 'supabase', 'migrations', name), sql)
    sh(dir, 'add', '.')
    sh(dir, 'commit', '-q', '-m', name)
  }

  it('passa com migration nova segura e falha ao editar a legada', () => {
    const dir = setup()
    try {
      addMigration(dir, '20261119120000_coluna.sql', 'alter table t add column x int;\n')
      assert.equal(guard(dir), 0)
      writeFileSync(path.join(dir, 'supabase', 'migrations', '001_initial.sql'), 'create table t (id bigint);\n')
      sh(dir, 'commit', '-q', '-am', 'edita legada')
      assert.equal(guard(dir), 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falha com Realtime esportivo mesmo com marcador', () => {
    const dir = setup()
    try {
      addMigration(dir, '20261119120000_rt.sql', '-- ci-guard:allow realtime-esportivo o app precisa de tempo real\nalter publication supabase_realtime add table public.partidas;\n')
      assert.equal(guard(dir), 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falha com TRUNCATE mesmo com marcador', () => {
    const dir = setup()
    try {
      addMigration(dir, '20261119120000_limpa.sql', '-- ci-guard:allow truncate limpeza combinada com a equipe\ntruncate t;\n')
      assert.equal(guard(dir), 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passa com DROP FUNCTION marcado (compat) e avisa', () => {
    const dir = setup()
    try {
      addMigration(dir, '20261119120000_assinatura.sql', '-- ci-guard:allow drop-function a assinatura de f muda de (int) para (bigint)\ndrop function if exists f(int);\n')
      assert.equal(guard(dir), 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
