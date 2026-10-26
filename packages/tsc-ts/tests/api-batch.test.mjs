// The batch queries getContextualTypes and getResolvedSignatures answer, in order, what getContextualType and
// getResolvedSignature answer for each location: tsc --api has no such methods, so tsc-ts is compared with itself.
import assert from 'node:assert/strict';
import { cpSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from './client.mjs';
import { symbolKey } from './compare.mjs';
import { nodeHandles } from './differential.mjs';
import { tempDir } from './temp.mjs';
import { typescriptLib as bundledLib, tscTs, tscTsMissing } from './toolchain.mjs';

const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const env = { TSC_TS_LIB_DIR: typescriptLib };
const skip = typescriptLib === '' ? 'needs the scriptc toolchain' : tscTsMissing;

// A handle `index.kind.path` relative to a copy's directory, in that copy.
function inCopy(server, relative) {
  const at = relative.indexOf('.', relative.indexOf('.') + 1) + 1;
  return relative.slice(0, at) + server.dir + relative.slice(at);
}

// A server's reply, with its copy's directory as `<dir>`: declarations name nodes by path.
function answer(server, reply) {
  return JSON.parse(reply.payload.toString().replaceAll(server.dir, '<dir>'));
}

// A tsc-ts server on its own copy of the fixture project, with the project's snapshot and source files.
async function open() {
  const dir = tempDir('tsc-ts-api-batch-');
  cpSync(resolve('tests/fixtures/project'), dir, { recursive: true });
  const client = new Client(tscTs, dir, env);
  await client.json('initialize');
  const update = await client.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  // The handles of the copy's nodes, relative to the copy's directory.
  const located = [];
  for (const file of await client.json('getSourceFileNames', base)) {
    if (!file.startsWith(dir)) continue;
    const reply = await client.request('getSourceFile', { ...base, file });
    assert.equal(reply.type, 'response');
    for (const handle of nodeHandles(reply.payload, file)) located.push(handle.replace(dir, ''));
  }
  return { client, base, dir, located };
}

test(
  'batch contextual type and signature queries answer as their single-location methods',
  { skip, timeout: 600_000 },
  async () => {
    // The servers run the same checker work in the same order, so their type and signature ids agree. The first
    // finds the locations the single-location methods answer without an error; handles are kept relative to the copy.
    const probe = await open();
    const servers = [];
    try {
      const located = probe.located;
      assert.ok(located.length > 200, `${located.length} nodes`);
      const answers = async (server, method, relative) => {
        const reply = await server.client.request(method, { ...server.base, location: inCopy(server, relative) });
        return reply.type === 'error' ? { error: reply.payload.toString() } : answer(server, reply);
      };
      const typeLocations = [];
      const signatureLocations = [];
      for (const relative of located) {
        if ((await answers(probe, 'getContextualType', relative))?.error === undefined) typeLocations.push(relative);
        if ((await answers(probe, 'getResolvedSignature', relative))?.error === undefined)
          signatureLocations.push(relative);
      }

      const single = await open();
      const batched = await open();
      servers.push(single, batched);
      const expectedTypes = [];
      for (const relative of typeLocations) expectedTypes.push(await answers(single, 'getContextualType', relative));
      const expectedSignatures = [];
      for (const relative of signatureLocations)
        expectedSignatures.push(await answers(single, 'getResolvedSignature', relative));
      assert.ok(expectedTypes.some((type) => type !== null));
      assert.ok(expectedSignatures.some((signature) => signature !== null));
      const batch = (method, params) => batched.client.request(method, { ...batched.base, ...params });
      const locations = (list) => list.map((relative) => inCopy(batched, relative));
      assert.deepEqual(
        answer(batched, await batch('getContextualTypes', { locations: locations(typeLocations) })),
        expectedTypes,
      );
      assert.deepEqual(
        answer(batched, await batch('getResolvedSignatures', { locations: locations(signatureLocations) })),
        expectedSignatures,
      );

      // Empty batches answer empty lists; a batch with a location a single query refuses is refused with that error.
      const base = probe.base;
      for (const method of ['getContextualTypes', 'getResolvedSignatures']) {
        assert.deepEqual(await probe.client.json(method, { ...base, locations: [] }), []);
        assert.deepEqual(await probe.client.json(method, base), []);
      }
      const missing = `1.0.${join(probe.dir, 'missing.ts')}`;
      for (const [single, batch, answered] of [
        ['getContextualType', 'getContextualTypes', typeLocations[0]],
        ['getResolvedSignature', 'getResolvedSignatures', signatureLocations[0]],
      ]) {
        const refused = await probe.client.request(single, { ...base, location: missing });
        assert.equal(refused.type, 'error');
        const refusedBatch = await probe.client.request(batch, {
          ...base,
          locations: [inCopy(probe, answered), missing],
        });
        assert.equal(refusedBatch.type, 'error');
        assert.equal(refusedBatch.payload.toString(), refused.payload.toString());
      }
    } finally {
      for (const server of [probe, ...servers]) await server.client.close();
    }
  },
);

test(
  'batch type, signature, symbol and constant queries answer as their single methods',
  { skip, timeout: 600_000 },
  async () => {
    // Every server first asks the type and symbol at each location, in the same order, so the ids of those answers
    // agree between servers; the single and batched servers then do the same checker work in the same order, so the
    // ids their answers introduce agree too. The probe finds the items each single method answers without an error.
    const probe = await open();
    const servers = [];
    try {
      const located = probe.located;
      // Each server's aliases are its own references, which name its copy's files.
      const prelude = async (server) => {
        const locations = located.map((relative) => inCopy(server, relative));
        const params = { ...server.base, locations };
        const symbols = await server.client.request('getSymbolsAtLocations', params);
        const aliases = new Map();
        for (const symbol of JSON.parse(symbols.payload.toString())) {
          if (symbol !== null && (symbol.flags & 2097152) !== 0)
            aliases.set(symbolKey(symbol.reference), symbol.reference);
        }
        server.aliases = [...aliases.values()];
        return {
          types: answer(server, await server.client.request('getTypeAtLocations', params)),
          symbols: answer(server, symbols),
        };
      };
      const seen = await prelude(probe);
      const distinct = (items) => [...new Set(items.filter((item) => item !== null).map((item) => item.id))];
      const types = distinct(seen.types);
      const aliases = probe.aliases;
      assert.ok(types.length > 50, `${types.length} types`);
      assert.ok(aliases.length > 3, `${aliases.length} aliases`);
      const succeeds = async (method, params) =>
        (await probe.client.request(method, { ...probe.base, ...params })).type !== 'error';
      const declarations = [];
      const constants = [];
      for (const relative of located) {
        const location = inCopy(probe, relative);
        if (await succeeds('getSignatureFromDeclaration', { location })) declarations.push(relative);
        if (await succeeds('getConstantValue', { location })) constants.push(relative);
      }
      const literalTypes = [];
      for (const type of types) if (await succeeds('getBaseTypeOfLiteralType', { type })) literalTypes.push(type);

      const single = await open();
      const batched = await open();
      servers.push(single, batched);
      assert.deepEqual(await prelude(single), await prelude(batched));
      const one = async (method, params) =>
        answer(single, await single.client.request(method, { ...single.base, ...params }));
      const many = async (method, params) =>
        answer(batched, await batched.client.request(method, { ...batched.base, ...params }));
      const each = async (items, ask) => {
        const out = [];
        for (const item of items) out.push(await ask(item));
        return out;
      };

      const signatures = await each(declarations, (relative) =>
        one('getSignatureFromDeclaration', { location: inCopy(single, relative) }),
      );
      assert.ok(signatures.some((signature) => signature !== null));
      assert.deepEqual(
        await many('getSignaturesFromDeclarations', { locations: declarations.map((r) => inCopy(batched, r)) }),
        signatures,
      );
      const signatureIds = distinct(signatures);
      assert.deepEqual(
        await many('getReturnTypesOfSignatures', { signatures: signatureIds }),
        await each(signatureIds, (signature) => one('getReturnTypeOfSignature', { objectId: signature })),
      );
      for (const kind of [0, 1]) {
        assert.deepEqual(
          await many('getSignaturesOfTypes', { types, kind }),
          await each(types, (type) => one('getSignaturesOfType', { type, kind })),
        );
      }
      assert.deepEqual(
        await many('getPropertiesOfTypes', { types }),
        await each(types, (type) => one('getPropertiesOfType', { type })),
      );
      assert.deepEqual(
        await many('getBaseTypesOfLiteralTypes', { types: literalTypes }),
        await each(literalTypes, (type) => one('getBaseTypeOfLiteralType', { type })),
      );
      assert.deepEqual(
        await many('getAliasedSymbols', { symbols: batched.aliases }),
        await each(single.aliases, (symbol) => one('getAliasedSymbol', { symbol })),
      );
      const values = await each(constants, (relative) =>
        one('getConstantValue', { location: inCopy(single, relative) }),
      );
      assert.ok(values.some((value) => value !== null));
      assert.deepEqual(
        await many('getConstantValues', { locations: constants.map((r) => inCopy(batched, r)) }),
        values,
      );

      // Empty batches answer empty lists; a batch with an item a single query refuses is refused with that error.
      const base = probe.base;
      const batches = [
        ['getSignaturesFromDeclarations', 'locations'],
        ['getReturnTypesOfSignatures', 'signatures'],
        ['getSignaturesOfTypes', 'types'],
        ['getPropertiesOfTypes', 'types'],
        ['getBaseTypesOfLiteralTypes', 'types'],
        ['getAliasedSymbols', 'symbols'],
        ['getConstantValues', 'locations'],
      ];
      for (const [method, field] of batches) {
        assert.deepEqual(await probe.client.json(method, { ...base, [field]: [] }), [], method);
        assert.deepEqual(await probe.client.json(method, base), [], method);
      }
      const missing = `1.0.${join(probe.dir, 'missing.ts')}`;
      const missingSymbol = { kind: 1, snapshot: base.snapshot, project: base.project, id: 999999999 };
      for (const [singleMethod, batch, field, plural, good, bad] of [
        [
          'getSignatureFromDeclaration',
          'getSignaturesFromDeclarations',
          'location',
          'locations',
          inCopy(probe, declarations[0]),
          missing,
        ],
        ['getConstantValue', 'getConstantValues', 'location', 'locations', inCopy(probe, constants[0]), missing],
        [
          'getReturnTypeOfSignature',
          'getReturnTypesOfSignatures',
          'objectId',
          'signatures',
          signatureIds[0],
          999999999,
        ],
        ['getPropertiesOfType', 'getPropertiesOfTypes', 'type', 'types', types[0], 999999999],
        ['getAliasedSymbol', 'getAliasedSymbols', 'symbol', 'symbols', aliases[0], missingSymbol],
      ]) {
        const refused = await probe.client.request(singleMethod, { ...base, [field]: bad });
        assert.equal(refused.type, 'error', singleMethod);
        const refusedBatch = await probe.client.request(batch, { ...base, [plural]: [good, bad] });
        assert.equal(refusedBatch.type, 'error', batch);
        assert.equal(refusedBatch.payload.toString(), refused.payload.toString(), batch);
      }
    } finally {
      for (const server of [probe, ...servers]) await server.client.close();
    }
  },
);
