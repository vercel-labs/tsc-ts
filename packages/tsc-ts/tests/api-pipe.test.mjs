// `tsc-ts --api --pipe`: on Windows the server creates the named pipe it is given and serves one client on it, as
// scriptc's Node host starts it (rpc-process.ts). A session over the pipe gives the same responses as the same session
// over standard input and output, which the native scriptc compiler uses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from './client.mjs';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const native = process.env.TSC_TS_BIN !== undefined;
const windows = process.platform === 'win32';

function pipeName() {
  return `\\\\.\\pipe\\tsc-ts-test-${process.pid}-${randomUUID()}`;
}

function copyProject() {
  const dir = tempDir('tsc-ts-api-pipe-');
  cpSync(resolve('tests/fixtures/project'), dir, { recursive: true });
  return dir;
}

// The responses to one session: the requests a compile makes, in its order.
async function session(client, dir) {
  const replies = [];
  const call = async (method, params) => {
    const reply = await client.request(method, params);
    replies.push(`${method} ${reply.type} ${reply.payload.toString('base64')}`);
    return reply.type === 'response' && method !== 'getSourceFile' ? JSON.parse(reply.payload.toString()) : undefined;
  };
  await call('initialize');
  await call('ping');
  const config = join(dir, 'tsconfig.json');
  await call('parseConfigFile', { file: config });
  const update = await call('createSnapshot', { openProjects: [config], ensurePrograms: true });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  const files = await call('getSourceFileNames', base);
  for (const file of files) if (file.startsWith(dir)) await call('getSourceFile', { ...base, file });
  for (const method of ['getProgramDiagnostics', 'getGlobalDiagnostics', 'getSemanticDiagnostics'])
    await call(method, base);
  return { replies, calls: client.calls.length };
}

test(
  'a session over the named pipe answers as over standard input and output',
  { skip: !windows || !native ? 'needs the native tsc-ts on Windows' : tscTsMissing, timeout: 300_000 },
  async () => {
    const dir = copyProject();
    const stdio = new Client(tscTs, dir);
    const expected = await session(stdio, dir);
    assert.equal(await stdio.close(), 0, stdio.stderr);

    const piped = new Client(tscTs, dir, {}, { pipe: pipeName() });
    const actual = await session(piped, dir);
    // Closing the client's end ends the server, as at the end of standard input.
    assert.equal(await piped.close(), 0, piped.stderr);
    assert.ok(expected.calls > 0, 'the session reads files through the client');
    assert.deepEqual(actual, expected);
  },
);

test(
  'a pipe name in use is refused',
  { skip: !windows || !native ? 'needs the native tsc-ts on Windows' : tscTsMissing, timeout: 120_000 },
  async () => {
    const dir = copyProject();
    const pipe = pipeName();
    const first = new Client(tscTs, dir, {}, { pipe });
    await first.request('ping');
    const second = spawnSync(tscTs[0], [...tscTs.slice(1), '--api', '--cwd', dir, '--pipe', pipe], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /cannot create pipe/);
    assert.equal(await first.close(), 0, first.stderr);
  },
);

test(
  '--pipe is refused where the build has no pipe server',
  { skip: windows && native ? 'Windows native build' : tscTsMissing },
  () => {
    const result = spawnSync(tscTs[0], [...tscTs.slice(1), '--api', '--pipe', pipeName()], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /-pipe is supported only by tsc-ts on Windows/);
  },
);
