"""Compile the consumer boundary and test the actual SDK with fake HTTP only.
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
    with tempfile.TemporaryDirectory(prefix='atos-p0-reader-') as folder:
        temp = Path(folder)
        config = {
            'compilerOptions': {
                'target': 'ES2022', 'module': 'ES2022', 'moduleResolution': 'Bundler',
                'strict': True, 'noEmitOnError': True, 'skipLibCheck': True,
                'lib': ['ES2022', 'DOM'], 'types': [], 'rootDir': str(ROOT),
                'outDir': str(temp / 'out'),
                'paths': {'@supabase/supabase-js': [str(package_dir / metadata['types'])]},
            },
            'files': [str(ROOT / 'src/contracts/public-read-v1.ts'), str(ROOT / 'src/data/participants-reader-v1.ts')],
        }
        (temp / 'tsconfig.json').write_text(json.dumps(config))
        subprocess.run(['node', str(args.tsc.resolve()), '-p', str(temp / 'tsconfig.json')], cwd=ROOT, env=env, check=True)
        (temp / 'out/package.json').write_text('{"type":"module"}\n')
        env['ATOS_COMPILED_READER'] = str(temp / 'out/src/data/participants-reader-v1.js')
        env['ATOS_SUPABASE_SDK'] = str(package_dir / metadata['main'])
        print('Offline SDK version:', metadata['version'], flush=True)
        subprocess.run(['node', '--test', 'tests/security/participants-reader.integration.test.mjs'], cwd=ROOT, env=env, check=True)


if __name__ == '__main__':
    main()
