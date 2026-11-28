// getDiagnosticsOfCheckedFiles answers, for each listed file, what getSemanticDiagnostics answers for it, and what
// getGlobalDiagnostics answers, after checking only the listed files: tsc --api has no such method, so tsc-ts is
// compared with itself after a full check.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from './client.mjs';
import { tempDir } from './temp.mjs';
import { typescriptLib as bundledLib, tscTs, tscTsMissing } from './toolchain.mjs';

const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const env = { TSC_TS_LIB_DIR: typescriptLib };
const skip = typescriptLib === '' ? 'needs the scriptc toolchain' : tscTsMissing;

// A project whose files have semantic errors, one of them across files, and a fileless program error (a
// missing type definition file).
function project() {
  const dir = realpathSync(tempDir('tsc-ts-api-checked-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'es2022', module: 'nodenext', types: ['missing-types'] },
      include: ['src'],
    }),
  );
  writeFileSync(
    join(dir, 'src/a.ts'),
    "import { f, Shape } from './b.js';\nexport const n: number = 'x';\nf(1, 2);\nexport class Square implements Shape { side = 1; }\n",
  );
  writeFileSync(
    join(dir, 'src/b.ts'),
    'export function f(x: string): string { return x * 2; }\nexport interface Shape { area(): number }\n',
  );
  writeFileSync(join(dir, 'src/c.ts'), 'export const ok = 1;\nexport const bad: string = ok;\n');
  return dir;
}

async function open(dir) {
  const client = new Client(tscTs, dir, env);
  await client.json('initialize');
  const update = await client.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  return { client, base };
}

test('checked-file diagnostics answer as the full check', { skip, timeout: 600_000 }, async () => {
  const dir = project();
  const servers = [];
  try {
    const full = await open(dir);
    servers.push(full);
    const files = await full.client.json('getSourceFileNames', full.base);
    const own = files.filter((file) => file.startsWith(join(dir, 'src')));
    assert.equal(own.length, 3);
    const global = await full.client.json('getGlobalDiagnostics', full.base);
    assert.ok(
      global.some((d) => d.code === 2688),
      JSON.stringify(global),
    );
    const semantic = new Map();
    for (const file of files)
      semantic.set(file, await full.client.json('getSemanticDiagnostics', { ...full.base, files: [file] }));
    assert.ok(own.every((file) => semantic.get(file).length > 0));

    // Every file listed: the full check's answers.
    const all = await open(dir);
    servers.push(all);
    const answered = await all.client.json('getDiagnosticsOfCheckedFiles', { ...all.base, files });
    assert.deepEqual(
      answered.files,
      files.map((file) => semantic.get(file)),
    );
    assert.deepEqual(answered.global, global);

    // The project's own files only: their answers, and here the same global diagnostics.
    const some = await open(dir);
    servers.push(some);
    const partial = await some.client.json('getDiagnosticsOfCheckedFiles', { ...some.base, files: own });
    assert.deepEqual(
      partial.files,
      own.map((file) => semantic.get(file)),
    );
    assert.deepEqual(partial.global, global);
    // In another order, the same answers.
    const reversed = await some.client.json('getDiagnosticsOfCheckedFiles', {
      ...some.base,
      files: [...own].reverse(),
    });
    assert.deepEqual(
      reversed.files,
      [...own].reverse().map((file) => semantic.get(file)),
    );

    // No files: no file answers, and the global diagnostics so far; a file the server does not have is refused
    // with getSemanticDiagnostics's error.
    assert.deepEqual((await some.client.json('getDiagnosticsOfCheckedFiles', some.base)).files, []);
    const missing = join(dir, 'src/missing.ts');
    const refused = await some.client.request('getSemanticDiagnostics', { ...some.base, files: [missing] });
    assert.equal(refused.type, 'error');
    const refusedBatch = await some.client.request('getDiagnosticsOfCheckedFiles', {
      ...some.base,
      files: [own[0], missing],
    });
    assert.equal(refusedBatch.type, 'error');
    assert.equal(refusedBatch.payload.toString(), refused.payload.toString());
  } finally {
    for (const server of servers) await server.client.close();
  }
});

test(
  'checked-file diagnostics include the checker global diagnostics checking found',
  { skip, timeout: 600_000 },
  async () => {
    // Without a lib, checking a file reports global types it needs and cannot find: global diagnostics of no file
    // that the checker, not the program, reports.
    const dir = realpathSync(tempDir('tsc-ts-api-checked-nolib-'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { noLib: true, types: [] }, files: ['a.ts'] }),
    );
    writeFileSync(join(dir, 'a.ts'), 'export const values = [1, 2];\nexport async function f() { return 1; }\n');
    const servers = [];
    try {
      const full = await open(dir);
      servers.push(full);
      const files = await full.client.json('getSourceFileNames', full.base);
      const global = await full.client.json('getGlobalDiagnostics', full.base);
      assert.ok(
        global.some((d) => d.code === 2318),
        JSON.stringify(global),
      );
      const semantic = [];
      for (const file of files) semantic.push(await full.client.json('getSemanticDiagnostics', { ...full.base, file }));
      const checked = await open(dir);
      servers.push(checked);
      const answered = await checked.client.json('getDiagnosticsOfCheckedFiles', { ...checked.base, files });
      assert.deepEqual(answered.files, semantic);
      assert.deepEqual(answered.global, global);
    } finally {
      for (const server of servers) await server.client.close();
    }
  },
);

test('a diagnostics answer can leave out the formatting context', { skip, timeout: 600_000 }, async () => {
  // A minified bundle is one very long line, so each of its diagnostics carries the whole line as source
  // lines: the answer is large exactly as it is on a minified JavaScript program. `dup.ts` reports a
  // diagnostic with related information, so the context is checked within chains too.
  const dir = realpathSync(tempDir('tsc-ts-api-formatting-'));
  const padding = '/*' + 'x'.repeat(64 * 1024) + '*/';
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, strict: true, noEmit: true, types: [] },
      files: ['bundle.js', 'dup.ts'],
    }),
  );
  writeFileSync(join(dir, 'bundle.js'), padding + 'function f(e){return e}\n');
  // Two default exports: the module's error carries related information naming each one.
  writeFileSync(join(dir, 'dup.ts'), 'export default 1;\nexport default 2;\n');

  const { client, base } = await open(dir);
  try {
    const files = await client.json('getSourceFileNames', base);
    const withoutContext = (d) => {
      const rest = { ...d };
      delete rest.startPosition;
      delete rest.endPosition;
      delete rest.sourceLines;
      if (rest.messageChain !== undefined) rest.messageChain = rest.messageChain.map(withoutContext);
      if (rest.relatedInformation !== undefined) rest.relatedInformation = rest.relatedInformation.map(withoutContext);
      return rest;
    };
    const hasContext = (d) =>
      d.startPosition !== undefined ||
      d.endPosition !== undefined ||
      d.sourceLines !== undefined ||
      (d.messageChain ?? []).some(hasContext) ||
      (d.relatedInformation ?? []).some(hasContext);

    // By default the answer is the one TypeScript's API sends: the source lines and positions are there,
    // and the answer is large because the bundle's line is.
    const plain = await client.request('getDiagnosticsOfCheckedFiles', { ...base, files });
    const answered = JSON.parse(plain.payload.toString());
    assert.ok(plain.payload.length > 64 * 1024, `${plain.payload.length} bytes`);
    assert.ok(answered.files.some((list) => list.some(hasContext)));
    assert.ok(answered.files.some((list) => list.some((d) => (d.relatedInformation ?? []).length > 0)));

    // With context false the answer is the same without that context, and small.
    const flaggedReply = await client.request('getDiagnosticsOfCheckedFiles', { ...base, files, context: false });
    const flagged = JSON.parse(flaggedReply.payload.toString());
    assert.ok(flaggedReply.payload.length < 4096, `${flaggedReply.payload.length} bytes`);
    assert.deepEqual(
      flagged.files,
      answered.files.map((list) => list.map(withoutContext)),
    );
    assert.deepEqual(flagged.global, answered.global.map(withoutContext));
    assert.ok(!flagged.files.some((list) => list.some(hasContext)));
    assert.ok(flagged.files.some((list) => list.some((d) => (d.relatedInformation ?? []).length > 0)));

    // The diagnostics of the whole program, and the global ones, answer the same way.
    for (const method of ['getSemanticDiagnostics', 'getGlobalDiagnostics']) {
      const params = { ...base };
      const full = JSON.parse((await client.request(method, params)).payload.toString());
      const reducedReply = await client.request(method, { ...params, context: false });
      const reduced = JSON.parse(reducedReply.payload.toString());
      assert.deepEqual(reduced, full.map(withoutContext));
      assert.ok(!reduced.some(hasContext));
      assert.ok(reducedReply.payload.length < 4096, `${method} ${reducedReply.payload.length} bytes`);
    }
  } finally {
    await client.close();
  }
});
