// `tsc-ts --api --default-libraries-from-disk`: the server reads the files in its default library directory from the
// disk instead of through the client's callbacks, and answers as it does when every read goes through them.
import assert from 'node:assert/strict';
import { cpSync, existsSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { Client } from './client.mjs';
import { tempDir } from './temp.mjs';
import { typescriptLib as bundledLib, tscTs, tscTsMissing } from './toolchain.mjs';

const lib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const skip = lib === '' ? 'needs the scriptc toolchain' : tscTsMissing;

// The responses to a session that loads the project and reads its files and diagnostics, and the client's calls.
async function session(dir, args, libDir = lib) {
  const client = new Client(tscTs, dir, { TSC_TS_LIB_DIR: libDir }, { args });
  const replies = [];
  const call = async (method, params) => {
    const reply = await client.request(method, params);
    replies.push(`${method} ${reply.type} ${reply.payload.toString('base64')}`);
    return reply.type === 'response' && method !== 'getSourceFile' ? JSON.parse(reply.payload.toString()) : undefined;
  };
  await call('initialize');
  const update = await call('updateSnapshot', { openProjects: [join(dir, 'tsconfig.json')] });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  for (const file of await call('getSourceFileNames', base)) await call('getSourceFile', { ...base, file });
  for (const method of ['getProgramDiagnostics', 'getGlobalDiagnostics', 'getSemanticDiagnostics'])
    await call(method, base);
  assert.equal(await client.close(), 0, client.stderr);
  return { replies, calls: client.calls };
}

test('the server reads its default library files from the disk', { skip, timeout: 300_000 }, async () => {
  const dir = tempDir('tsc-ts-api-libraries-');
  cpSync(resolve('tests/fixtures/project'), dir, { recursive: true });
  const underLib = ([, path]) => typeof path === 'string' && (path === lib || path.startsWith(lib + '/'));
  const expected = await session(dir, []);
  assert.ok(expected.calls.some(underLib), 'without the flag, library files are read through the client');
  const actual = await session(dir, ['--default-libraries-from-disk']);
  assert.deepEqual(actual.replies, expected.replies);
  assert.deepEqual(actual.calls.filter(underLib), []);
  assert.deepEqual(
    actual.calls,
    expected.calls.filter((call) => !underLib(call)),
  );
  // TSC_TS_LIB_DIR relative to the session's directory, with `.` and `..` segments, names the same directory.
  const dotted = await session(dir, ['--default-libraries-from-disk'], `${relative(dir, lib)}/../${basename(lib)}/.`);
  assert.deepEqual(dotted.replies, expected.replies);
  assert.deepEqual(dotted.calls, actual.calls);
});
