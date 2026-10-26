// Compares the scanner with the reference scan oracle on TypeScript's test cases.
//
// Usage: node scripts/scan-corpus.mjs [--native BINARY] [--jobs N] [--limit N] [--modes a,b] [DIR|FILE ...]
//
// Modes: plain, full (with trivia), rescan, jsdoc, es5 (rescan targeting ES5).
// Without --native, the scanner runs under Node from a tsc build.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { tempDir } from '../tests/temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const oracle = resolve(repo, 'packages/tsgo/dist/scan-oracle');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const jobs = Number(option('--jobs', availableParallelism()));
const limit = Number(option('--limit', Infinity));
const modes = option('--modes', 'plain,full,rescan,jsdoc,es5').split(',');
const valued = new Set(['--native', '--jobs', '--limit', '--modes']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (inputs.length === 0) {
  const cases = resolve(repo, 'upstream/TypeScript/tsc/testdata/tests/cases');
  inputs.push(
    join(cases, 'compiler'),
    join(cases, 'conformance'),
    resolve(repo, 'upstream/TypeScript/tsc/internal/bundled/libs'),
  );
}

function files(path) {
  if (!statSync(path).isDirectory()) return [path];
  const out = [];
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) out.push(...files(child));
    else if (/\.[cm]?[jt]sx?$/.test(name)) out.push(child);
  }
  return out;
}

let command;
const native = option('--native', undefined);
if (native !== undefined) {
  command = [resolve(native)];
} else {
  const out = tempDir('tsc-ts-scan-');
  execFileSync(
    resolve(repo, 'node_modules/.bin/tsc'),
    [
      '--outDir',
      out,
      '--strict',
      '--target',
      'es2024',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--types',
      'node',
      '--skipLibCheck',
      join(root, 'src/drivers/scan.ts'),
    ],
    { stdio: 'inherit' },
  );
  command = [process.execPath, join(out, 'drivers/scan.js')];
}

function flagsFor(mode, file) {
  const jsx = file.endsWith('x') ? ['--jsx'] : [];
  switch (mode) {
    case 'plain':
      return [];
    case 'full':
      return ['--full', '--trivia', ...jsx];
    case 'rescan':
      return ['--rescan', ...jsx];
    case 'jsdoc':
      return ['--jsdoc'];
    case 'es5':
      return ['--rescan', '--target', '1'];
  }
  throw new Error(`unknown mode ${mode}`);
}

function run(argv) {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = createHash('sha1');
    child.stdout.on('data', (d) => hash.update(d));
    child.stderr.on('data', (d) => hash.update(d));
    child.on('close', (code) => done({ code, text: hash.digest('hex') }));
  });
}

// Files that aren't UTF-8 (UTF-16 test inputs) scan differently as bytes than as text.
const utf8 = new TextDecoder('utf-8', { fatal: true });
const isUTF8 = (file) => {
  try {
    utf8.decode(readFileSync(file));
    return true;
  } catch {
    return false;
  }
};
const listed = inputs.flatMap(files);
const decodable = listed.filter(isUTF8);
if (decodable.length < listed.length) console.log(`skipped ${listed.length - decodable.length} non-UTF-8 files`);
const all = decodable.slice(0, limit);
console.log(`skipped ${listed.length - all.length - Math.max(0, listed.length - limit)} non-UTF-8 files`);
const tasks = all.flatMap((file) => modes.map((mode) => ({ file, mode })));
const failures = new Map(modes.map((mode) => [mode, []]));
let next = 0;
async function worker() {
  while (next < tasks.length) {
    const { file, mode } = tasks[next++];
    const flags = flagsFor(mode, file);
    const [expected, actual] = await Promise.all([run([oracle, file, ...flags]), run([...command, file, ...flags])]);
    if (expected.text !== actual.text || actual.code !== 0) failures.get(mode).push(file);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
for (const mode of modes) {
  const failed = failures.get(mode);
  console.log(`${mode}: ${all.length - failed.length}/${all.length} match`);
  for (const file of failed.slice(0, 20)) console.log(`  ${file}`);
}
process.exitCode = modes.some((mode) => failures.get(mode).length > 0) ? 1 : 0;
