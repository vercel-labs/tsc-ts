// The type the last completed check of an expression produced, by node and check mode, for the
// expressions that are checked with no contextual type.
//
// The checker checks some expressions more than once with the same inputs: a body that the eager
// pass reached and the deferred pass reaches again, a node re-checked after a loop body, an
// argument of a second inference round. A check is a function of the node, the check mode and the
// checker's state, and the state only grows while the checker runs, so a check that completed
// earlier answers the next check of the same node: the later check would produce the type the
// earlier one produced, report the diagnostics it reported and defer the nodes it deferred.
//
// A contextual type is part of the inputs, so the record can only serve an expression whose check
// has none: the checker-contextual predicate says so before the record is consulted, and a check
// under a contextual type never reads or writes the record. For the same reason the record is not
// consulted while an inference context is in force: what the check infers into depends on it.
//
// The record is a direct-mapped table that stores the key beside the value, so a lookup that lands
// on another node reads the entry as a miss. Its size bounds the memory and the cache the lookups
// use: an entry is a node id, a mode and a type slot, the whole table takes about 200 KB, and 2^14
// entries serve nearly all repeats (2^14 against 2^20 loses 0.1% of the check on the largest
// program measured).

import type { Type } from './checker-types.js';

/** Entries in the record; a power of two. */
const EntryCount = 1 << 14;
const EntryMask = EntryCount - 1;

/** The types by entry; a slot holds the type of the check recorded at that entry. */
function newTypeSlots(): (Type | undefined)[] {
  const slots: (Type | undefined)[] = [];
  for (let i = 0; i < EntryCount; i++) slots.push(undefined);
  return slots;
}

function entryOf(nodeId: number, mode: number): number {
  return (Math.imul(nodeId, 0x9e3779b1) ^ mode) & EntryMask;
}

export class ExprCheckRecord {
  /** The node id of the check at each entry, plus one; zero where no check is recorded. */
  private readonly nodeIds = new Int32Array(EntryCount);
  private readonly modes = new Uint8Array(EntryCount);
  private readonly types = newTypeSlots();

  /** The type the last completed check of the node under `mode` produced, if the entry holds it. */
  get(nodeId: number, mode: number): Type | undefined {
    const entry = entryOf(nodeId, mode);
    if (this.nodeIds[entry] !== nodeId + 1 || this.modes[entry] !== mode) return undefined;
    return this.types[entry];
  }

  /** Records that a check of the node under `mode` produced `type`. */
  set(nodeId: number, mode: number, type: Type): void {
    const entry = entryOf(nodeId, mode);
    this.nodeIds[entry] = nodeId + 1;
    this.modes[entry] = mode;
    this.types[entry] = type;
  }
}
