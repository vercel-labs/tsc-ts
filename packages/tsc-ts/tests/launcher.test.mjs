// The launcher (bin/tsc-ts.js) on Linux: its first run writes the platform package's executable again with one write
// and keeps its mode under any umask; later runs leave the copy as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

// Under umask 077 the launcher runs as `sh -c 'umask 077; node launcher'`.
const run = (launcher) =>
  spawnSync('sh', ['-c', 'umask 077; exec "$0" "$1"', process.execPath, launcher], { encoding: 'utf8' });

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
