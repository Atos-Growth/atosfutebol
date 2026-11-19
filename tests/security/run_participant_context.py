"""Compile participant-list contexts/adapters and test the SDK with fake HTTP only.
No dependency installation, SQL, Supabase connection or application bootstrap.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tsc', type=Path, default=ROOT / 'node_modules/typescript/bin/tsc')
    parser.add_argument('--supabase-package', type=Path, default=ROOT / 'node_modules/@supabase/supabase-js')
    args = parser.parse_args()
    package_dir = args.supabase_package.resolve()
    metadata = json.loads((package_dir / 'package.json').read_text())
    env = {k: v for k, v in os.environ.items() if not k.startswith('ATOS_TEST_')}
    with tempfile.TemporaryDirectory(prefix='atos-p0-list-context-') as folder:
        temp = Path(folder)
        config = {
            'compilerOptions': {
                'target': 'ES2022', 'module': 'ES2022', 'moduleResolution': 'Bundler',
                'strict': True, 'noEmitOnError': True, 'skipLibCheck': True,
                'lib': ['ES2022', 'DOM'], 'types': [], 'rootDir': str(ROOT),
                'outDir': str(temp / 'out'),
                'paths': {'@supabase/supabase-js': [str(package_dir / metadata['types'])]},
            },
            'files': [str(ROOT / path) for path in [
                'src/contracts/participant-context-v1.ts',
                'src/data/participant-context-reader-v1.ts',
                'src/adapters/participant-list-v1.ts',
                'tests/security/participant-context-v1.types.ts',
            ]],
        }
        (temp / 'tsconfig.json').write_text(json.dumps(config))
        subprocess.run(['node', str(args.tsc.resolve()), '-p', str(temp / 'tsconfig.json')], cwd=ROOT, env=env, check=True)
        (temp / 'out/package.json').write_text('{"type":"module"}\n')
        env['ATOS_CONTEXT_OUT'] = str(temp / 'out')
        env['ATOS_SUPABASE_SDK'] = str(package_dir / metadata['main'])
        print('Offline SDK version:', metadata['version'], flush=True)
        subprocess.run(['node', '--test', 'tests/security/participant-context.integration.test.mjs'], cwd=ROOT, env=env, check=True)


if __name__ == '__main__':
    main()
