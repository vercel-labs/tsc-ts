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
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/**
 * The presence bits of a `CompactLinkPage`: one bit per id of the page in eight 32-id words, and the
 * number of values stored before each word. The words are fields, so a lookup reads one object before
 * the values. The class isn't generic, so natively the words are 32-bit fields: every write stores an
 * int32.
 */
class CompactLinkWords {
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
    return before + bitCount(bits & ((1 << (slot & 31)) - 1));
  }

  /** Adds `delta` to the counts of the words after `word`. */
  shiftCounts(word: number, delta: number): void {
    for (let w = word + 1; w < 8; w++) {
      const step = delta << ((w & 3) << 3);
      if (w < 4) this.before0 = (this.before0 + step) | 0;
      else this.before1 = (this.before1 + step) | 0;
    }
  }
}

/** A page of a `CompactLinkTable`: its presence bits and the values stored, in id order. */
class CompactLinkPage<T> extends CompactLinkWords {
  readonly values: T[] = [];
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
  readonly pages: (CompactLinkPage<T> | undefined)[] = [];
  /** The number of values stored. */
  size = 0;

  get(id: number): T | undefined {
    const page = this.pages[id >> LinkPaging.Bits];
    if (page === undefined) return undefined;
    const slot = id & LinkPaging.Mask;
    const bits = page.word(slot >> 5);
    if ((bits & (1 << (slot & 31))) === 0) return undefined;
    return page.values[page.rank(slot, bits)];
  }

  set(id: number, value: T | undefined): void {
    const index = id >> LinkPaging.Bits;
    let page = this.pages[index];
    if (page === undefined) {
      if (value === undefined) return;
      while (this.pages.length <= index) this.pages.push(undefined);
      page = new CompactLinkPage<T>();
      this.pages[index] = page;
    }
    const slot = id & LinkPaging.Mask;
    const word = slot >> 5;
    const bit = 1 << (slot & 31);
    const bits = page.word(word);
    const at = page.rank(slot, bits);
    const values = page.values;
    if ((bits & bit) !== 0) {
      if (value !== undefined) {
        values[at] = value;
        return;
      }
      for (let i = at; i < values.length - 1; i++) values[i] = values[i + 1]!;
      values.pop();
      page.setWord(word, bits & ~bit);
      page.shiftCounts(word, -1);
      this.size--;
      return;
    }
    if (value === undefined) return;
    values.push(value);
    for (let i = values.length - 1; i > at; i--) values[i] = values[i - 1]!;
    values[at] = value;
    page.setWord(word, bits | bit);
    page.shiftCounts(word, 1);
    this.size++;
  }

  clear(): void {
    this.pages.length = 0;
    this.size = 0;
  }
}
