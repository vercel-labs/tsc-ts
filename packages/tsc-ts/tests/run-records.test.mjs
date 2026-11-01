// Run records: where they live, what the key covers, the file they hold, and when the samples stop
// describing the project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const out = compileSources('tsc-ts-run-records-', ['main.ts']);
const {
  displayPath,
  nextRecord,
  readRecord,
  recordFile,
  recordKey,
  recordKeyText,
  recordsDirectory,
  shapeChanged,
  writeRecord,
} = await import(pathToFileURL(join(out, 'compiler/run-records.js')).href);

const now = Math.floor(Date.now() / 1000);

const sample = (extra = {}) => ({
  at: now,
  role: 'chosen',
  checkers: 4,
  share: false,
  parseThreads: 3,
  parseMs: 10,
  checkMs: 20,
  totalMs: 35,
  cpuMs: 40,
  peakMB: 100,
  load: 0.2,
  ...extra,
});

const shape = (extra = {}) => ({
  files: 100,
  chars: 1000,
  declarationChars: 400,
  checkChars: 600,
  library: 0,
  own: 0,
  redundancy: 0,
  ...extra,
});

const chosen = (extra = {}) => ({ checkers: 4, share: false, parseThreads: 3, source: 'default', since: 0, ...extra });

const keyInput = (extra = {}) => ({
  version: '1.2.3',
  executable: join(out, 'no-executable-here'),
  configFile: join(out, 'tsconfig.json'),
  rootNames: ['b.ts', 'a.ts'],
  options: { noEmit: true },
  cpus: 8,
  memoryBytes: 16 * 1073741824,
  ...extra,
});

test('the record directory follows TSC_TS_CACHE, TSC_TS_CACHE_DIR and the platform', () => {
  assert.equal(recordsDirectory({ TSC_TS_CACHE: '0' }, 'linux', '/home/u'), undefined);
  assert.equal(recordsDirectory({ TSC_TS_CACHE_DIR: '/cache' }, 'linux', '/home/u'), '/cache');
  assert.equal(recordsDirectory({ TSC_TS_CACHE_DIR: '' }, 'linux', '/home/u'), '/home/u/.cache/tsc-ts');
  assert.equal(recordsDirectory({}, 'linux', '/home/u'), '/home/u/.cache/tsc-ts');
  assert.equal(recordsDirectory({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/u'), '/xdg/tsc-ts');
  assert.equal(recordsDirectory({}, 'darwin', '/home/u'), '/home/u/Library/Caches/tsc-ts');
  assert.equal(recordsDirectory({}, 'win32', '/home/u'), join('/home/u', 'AppData', 'Local', 'tsc-ts', 'cache'));
  assert.equal(recordsDirectory({ LOCALAPPDATA: '/local' }, 'win32', '/home/u'), join('/local', 'tsc-ts', 'cache'));
});

test('the key covers the build, the project, the options and the machine', () => {
  const key = (extra = {}) => recordKey(keyInput(extra));
  assert.equal(key(), key());
  assert.notEqual(key(), key({ version: '1.2.4' }));
  assert.notEqual(key(), key({ options: { noEmit: false } }));
  // The root files name the project only where no config file does.
  assert.notEqual(
    recordKey(keyInput({ configFile: undefined })),
    recordKey(keyInput({ configFile: undefined, rootNames: ['a.ts'] })),
  );
  assert.notEqual(key(), key({ cpus: 4 }));
  assert.notEqual(key(), key({ memoryBytes: 17 * 1073741824 }));
  // The memory limit counts in whole GiB, and the config file, where given, names the project.
  assert.equal(key({ memoryBytes: Math.floor(16.9 * 1073741824) }), key());
  assert.notEqual(key({ configFile: undefined }), key());
  const text = recordKeyText(keyInput());
  assert.match(text, /^format 1\n/);
  assert.match(text, /\ncpus 8\n/);
  assert.match(text, /\nmemory 16$/);
  assert.match(text, /\noptions noEmit=1 /);
});

test('a written record follows the choice each run made, and a changed choice starts at its run', () => {
  const dir = tempDir('tsc-ts-run-records-');
  const file = recordFile(dir, 'abc');
  const first = writeRecord(dir, 'abc', sample(), shape(), chosen());
  assert.equal(first.path, file);
  const read = readRecord(file);
  assert.equal(read.format, 1);
  assert.equal(read.runs, 1);
  assert.equal(read.samples.length, 1);
  assert.equal(read.samples[0].run, 1);
  assert.equal(read.chosen.since, 1);

  const second = writeRecord(dir, 'abc', sample({ at: now + 1, totalMs: 40 }), shape(), chosen({ checkers: 8 }));
  assert.equal(second.path, file);
  const after = readRecord(file);
  assert.equal(after.runs, 2);
  assert.equal(after.samples.length, 2);
  assert.equal(after.samples[1].run, 2);
  assert.equal(after.samples[1].totalMs, 40);
  // The second run chose another count: the record describes that choice from this run.
  assert.equal(after.chosen.checkers, 8);
  assert.equal(after.chosen.since, 2);

  // A run that chose the same configuration keeps the run that chose it.
  writeRecord(dir, 'abc', sample({ at: now + 2 }), shape(), chosen({ checkers: 8 }));
  const kept = readRecord(file);
  assert.equal(kept.runs, 3);
  assert.equal(kept.chosen.checkers, 8);
  assert.equal(kept.chosen.since, 2);
});

test('an explore or control sample moves the schedule its role keeps', () => {
  let record;
  record = nextRecord(record, sample({ at: now }), shape(), chosen());
  assert.equal(record.lastExplore, 0);
  assert.equal(record.lastControl, 0);
  record = nextRecord(record, sample({ at: now + 1, role: 'explore', checkers: 8 }), shape(), chosen());
  assert.equal(record.lastExplore, 2);
  assert.equal(record.lastControl, 0);
  record = nextRecord(record, sample({ at: now + 2, role: 'control' }), shape(), chosen());
  assert.equal(record.lastControl, 3);
  assert.equal(record.lastExplore, 2);
});

test('adopting a learned choice starts its control schedule', () => {
  const learned = (extra = {}) => chosen({ checkers: 8, source: 'learned', ...extra });
  let record = nextRecord(undefined, sample({ at: now }), shape(), chosen());
  assert.equal(record.lastControl, 0);
  // The run that adopted the choice is when the next control is due from.
  record = nextRecord(record, sample({ at: now + 1 }), shape(), learned());
  assert.equal(record.lastControl, 2);
  // A run that keeps it leaves the schedule alone.
  record = nextRecord(record, sample({ at: now + 2 }), shape(), learned());
  assert.equal(record.lastControl, 2);
  // A new adoption starts it over.
  record = nextRecord(record, sample({ at: now + 3 }), shape(), learned({ checkers: 12 }));
  assert.equal(record.lastControl, 4);
});

test('an unreadable or malformed record is replaced, not merged', () => {
  const dir = tempDir('tsc-ts-run-records-');
  const file = recordFile(dir, 'abc');
  mkdirSync(join(dir, 'runs-v1'), { recursive: true });
  for (const text of ['not json', '{"format":99}', '[]', '{"format":1}']) {
    writeFileSync(file, text);
    const written = writeRecord(dir, 'abc', sample(), shape(), chosen());
    assert.equal(written.path, file);
    const record = readRecord(file);
    assert.equal(record.runs, 1);
    assert.equal(record.samples.length, 1);
  }
});

test('a record keeps the configuration a fast revert rejected', () => {
  const dir = tempDir('tsc-ts-run-records-');
  const file = recordFile(dir, 'abc');
  const rejection = { checkers: 8, share: true, run: 1 };
  writeRecord(dir, 'abc', sample(), shape(), chosen(), rejection);
  assert.deepEqual(readRecord(file).rejected, rejection);
  // A later run that rejects nothing keeps it, and one that rejects another configuration replaces it.
  writeRecord(dir, 'abc', sample({ at: now + 1 }), shape(), chosen());
  assert.deepEqual(readRecord(file).rejected, rejection);
  const next = { checkers: 16, share: false, run: 2 };
  writeRecord(dir, 'abc', sample({ at: now + 2 }), shape(), chosen(), next);
  assert.deepEqual(readRecord(file).rejected, next);
  // A project that changed past the shape limits starts over, the rejection with the samples.
  writeRecord(dir, 'abc', sample({ at: now + 3 }), shape({ files: 200 }), chosen());
  const changed = readRecord(file);
  assert.equal(changed.rejected, undefined);
  assert.equal(changed.samples.length, 1);
  // A rejection that is not one this build writes is ignored, like a malformed sample.
  writeFileSync(file, JSON.stringify({ ...changed, rejected: { checkers: 'x' } }));
  assert.equal(readRecord(file).rejected, undefined);
});

test('a shape change discards the samples but keeps the run count', () => {
  const dir = tempDir('tsc-ts-run-records-');
  const file = recordFile(dir, 'abc');
  writeRecord(dir, 'abc', sample(), shape(), chosen());
  // A small edit keeps the samples.
  writeRecord(dir, 'abc', sample(), shape({ files: 105 }), chosen());
  assert.equal(readRecord(file).samples.length, 2);
  // A change past 15% starts the samples over, and the new choice counts from that run.
  writeRecord(dir, 'abc', sample(), shape({ files: 200 }), chosen({ checkers: 8 }));
  const record = readRecord(file);
  assert.equal(record.runs, 3);
  assert.equal(record.samples.length, 1);
  assert.equal(record.samples[0].run, 3);
  assert.equal(record.chosen.checkers, 8);
  assert.equal(record.chosen.since, 3);
});

test('samples older than the age limit are dropped when read', () => {
  const dir = tempDir('tsc-ts-run-records-');
  const file = recordFile(dir, 'abc');
  const old = now - 40 * 86400;
  mkdirSync(join(dir, 'runs-v1'), { recursive: true });
  const record = {
    format: 1,
    shape: shape(),
    runs: 2,
    lastExplore: 0,
    lastControl: 0,
    chosen: chosen({ since: 1 }),
    samples: [
      { ...sample({ at: old }), run: 1 },
      { ...sample(), run: 2 },
    ],
  };
  writeFileSync(file, JSON.stringify(record));
  const read = readRecord(file);
  assert.equal(read.samples.length, 1);
  assert.equal(read.samples[0].run, 2);
});

test('a record keeps at most 32 samples, dropping the oldest', () => {
  let record;
  for (let i = 0; i < 40; i++) record = nextRecord(record, sample({ at: now + i }), shape(), chosen());
  assert.equal(record.runs, 40);
  assert.equal(record.samples.length, 32);
  assert.equal(record.samples[0].run, 9);
  assert.equal(record.samples.at(-1).run, 40);
});

test('an unwritable directory reports why instead of throwing', () => {
  const dir = tempDir('tsc-ts-run-records-');
  const file = join(dir, 'a-file');
  writeFileSync(file, 'not a directory');
  const written = writeRecord(file, 'abc', sample(), shape(), chosen());
  assert.equal(written.path, undefined);
  assert.ok(written.reason !== undefined && written.reason !== '');
  assert.equal(readRecord(recordFile(file, 'abc')), undefined);
});

test('the shape changes past 15%, and the redundancy past 0.1', () => {
  assert.equal(shapeChanged(shape(), shape({ files: 114 })), false);
  assert.equal(shapeChanged(shape(), shape({ files: 116 })), true);
  assert.equal(shapeChanged(shape(), shape({ checkChars: 691 })), true);
  assert.equal(shapeChanged(shape({ declarationChars: 0 }), shape({ declarationChars: 1 })), true);
  assert.equal(shapeChanged(shape({ redundancy: 0.5 }), shape({ redundancy: 0.59 })), false);
  assert.equal(shapeChanged(shape({ redundancy: 0.5 }), shape({ redundancy: 0.61 })), true);
});

test('the section prints the home directory of a record as ~', () => {
  assert.equal(displayPath('/home/u/.cache/tsc-ts/runs-v1/a.json', '/home/u'), '~/.cache/tsc-ts/runs-v1/a.json');
  assert.equal(displayPath('/home/u2/a.json', '/home/u'), '/home/u2/a.json');
  assert.equal(displayPath('/home/other/a.json', '/home/u'), '/home/other/a.json');
});
