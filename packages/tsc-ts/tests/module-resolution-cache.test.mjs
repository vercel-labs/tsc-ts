// A checker resolves each import's module specifier once and keeps the result for the declaration's
// other names (`resolveExternalModule`). Merging module augmentations resolves module specifiers too:
// augmenting a barrel resolves the barrel's `export *` specifiers, and a later augmentation of a
// re-exported module gives that module a new merged symbol. A result kept during merging would be
// the module without its later augmentations, so imports through the barrel would miss their exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');

const out = compileSources('tsc-ts-module-resolution-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram } = await load('compiler/program-checker.js');

test('imports through a barrel see augmentations merged after the barrel was augmented', () => {
  const dir = tempDir('tsc-ts-module-resolution-project-');
  const files = {
    'x.ts': 'export const x = 1;\n',
    'barrel.ts': "export * from './x';\n",
    // Merged first: augmenting the barrel resolves its `export *` from './x'.
    'aug1.ts': "export {};\ndeclare module './barrel' {\n  export const z: number;\n}\n",
    // Merged second: './x' gets a new merged symbol with `y`.
    'aug2.ts': "export {};\ndeclare module './x' {\n  export const y: number;\n}\n",
    'use.ts': "import { x, y, z } from './barrel';\nexport const sum = x + y + z;\n",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, module: 'commonjs', noEmit: true, types: [] },
      files: ['x.ts', 'barrel.ts', 'aug1.ts', 'aug2.ts', 'use.ts'],
    }),
  );
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  const checker = new CheckedProgram(work.program).createChecker();
  for (const file of work.program.getSourceFiles())
    if (file.fileName.startsWith(dir.replaceAll('\\', '/')) || file.fileName.startsWith(dir))
      assert.deepEqual(
        checker.getDiagnostics(file).map((d) => `${d.code}@${d.pos}`),
        [],
        file.fileName,
      );
});
