// Releasing a program gives its memory back: a snapshot released in a session, and a client that closes its end of
// a `--listen` server, both let the server drop the program, so the memory of the clients that came before does not
// accumulate. Resident memory is sampled from /proc, so this runs on Linux.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { callbacks, Client } from './client.mjs';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const native = process.env.TSC_TS_BIN !== undefined;
const skip =
  !native ? 'needs the native tsc-ts on Linux' : process.platform !== 'linux' ? 'reads /proc' : tscTsMissing;

// A project large enough that a program's memory is visible: files of interfaces that reference the next file's
// types through maps, records and unions, so the program builds and checks a real type graph.
function project(files = 300) {
  const dir = tempDir('tsc-ts-api-memory-');
  mkdirSync(join(dir, 'src'));
  for (let i = 0; i < files; i++) {
    const next = i + 1 < files ? `import type { T${i + 1} } from './f${i + 1}.js';\n` : '';
    const reference = i + 1 < files ? `T${i + 1}` : 'never';
    writeFileSync(
      join(dir, 'src', `f${i}.ts`),
      `${next}export type U${i} = { a: number; b: string } | { c: ${reference}[] };\n` +
        `export interface T${i} {\n  p1: Map<string, U${i}>;\n  p2: Array<{ x: T${i}; y: U${i} }>;\n` +
        `  p3?: ${reference};\n  p4: Record<string, ${reference} | null>;\n  m<P extends keyof T${i}>(k: P): T${i}[P];\n}\n`,
    );
  }
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'esnext',
        module: 'esnext',
        moduleResolution: 'bundler',
        noEmit: true,
        lib: ['es2025'],
        types: [],
      },
      include: ['src'],
    }),
  );
  return dir;
}

function rss(pid) {
  const text = readFileSync(`/proc/${pid}/status`, 'utf8');
  return Math.round(Number(/^VmRSS:\s+(\d+) kB$/m.exec(text)[1]) / 1024);
}

// A server listening on a socket in a new directory; `ready` resolves once the socket exists.
function listen(dir) {
  const socket = join(tempDir('tsc-ts-socket-'), 's');
  const child = spawn(
    tscTs[0],
    [...tscTs.slice(1), '--api', '--cwd', dir, `--callbacks=${callbacks.join(',')}`, '--listen', socket],
    { stdio: ['ignore', 'ignore', 'pipe'], env: process.env },
  );
  const server = { socket, child, stderr: '' };
  child.stderr.on('data', (chunk) => (server.stderr += chunk));
  server.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  server.ready = (async () => {
    const deadline = Date.now() + 60_000;
    while (!existsSync(socket)) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`the server did not listen: ${server.stderr}`);
      await delay(20);
    }
  })();
  return server;
}

// One client's compile: open the project, read its files, check it, and close.
async function compile(client, dir) {
  await client.json('initialize');
  const config = join(dir, 'tsconfig.json');
  const update = await client.json('createSnapshot', { openProjects: [config], ensurePrograms: true });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  await client.json('getSourceFileNames', base);
  await client.json('getSemanticDiagnostics', base);
  return update;
}

test('a client that releases its snapshot gives the program back', { skip, timeout: 900_000 }, async () => {
  const dir = project();
  const client = new Client(tscTs, dir);
  try {
    const start = rss(client.child.pid);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      const update = await compile(client, dir);
      const program = rss(client.child.pid);
      await client.json('release', { snapshot: update.snapshot });
      const released = rss(client.child.pid);
      samples.push({ program, released });
    }
    // Without freeing, the fourth program would sit at the start plus four programs; with it, the freed programs
    // leave at most about one program's pages behind.
    const programCost = samples[0].program - start;
    assert.ok(
      samples[3].program < start + 2 * programCost,
      `four programs stay resident: ${samples.map((s) => `${s.program}/${s.released}`).join(' ')} MB, start ${start}`,
    );
  } finally {
    await client.close();
  }
});

test('a listen server drops a client program when the client disconnects', { skip, timeout: 900_000 }, async () => {
  const dir = project();
  const server = listen(dir);
  await server.ready;
  try {
    const baseline = rss(server.child.pid);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      const client = Client.connect(server.socket);
      await compile(client, dir);
      assert.equal(await client.close(), 0, client.stderr);
      await delay(100);
      samples.push(rss(server.child.pid));
    }
    const first = samples[0] - baseline;
    assert.ok(first > 0, `the first client did not make the server allocate: ${baseline} MB`);
    assert.ok(
      samples[3] - samples[0] < first,
      `earlier clients' programs stay resident: ${samples.join(' ')} MB (baseline ${baseline})`,
    );
  } finally {
    server.child.kill();
  }
});
