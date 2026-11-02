// Sharing results between checker threads (TSC_TS_SHARE, shared-results.ts): a posted result's state names the
// checker that posted it and the offset of the result in its number log, and each file has a forbidden bit for each
// checker, at every checker count sharing supports. A store's records are int32 words at a cursor: their headers name
// their kind, their refs, and how they name an alias and a symbol; a consumer reads them where they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-shared-results-', ['main.ts']);
const {
  Exporter,
  budgetFailure,
  RecordReader,
  StoreWriter,
  forbiddenWords,
  isForbidden,
  isWanted,
  maxSharingCheckers,
  numberLogSize,
  postedOffset,
  postedProducer,
  postedState,
} = await import(pathToFileURL(join(out, 'compiler/shared-results.js')).href);

const counts = [2, 31, 32, 33, 63, 64, 65, 100, 128, 129, maxSharingCheckers];

// The record kinds and header bits (shared-results.ts), which compiled code has no names for.
const UNION = 12;
const LITERAL = 1;
const ANONYMOUS_OBJECT = 22;
const COMPLETE_OBJECT = 23;
const PROPERTY = 24;
const HAS_ALIAS = 1 << 5;
const CONSTITUENT = 1 << 11;
const NAMING_SHIFT = 6;
const NODE_NAMING = 1;
const HAS_NODE = 1 << 8;
const REF_ESCAPE = 0xffff;
const header = (kind, refs, bits = 0) => kind | bits | (Math.min(refs, REF_ESCAPE) << 16);

/** A writer and reader over fresh logs: 256 numbers, 64 code units, 8 records. */
function store(numbers = 256, units = 64, records = 8) {
  const numberLog = new Int32Array(numbers);
  const stringLog = new Uint16Array(units);
  const table = new Int32Array(records);
  const files = [];
  const writer = new StoreWriter(numberLog, stringLog, table, new Map());
  const reader = new RecordReader(numberLog, stringLog, table, files, new Map());
  return { numberLog, stringLog, table, writer, reader };
}

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

test('each checker has its own wanted bit', () => {
  for (const count of counts) {
    const words = forbiddenWords(count);
    const files = 3;
    const wanted = new Int32Array(new SharedArrayBuffer(4 * files * words));
    const file = 1;
    for (let index = 0; index < count; index++) {
      Atomics.or(wanted, file * words + (index >>> 5), 1 << (index & 31));
      for (let other = 0; other < count; other++)
        assert.equal(
          isWanted(wanted, count, file, other),
          other <= index,
          `checker ${other} after ${index} of ${count}`,
        );
      assert.equal(isWanted(wanted, count, 0, index), false);
    }
  }
});

// The export budget: a record past it fails the export, and the export writes nothing for it.
test('an export stops at its record budget', () => {
  const { writer } = store();
  const exporter = new Exporter(undefined, new Map(), writer);
  exporter.limit = 2;
  assert.equal(exporter.nextIndex(), 0);
  assert.equal(exporter.nextIndex(), 1);
  assert.equal(exporter.nextIndex(), -1);
  assert.equal(exporter.failure, budgetFailure);
});

test('a record over the export budget is not counted or written', () => {
  const { writer } = store();
  const exporter = new Exporter(undefined, new Map(), writer);
  exporter.limit = 1;
  assert.equal(exporter.nextIndex(), 0);
  const at = writer.at;
  assert.equal(exporter.nextIndex(), -1);
  assert.equal(exporter.count, 1);
  assert.equal(writer.at, at);
});

test('a record is read where it was written', () => {
  const { writer, reader, table } = store();
  writer.beginRecord(0, header(UNION, 2));
  writer.word(5);
  writer.word(6);
  writer.word(0);
  writer.word(-1);
  assert.equal(table[0], 1);
  assert.equal(reader.begin(0), true);
  assert.equal(reader.kind, UNION);
  assert.equal(reader.refCount, 2);
  assert.equal(reader.aliasNaming, -1);
  assert.equal(reader.symbolNaming, 0);
  assert.equal(reader.nodeStart, -1);
  assert.equal(reader.node(), undefined);
  reader.scan();
  assert.deepEqual(reader.deps, [5, 6, -1]);
  assert.equal(reader.numbers[reader.fields], 0);
  assert.equal(reader.numbers[reader.fields + 1], -1);
});

test('a record with 0xffff refs or more counts them in a word after its header', () => {
  const { writer, reader } = store();
  writer.beginRecord(0, UNION | (REF_ESCAPE << 16));
  writer.word(3);
  writer.word(7);
  writer.word(8);
  writer.word(9);
  writer.word(0);
  writer.word(-1);
  assert.equal(reader.begin(0), true);
  assert.equal(reader.refCount, 3);
  assert.equal(reader.refAt, 2);
  reader.scan();
  assert.deepEqual(reader.deps, [7, 8, 9, -1]);
});

test('a union origin record depends on its constituents, not on record zero', () => {
  const { writer, reader } = store();
  const exporter = new Exporter({}, new Map(), writer);
  // The origin of a distribution is not a type: a record of its constituents with no origin of its own.
  assert.equal(exporter.originRecord(UNION, 0, [5, 6]), 0);
  assert.equal(reader.begin(0), true);
  assert.equal(reader.kind, UNION);
  assert.ok((reader.header & CONSTITUENT) !== 0);
  assert.equal(reader.numbers[reader.fields + 1], -1);
  reader.scan();
  assert.deepEqual(reader.deps, [5, 6, -1]);
});

test('a record that names an alias with no arguments writes none of the last alias arguments', () => {
  const { writer, reader } = store();
  const exporter = new Exporter({}, new Map(), writer);
  // A union names an alias with two type arguments, records 6 and 7.
  exporter.begin(UNION, 0, [], exporter.aliasBits({ symbol: undefined, typeArguments: [] }, [6, 7]));
  // A property names its parent, an alias with no type arguments: the union's arguments are not its dependencies.
  exporter.nameSymbol(undefined, true);
  exporter.begin(PROPERTY, 1, [], HAS_ALIAS);
  assert.equal(reader.begin(1), true);
  assert.equal(reader.kind, PROPERTY);
  assert.equal(reader.aliasNaming, NODE_NAMING);
  assert.equal(reader.aliasNodeStart, 8);
  assert.equal(reader.aliasRefCount, 0);
  reader.scan();
  assert.deepEqual(reader.deps, []);
});

test('a record names its alias, its symbol and its node where its refs end', () => {
  const { writer, reader } = store();
  writer.beginRecord(0, header(UNION, 1, HAS_ALIAS | (NODE_NAMING << NAMING_SHIFT) | HAS_NODE));
  writer.word(4);
  // The alias: named by its node (0), which the program hasn't here; then its type arguments.
  writer.word(0);
  writer.word(-1);
  writer.word(2);
  writer.word(-1);
  writer.word(-1);
  // The symbol: named by its node, which the program hasn't here; then the node the record carries.
  writer.word(-1);
  writer.word(-1);
  writer.word(0);
  writer.word(-1);
  assert.equal(reader.begin(0), true);
  assert.equal(reader.refAt, 1);
  assert.equal(reader.refCount, 1);
  assert.equal(reader.aliasNaming, NODE_NAMING);
  assert.equal(reader.aliasMergedId, -1);
  assert.equal(reader.aliasNodeStart, 3);
  assert.equal(reader.aliasRefAt, 5);
  assert.equal(reader.aliasRefCount, 2);
  assert.equal(reader.symbolNaming, NODE_NAMING);
  assert.equal(reader.symbolNodeStart, 7);
  assert.equal(reader.nodeStart, 8);
  assert.equal(reader.fields, 9);
  reader.scan();
  assert.deepEqual(reader.deps, [4, -1, -1, -1]);
});

test('an object literal record names the record of its members after its flags', () => {
  const { writer, reader } = store();
  writer.beginRecord(0, header(ANONYMOUS_OBJECT, 0));
  writer.word(0);
  writer.word(3);
  assert.equal(reader.begin(0), true);
  assert.equal(reader.kind, ANONYMOUS_OBJECT);
  assert.equal(reader.fields, 1);
  // The members come in a record of their own, which the object names in its fields.
  reader.scan();
  assert.deepEqual(reader.deps, [3]);
});

test('a completed object record names its shell, its members and its index info types', () => {
  const { writer, reader } = store();
  writer.beginRecord(1, header(COMPLETE_OBJECT, 2));
  writer.word(4);
  writer.word(5);
  writer.word(0);
  writer.word(1);
  writer.word(6);
  writer.word(7);
  writer.word(1);
  writer.word(-1);
  writer.word(1);
  writer.word(-1);
  assert.equal(reader.begin(1), true);
  assert.equal(reader.kind, COMPLETE_OBJECT);
  assert.equal(reader.refCount, 2);
  reader.scan();
  assert.deepEqual(reader.deps, [4, 5, 0, 6, 7]);
});

test('doubles and texts keep their value', () => {
  const { writer, reader } = store();
  writer.double(1.5);
  writer.text('abc');
  assert.equal(reader.doubleAt(0), 1.5);
  assert.equal(reader.textAt(2), 'abc');
  assert.equal(reader.begin(0), false);
});

test('doubles keep their bits, and texts their code units', () => {
  const { writer, reader } = store(64, 256);
  const doubles = [NaN, -0, Infinity, -Infinity, 5e-324, 2.2250738585072014e-308, 2 ** 53 + 1, 0.1];
  for (const value of doubles) writer.double(value);
  for (let i = 0; i < doubles.length; i++) {
    const read = reader.doubleAt(2 * i);
    assert.ok(
      Object.is(read, doubles[i]) || (Number.isNaN(doubles[i]) && Number.isNaN(read)),
      `${doubles[i]} reads back as ${read}`,
    );
  }
  const texts = ['', '9007199254740993', '\uD800', '\uDC00x'];
  for (const text of texts) {
    const at = writer.at;
    writer.text(text);
    assert.equal(reader.textAt(at), text);
  }
});

test('ref lists of 0, 1, 65534, 65535 and 70000 refs keep their count and their refs', () => {
  const counts = [0, 1, 0xffff - 1, 0xffff, 70000];
  const { writer, reader } = store(4 * 70000, 8, counts.length);
  counts.forEach((count, index) => {
    writer.beginRecord(index, header(UNION, count));
    if (count >= REF_ESCAPE) writer.word(count);
    for (let ref = 0; ref < count; ref++) writer.word(ref);
    // The object flags, then the origin: a union has no origin record here.
    writer.word(0);
    writer.word(-1);
    assert.equal(reader.begin(index), true);
    assert.equal(reader.refCount, count);
    reader.scan();
    const deps = reader.deps;
    assert.equal(deps.length, count + 1);
    for (let ref = 0; ref < count; ref += 5000) assert.equal(deps[ref], ref);
    if (count > 0) assert.equal(deps[count - 1], count - 1);
  });
});

test('a field that does not fit the end of its log is counted, and nothing is written past it', () => {
  const numbers = new Int32Array(3);
  const writer = new StoreWriter(numbers, new Uint16Array(2), new Int32Array(2), new Map());
  writer.double(1.5);
  assert.equal(writer.full, false);
  writer.double(2.5);
  assert.equal(writer.full, true);
  assert.equal(writer.at, 4);
  const reader = new RecordReader(numbers, new Uint16Array(2), new Int32Array(2), [], new Map());
  assert.equal(reader.doubleAt(0), 1.5);
  const text = new StoreWriter(new Int32Array(4), new Uint16Array(2), new Int32Array(2), new Map());
  text.text('ab');
  assert.equal(text.full, false);
  text.text('c');
  assert.equal(text.full, true);
  assert.equal(text.unitAt, 2);
  assert.equal(text.at, 4);
  assert.equal(text.numbers[2], 0);
  assert.equal(text.numbers[3], 0);
  const records = new StoreWriter(new Int32Array(4), new Uint16Array(4), new Int32Array(2), new Map());
  records.beginRecord(0, header(UNION, 0));
  records.beginRecord(2, header(UNION, 0));
  assert.equal(records.full, true);
  assert.equal(records.table[0], 1);
  assert.equal(records.table[1], 0);
});

test('a store that runs out says so, and keeps its words', () => {
  const numbers = new Int32Array(2);
  const writer = new StoreWriter(numbers, new Uint16Array(2), new Int32Array(4), new Map());
  writer.word(1);
  writer.word(2);
  assert.equal(writer.full, false);
  writer.word(3);
  assert.equal(writer.full, true);
  assert.equal(writer.at, 3);
  const units = new StoreWriter(new Int32Array(8), new Uint16Array(2), new Int32Array(4), new Map());
  units.text('abc');
  assert.equal(units.full, true);
  assert.equal(units.unitAt, 0);
  assert.equal(units.at, 2);
  const records = new StoreWriter(new Int32Array(8), new Uint16Array(8), new Int32Array(1), new Map());
  records.beginRecord(0, 0);
  assert.equal(records.full, false);
  records.beginRecord(1, 0);
  assert.equal(records.full, true);
  writer.reset(0, 0);
  assert.equal(writer.full, false);
  assert.equal(writer.at, 0);
});

// An instantiation's record lists the return types of its signatures when they can be exported (optionalType); one
// that can't is left out, and the export goes on as it was.
test('an optional type that fails to export leaves the export as it was', () => {
  const { writer } = store();
  const exporter = new Exporter(undefined, new Map(), writer);
  const kept = { id: 1 };
  writer.beginRecord(0, 0);
  exporter.count = 1;
  exporter.indexes.set(kept.id, 0);
  exporter.addedTypes.push(kept.id);
  const failing = { id: 2 };
  exporter.type = (t) => {
    writer.beginRecord(exporter.base + exporter.count, 0);
    exporter.count++;
    exporter.addedTypes.push(t.id);
    exporter.indexes.set(t.id, exporter.count);
    return exporter.fail('no record kind');
  };
  assert.equal(exporter.optionalType(failing), -1);
  assert.equal(exporter.failure, undefined);
  assert.equal(exporter.count, 1);
  assert.equal(writer.at, 1);
  assert.equal(writer.unitAt, 0);
  assert.equal(exporter.indexes.has(failing.id), false);
  assert.equal(exporter.indexes.get(kept.id), 0);
});

test('an optional type does not clear an earlier failure of the export', () => {
  const { writer } = store();
  const exporter = new Exporter(undefined, new Map(), writer);
  exporter.fail('alias of the instantiation');
  writer.beginRecord(0, 0);
  assert.equal(exporter.optionalType({ id: 1 }), -1);
  assert.equal(exporter.failure, 'alias of the instantiation');
  assert.equal(exporter.count, 0);
  assert.equal(writer.at, 1);
});
