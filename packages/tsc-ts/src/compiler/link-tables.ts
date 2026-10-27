// Side tables of checker links, indexed by node or symbol id.
//
// The checker caches values per node and per symbol. A cached value that many nodes or symbols
// have lives in a table of its own (a column) instead of a field of a links object, so a node or
// symbol costs a slot in each column it uses rather than a whole object, and a lookup is two
// array reads. Columns are stored in pages of `LinkPaging.Size` ids created on first write: a
// checker that touches part of a program (as each of several parallel checkers does) stores only
// the pages it touches.

/** Links are stored in pages of 256 ids. */
export const enum LinkPaging {
  Bits = 8,
  Size = 1 << Bits,
  Mask = Size - 1,
}

/** A page of values, indexed by the low bits of an id; undefined until a value in it is stored. */
export type LinkPage<T> = (T | undefined)[] | undefined;

/** Values by id; undefined where none is stored. */
export class LinkTable<T> {
  readonly pages: LinkPage<T>[] = [];

  get(id: number): T | undefined {
    const page = this.pages[id >> LinkPaging.Bits];
    return page !== undefined ? page[id & LinkPaging.Mask] : undefined;
  }

  set(id: number, value: T | undefined): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pages[index];
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== undefined) newLinkPage(this.pages, index)[id & LinkPaging.Mask] = value;
  }

  clear(): void {
    this.pages.length = 0;
  }
}

/** Creates the page at `index`, filling the gap below it so the page list stays dense. */
export function newLinkPage<T>(pages: LinkPage<T>[], index: number): (T | undefined)[] {
  while (pages.length <= index) pages.push(undefined);
  const page: (T | undefined)[] = [];
  for (let i = 0; i < LinkPaging.Size; i++) page.push(undefined);
  pages[index] = page;
  return page;
}

/** Int32 values by id, zero where none is stored: flags and small counters. */
export class IntLinkTable {
  readonly pages: (Int32Array | undefined)[] = [];

  get(id: number): number {
    const page = this.pages[id >> LinkPaging.Bits];
    return page !== undefined ? page[id & LinkPaging.Mask]! : 0;
  }

  set(id: number, value: number): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pages[index];
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== 0) this.newPage(index)[id & LinkPaging.Mask] = value;
  }

  private newPage(index: number): Int32Array {
    while (this.pages.length <= index) this.pages.push(undefined);
    const page = new Int32Array(LinkPaging.Size);
    this.pages[index] = page;
    return page;
  }

  clear(): void {
    this.pages.length = 0;
  }
}

/**
 * Values by id in a map, for ids that are sparse: a checker caches values for a small part of the
 * nodes of a program, spread over the declaration files it reads, where a page would mostly hold
 * empty slots.
 */
export class SparseLinkTable<T> {
  readonly values = new Map<number, T>();

  get(id: number): T | undefined {
    return this.values.get(id);
  }

  set(id: number, value: T | undefined): void {
    if (value !== undefined) this.values.set(id, value);
    else this.values.delete(id);
  }

  clear(): void {
    this.values.clear();
  }
}

/**
 * Values by id for ids in a few clusters, as one file's emit uses them: the file's nodes and the
 * nodes the emit synthesizes, far above them. Pages of `LinkPaging.Size` ids are found through a
 * map from the page index, so the ids between clusters cost nothing, and the page of the last
 * lookup is kept, since lookups come in runs of nearby ids.
 */
export class ClusteredLinkTable<T> {
  private readonly pages = new Map<number, (T | undefined)[]>();
  private lastIndex = -1;
  private lastPage: (T | undefined)[] | undefined = undefined;

  get(id: number): T | undefined {
    const page = this.pageOf(id >> LinkPaging.Bits);
    return page !== undefined ? page[id & LinkPaging.Mask] : undefined;
  }

  set(id: number, value: T | undefined): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pageOf(index);
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== undefined) {
      const created: (T | undefined)[] = [];
      for (let i = 0; i < LinkPaging.Size; i++) created.push(undefined);
      created[id & LinkPaging.Mask] = value;
      this.pages.set(index, created);
      this.lastPage = created;
    }
  }

  private pageOf(index: number): (T | undefined)[] | undefined {
    if (index !== this.lastIndex) {
      this.lastIndex = index;
      this.lastPage = this.pages.get(index);
    }
    return this.lastPage;
  }
}

/** Int32 values by id, zero where none is stored, for ids in a few clusters (`ClusteredLinkTable`). */
export class ClusteredIntLinkTable {
  private readonly pages = new Map<number, Int32Array>();
  private lastIndex = -1;
  private lastPage: Int32Array | undefined = undefined;

  get(id: number): number {
    const page = this.pageOf(id >> LinkPaging.Bits);
    return page !== undefined ? page[id & LinkPaging.Mask]! : 0;
  }

  set(id: number, value: number): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pageOf(index);
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== 0) {
      const created = new Int32Array(LinkPaging.Size);
      created[id & LinkPaging.Mask] = value;
      this.pages.set(index, created);
      this.lastPage = created;
    }
  }

  private pageOf(index: number): Int32Array | undefined {
    if (index !== this.lastIndex) {
      this.lastIndex = index;
      this.lastPage = this.pages.get(index);
    }
    return this.lastPage;
  }
}

/** Ids in pages of `IdSetPaging.Ids` ids, one bit each; a page is created by the first id added to it. */
export class PagedIdSet {
  readonly pages: (Int32Array | undefined)[] = [];

  has(id: number): boolean {
    const page = this.pages[id >> IdSetPaging.Bits];
    return page !== undefined && (page[(id >> 5) & IdSetPaging.WordMask]! & (1 << (id & 31))) !== 0;
  }

  add(id: number): void {
    const index = id >> IdSetPaging.Bits;
    let page = this.pages[index];
    if (page === undefined) {
      while (this.pages.length <= index) this.pages.push(undefined);
      page = new Int32Array(IdSetPaging.Words);
      this.pages[index] = page;
    }
    page[(id >> 5) & IdSetPaging.WordMask] |= 1 << (id & 31);
  }

  clear(): void {
    this.pages.length = 0;
  }
}

/** `PagedIdSet` pages: 8192 ids in 256 words. */
const enum IdSetPaging {
  Bits = 13,
  Words = 1 << (Bits - 5),
  WordMask = Words - 1,
}

/** The number of set bits of a 32-bit value. */
function bitCount(x: number): number {
  x = (x - ((x >>> 1) & 0x55555555)) | 0;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  // At most 32, so the top byte is the count with either shift; `>>` keeps it an int32.
  return Math.imul(x, 0x01010101) >> 24;
}

/**
 * A page of a `CompactLinkTable`'s presence bits: one bit per id of the page in eight 32-id words, and
 * the number of values stored before each word. The words are fields, so a lookup reads one object
 * before the values. Natively the words are 32-bit fields, since every write stores an int32. A class
 * that is generic or has a generic subclass keeps its number fields as doubles, so the values the
 * bits index are in the table's `values`, not in this class or a subclass.
 */
class CompactLinkPage {
  private w0: number;
  private w1: number;
  private w2: number;
  private w3: number;
  private w4: number;
  private w5: number;
  private w6: number;
  private w7: number;
  /** Byte `w & 3` of `before0` (words 1 to 3) or of `before1` (words 4 to 7): the values before word `w`. */
  private before0: number;
  private before1: number;

  constructor() {
    this.w0 = 0;
    this.w1 = 0;
    this.w2 = 0;
    this.w3 = 0;
    this.w4 = 0;
    this.w5 = 0;
    this.w6 = 0;
    this.w7 = 0;
    this.before0 = 0;
    this.before1 = 0;
  }

  /** The presence bits of ids `32 * word` to `32 * word + 31`. */
  word(word: number): number {
    switch (word) {
      case 0:
        return this.w0;
      case 1:
        return this.w1;
      case 2:
        return this.w2;
      case 3:
        return this.w3;
      case 4:
        return this.w4;
      case 5:
        return this.w5;
      case 6:
        return this.w6;
      default:
        return this.w7;
    }
  }

  setWord(word: number, bits: number): void {
    switch (word) {
      case 0:
        this.w0 = bits | 0;
        break;
      case 1:
        this.w1 = bits | 0;
        break;
      case 2:
        this.w2 = bits | 0;
        break;
      case 3:
        this.w3 = bits | 0;
        break;
      case 4:
        this.w4 = bits | 0;
        break;
      case 5:
        this.w5 = bits | 0;
        break;
      case 6:
        this.w6 = bits | 0;
        break;
      default:
        this.w7 = bits | 0;
    }
  }

  /** The index in `values` of the value of `slot` (an id's low bits), or of where it goes. */
  rank(slot: number, bits: number): number {
    const word = slot >> 5;
    const before = ((word < 4 ? this.before0 : this.before1) >>> ((word & 3) << 3)) & 0xff;
    return (before + bitCount(bits & ((1 << (slot & 31)) - 1))) | 0;
  }

  /**
   * Adds 1 (`delta` 1) or subtracts 1 (`delta` -1) from the counts of the words after `word`, a byte
   * of `before0` or `before1` each. No byte carries or borrows: a count is at most 224, and a count
   * that goes down includes the value removed.
   */
  shiftCounts(word: number, delta: number): void {
    // A 1 in each byte of the words after `word`: shifting `0x01010100` left by `word` bytes keeps
    // the bytes above it, and shifts them all out at word 3.
    const low = word < 4 ? 0x01010100 << (word << 3) : 0;
    const high = word < 4 ? 0x01010101 : 0x01010100 << ((word & 3) << 3);
    this.before0 = (this.before0 + Math.imul(low, delta)) | 0;
    this.before1 = (this.before1 + Math.imul(high, delta)) | 0;
  }
}

/**
 * Values by node id, for ids a checker stores a value for in more than about one in sixteen of the
 * ids of the pages it touches: the symbols it resolves for the identifiers and names of the files it
 * checks (one in four to one in eight), and the types and signatures it resolves for their type
 * nodes and calls (one in twelve to one in seventeen). Pages of `LinkPaging.Size` ids keep a presence
 * bit per id and only the values stored, so a value costs about one array slot. A `LinkTable` page
 * costs a slot for every id, and a `Map` entry also stores its key and a share of the hash buckets.
 * At fewer values per page than that, the page's own allocations outweigh what it saves, and a
 * `SparseLinkTable` costs less.
 */
export class CompactLinkTable<T> {
  readonly pages: (CompactLinkPage | undefined)[] = [];
  /** The values stored in each page, in id order. */
  readonly values: (T[] | undefined)[] = [];
  /** The number of values stored. */
  size = 0;

  get(id: number): T | undefined {
    const index = id >> LinkPaging.Bits;
    const page = this.pages[index];
    if (page === undefined) return undefined;
    const slot = id & LinkPaging.Mask;
    const bits = page.word(slot >> 5);
    if ((bits & (1 << (slot & 31))) === 0) return undefined;
    return this.values[index]![page.rank(slot, bits)];
  }

  set(id: number, value: T | undefined): void {
    const index = id >> LinkPaging.Bits;
    let page = this.pages[index];
    if (page === undefined) {
      if (value === undefined) return;
      while (this.pages.length <= index) {
        this.pages.push(undefined);
        this.values.push(undefined);
      }
      page = new CompactLinkPage();
      this.pages[index] = page;
      this.values[index] = [];
    }
    const values = this.values[index]!;
    const slot = id & LinkPaging.Mask;
    const word = slot >> 5;
    const bit = 1 << (slot & 31);
    const bits = page.word(word);
    const at = page.rank(slot, bits);
    if ((bits & bit) !== 0) {
      if (value !== undefined) {
        values[at] = value;
        return;
      }
      if (at === values.length - 1) values.pop();
      else values.splice(at, 1);
      page.setWord(word, bits & ~bit);
      page.shiftCounts(word, -1);
      this.size--;
      return;
    }
    if (value === undefined) return;
    // Values are mostly stored in id order, at the end.
    if (at === values.length) values.push(value);
    else values.splice(at, 0, value);
    page.setWord(word, bits | bit);
    page.shiftCounts(word, 1);
    this.size++;
  }

  clear(): void {
    this.pages.length = 0;
    this.values.length = 0;
    this.size = 0;
  }
}
