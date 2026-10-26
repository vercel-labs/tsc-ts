// Drives the reference `tsc --api` and `tsc-ts --api` with the same requests
// and checks that their responses agree.
import { Client, snapshotRequest } from './client.mjs';
import { compareSourceFile, IdMap, symbolKey } from './compare.mjs';

export class Differential {
  constructor(expectedCommand, actualCommand, cwd, actualEnv) {
    this.expected = new Client(expectedCommand, cwd);
    this.actual = new Client(actualCommand, cwd, actualEnv);
    this.ids = new IdMap();
    this.count = 0;
    this.skipped = 0;
    this.failures = [];
    // The snapshot `snapshot` makes the next one from.
    this.latestSnapshot = undefined;
    // Encoded source files by path, to name nodes.
    this.files = new Map();
  }

  // Sends a request (params use the reference server's ids) to both servers,
  // records any difference, and returns the reference response (or undefined
  // for an error). A pair of replies that `skip` accepts is not compared.
  async call(method, params, { skip } = {}) {
    const [a, b] = await Promise.all([
      this.expected.request(method, params),
      this.actual.request(method, this.ids.translate(method, params)),
    ]);
    this.count++;
    const where = `${method} ${JSON.stringify(params)}`;
    if (skip?.(a, b) === true) {
      this.skipped++;
      return undefined;
    }
    try {
      if (a.type !== b.type) throw new Error(`${a.type} vs ${b.type}: ${a.payload} | ${b.payload}`);
      if (a.type === 'error') {
        // Panic messages carry Go stack traces; only the API's own errors must match.
        const text = a.payload.toString();
        if (!text.startsWith('panic:') && text !== b.payload.toString()) {
          throw new Error(`error ${text} vs ${b.payload}`);
        }
        return undefined;
      }
      if (isBinary(method)) {
        compareSourceFile(a.payload, b.payload, where);
        if (method === 'getSourceFile') this.files.set(params.file, a.payload);
        return a.payload;
      }
      const expected = JSON.parse(a.payload.toString());
      const actual = JSON.parse(b.payload.toString());
      // After invalidateAll, tsc lists the files a config's patterns match in no fixed order.
      if (params?.changes?.fileNotifications?.invalidateAll === true) {
        for (const reply of [expected, actual]) {
          for (const project of reply.projects ?? []) project.parsedCommandLine?.fileNames?.sort();
        }
      }
      if (returnsNodes(method)) {
        this.ids.compare(method, this.canonicalNodes(expected), this.canonicalNodes(actual));
      } else {
        this.ids.compare(method, expected, actual);
      }
      return expected;
    } catch (e) {
      this.failures.push(`${where.slice(0, 300)}\n  ${e.message.slice(0, 1000)}`);
      return a.type === 'error' ? undefined : isBinary(method) ? a.payload : JSON.parse(a.payload.toString());
    }
  }

  // Makes a snapshot from the latest one with `changes` (see snapshotRequest) on both servers.
  async snapshot(changes, options) {
    const reply = await this.call(...snapshotRequest(this.latestSnapshot, changes, options));
    if (reply !== undefined) this.latestSnapshot = reply.snapshot;
    return reply;
  }

  async close() {
    await Promise.all([this.expected.close(), this.actual.close()]);
  }

  // JSDoc reparsing in JavaScript files shares nodes between a JSDoc comment and the
  // declaration made from it, so they appear twice in the node table, and tsc names
  // them by either index. Such handles are compared by the first index.
  canonicalNodes(value) {
    if (typeof value === 'string') return this.canonicalNode(value);
    if (Array.isArray(value)) return value.map((v) => this.canonicalNodes(v));
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = k === 'symbol' ? v : this.canonicalNodes(v);
      return out;
    }
    return value;
  }

  canonicalNode(handle) {
    const match = /^(\d+)\.(\d+)\.(.*)$/.exec(handle);
    const encoded = match && this.files.get(match[3]);
    if (!encoded) return handle;
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const nodes = view.getUint32(40, true);
    const record = (i) => nodes + i * 28;
    const index = Number(match[1]);
    if (record(index + 1) > encoded.length) return handle;
    const at = record(index);
    if ((view.getUint32(at + 24, true) & NodeFlags.JSDoc) === 0) return handle;
    const kind = view.getUint32(at, true);
    const pos = view.getUint32(at + 4, true);
    const end = view.getUint32(at + 8, true);
    for (let i = 1; i < index; i++) {
      const other = record(i);
      if (
        view.getUint32(other, true) === kind &&
        view.getUint32(other + 4, true) === pos &&
        view.getUint32(other + 8, true) === end &&
        (view.getUint32(other + 24, true) & NodeFlags.JSDoc) !== 0
      )
        return `${i}.${kind}.${match[3]}`;
    }
    return handle;
  }
}

function returnsNodes(method) {
  return (
    method === 'getReferencesToSymbolInFile' ||
    method === 'getReferencedSymbolsForNode' ||
    method === 'getSignatureUsages'
  );
}

const NodeFlags = { JSDoc: 1 << 22 };

function isBinary(method) {
  return method === 'getSourceFile' || method === 'typeToTypeNode' || method === 'signatureToSignatureDeclaration';
}

const TypeFlags = {
  Freshable: 80896,
  Object: 1048576,
  Union: 134217728,
  UnionOrIntersection: 402653184,
  Index: 2097152,
  IndexedAccess: 33554432,
  Conditional: 67108864,
  Substitution: 16777216,
  TemplateLiteral: 4194304,
  StringMapping: 8388608,
  TypeParameter: 524288,
};
const ObjectFlags = { ClassOrInterface: 3, Reference: 4 };
const SymbolFlags = { Alias: 2097152, Module: 1536 };
// TypeScript 7.1's syntax kinds.
const Kind = {
  FirstTypeNode: 184,
  LastTypeNode: 207,
  CallExpression: 215,
  NewExpression: 216,
  TaggedTemplate: 217,
  SourceFile: 308,
  NodeList: 0xffffffff,
};

// The handles of the nodes in an encoded source file: `index.kind.path`.
export function nodeHandles(encoded, path) {
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const nodes = view.getUint32(40, true);
  const handles = [];
  for (let i = 1; nodes + (i + 1) * 28 <= encoded.length; i++) {
    const kind = view.getUint32(nodes + i * 28, true);
    if (kind !== Kind.NodeList) handles.push(`${i}.${kind}.${path}`);
  }
  return handles;
}

// Explores the checker from the symbols at every position of the given files,
// calling the query methods on each symbol, type, signature and node found.
export async function explore(d, snapshot, project, files, limit) {
  const base = { snapshot, project };
  const seen = new Set();
  const queue = [];
  const add = (kind, value) => {
    if (value === null || value === undefined) return;
    const id = kind === 'symbol' ? symbolKey(value.reference) : typeof value === 'object' ? value.id : value;
    const key = `${kind}:${id}`;
    if (seen.has(key) || seen.size >= limit) return;
    seen.add(key);
    queue.push([kind, value]);
  };
  const addAll = (kind, values) => {
    for (const v of values ?? []) add(kind, v);
  };

  for (const { file, length, encoded } of files) {
    for (const handle of nodeHandles(encoded, file)) add('node', handle);
    const positions = Array.from({ length }, (_, i) => i);
    addAll('symbol', await d.call('getSymbolsAtPositions', { ...base, file, positions }));
    addAll(
      'type',
      await d.call('getTypesAtPositions', { ...base, file, positions: positions.filter((p) => p % 3 === 0) }),
    );
  }

  while (queue.length > 0) {
    const [kind, value] = queue.shift();
    switch (kind) {
      case 'symbol': {
        const symbol = value.reference;
        add('type', await d.call('getTypeOfSymbol', { ...base, symbol }));
        add('type', await d.call('getDeclaredTypeOfSymbol', { ...base, symbol }));
        addAll('type', await d.call('getTypesOfSymbols', { ...base, symbols: [symbol] }));
        add('symbol', await d.call('getParentOfSymbol', { symbol }));
        add('symbol', await d.call('getExportSymbolOfSymbol', { symbol }));
        addAll('symbol', await d.call('getMembersOfSymbol', { symbol }));
        addAll('symbol', await d.call('getExportsOfSymbol', { symbol }));
        if (value.flags & SymbolFlags.Alias) {
          add('symbol', await d.call('getAliasedSymbol', { ...base, symbol }));
          add('symbol', await d.call('getImmediateAliasedSymbol', { ...base, symbol }));
        }
        if (value.flags & SymbolFlags.Module) {
          addAll('symbol', await d.call('getExportsOfModule', { ...base, symbol }));
          add('symbol', await d.call('getMemberInModuleExports', { ...base, symbol, name: 'Color' }));
        }
        for (const location of value.declarations ?? []) {
          add('node', location);
          add('type', await d.call('getTypeOfSymbolAtLocation', { ...base, symbol, location }));
        }
        break;
      }
      case 'node': {
        const location = value;
        const nodeKind = Number(location.split('.')[1]);
        add('type', await d.call('getTypeAtLocation', { ...base, location }));
        if (nodeKind >= Kind.FirstTypeNode && nodeKind <= Kind.LastTypeNode) {
          add('type', await d.call('getTypeFromTypeNode', { ...base, location }));
        }
        if (nodeKind === Kind.CallExpression || nodeKind === Kind.NewExpression || nodeKind === Kind.TaggedTemplate) {
          add('signature', await d.call('getResolvedSignature', { ...base, location }));
        }
        add('symbol', await d.call('getSymbolAtLocation', { ...base, location }));
        add('signature', await d.call('getSignatureFromDeclaration', { ...base, location }));
        add('type', await d.call('getContextualType', { ...base, location }));
        await d.call('isContextSensitive', { ...base, location });
        await d.call('getConstantValue', { ...base, location });
        add('symbol', await d.call('getShorthandAssignmentValueSymbol', { ...base, location }));
        add('symbol', await d.call('getExportSpecifierLocalTargetSymbol', { ...base, location }));
        break;
      }
      case 'type': {
        const type = value.id;
        const flags = value.flags;
        const objectFlags = value.objectFlags;
        addAll('symbol', await d.call('getPropertiesOfType', { ...base, type }));
        addAll('signature', await d.call('getSignaturesOfType', { ...base, type, kind: 0 }));
        addAll('signature', await d.call('getSignaturesOfType', { ...base, type, kind: 1 }));
        for (const info of (await d.call('getIndexInfosOfType', { ...base, type })) ?? []) {
          add('type', info.keyType);
          add('type', info.valueType);
        }
        await d.call('isArrayType', { ...base, type });
        await d.call('isArrayLikeType', { ...base, type });
        await d.call('typeToString', { ...base, type });
        await d.call('typeToTypeNode', { ...base, type });
        add('type', await d.call('getApparentType', { ...base, objectId: type }));
        add('type', await d.call('getNonNullableType', { ...base, objectId: type }));
        add('type', await d.call('getWidenedType', { ...base, type }));
        add('type', await d.call('getBaseTypeOfLiteralType', { ...base, type }));
        add('type', await d.call('getBaseConstraintOfType', { ...base, type }));
        add('symbol', await d.call('getSymbolOfType', { ...base, objectId: type }));
        add('symbol', await d.call('getAliasSymbolOfType', { ...base, objectId: type }));
        addAll('type', await d.call('getAliasTypeArgumentsOfType', { ...base, objectId: type }));
        await d.call('getPropertyOfType', { ...base, type, name: 'x' });
        if (flags & TypeFlags.Freshable) {
          add('type', await d.call('getFreshTypeOfType', { ...base, objectId: type }));
          add('type', await d.call('getRegularTypeOfType', { ...base, objectId: type }));
        }
        if (flags & (TypeFlags.UnionOrIntersection | TypeFlags.TemplateLiteral)) {
          addAll('type', await d.call('getTypesOfType', { ...base, objectId: type }));
        }
        if (flags & TypeFlags.Object && objectFlags & ObjectFlags.Reference) {
          add('type', await d.call('getTargetOfType', { ...base, objectId: type }));
          addAll('type', await d.call('getTypeArguments', { ...base, type }));
        }
        if (flags & TypeFlags.Object && objectFlags & ObjectFlags.ClassOrInterface) {
          addAll('type', await d.call('getBaseTypes', { ...base, type }));
          addAll('type', await d.call('getTypeParametersOfType', { ...base, objectId: type }));
          addAll('type', await d.call('getOuterTypeParametersOfType', { ...base, objectId: type }));
          addAll('type', await d.call('getLocalTypeParametersOfType', { ...base, objectId: type }));
        }
        if (flags & (TypeFlags.Index | TypeFlags.StringMapping)) {
          add('type', await d.call('getTargetOfType', { ...base, objectId: type }));
        }
        if (flags & TypeFlags.IndexedAccess) {
          add('type', await d.call('getObjectTypeOfType', { ...base, objectId: type }));
          add('type', await d.call('getIndexTypeOfType', { ...base, objectId: type }));
        }
        if (flags & TypeFlags.Conditional) {
          add('type', await d.call('getCheckTypeOfType', { ...base, objectId: type }));
          add('type', await d.call('getExtendsTypeOfType', { ...base, objectId: type }));
          add('type', await d.call('getTrueTypeOfConditionalType', { ...base, objectId: type }));
          add('type', await d.call('getFalseTypeOfConditionalType', { ...base, objectId: type }));
        }
        if (flags & TypeFlags.Substitution) {
          add('type', await d.call('getBaseTypeOfType', { ...base, objectId: type }));
          add('type', await d.call('getConstraintOfType', { ...base, objectId: type }));
        }
        if (flags & TypeFlags.TypeParameter) {
          add('type', await d.call('getConstraintOfTypeParameter', { ...base, objectId: type }));
        }
        break;
      }
      case 'signature': {
        const signature = value.id;
        add('type', await d.call('getReturnTypeOfSignature', { ...base, objectId: signature }));
        add('type', await d.call('getRestTypeOfSignature', { ...base, signature }));
        const predicate = await d.call('getTypePredicateOfSignature', { ...base, signature });
        add('type', predicate?.type);
        add('type', await d.call('getParameterType', { ...base, signature, index: 0 }));
        addAll('symbol', await d.call('getParametersOfSignature', { ...base, objectId: signature }));
        addAll('type', await d.call('getTypeParametersOfSignature', { ...base, objectId: signature }));
        add('symbol', await d.call('getThisParameterOfSignature', { ...base, objectId: signature }));
        add('signature', await d.call('getTargetOfSignature', { ...base, objectId: signature }));
        if (value.declaration !== undefined) {
          const kind = Number(value.declaration.split('.')[1]);
          await d.call('signatureToSignatureDeclaration', { ...base, signature, kind });
          add('node', value.declaration);
        }
        break;
      }
    }
  }
  return seen.size;
}

// Calls the language service methods on every symbol and node of the given files.
export async function exploreServices(d, snapshot, project, files) {
  const base = { snapshot, project };
  const symbols = new Map();
  for (const { file, length } of files) {
    const positions = Array.from({ length }, (_, i) => i);
    for (const symbol of (await d.call('getSymbolsAtPositions', { ...base, file, positions })) ?? []) {
      if (symbol !== null) symbols.set(symbolKey(symbol.reference), symbol);
    }
  }
  for (const symbol of symbols.values()) {
    await d.call('getJsDocTags', { ...base, symbol: symbol.reference });
    await d.call('getDocumentationComment', { ...base, symbol: symbol.reference });
    for (const { file } of files) {
      await d.call('getReferencesToSymbolInFile', { ...base, file, symbol: symbol.reference });
    }
    for (const signatureDecl of symbol.declarations ?? []) {
      await d.call('getSignatureUsages', { ...base, signatureDecl });
    }
  }
  for (const { file, length, encoded } of files) {
    for (const node of nodeHandles(encoded, file)) {
      await d.call('getReferencedSymbolsForNode', { ...base, node, position: 0 });
    }
    for (let position = 0; position < length; position += 7) {
      await d.call('getReferencedSymbolsForNode', { ...base, node: `1.${Kind.SourceFile}.${file}`, position });
    }
  }
  return symbols.size;
}
