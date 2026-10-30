// The launcher (bin/tsc-ts.js) on Linux: its first run writes the platform package's executable again with one write
// and keeps its mode under any umask; later runs leave the copy as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPlatform, packageName } from '../bin/platforms.js';
import { tempDir } from './temp.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '../bin');
const platform = hostPlatform();
const skip = (process.platform !== 'linux' && 'Linux only') || (platform === undefined && 'no platform package');

/** An installation with the launcher and a platform package whose executable is a script that prints `ran`. */
function installation() {
  const dir = tempDir('launcher-');
  cpSync(bin, join(dir, 'node_modules/tsc-ts/bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/tsc-ts/package.json'), '{ "name": "tsc-ts", "type": "module" }\n');
  const pkg = join(dir, 'node_modules', packageName(platform));
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: packageName(platform) }));
  const executable = join(pkg, 'lib/tsc-ts');
  writeFileSync(executable, '#!/bin/sh\necho ran\n');
  chmodSync(executable, 0o755);
  return { launcher: join(dir, 'node_modules/tsc-ts/bin/tsc-ts.js'), executable, lib: join(pkg, 'lib') };
}

// The launcher runs as `sh -c 'umask <umask>; node [--import preload] launcher'`.
const run = (launcher, { umask = '077', preload, env = {} } = {}) =>
  spawnSync(
    'sh',
    ['-c', `umask ${umask}; exec "$@"`, 'sh', process.execPath, ...(preload ? ['--import', preload] : []), launcher],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );

// A preload for the launcher's process: it logs the mode of each file the launcher writes, at each write and at the
// rename, to LAUNCHER_LOG, and with LAUNCHER_FIXED_RANDOM makes crypto.randomBytes return 0xab bytes, so the
// temporary name is known.
const preloadSource = `import fs from 'node:fs';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
const log = process.env.LAUNCHER_LOG;
let logging = false;
const record = (entry) => {
  if (logging) return;
  logging = true;
  try { fs.appendFileSync(log, JSON.stringify(entry) + '\\n'); } finally { logging = false; }
};
const writeSync = fs.writeSync;
fs.writeSync = function (fd, ...rest) {
  if (!logging) record({ op: 'write', mode: fs.fstatSync(fd).mode & 0o7777 });
  return writeSync.call(this, fd, ...rest);
};
const renameSync = fs.renameSync;
fs.renameSync = function (from, to) {
  record({ op: 'rename', to, mode: fs.statSync(from).mode & 0o7777 });
  return renameSync.call(this, from, to);
};
if (process.env.LAUNCHER_FIXED_RANDOM) crypto.randomBytes = (n) => Buffer.alloc(n, 0xab);
syncBuiltinESMExports();
`;

function preload() {
  const dir = tempDir('launcher-preload-');
  writeFileSync(join(dir, 'preload.mjs'), preloadSource);
  return { preload: join(dir, 'preload.mjs'), log: join(dir, 'log.jsonl') };
}

test('the first run writes the executable again and keeps its mode under umask 077', { skip }, () => {
  const { launcher, executable, lib } = installation();
  const before = statSync(executable);
  const first = run(launcher);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'ran\n');
  const after = statSync(executable);
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode & 0o7777, 0o755);
  assert.equal(readFileSync(join(lib, '.tsc-ts-written'), 'utf8'), String(after.size));
  // A later run finds the marker and leaves the copy as it is.
  assert.equal(run(launcher).stdout, 'ran\n');
  assert.equal(statSync(executable).ino, after.ino);
});

test('the copy is never writable by other users while it is written, under umask 0002', { skip }, () => {
  const { launcher, executable, lib } = installation();
  const { preload: file, log } = preload();
  const result = run(launcher, { umask: '0002', preload: file, env: { LAUNCHER_LOG: log } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ran\n');
  const entries = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const writes = entries.filter((entry) => entry.op === 'write');
  assert.ok(writes.length > 0);
  for (const entry of writes) assert.equal(entry.mode, 0o600);
  const renames = entries.filter((entry) => entry.op === 'rename');
  assert.deepEqual(
    renames.map((entry) => [entry.to, entry.mode]),
    [
      [executable, 0o755],
      [join(lib, '.tsc-ts-written'), 0o644],
    ],
  );
  assert.equal(statSync(executable).mode & 0o7777, 0o755);
});

test("a path already at the copy's name is not followed", { skip }, () => {
  const { launcher, executable, lib } = installation();
  const { preload: file, log } = preload();
  const victim = join(tempDir('launcher-victim-'), 'victim');
  writeFileSync(victim, 'not the executable\n');
  const temporary = `${executable}.${'ab'.repeat(8)}.tmp`;
  symlinkSync(victim, temporary);
  const before = statSync(executable);
  const result = run(launcher, { preload: file, env: { LAUNCHER_LOG: log, LAUNCHER_FIXED_RANDOM: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ran\n');
  assert.equal(readFileSync(victim, 'utf8'), 'not the executable\n');
  assert.ok(lstatSync(temporary).isSymbolicLink());
  assert.equal(readlinkSync(temporary), victim);
  assert.equal(statSync(executable).ino, before.ino);
  assert.equal(existsSync(join(lib, '.tsc-ts-written')), false);
});
