// The node classes in src/compiler/ast.ts are generated from upstream's ast.json: a change to them has to
// reach scripts/generate-ast.mjs too, or the next `npm run generate` puts the old classes back. The file is
// current when the script regenerates it without a difference.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const schema = resolve(root, '../../upstream/TypeScript/tools/scripts/tsc/ast.json');
const formatter = resolve(root, '../../node_modules/.bin/oxfmt');
const skip = !existsSync(schema) ? 'needs upstream sources' : !existsSync(formatter) ? 'needs the formatter' : false;

test('the node classes are current', { skip }, () => {
  execFileSync(process.execPath, [join(root, 'scripts/generate-ast.mjs'), '--check'], { stdio: 'pipe' });
});
