// scripts/check-int32-fields.mjs, the native build's check that Node, Type and Symbol keep 32-bit number fields.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInt32Fields } from '../scripts/check-int32-fields.mjs';

const node =
  '%sc_o__x25_m32_Node = type { i32, i32, i32, i32, i32, i32, i32 } ; class %m32.Node (32-bit header) { kind; flags; pos; end; id; parent }';
const type =
  '%sc_o__x25_m43_Type = type { i32, i32, i32, i32, ptr, i32, i32, i32 } ; class %m43.Type (32-bit header) { flags; objectFlags; id; alias; symbol; resolvedBaseConstraint; extra }';
const symbol =
  '%sc_o__x25_m39_Symbol = type { i32, i32, i32, i32, ptr, i32, i32, i32 } ; class %m39.Symbol (32-bit header) { flags; bits; id; name; declaration; parent; rareFields }';
const doubles =
  '%sc_o__x25_m32_Node = type { i32, i32, double, double, double, double, double, ptr } ; class %m32.Node (32-bit header) { parent; kind; flags; pos; end; id; %dynProperties }';

test('the int32 field check accepts 32-bit number fields', async () => {
  assert.deepEqual(await checkInt32Fields([node, type, symbol]), []);
});

test('the int32 field check reports double fields and missing classes', async () => {
  const problems = await checkInt32Fields([doubles, type]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^class Node stores number fields as doubles/);
  assert.equal(problems[1], 'no struct type for class Symbol');
});

test('the int32 field check reads only class struct types', async () => {
  const other = '%sc_o__x25_m32_NodeList = type { i32, double } ; class %m32.NodeList (32-bit header) { pos; nodes }';
  assert.deepEqual(await checkInt32Fields([other, node, type, symbol]), []);
});
