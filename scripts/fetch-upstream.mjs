// Fetches TypeScript at the pinned commit as a shallow sparse checkout in upstream/TypeScript.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const identity = JSON.parse(readFileSync('upstream.json', 'utf8'));

function git(args) {
  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('git failed: ' + args.join(' '));
}

function checkout(dir, url, commit, paths) {
  if (!existsSync(dir + '/.git')) {
    mkdirSync(dir, { recursive: true });
    git(['-C', dir, 'init', '-q']);
    git(['-C', dir, 'remote', 'add', 'origin', url]);
  }
  git(['-C', dir, 'sparse-checkout', 'set', '--cone', ...paths]);
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.stdout.trim() !== commit) {
    git(['-C', dir, 'fetch', '--depth', '1', '--filter=blob:none', 'origin', commit]);
  }
  git(['-C', dir, 'checkout', '-q', '--detach', commit]);
}

// TypeScript 7's Go compiler is in tsc/, with TypeScript's compiler and conformance test cases in
// tsc/testdata/tests/cases. tools/scripts/tsc holds ast.json, the AST schema scripts/generate-ast.mjs reads.
// The enums and API options of TypeScript 7's API package (packages/typescript/src) are the source of
// tsc-ts's public API types (scripts/generate-api.mjs).
checkout(resolve('upstream/TypeScript'), identity.repository, identity.commit, [
  'tsc/internal',
  'tsc/cmd',
  'tsc/testdata/tests/cases/compiler',
  'tsc/testdata/tests/cases/conformance',
  'tools/scripts/tsc',
  'packages/typescript/src/enums',
  'packages/typescript/src/api',
]);
console.log('Pinned upstream: ' + identity.commit);
