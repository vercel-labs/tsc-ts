// Shared by the parser test and scripts/parse-corpus.mjs: test case discovery, splitting
// multi-file cases, building the parse driver, and comparing it with the encode oracle.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { compileSources, tempDir } from './temp.mjs';

export const root = resolve(import.meta.dirname, '..');
export const repo = resolve(root, '../..');
export const oracle = resolve(repo, 'packages/tsgo/dist/encode-oracle');
export const cases = resolve(repo, 'upstream/TypeScript/tsc/testdata/tests/cases');
export const libs = resolve(repo, 'upstream/TypeScript/tsc/internal/bundled/libs');

const parsable = /\.(?:[cm]?[jt]sx?|json)$/;

/** Files under `dir` (or `dir` itself) in a stable order. */
export function listFiles(path) {
  if (!statSync(path).isDirectory()) return [path];
  const out = [];
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) out.push(...listFiles(child));
    else if (parsable.test(name)) out.push(child);
  }
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decode(file) {
  try {
    return utf8.decode(readFileSync(file));
  } catch {
    return undefined;
  }
}

const directive = /^\/\/\s*@(\w+)\s*:\s*([^\r\n]*)/;

/**
 * The files of a test case, split at `// @filename:` directives like TypeScript's
 * harness. Directive lines are dropped from split files. Returns `[{ name, text }]`, or
 * undefined if the file isn't UTF-8.
 */
export function splitTestCase(file) {
  const text = decode(file);
  if (text === undefined) return undefined;
  const lines = text.split('\n');
  if (!lines.some((line) => directive.exec(line)?.[1].toLowerCase() === 'filename'))
    return [{ name: basename(file), text }];
  const units = [];
  let name;
  let content = [];
  const flush = () => {
    const body = content.join('\n');
    if (name !== undefined) units.push({ name, text: body });
    else if (body.trim() !== '') units.push({ name: basename(file), text: body });
    content = [];
  };
  for (const line of lines) {
    const match = directive.exec(line);
    if (match) {
      if (match[1].toLowerCase() === 'filename') {
        flush();
        name = basename(match[2].trim().replaceAll('\\', '/'));
      }
      continue;
    }
    content.push(line);
  }
  flush();
  return units.filter((unit) => parsable.test(unit.name));
}

/**
 * Writes the units of `files` into a temporary directory, one subdirectory per unit so
 * names can repeat. Returns `{ paths, skipped }` where `skipped` counts non-UTF-8 files.
 */
export function materialize(files, prefix = 'tsc-ts-parse-cases-') {
  const dir = tempDir(prefix);
  const paths = [];
  let skipped = 0;
  for (const file of files) {
    const units = splitTestCase(file);
    if (units === undefined) {
      skipped++;
      continue;
    }
    for (const unit of units) {
      const unitDir = join(dir, String(paths.length));
      mkdirSync(unitDir);
      const path = join(unitDir, unit.name);
      writeFileSync(path, unit.text);
      paths.push({ source: file, path });
    }
  }
  return { paths, skipped };
}

/** Compiles the parse driver with tsc and returns the command that runs it under Node. */
export function buildDriver() {
  const out = compileSources('tsc-ts-parse-', ['drivers/parse.ts']);
  return [process.execPath, '--stack-size=16000', join(out, 'drivers/parse.js')];
}

export function run(argv) {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errors.push(d));
    child.on('close', (code) =>
      done({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors).toString() }),
    );
  });
}

const isDiagnostic = (line) => /^(?:diag|jsdiag|jsdocdiag) /.test(line);

/**
 * Compares the driver with the oracle on one file. Returns which parts match:
 * `diagnostics` (diagnostic lines), `tree` (all other --tree lines), `bytes` (the
 * encoding), `bytesIgnoringHash` (the encoding without header bytes 4-19).
 */
export async function compare(command, path) {
  const [expectedTree, actualTree, expectedBytes, actualBytes] = await Promise.all([
    run([oracle, path, '--tree']),
    run([...command, path, '--tree']),
    run([oracle, path]),
    run([...command, path]),
  ]);
  const expectedLines = expectedTree.stdout.toString().split('\n');
  const actualLines = actualTree.stdout.toString().split('\n');
  const same = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);
  const ok = actualTree.code === 0 && expectedTree.code === 0;
  const diagnostics = ok && same(expectedLines.filter(isDiagnostic), actualLines.filter(isDiagnostic));
  const tree =
    ok &&
    same(
      expectedLines.filter((line) => !isDiagnostic(line)),
      actualLines.filter((line) => !isDiagnostic(line)),
    );
  const bytesOk = actualBytes.code === 0 && expectedBytes.code === 0;
  const bytes = bytesOk && expectedBytes.stdout.equals(actualBytes.stdout);
  let bytesIgnoringHash = bytes;
  if (!bytes && bytesOk && expectedBytes.stdout.length === actualBytes.stdout.length) {
    const a = Buffer.from(expectedBytes.stdout);
    const b = Buffer.from(actualBytes.stdout);
    a.fill(0, 4, 20);
    b.fill(0, 4, 20);
    bytesIgnoringHash = a.equals(b);
  }
  return { diagnostics, tree, bytes, bytesIgnoringHash, error: actualTree.stderr || actualBytes.stderr };
}
