import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-link-tables-', ['compiler/link-tables.ts']);
const { CompactLinkTable, PagedIdSet } = await import(pathToFileURL(join(out, 'compiler/link-tables.js')).href);

/** A pseudo-random sequence that is the same in every run. */
function random(seed) {
  return () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
}

test('CompactLinkTable stores, replaces and deletes values like a Map', () => {
  const next = random(7);
  for (const span of [64, 300, 5000, 100000]) {
    const table = new CompactLinkTable();
    const expected = new Map();
    for (let step = 0; step < 20000; step++) {
      const id = Math.floor(next() * span);
      const r = next();
      if (r < 0.6) {
        table.set(id, step);
        expected.set(id, step);
      } else if (r < 0.8) {
        table.set(id, undefined);
        expected.delete(id);
      } else assert.equal(table.get(id), expected.get(id), `span ${span}, step ${step}, id ${id}`);
    }
    assert.equal(table.size, expected.size);
    for (let id = 0; id < Math.min(span, 20000); id++) assert.equal(table.get(id), expected.get(id), `id ${id}`);
    table.clear();
    assert.equal(table.size, 0);
    assert.equal(table.get(0), undefined);
  }
});

test('CompactLinkTable keeps the values of every id of a full page', () => {
  const table = new CompactLinkTable();
  for (let id = 511; id >= 256; id--) table.set(id, id * 2);
  for (let id = 256; id < 512; id++) assert.equal(table.get(id), id * 2);
  for (let id = 256; id < 512; id += 2) table.set(id, undefined);
  for (let id = 256; id < 512; id++) assert.equal(table.get(id), id % 2 === 0 ? undefined : id * 2);
  assert.equal(table.size, 128);
  assert.equal(table.get(0), undefined);
  assert.equal(table.get(1 << 20), undefined);
});

test('PagedIdSet has the ids added to it', () => {
  const next = random(11);
  const set = new PagedIdSet();
  const expected = new Set();
  // Ids in a few pages, at page and word edges, and scattered up to 2^28.
  const ids = [0, 31, 32, 8191, 8192, 8193, 65535, 65536];
  for (let i = 0; i < 3000; i++) ids.push(Math.floor(next() * 40000), Math.floor(next() * (1 << 28)));
  for (const id of ids) {
    set.add(id);
    expected.add(id);
  }
  for (const id of ids) assert.equal(set.has(id), true, `id ${id}`);
  for (let i = 0; i < 20000; i++) {
    const id = Math.floor(next() * (i % 2 === 0 ? 40000 : 1 << 28));
    assert.equal(set.has(id), expected.has(id), `id ${id}`);
  }
  set.clear();
  for (const id of ids) assert.equal(set.has(id), false, `id ${id} after clear`);
});
