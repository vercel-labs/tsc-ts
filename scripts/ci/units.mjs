// The CI test units, their measured durations, and shard packing.
//
// A unit is one test file run with `node --test` in its package, one part of a test file that splits its runs
// (program.test.mjs, command-line.test.mjs and library-checking.test.mjs take an `i/n` shard), or the native twin of
// a unit (`native:` and the unit's id), which runs the same test file against a native build. Unit ids are stable
// strings such as `packages/tsc-ts/tests/program.test.mjs#2/8`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Parts the split test files run in. More parts shorten the longest unit; each part repeats the file's setup.
const parts = {
  'packages/tsc-ts/tests/program.test.mjs': { env: 'PROGRAM_SHARD', count: 8 },
  'packages/tsc-ts/tests/command-line.test.mjs': { env: 'CLI_SHARD', count: 4 },
  'packages/tsc-ts/tests/library-checking.test.mjs': { env: 'LIBRARY_SHARD', count: 3 },
};

// Test files that can run a native build instead of the Node one, and the variable that names it: TSC_TS_BIN
// takes the native tsc-ts (`npm run build:native`, dist/tsc), TSC_TS_CLI the native command line driver
// (src/drivers/cli.ts, dist/cli). Each of their units has a native twin, `native:<unit id>`.
const nativeFiles = {
  'packages/tsc-ts/tests/api.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/api-libraries-from-disk.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/api-listen.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/api-pipe.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/build.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/library-checking.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/parallel-emit.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/projects.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/scriptc.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/tsc-project.test.mjs': 'TSC_TS_BIN',
  'packages/tsc-ts/tests/program.test.mjs': 'TSC_TS_CLI',
  'packages/tsc-ts/tests/command-line.test.mjs': 'TSC_TS_CLI',
};
export const nativeBinaries = {
  TSC_TS_BIN: join(root, 'packages/tsc-ts/dist/tsc'),
  TSC_TS_CLI: join(root, 'packages/tsc-ts/dist/cli'),
};

/**
 * @typedef {{ id: string, file: string, cwd: string, command: string[], env: Record<string, string>, native: boolean }} Unit
 */

/** Every unit, in a fixed order. */
export function allUnits() {
  /** @type {Unit[]} */
  const units = [];
  for (const pkg of ['tsc-ts']) {
    const dir = join(root, 'packages', pkg, 'tests');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.test.mjs')) continue;
      const file = `packages/${pkg}/tests/${name}`;
      const base = { file, cwd: `packages/${pkg}`, command: ['node', '--test', `tests/${name}`] };
      const split = parts[file];
      const own = [];
      if (split === undefined) own.push({ ...base, id: file, env: {}, native: false });
      else
        for (let i = 1; i <= split.count; i++)
          own.push({
            ...base,
            id: `${file}#${i}/${split.count}`,
            env: { [split.env]: `${i}/${split.count}` },
            native: false,
          });
      units.push(...own);
      const variable = nativeFiles[file];
      if (variable !== undefined)
        for (const unit of own)
          units.push({
            ...unit,
            id: `native:${unit.id}`,
            env: { ...unit.env, [variable]: nativeBinaries[variable] },
            native: true,
          });
    }
  }
  return units;
}

/** Measured seconds per unit id on a GitHub-hosted ubuntu runner (scripts/ci/durations.json). */
export function durations() {
  const path = join(root, 'scripts/ci/durations.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).seconds : {};
}

// Units without a measurement count as this many seconds.
const unmeasured = 60;

export function durationOf(id, measured = durations()) {
  return measured[id] ?? unmeasured;
}

/**
 * Packs units into `count` shards, longest first onto the least loaded shard. Returns arrays of unit ids; the
 * packing depends only on the ids and the durations file, so every job computes the same shards.
 */
export function pack(ids, count, measured = durations()) {
  const shards = Array.from({ length: count }, () => ({ ids: [], seconds: 0 }));
  const sorted = [...ids].sort((a, b) => durationOf(b, measured) - durationOf(a, measured) || a.localeCompare(b));
  for (const id of sorted) {
    const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    lightest.ids.push(id);
    lightest.seconds += durationOf(id, measured);
  }
  return shards;
}

/** The number of shards that keeps each at about `target` seconds (or the longest unit), between 1 and `max`. */
export function shardCount(ids, target, max, measured = durations()) {
  const total = ids.reduce((sum, id) => sum + durationOf(id, measured), 0);
  const longest = Math.max(0, ...ids.map((id) => durationOf(id, measured)));
  const limit = Math.max(target, longest);
  let count = Math.max(1, Math.min(max, Math.ceil(total / limit)));
  // Units do not split, so a count that fits on average can still leave one shard well over the target (three
  // parts of 185 s in two shards): add shards while the packed longest shard is more than 10% over.
  while (count < max && Math.max(...pack(ids, count, measured).map((s) => s.seconds)) > limit * 1.1) count++;
  return count;
}
