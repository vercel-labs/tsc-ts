// Sharing results between checker threads (TSC_TS_SHARE, shared-results.ts): a posted result's state names the
// checker that posted it and the offset of the result in its number log, and each file has a forbidden bit for each
// checker, at every checker count sharing supports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-shared-results-', ['main.ts']);
const {
  Exporter,
  forbiddenWords,
  isForbidden,
  maxSharingCheckers,
  numberLogSize,
  postedOffset,
  postedProducer,
  postedState,
} = await import(pathToFileURL(join(out, 'compiler/shared-results.js')).href);

const counts = [2, 31, 32, 33, 63, 64, 65, 100, 128, 129, maxSharingCheckers];

test('a posted state names its checker and offset at every checker count', () => {
  for (const count of counts)
    for (const producer of [0, 1, count >> 1, count - 1])
      for (const offset of [0, 1, 12345, numberLogSize - 1]) {
        const state = postedState(count, producer, offset);
        assert.ok(
          state <= -2 && state >= -(2 ** 31),
          `state of ${producer}/${count} at ${offset} is an int32 below -1`,
        );
        assert.equal(state | 0, state);
        assert.equal(postedProducer(count, state), producer);
        assert.equal(postedOffset(count, state), offset);
      }
});

test('each checker has its own forbidden bit', () => {
  for (const count of counts) {
    const words = forbiddenWords(count);
    const files = 3;
    const forbidden = new Int32Array(new SharedArrayBuffer(4 * files * words));
    const file = 1;
    for (let index = 0; index < count; index++) {
      Atomics.or(forbidden, file * words + (index >>> 5), 1 << (index & 31));
      for (let other = 0; other < count; other++)
        assert.equal(
          isForbidden(forbidden, count, file, other),
          other <= index,
          `checker ${other} after ${index} of ${count}`,
        );
      assert.equal(isForbidden(forbidden, count, 0, index), false);
      assert.equal(isForbidden(forbidden, count, 2, index), false);
    }
  }
});

// An instantiation's record lists the return types of its signatures when they can be exported (optionalType); one
// that can't is left out, and the export goes on as it was.
test('an optional type that fails to export leaves the export as it was', () => {
  const exporter = new Exporter(undefined, new Map());
  const kept = {};
  exporter.records.push({});
  exporter.addedTypes.push(kept);
  exporter.indexes.set(kept, 0);
  const failing = {};
  exporter.type = (t) => {
    exporter.records.push({});
    exporter.addedTypes.push(t);
    exporter.indexes.set(t, 1);
    return exporter.fail('no record kind');
  };
  assert.equal(exporter.optionalType(failing), -1);
  assert.equal(exporter.failure, undefined);
  assert.equal(exporter.records.length, 1);
  assert.deepEqual(exporter.addedTypes, [kept]);
  assert.equal(exporter.indexes.has(failing), false);
  assert.equal(exporter.indexes.get(kept), 0);
});

test('an optional type does not clear an earlier failure of the export', () => {
  const exporter = new Exporter(undefined, new Map());
  exporter.fail('alias of the instantiation');
  exporter.records.push({});
  assert.equal(exporter.optionalType({}), -1);
  assert.equal(exporter.failure, 'alias of the instantiation');
  assert.equal(exporter.records.length, 1);
});
