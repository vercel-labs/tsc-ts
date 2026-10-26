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

  assert.throws(() => decodeNodes(new Uint8Array(4)), /too short/);
  const corrupt = encodeNode(file.statements.nodes[1]);
  corrupt[3] = 0;
  assert.throws(() => decodeNodes(corrupt), /protocol version/);
});

test('encodings use the protocol 9 layout', { skip }, async () => {
  const { parseSourceFile } = await load('compiler/parser.js');
  const { decodeNodes } = await load('compiler/decoder.js');
  const { encodeNode, encodeSourceFile } = await load('compiler/encoder.js');
  const { ModuleDeclaration } = await load('compiler/ast.js');
  const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);

  const file = parseSourceFile('/b.ts', 'f(a, b,);\ng(a, b);\n');
  const bytes = encodeSourceFile(file);
  assert.equal(bytes[3], 9);
  // Source file ID, lease ID and binder data offset are 0.
  for (let at = 44; at < 64; at += 4) assert.equal(u32(bytes, at), 0);
  assert.equal(u32(bytes, 24), 64);

  // The source file's extended data has 19 words; the original text is the text, and the
  // content mapper fields are empty.
  const extended = u32(bytes, 32);
  assert.equal(u32(bytes, extended + 48), u32(bytes, extended));
  for (let at = 52; at < 76; at += 4) assert.equal(u32(bytes, extended + at), 0xffffffff);

  // A node list record's last word is 1 when the list has a trailing comma: the statements,
  // then the arguments of `f` and of `g`.
  const nodes = u32(bytes, 40);
  const listWords = [];
  for (let at = nodes; at < bytes.length; at += 28) {
    if (u32(bytes, at) === 0xffffffff && u32(bytes, at + 20) === 2) listWords.push(u32(bytes, at + 24));
  }
  assert.deepEqual(listWords, [0, 1, 0]);

  // A module declaration's attributes come before its body.
  const typed = parseSourceFile('/c.ts', 'declare module "m" {}\ntype T = { a: 1 };\n');
  const [module, alias] = typed.statements.nodes;
  const withAttributes = new ModuleDeclaration(undefined, module.keyword, module.name, alias.type, module.body);
  const decoded = decodeNodes(encodeNode(withAttributes));
  assert.equal(decoded.attributes?.kind, alias.type.kind);
  assert.equal(decoded.body?.kind, module.body.kind);
});
