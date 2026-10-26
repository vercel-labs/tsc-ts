// Compares the order of .tsbuildinfo lists that hold default library files with tsgo's, which sorts
// those files by their bundled path (`bundled:///libs/...`), after every real path, wherever the
// libraries and the project are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;

test('default library files are ordered in .tsbuildinfo as tsgo orders them', { skip }, () => {
  // The libraries' directory sorts before the project's.
  const libs = tempDir('a-libs-');
  cpSync(bundledLibs, libs, { recursive: true });
  const build = (command) => {
    const dir = tempDir('z-project-');
    // An ambient module declared twice makes every file reference its declarations, libraries too.
    writeFileSync(join(dir, 'm1.d.ts'), 'declare module "m" { export const x: number; }\n');
    writeFileSync(join(dir, 'm2.d.ts'), 'declare module "m" { export const y: number; }\n');
    writeFileSync(join(dir, 'a.ts'), 'import { x } from "m";\nexport const a = x;\n');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      '{"compilerOptions":{"composite":true,"lib":["es2015"]},"files":["a.ts","m1.d.ts","m2.d.ts"]}\n',
    );
    // tsc-ts reads them from a directory, as an installed tsc-ts reads them from its own.
    const env = { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: libs, NO_COLOR: '1' };
    const result = spawnSync(command[0], [...command.slice(1), '-p', '.'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.stdout, '');
    return readFileSync(join(dir, 'tsconfig.tsbuildinfo'), 'utf8');
  };
  const expected = build([tsgo]);
  assert.match(expected, /"referencedMap":\[\[\d+,\d+\]/);
  assert.equal(build(tscTs), expected);
});
