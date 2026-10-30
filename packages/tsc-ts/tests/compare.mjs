// Compares API responses from two servers. Type, symbol and signature ids and source file node ids are
// opaque, so ids in the expected responses are mapped to the actual ones. A symbol is named by its
// file's node id and its id there, or for a snapshot's symbol by its id alone.
import { isDeepStrictEqual } from 'node:util';

// The kind of object each method returns.
const results = {
  getSymbolAtPosition: 'symbol',
  getSymbolsAtPositions: 'symbol',
  getSymbolAtLocation: 'symbol',
  getSymbolsAtLocations: 'symbol',
  resolveName: 'symbol',
  getParentOfSymbol: 'symbol',
  getMembersOfSymbol: 'symbol',
  getExportsOfSymbol: 'symbol',
  getExportSymbolOfSymbol: 'symbol',
  getSymbolOfType: 'symbol',
  getAliasSymbolOfType: 'symbol',
  getParametersOfSignature: 'symbol',
  getThisParameterOfSignature: 'symbol',
  getShorthandAssignmentValueSymbol: 'symbol',
  getPropertiesOfType: 'symbol',
  getPropertyOfType: 'symbol',
  getExportSpecifierLocalTargetSymbol: 'symbol',
  getAliasedSymbol: 'symbol',
  getImmediateAliasedSymbol: 'symbol',
  getExportsOfModule: 'symbol',
  getMemberInModuleExports: 'symbol',
  getSignaturesOfType: 'signature',
  getResolvedSignature: 'signature',
  getTargetOfSignature: 'signature',
  getSignatureFromDeclaration: 'signature',
  getResolvedSignatures: 'signature',
  getSignaturesFromDeclarations: 'signature',
  getSignaturesOfTypes: 'signature',
  getIndexInfosOfType: 'indexInfo',
  getTypePredicateOfSignature: 'predicate',
  getWellKnownSymbols: 'wellKnown',
  getReferencedSymbolsForNode: 'referencedSymbols',
};

// Request fields that hold type ids.
const typeParams = ['type', 'source', 'target'];

// The key of a symbol a full reference names.
export function symbolKey(reference) {
  return reference.kind === 0 ? `f:${reference.file?.nodeId}:${reference.id}` : `s:${reference.id}`;
}

// The key of a symbol a compact reference names.
function compactKey(reference) {
  return reference.file === undefined ? `s:${reference.id}` : `f:${reference.file}:${reference.id}`;
}

function resultKind(method) {
  if (method in results) return results[method];
  if (/Type|Types|TypeArguments|TypeParameters/.test(method) && method.startsWith('get')) return 'type';
  return 'raw';
}

// The kind of object an `objectId` param names.
function objectKind(method) {
  return method.endsWith('OfSignature') ? 'signature' : 'type';
}

export class IdMap {
  constructor() {
    // Symbols by key, unique symbol names' embedded ids, and file node ids, besides type and signature ids.
    this.maps = { type: new Map(), symbol: new Map(), signature: new Map(), symbolName: new Map(), nodeId: new Map() };
    // The actual server's full reference for each expected symbol key, to send it back.
    this.references = new Map();
  }

  bind(kind, expected, actual, where) {
    if (expected === undefined && actual === undefined) return;
    const type = kind === 'symbol' || kind === 'nodeId' ? 'string' : 'number';
    if (typeof expected !== type || typeof actual !== type) {
      throw new Error(`${where}: ${kind} id ${expected} vs ${actual}`);
    }
    const map = this.maps[kind];
    const known = map.get(expected);
    if (known === undefined) map.set(expected, actual);
    else if (known !== actual) throw new Error(`${where}: ${kind} id ${expected} maps to ${known}, received ${actual}`);
  }

  // Binds two full symbol references: the same kind, file (but for its node id) or snapshot and project.
  bindReference(expected, actual, where) {
    if (expected === undefined && actual === undefined) return;
    if (expected === null || typeof expected !== 'object' || actual === null || typeof actual !== 'object') {
      throw new Error(`${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
    const { id, file, ...rest } = expected;
    const { id: actualId, file: actualFile, ...actualRest } = actual;
    if (!isDeepStrictEqual(rest, actualRest) || (file === undefined) !== (actualFile === undefined)) {
      throw new Error(`${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
    if (file !== undefined) {
      const { nodeId, ...fileRest } = file;
      const { nodeId: actualNodeId, ...actualFileRest } = actualFile;
      if (!isDeepStrictEqual(fileRest, actualFileRest)) {
        throw new Error(`${where}.file: expected ${JSON.stringify(file)}, received ${JSON.stringify(actualFile)}`);
      }
      this.bind('nodeId', nodeId, actualNodeId, `${where}.file.nodeId`);
    }
    walk(this, 'raw', typeof id, typeof actualId, `${where}.id`);
    this.bind('symbol', symbolKey(expected), symbolKey(actual), where);
    if (!this.references.has(symbolKey(expected))) this.references.set(symbolKey(expected), actual);
  }

  // Binds two compact symbol references, `{id, file?}`.
  bindCompact(expected, actual, where) {
    if (expected === undefined && actual === undefined) return;
    if (
      expected === null ||
      typeof expected !== 'object' ||
      actual === null ||
      typeof actual !== 'object' ||
      (expected.file === undefined) !== (actual.file === undefined)
    ) {
      throw new Error(`${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
    if (expected.file !== undefined) this.bind('nodeId', expected.file, actual.file, `${where}.file`);
    this.bind('symbol', compactKey(expected), compactKey(actual), where);
  }

  // The actual server's reference for an expected one; one never received is sent as it is.
  reference(expected) {
    if (expected === null || typeof expected !== 'object') return expected;
    return this.references.get(symbolKey(expected)) ?? expected;
  }

  // Rewrites the ids in request params from expected-server ids.
  translate(method, params) {
    if (params === null || typeof params !== 'object') return params;
    const out = { ...params };
    const map = (kind, id) => this.maps[kind].get(id) ?? id;
    for (const key of typeParams) if (typeof out[key] === 'number') out[key] = map('type', out[key]);
    if (Array.isArray(out.types)) out.types = out.types.map((id) => map('type', id));
    if (out.symbol !== undefined) out.symbol = this.reference(out.symbol);
    if (Array.isArray(out.symbols)) out.symbols = out.symbols.map((ref) => this.reference(ref));
    if (Array.isArray(out.actions)) {
      out.actions = out.actions.map((a) => (a?.symbol == null ? a : { ...a, symbol: this.reference(a.symbol) }));
    }
    if (typeof out.signature === 'number') out.signature = map('signature', out.signature);
    if (Array.isArray(out.signatures)) out.signatures = out.signatures.map((id) => map('signature', id));
    if (typeof out.objectId === 'number') out.objectId = map(objectKind(method), out.objectId);
    // A source file descriptor (retainSourceFile) names the file by the server's node id.
    if (out.file !== null && typeof out.file === 'object' && typeof out.file.nodeId === 'string') {
      out.file = { ...out.file, nodeId: map('nodeId', out.file.nodeId) };
    }
    return out;
  }

  // Throws if actual differs from expected beyond id numbering.
  compare(method, expected, actual) {
    if (method === 'getCompletionsAtPosition') compareCompletions(this, expected, actual, method);
    else walk(this, resultKind(method), expected, actual, method);
  }
}

const typeIdFields = [
  'target',
  'objectType',
  'indexType',
  'checkType',
  'extendsType',
  'baseType',
  'substConstraint',
  'freshType',
  'regularType',
  'typeParameter',
  'constraintType',
  'nameType',
  'templateType',
  'thisType',
];
const typeIdListFields = ['typeParameters', 'outerTypeParameters', 'localTypeParameters', 'aliasTypeArguments'];

function walk(ids, kind, expected, actual, where) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(`${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
    expected.forEach((e, i) => walk(ids, kind, e, actual[i], `${where}[${i}]`));
    return;
  }
  if (expected === null || typeof expected !== 'object' || kind === 'raw') {
    if (!isDeepStrictEqual(expected, actual)) {
      throw new Error(`${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (actual === null || typeof actual !== 'object') {
    throw new Error(`${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
  const keys = Object.keys(expected).join(',');
  if (keys !== Object.keys(actual).join(',')) {
    throw new Error(`${where}: expected keys ${keys}, received ${Object.keys(actual).join(',')}`);
  }
  const rest = { ...expected };
  const restActual = { ...actual };
  const take = (field, k) => {
    if (k === 'compact') ids.bindCompact(expected[field], actual[field], `${where}.${field}`);
    else ids.bind(k, expected[field], actual[field], `${where}.${field}`);
    delete rest[field];
    delete restActual[field];
  };
  const takeList = (field, k) => {
    if (expected[field] === undefined) return;
    walk(ids, 'raw', expected[field].length, actual[field]?.length, `${where}.${field}.length`);
    expected[field].forEach((id, i) =>
      k === 'compact'
        ? ids.bindCompact(id, actual[field][i], `${where}.${field}[${i}]`)
        : ids.bind(k, id, actual[field][i], `${where}.${field}[${i}]`),
    );
    delete rest[field];
    delete restActual[field];
  };
  switch (kind) {
    case 'type':
      take('id', 'type');
      for (const f of typeIdFields) if (f in expected) take(f, 'type');
      for (const f of typeIdListFields) takeList(f, 'type');
      if ('aliasSymbol' in expected) take('aliasSymbol', 'compact');
      if ('symbol' in expected) take('symbol', 'compact');
      break;
    case 'symbol': {
      ids.bindReference(expected.reference, actual.reference, `${where}.reference`);
      delete rest.reference;
      delete restActual.reference;
      // Properties named by unique symbols embed the symbol's id: __@iterator@12.
      const named = /^(__@.*@)(\d+)$/;
      const [, prefix, id] = named.exec(expected.name) ?? [];
      const [, actualPrefix, actualId] = named.exec(actual.name) ?? [];
      if (prefix !== undefined && prefix === actualPrefix) {
        ids.bind('symbolName', Number(id), Number(actualId), `${where}.name`);
        delete rest.name;
        delete restActual.name;
      }
      if ('parent' in expected) take('parent', 'compact');
      if ('exportSymbol' in expected) take('exportSymbol', 'compact');
      break;
    }
    case 'signature':
      take('id', 'signature');
      takeList('typeParameters', 'type');
      takeList('parameters', 'compact');
      if ('thisParameter' in expected) take('thisParameter', 'compact');
      if ('target' in expected) take('target', 'signature');
      break;
    case 'indexInfo':
      walk(ids, 'type', expected.keyType, actual.keyType, `${where}.keyType`);
      walk(ids, 'type', expected.valueType, actual.valueType, `${where}.valueType`);
      delete rest.keyType;
      delete rest.valueType;
      delete restActual.keyType;
      delete restActual.valueType;
      break;
    case 'predicate':
      if (expected.type !== undefined) walk(ids, 'type', expected.type, actual.type, `${where}.type`);
      delete rest.type;
      delete restActual.type;
      break;
    case 'referencedSymbols':
      if (expected.symbol !== undefined) walk(ids, 'symbol', expected.symbol, actual.symbol, `${where}.symbol`);
      delete rest.symbol;
      delete restActual.symbol;
      break;
    case 'wellKnown':
      // Plain ids of the snapshot's symbols.
      for (const field of ['unknown', 'undefined', 'arguments']) {
        ids.bindCompact({ id: expected[field] }, { id: actual[field] }, `${where}.${field}`);
        delete rest[field];
        delete restActual[field];
      }
      break;
  }
  if (!isDeepStrictEqual(rest, restActual)) {
    throw new Error(`${where}: expected ${JSON.stringify(rest)}, received ${JSON.stringify(restActual)}`);
  }
}

// Completion entries come in symbol table order, which tsgo doesn't fix; editors sort them
// by sortText and name anyway.
function compareCompletions(ids, expected, actual, where) {
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') {
    walk(ids, 'raw', expected, actual, where);
    return;
  }
  walk(ids, 'raw', expected.isIncomplete, actual.isIncomplete, `${where}.isIncomplete`);
  const key = (e) => [e.sortText ?? '', e.name, e.kind ?? 0, e.insertText ?? '', e.filterText ?? ''].join('\u0000');
  const sorted = (entries) => [...(entries ?? [])].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  const e = sorted(expected.entries);
  const a = sorted(actual.entries);
  if (e.length !== a.length) {
    const names = (list) => list.map((x) => x.name).join(',');
    throw new Error(`${where}: expected ${names(e)}, received ${names(a)}`);
  }
  e.forEach((entry, i) => {
    const { symbol, ...rest } = entry;
    const { symbol: actualSymbol, ...actualRest } = a[i];
    walk(ids, 'raw', rest, actualRest, `${where}.entries[${i}]`);
    if (symbol !== undefined || actualSymbol !== undefined)
      walk(ids, 'symbol', symbol, actualSymbol, `${where}.entries[${i}].symbol`);
  });
}

// Source file encodings must match except for the source file and lease ids (bytes 44-59), which are each
// server's own.
export function compareSourceFile(expected, actual, where) {
  if (expected.length !== actual.length) throw new Error(`${where}: ${expected.length} bytes vs ${actual.length}`);
  for (let i = 0; i < expected.length; i++) {
    if (i >= 44 && i < 60) continue;
    if (expected[i] !== actual[i]) throw new Error(`${where}: bytes differ at offset ${i}`);
  }
}
