#!/usr/bin/env node
// Runs the native tsc-ts executable from this platform's package. The lib
// files sit next to the executable, where it looks for them.
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { executableName, hostDescription, hostPlatform, packageName } from './platforms.js';

const platform = hostPlatform();
if (platform === undefined) fail(`no native executable for ${hostDescription()}`);

const name = packageName(platform);
let root;
try {
  root = dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
} catch {
  fail(`${name} is not installed; reinstall tsc-ts with optional dependencies enabled`);
}

const executable = join(root, 'lib', executableName());
if (process.platform !== 'win32') {
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    try {
      chmodSync(executable, 0o755);
    } catch {
      // spawnSync reports the error.
    }
  }
}

if (process.platform === 'linux') writeOnce(executable);

const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) fail(`could not run ${executable}: ${result.error.message}`);
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;

// The executable's code maps with 2 MiB pages when the page cache holds the
// file in 2 MiB folios, which a file written with one write gets on file
// systems with large folios (XFS, ext4 from Linux 6.16). Package managers
// write it in chunks, which leaves 4 KiB folios until the file is read from
// disk again. The first run writes it again with one write and renames the
// copy into place; .tsc-ts-written beside it holds the size of the copy, so
// later runs only read it. When the directory is not writable, the
// executable runs as installed.
function writeOnce(file) {
  const marker = join(dirname(file), '.tsc-ts-written');
  let size;
  try {
    size = statSync(file).size;
    if (readFileSync(marker, 'utf8') === String(size)) return;
  } catch {
    if (size === undefined) return;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const bytes = readFileSync(file);
    writeFileSync(temporary, bytes, { mode: statSync(file).mode & 0o777 });
    renameSync(temporary, file);
    writeFileSync(marker, String(bytes.length));
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // There is no copy to remove.
    }
  }
}

function fail(message) {
  process.stderr.write(`tsc-ts: ${message}\n`);
  process.exit(1);
}
