import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/tsc-ts/src');
const skip = !existsSync(dist) && 'run npm run build';
const load = (path) => import(pathToFileURL(resolve(dist, path)).href);

const source = `
/** A shape. */
export type Shape = { kind: "circle"; radius: number } | readonly [x: number, y?: string, ...rest: boolean[]];
export declare function area<T extends Shape>(shape: T, ...scale: number[]): \`size-\${number}\` | keyof T | -1n;
`;

test('nodes survive encoding and decoding', { skip }, async () => {
  const { parseSourceFile } = await load('compiler/parser.js');
  const { decodeNodes } = await load('compiler/decoder.js');
  const { encodeNode, encodeSourceFile } = await load('compiler/encoder.js');
  const { printNode } = await load('api/backend.js');

  const file = parseSourceFile('/a.ts', source);
  const decodedFile = decodeNodes(encodeSourceFile(file));
  assert.equal(decodedFile.fileName, '/a.ts');
  assert.equal(decodedFile.text, source);
  assert.equal(decodedFile.statements.nodes.length, 2);

  for (const statement of file.statements.nodes) {
    const encoded = encodeNode(statement);
    const decoded = decodeNodes(encoded);
    assert.equal(decoded.kind, statement.kind);
    assert.equal(decoded.pos, statement.pos);
    assert.deepEqual(encodeNode(decoded), encoded);
  }
  assert.equal(
    printNode(decodeNodes(encodeNode(file.statements.nodes[0])), false, false, false),
    'export type Shape = {\n    kind: "circle";\n    radius: number;\n} | readonly [\n    x: number,\n    y?: string,\n    ...rest: boolean[]\n];',
  );

  // The right side of a qualified name in a type query can be a private name.
  const privateName = parseSourceFile('/b.ts', 'class C {\n    #x = 1;\n    y: typeof this.#x;\n}');
  const classNode = privateName.statements.nodes[0];
  assert.deepEqual(encodeNode(decodeNodes(encodeNode(classNode))), encodeNode(classNode));
  assert.equal(
    printNode(decodeNodes(encodeNode(classNode)), false, false, false),
    'class C {\n    #x = 1;\n    y: typeof this.#x;\n}',
  );

  assert.throws(() => decodeNodes(new Uint8Array(4)), /too short/);
  const corrupt = encodeNode(file.statements.nodes[1]);
  corrupt[3] = 0;
  assert.throws(() => decodeNodes(corrupt), /protocol version/);
});
