import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const oracle = resolve(repo, 'packages/tsgo/dist/scan-oracle');
const cases = resolve(repo, 'upstream/TypeScript/tsc/testdata/tests/cases');
const libs = resolve(repo, 'upstream/TypeScript/tsc/internal/bundled/libs');

// Every 25th test case, plus the fixtures and the bundled libs.
function sample() {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
    }
  };
  visit(join(cases, 'compiler'));
  visit(join(cases, 'conformance'));
  const picked = files.filter((_, i) => i % 25 === 0);
  const fixtures = readdirSync(join(root, 'tests/fixtures')).map((f) => join(root, 'tests/fixtures', f));
  const bundled = readdirSync(libs).map((f) => join(libs, f));
  return [...fixtures, ...bundled, ...picked];
}

const modes = [[], ['--full', '--trivia'], ['--rescan'], ['--jsdoc'], ['--rescan', '--target', '1']];

function run(argv) {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('close', () => done(Buffer.concat(chunks)));
  });
}

test(
  'scanner matches tsgo on test cases and libs',
  { skip: (!existsSync(oracle) || !existsSync(cases)) && 'needs upstream sources and the scan oracle' },
  async () => {
    const out = compileSources('tsc-ts-scan-', ['drivers/scan.ts']);
    const driver = join(out, 'drivers/scan.js');
    const tasks = [];
    for (const file of sample())
      for (const mode of modes) {
        const flags = file.endsWith('x') && mode[0] === '--rescan' ? [...mode, '--jsx'] : mode;
        tasks.push({ file, flags });
      }
    const failures = [];
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const { file, flags } = tasks[next++];
        const [expected, actual] = await Promise.all([
          run([oracle, file, ...flags]),
          run([process.execPath, driver, file, ...flags]),
        ]);
        if (!expected.equals(actual)) failures.push(`${file} ${flags.join(' ')}`);
      }
    };
    await Promise.all(Array.from({ length: availableParallelism() }, worker));
    assert.deepEqual(failures, []);
  },
);

// Line comments end at the next line break, found with string searches. A text with LF line breaks
// and a CR only at its end (or CR line breaks and no LF) must not be searched to its end once per
// comment: scanning stays linear in the text's length.
test('line comments scan in linear time with a CR or LF found only at the end', async () => {
  const out = compileSources('tsc-ts-scan-linear-', ['compiler/scanner.ts']);
  const { Scanner } = await import(pathToFileURL(join(out, 'compiler/scanner.js')).href);
  // Milliseconds to scan the text with trivia, and the line comments seen.
  const scan = (text) => {
    const scanner = new Scanner(text);
    scanner.setSkipTrivia(false);
    let comments = 0;
    const start = performance.now();
    for (let token = scanner.scan(); token !== endOfFile; token = scanner.scan()) if (token === lineComment) comments++;
    return [performance.now() - start, comments];
  };
  // SyntaxKind is a const enum: the kinds of the end of a text and of a line comment.
  const endOfFile = new Scanner('').scan();
  const probe = new Scanner('// x');
  probe.setSkipTrivia(false);
  const lineComment = probe.scan();
  const lines = 100_000;
  for (const [lineBreak, last] of [
    ['\n', '\r\n'],
    ['\r', '\n'],
  ]) {
    const text = '// a comment on its own line\n'.replace('\n', lineBreak).repeat(lines) + '// last' + last;
    const small = '// a comment on its own line\n'.replace('\n', lineBreak).repeat(lines / 10) + '// last' + last;
    const [time, comments] = scan(text);
    const [smallTime] = scan(small);
    assert.equal(comments, lines + 1);
    // Ten times the text takes about ten times as long; searching to the end per comment would take
    // about a hundred times as long.
    assert.ok(
      time < Math.max(smallTime, 1) * 40,
      `${time.toFixed(1)} ms for ${lines} lines, ${smallTime.toFixed(1)} ms for a tenth`,
    );
  }
});
