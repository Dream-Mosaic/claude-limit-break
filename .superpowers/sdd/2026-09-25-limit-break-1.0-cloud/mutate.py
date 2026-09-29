#!/usr/bin/env python3
"""Mutation runner for the cloud lane.

Usage:  python3 mutate.py SPEC.json

SPEC.json is a list of mutations:
  [{"file": "src/x.ts", "name": "guard drops the null check",
    "old": "if (!job) {", "new": "if (false) {",
    "tests": ["out/test/x.test.js"]}]            # "tests" is optional

For each mutation, in order:
  1. `old` must occur EXACTLY once in `file` (otherwise: SPEC ERROR, file untouched).
  2. The file is rewritten with `old` -> `new`, bytes otherwise identical.
  3. `npm run compile` runs. A failed compile is reported DID NOT COMPILE.
  4. `node --test <tests>` runs (all of out/test/**/*.test.js when "tests" is absent).
     A non-zero exit is CAUGHT; zero is SURVIVED. The failing test names are printed.
  5. The original file is ALWAYS restored (try/finally), then verified byte-identical.

Run from the repository root. Exit code: 0 when every mutation is CAUGHT or DID NOT
COMPILE, 1 when any SURVIVED or had a SPEC ERROR.
"""
import glob
import json
import re
import subprocess
import sys


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def main():
    specs = json.load(open(sys.argv[1], encoding='utf-8'))
    bad = 0
    for m in specs:
        path, name = m['file'], m['name']
        original = open(path, 'rb').read()
        text = original.decode('utf-8')
        count = text.count(m['old'])
        if count != 1:
            print(f'SPEC ERROR  {name}: "old" occurs {count} times in {path}')
            bad += 1
            continue
        try:
            open(path, 'wb').write(text.replace(m['old'], m['new']).encode('utf-8'))
            code, out = run(['npm', 'run', 'compile', '--silent'])
            if code != 0:
                print(f'DID NOT COMPILE  {name}')
                continue
            tests = m.get('tests') or sorted(glob.glob('out/test/**/*.test.js', recursive=True))
            code, out = run(['node', '--test', *tests])
            if code != 0:
                failed = sorted(set(re.findall(r'^\s*not ok \d+ - (.+)$', out, re.M)))
                print(f'CAUGHT  {name}')
                for f in failed[:8]:
                    print(f'    red: {f}')
            else:
                print(f'SURVIVED  {name}')
                bad += 1
        finally:
            open(path, 'wb').write(original)
            assert open(path, 'rb').read() == original, f'restore failed for {path}'
    # Leave out/ matching the restored sources.
    run(['npm', 'run', 'compile', '--silent'])
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
