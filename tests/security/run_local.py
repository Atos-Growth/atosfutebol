"""Local compilation, contract tests, SQL parsing and mock probes; NO database.

Use existing TypeScript and pglast installations. Does not install dependencies.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tsc', type=Path, default=ROOT / 'node_modules/typescript/bin/tsc')
    parser.add_argument('--parser-path', type=Path, help='Existing pglast 7.x import root (PG17)')
    args = parser.parse_args()
    if not args.tsc.is_file():
        parser.error('TypeScript must already be installed; pass --tsc')
    # Never pass Supabase test credentials to local subprocesses.
    env = {k: v for k, v in os.environ.items() if not k.startswith('ATOS_TEST_')}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    if args.parser_path:
        env['PYTHONPATH'] = str(args.parser_path.resolve())
    with tempfile.TemporaryDirectory(prefix='atos-r44-offline-') as output:
        subprocess.run(['node', str(args.tsc.resolve()), '-p', 'tests/security/tsconfig.json', '--outDir', output],
                       cwd=ROOT, env=env, check=True)
        Path(output, 'package.json').write_text('{"type":"module"}\n')
        env['ATOS_COMPILED_CONTRACT'] = str(Path(output, 'src/contracts/public-read-v1.js'))
        subprocess.run(['node', '--test', 'tests/security/public-read-v1.test.mjs'], cwd=ROOT, env=env, check=True)
        subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tests/security', '-p', 'test_*.py', '-v'],
                       cwd=ROOT, env=env, check=True)


if __name__ == '__main__':
    main()
