// A parse thread walks a file's grammar before the file is published (checkGrammarSourceFileInParseThread).
// The walk reports once per block in an ambient context, and it records the blocks that reported, so the
// checker's walk of the nodes left to it reports the same diagnostics. A walk of a file with many ambient
// function bodies stays linear in the file's nodes: the reports a node's check made are undone from the
// node itself, not by copying the blocks reported so far.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-grammar-ambient-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { ParseOptions } = await load('compiler/ast.js');
const { checkGrammarSourceFileInParseThread } = await load('compiler/checker-grammar.js');
const { messageTexts } = await load('compiler/diagnostic-messages.js');
const { SourceFileMetadata } = await load('compiler/program-utilities.js');
const { parseSourceFile } = await load('compiler/parser.js');

const fileName = '/p/ambient.d.ts';
// A declaration file in no package: the metadata `FileLoader` would hand the walk. `ModuleKind` is a
// const enum, so its `None` is written as the 0 it has.
const metadata = new SourceFileMetadata('', '', 0);
const options = {};
// A diagnostic's message is its index in the generated table of messages.
const messages = messageTexts.split('\n');

/** `count` ambient function declarations, each body a block that reports a statement in an ambient context. */
function declarations(count) {
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(`declare function f${i}(i: number) {\n    return i;\n}\n`);
  return parts.join('');
}

/** Parses a declaration file with `count` ambient function bodies, as a parse thread loads one. */
function parse(count) {
  // `ScriptKind.Unknown` is a const enum, so its value is written as the 0 it has: the extension decides.
  return parseSourceFile(fileName, declarations(count), new ParseOptions(fileName, 0, { jsx: false, force: false }));
}

/** Walks the grammar of a declaration file with `count` ambient function bodies; returns the file. */
function walk(count) {
  const file = parse(count);
  checkGrammarSourceFileInParseThread(file, options, metadata);
  return file;
}

/** Milliseconds the grammar walk of a freshly parsed file of `count` bodies takes. */
function walkTime(count) {
  const file = parse(count);
  const start = performance.now();
  checkGrammarSourceFileInParseThread(file, options, metadata);
  return performance.now() - start;
}

test('an ambient function body reports the statement in an ambient context once', () => {
  const count = 3;
  const file = walk(count);
  assert.deepEqual(
    file.grammarDiagnostics.map((d) => messages[d.message]),
    Array.from({ length: count }, () => 'An implementation cannot be declared in ambient contexts.'),
  );
  // Each block that reported is recorded, for the checker's walk of the nodes left to it.
  assert.equal(file.grammarAmbientReports.length, count);
});

test('the ambient walk stays linear in the file', () => {
  const small = 2_000;
  const large = 10 * small;
  // The shortest of two walks of each size, to keep the comparison off a single slow sample.
  const time = (count) => Math.min(walkTime(count), walkTime(count));
  const smallTime = time(small);
  const largeTime = time(large);
  // Ten times the declarations take about ten times as long; copying the reported blocks per node would
  // take about a hundred times as long.
  assert.ok(
    largeTime < Math.max(smallTime, 1) * 40,
    `${largeTime.toFixed(1)} ms for ${large} declarations, ${smallTime.toFixed(1)} ms for ${small}`,
  );
});
