// An identifier holds its text as an `IdentifierName`: the identifiers of a file with the same text share one
// name, and each file records each of its identifier texts once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-identifier-names-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { Identifier, NodeVisitor } = await load('compiler/ast.js');
const { parseSourceFile } = await load('compiler/parser.js');

/** The identifiers of `file` in source order. */
function identifiers(file) {
  const result = [];
  const walk = (node) => {
    if (node instanceof Identifier) result.push(node);
    node.forEachChild(
      new (class extends NodeVisitor {
        visitNode(child) {
          walk(child);
          return false;
        }
      })(),
    );
  };
  walk(file);
  return result;
}

const nameOf = (file, text) => identifiers(file).find((id) => id.text === text).identifierName;

test('the identifiers of a file with the same text share one name', () => {
  const ids = identifiers(parseSourceFile('a.ts', 'const value = 1; f(value, value.value);'));
  const values = ids.filter((id) => id.text === 'value');
  assert.equal(values.length, 4);
  for (const id of values) assert.equal(id.identifierName, values[0].identifierName);
  assert.notEqual(ids.find((id) => id.text === 'f').identifierName, values[0].identifierName);
});

test('each file has a table of its own and records each identifier text once', () => {
  const a = parseSourceFile('a.ts', 'export const shared = 1; shared;');
  const b = parseSourceFile('b.ts', 'import { shared } from "./a"; shared;');
  assert.notEqual(nameOf(a, 'shared'), nameOf(b, 'shared'));
  assert.deepEqual(a.identifierTexts, ['shared']);
  assert.deepEqual(b.identifierTexts, ['shared', './a']);
});

test('an identifier written with escapes gets a name of its own text', () => {
  const ids = identifiers(parseSourceFile('a.ts', 'const \\u0061b = 1; ab;'));
  assert.deepEqual(
    ids.map((id) => id.text),
    ['ab', 'ab'],
  );
  // Its value is cooked from the escapes, so it is not the name the scanner interned for `ab`.
  assert.equal(ids[0].identifierName.text, 'ab');
  assert.notEqual(ids[0].identifierName, ids[1].identifierName);
});
