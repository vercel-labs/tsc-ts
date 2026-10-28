// With object references (initialize { objectReferences: true }), a reply that is a type, symbol or signature, or an
// array of them, names one an earlier reply carried by its id. A client that keeps the first copy of each object it
// receives decodes the same objects from such replies as from the replies of a server without object references
// that is asked the same questions in the same order. (A later copy can differ: a type's object flags include flags
// the checker sets as it caches facts about the type.)
import assert from 'node:assert/strict';
import { cpSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from './client.mjs';
import { nodeHandles } from './differential.mjs';
import { tempDir } from './temp.mjs';
import { typescriptLib as bundledLib, tscTs, tscTsMissing } from './toolchain.mjs';

const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const env = { TSC_TS_LIB_DIR: typescriptLib };
const skip = typescriptLib === '' ? 'needs the scriptc toolchain' : tscTsMissing;

// The kind of object each method's reply carries.
const kinds = {
  getTypeAtLocation: 'type',
  getTypeAtLocations: 'type',
  getSymbolAtLocation: 'symbol',
  getSymbolsAtLocations: 'symbol',
  getResolvedSignature: 'signature',
  getResolvedSignatures: 'signature',
  getPropertiesOfType: 'symbol',
  getSignaturesOfType: 'signature',
  getReturnTypeOfSignature: 'type',
  getTypeOfSymbol: 'type',
  getTypesOfSymbols: 'type',
  getAliasedSymbol: 'symbol',
  getTypesOfType: 'type',
  getBaseTypeOfLiteralType: 'type',
};

// A tsc-ts server on its own copy of the fixture project, with the project's snapshot and the copy's node handles
// relative to its directory.
async function open(objectReferences) {
  const dir = tempDir('tsc-ts-api-object-references-');
  cpSync(resolve('tests/fixtures/project'), dir, { recursive: true });
  const client = new Client(tscTs, dir, env);
  const initialized = await client.json('initialize', objectReferences ? { objectReferences: true } : undefined);
  const update = await client.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  const located = [];
  for (const file of await client.json('getSourceFileNames', base)) {
    if (!file.startsWith(dir)) continue;
    const reply = await client.request('getSourceFile', { ...base, file });
    assert.equal(reply.type, 'response');
    for (const handle of nodeHandles(reply.payload, file)) located.push(handle.replace(dir, ''));
  }
  const held = { type: new Map(), symbol: new Map(), signature: new Map() };
  return { client, base, dir, located, initialized, held, references: 0 };
}

// A handle `index.kind.path` relative to a copy's directory, in that copy.
function inCopy(server, relative) {
  const at = relative.indexOf('.', relative.indexOf('.') + 1) + 1;
  return relative.slice(0, at) + server.dir + relative.slice(at);
}

// The objects a client decodes from a reply: ids and repeated objects resolve to the first copy an earlier reply
// carried.
function resolveReply(server, kind, value) {
  if (Array.isArray(value)) return value.map((item) => resolveReply(server, kind, item));
  if (typeof value === 'number') {
    const object = server.held[kind].get(value);
    assert.ok(object !== undefined, `${kind} ${value} was not carried by an earlier reply`);
    server.references++;
    return object;
  }
  if (value === null) return null;
  // A symbol's id is its reference's.
  const id = kind === 'symbol' ? value.reference.id : value.id;
  const held = server.held[kind].get(id);
  if (held !== undefined) return held;
  server.held[kind].set(id, value);
  return value;
}

// A server's answer, resolved, with its copy's directory as `<dir>`; errors as { error }.
async function ask(server, method, params) {
  const reply = await server.client.request(method, { ...server.base, ...params });
  const text = reply.payload.toString().replaceAll(server.dir, '<dir>');
  if (reply.type === 'error') return { error: text };
  const value = JSON.parse(text);
  // Objects inside other response objects are always carried in full.
  return kinds[method] === undefined ? value : resolveReply(server, kinds[method], value);
}

test('replies with object references resolve to the replies without them', { skip, timeout: 600_000 }, async () => {
  const plain = await open(false);
  const referencing = await open(true);
  try {
    assert.equal(plain.initialized.objectReferences, undefined);
    assert.equal(referencing.initialized.objectReferences, true);
    const located = plain.located;
    assert.ok(located.length > 200, `${located.length} nodes`);
    assert.deepEqual(referencing.located, located);

    // Both servers are asked the same questions in the same order, so their ids agree.
    const both = async (method, params) => {
      const expected = await ask(plain, method, params(plain));
      const actual = await ask(referencing, method, params(referencing));
      assert.deepEqual(actual, expected, method);
      return expected;
    };
    const all = (server) => located.map((relative) => inCopy(server, relative));

    // A refused request marks nothing as carried: its objects reach the client in full later.
    const missing = (server) => `1.0.${join(server.dir, 'missing.ts')}`;
    const refused = await both('getTypeAtLocations', (s) => ({ locations: [...all(s), missing(s)] }));
    assert.ok(refused.error !== undefined);

    const types = await both('getTypeAtLocations', (s) => ({ locations: all(s) }));
    const symbols = await both('getSymbolsAtLocations', (s) => ({ locations: all(s) }));
    for (const relative of located) {
      const location = (s) => ({ location: inCopy(s, relative) });
      await both('getTypeAtLocation', location);
      await both('getSymbolAtLocation', location);
      await both('getResolvedSignature', location);
    }
    await both('getResolvedSignatures', (s) => ({ locations: all(s) }));

    const typeIds = [...new Set(types.filter((t) => t !== null).map((t) => t.id))];
    // Each server's symbol references name its own copy's files.
    const references = new Map();
    for (const symbol of symbols)
      if (symbol !== null) references.set(JSON.stringify(symbol.reference), symbol.reference);
    const symbolReferences = [...references.values()];
    const inServer = (server, reference) => JSON.parse(JSON.stringify(reference).replaceAll('<dir>', server.dir));
    assert.ok(typeIds.length > 50, `${typeIds.length} types`);
    for (const type of typeIds) {
      await both('getPropertiesOfType', () => ({ type }));
      await both('getBaseTypeOfLiteralType', () => ({ type }));
      await both('getTypesOfType', () => ({ objectId: type }));
      // Index infos carry their types in full.
      await both('getIndexInfosOfType', () => ({ type }));
      for (const kind of [0, 1]) {
        const signatures = await both('getSignaturesOfType', () => ({ type, kind }));
        for (const signature of Array.isArray(signatures) ? signatures : []) {
          await both('getReturnTypeOfSignature', () => ({ objectId: signature.id }));
          await both('getTypePredicateOfSignature', () => ({ signature: signature.id }));
        }
      }
    }
    for (const reference of symbolReferences) {
      await both('getTypeOfSymbol', (s) => ({ symbol: inServer(s, reference) }));
      await both('getAliasedSymbol', (s) => ({ symbol: inServer(s, reference) }));
    }
    await both('getTypesOfSymbols', (s) => ({ symbols: symbolReferences.map((reference) => inServer(s, reference)) }));

    assert.equal(plain.references, 0);
    assert.ok(referencing.references > 1000, `${referencing.references} references`);
  } finally {
    await plain.client.close();
    await referencing.client.close();
  }
});
