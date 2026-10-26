// tsc-ts/api in process against TypeScript's `tsc --api` at the pinned upstream (the reference the --api tests use): the
// same program, diagnostics, symbols, types, signatures and parsed files for the same queries. Answers are
// compared by what identifies them across processes: names, flags, node handles (index, kind and path)
// and the text of types.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from './client.mjs';
import { tempDir } from './temp.mjs';
import { typescriptLib as bundledLib } from './toolchain.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist/tsc-ts/src');
const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const realTsc = join(typescriptLib, 'tsc');
const skip =
  (!existsSync(realTsc) && 'needs the scriptc toolchain') ||
  (!existsSync(join(dist, 'library/index.js')) && 'run npm run build');

const load = async (path) => import(pathToFileURL(join(dist, path)).href);
const { ObjectFlags, SyntaxKind, TypeFlags } = skip ? {} : await load('library/index.js');

function hostFor(dir) {
  return {
    getCurrentDirectory: () => dir,
    useCaseSensitiveFileNames: () => true,
    getDefaultLibraryDirectory: () => typescriptLib,
  };
}

/** The library and tsgo, with the fixture project open in both. */
async function open(fixture) {
  const api = await load('library/index.js');
  const { NodeIndexTable } = await load('compiler/encoder.js');
  const { getTouchingPropertyName } = await load('compiler/astnav.js');
  const dir = tempDir('tsc-ts-library-');
  cpSync(join(root, 'tests/fixtures', fixture), dir, { recursive: true });
  const config = join(dir, 'tsconfig.json');
  const program = api.createProgramFromConfigFile(config, hostFor(dir));
  const tsgo = new Client([realTsc], dir);
  await tsgo.json('initialize');
  const update = await tsgo.snapshot({ openProjects: [config] });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  const tables = new Map();
  const handle = (node) => {
    const file = sourceFileOf(node);
    let table = tables.get(file);
    if (table === undefined) tables.set(file, (table = new NodeIndexTable(file)));
    return `${table.indexOf(node)}.${node.kind}.${file.path}`;
  };
  return { api, dir, config, program, checker: program.getTypeChecker(), tsgo, base, handle, getTouchingPropertyName };
}

function sourceFileOf(node) {
  while (node.parent !== undefined) node = node.parent;
  return node;
}

/** The parts of a node handle that identify the node across processes. */
const handleOf = (h) => h ?? null;

/** The kinds of declarations getSignatureFromDeclaration takes. */
const signatureDeclarationKinds = new Set(
  [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunction',
    'MethodDeclaration',
    'MethodSignature',
    'Constructor',
    'GetAccessor',
    'SetAccessor',
    'CallSignature',
    'ConstructSignature',
    'IndexSignature',
    'FunctionType',
    'ConstructorType',
  ].map((name) => SyntaxKind?.[name]),
);

/** The kind guards of types, with the test TypeScript 7's client makes of a type's flags. */
const kindGuards = [
  ['isUnionType', (t) => (t.flags & TypeFlags.Union) !== 0],
  ['isIntersectionType', (t) => (t.flags & TypeFlags.Intersection) !== 0],
  ['isObjectType', (t) => (t.flags & TypeFlags.Object) !== 0],
  [
    'isClassOrInterface',
    (t) => (t.flags & TypeFlags.Object) !== 0 && (t.objectFlags & ObjectFlags.ClassOrInterface) !== 0,
  ],
  ['isTypeReference', (t) => (t.flags & TypeFlags.Object) !== 0 && (t.objectFlags & ObjectFlags.Reference) !== 0],
  ['isTupleType', (t) => (t.flags & TypeFlags.Object) !== 0 && (t.objectFlags & ObjectFlags.Tuple) !== 0],
  ['isIntrinsicType', (t) => (t.flags & TypeFlags.Intrinsic) !== 0],
  ['isErrorType', (t) => (t.flags & TypeFlags.Intrinsic) !== 0 && t.intrinsicName === 'error'],
  ['isLiteralType', (t) => (t.flags & TypeFlags.Literal) !== 0],
  ['isStringLiteralType', (t) => (t.flags & TypeFlags.StringLiteral) !== 0],
  ['isNumberLiteralType', (t) => (t.flags & TypeFlags.NumberLiteral) !== 0],
  ['isBigIntLiteralType', (t) => (t.flags & TypeFlags.BigIntLiteral) !== 0],
  ['isBooleanLiteralType', (t) => (t.flags & TypeFlags.BooleanLiteral) !== 0],
  ['isIndexType', (t) => (t.flags & TypeFlags.Index) !== 0],
  ['isIndexedAccessType', (t) => (t.flags & TypeFlags.IndexedAccess) !== 0],
  ['isConditionalType', (t) => (t.flags & TypeFlags.Conditional) !== 0],
  ['isSubstitutionType', (t) => (t.flags & TypeFlags.Substitution) !== 0],
  ['isTemplateLiteralType', (t) => (t.flags & TypeFlags.TemplateLiteral) !== 0],
  ['isStringMappingType', (t) => (t.flags & TypeFlags.StringMapping) !== 0],
  ['isTypeParameter', (t) => (t.flags & TypeFlags.TypeParameter) !== 0],
];

/** A symbol name without the symbol id that names of unique symbols end with (`__@iterator@10`). */
const withoutSymbolId = (name) => (name.startsWith('__@') ? name.replace(/@\d+$/, '') : name);

/**
 * Diagnostics as tsgo's API writes them: without the fields that are undefined, false or empty, which the
 * library always sets.
 */
/** tsgo's diagnostics without the line and character positions and source lines, which the library does not give. */
function withoutPositions(diagnostics) {
  return diagnostics.map((diagnostic) => {
    const d = { ...diagnostic };
    for (const key of ['startPosition', 'endPosition', 'sourceLines']) delete d[key];
    if (d.messageChain !== undefined) d.messageChain = withoutPositions(d.messageChain);
    if (d.relatedInformation !== undefined) d.relatedInformation = withoutPositions(d.relatedInformation);
    return d;
  });
}

function wire(diagnostics) {
  return diagnostics.map((d) => {
    const result = {};
    for (const [key, value] of Object.entries(d)) {
      if (value === undefined || value === false || (Array.isArray(value) && value.length === 0)) continue;
      result[key] = key === 'messageChain' || key === 'relatedInformation' ? wire(value) : value;
    }
    return result;
  });
}

test('programs and diagnostics are those of tsc --api', { skip, timeout: 300_000 }, async () => {
  const { api, dir, config, program, tsgo, base } = await open('library');
  try {
    assert.deepEqual(program.getSourceFileNames(), await tsgo.json('getSourceFileNames', base));
    for (const fileName of program.getSourceFileNames()) {
      const metadata = await tsgo.json('getSourceFileMetadata', { ...base, file: fileName });
      assert.deepEqual(program.getSourceFileMetadata(fileName), metadata, fileName);
      const file = program.getSourceFile(fileName);
      assert.equal(program.isSourceFileDefaultLibrary(file), metadata.isDefaultLibrary, fileName);
      assert.equal(program.isSourceFileFromExternalLibrary(file), metadata.isFromExternalLibrary, fileName);
    }
    const parsed = api.parseConfigFile(config, hostFor(dir));
    const reference = await tsgo.json('parseConfigFile', { file: config });
    assert.deepEqual(parsed.fileNames, reference.fileNames);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.options)), reference.options);
    assert.deepEqual(JSON.parse(JSON.stringify(program.getCompilerOptions())), reference.options);
    for (const [method, kind] of [
      ['getConfigFileParsingDiagnostics', 'ConfigFileParsing'],
      ['getProgramDiagnostics', 'Program'],
      ['getGlobalDiagnostics', 'Global'],
    ])
      assert.deepEqual(
        wire(program[`get${kind}Diagnostics`]()),
        withoutPositions(await tsgo.json(method, base)),
        method,
      );
    for (const kind of ['Syntactic', 'Bind', 'Semantic', 'Suggestion', 'Declaration']) {
      assert.deepEqual(
        wire(program[`get${kind}Diagnostics`]()),
        withoutPositions(await tsgo.json(`get${kind}Diagnostics`, base)),
        kind,
      );
      for (const file of program.getSourceFiles())
        if (file.fileName.startsWith(dir))
          assert.deepEqual(
            wire(program[`get${kind}Diagnostics`](file)),
            withoutPositions(await tsgo.json(`get${kind}Diagnostics`, { ...base, files: [file.fileName] })),
            `${kind} ${file.fileName}`,
          );
    }
    // A program from options and root names is the config's program.
    const fromOptions = api.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host: hostFor(dir) });
    assert.deepEqual(fromOptions.getSourceFileNames(), program.getSourceFileNames());
    assert.deepEqual(fromOptions.getSemanticDiagnostics(), program.getSemanticDiagnostics());
    // `lib` by tsconfig name.
    const named = api.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, lib: ['es2024', 'dom'] },
      host: hostFor(dir),
    });
    assert.ok(named.getSourceFileNames().some((name) => name.endsWith('lib.es2024.d.ts')));
    assert.ok(named.getSourceFileNames().some((name) => name.endsWith('lib.dom.d.ts')));
  } finally {
    await tsgo.close();
  }
});

test('symbols, types and signatures answer as tsc --api', { skip, timeout: 600_000 }, async () => {
  const s = await open('library');
  const { api, program, checker, tsgo, base, handle } = s;
  try {
    const typeText = (t) => checker.typeToString(t);
    const tsgoText = async (t) => tsgo.json('typeToString', { ...base, type: t.id });
    const failures = [];
    const expect = (actual, expected, what) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({ what, actual, expected });
    };

    const describeSymbol = (symbol) =>
      symbol === undefined
        ? null
        : {
            name: withoutSymbolId(api.symbolName(symbol)),
            escapedName: withoutSymbolId(symbol.escapedName),
            flags: symbol.flags >>> 0,
            checkFlags: symbol.checkFlags >>> 0,
            declarations: symbol.declarations.map(handle),
            valueDeclaration: symbol.valueDeclaration === undefined ? null : handle(symbol.valueDeclaration),
          };
    const describeTsgoSymbol = (r) =>
      r === null
        ? null
        : {
            name: withoutSymbolId(r.name.startsWith('___') ? r.name.slice(1) : r.name),
            escapedName: withoutSymbolId(r.name),
            flags: r.flags >>> 0,
            checkFlags: r.checkFlags >>> 0,
            declarations: (r.declarations ?? []).map(handleOf),
            valueDeclaration: handleOf(r.valueDeclaration),
          };

    const pairs = [];
    let nonAliasChecked = false;
    const seen = new Set();
    const visitType = (lib, ref, what) => {
      if ((lib === undefined) !== (ref === null || ref === undefined)) {
        failures.push(`${what}: library ${lib === undefined ? 'none' : typeText(lib)}, tsgo ${ref ? ref.id : 'none'}`);
        return;
      }
      if (lib === undefined || seen.has(lib) || pairs.length > 1500) return;
      seen.add(lib);
      pairs.push([lib, ref, what, (lib.flags & api.TypeFlags.Object) !== 0 ? lib.objectFlags >>> 0 : 0]);
    };

    // Symbols and types at every identifier and expression of the user files.
    const symbols = [];
    for (const file of program.getSourceFiles()) {
      if (!file.fileName.startsWith(s.dir)) continue;
      const locations = [];
      api.walkPreorder(file, (node) => {
        if (node !== file) locations.push(node);
      });
      for (const node of locations) {
        const location = handle(node);
        const symbol = checker.getSymbolAtLocation(node);
        const refSymbol = await tsgo.json('getSymbolAtLocation', { ...base, location });
        expect(describeSymbol(symbol), describeTsgoSymbol(refSymbol), `symbol at ${location}`);
        if (symbol !== undefined && refSymbol !== null) symbols.push([symbol, refSymbol, location]);
        const type = checker.getTypeAtLocation(node);
        const refType = await tsgo.json('getTypeAtLocation', { ...base, location });
        visitType(type, refType, `type at ${location}`);
        if (node.kind === api.SyntaxKind.CallExpression || node.kind === api.SyntaxKind.NewExpression) {
          const signature = checker.getResolvedSignature(node);
          const refSignature = await tsgo.json('getResolvedSignature', { ...base, location });
          expect(
            signature === undefined ? null : signature.declaration === undefined ? null : handle(signature.declaration),
            refSignature?.declaration ?? null,
            `resolved signature at ${location}`,
          );
        }
        if (api.SyntaxKind.FirstTypeNode <= node.kind && node.kind <= api.SyntaxKind.LastTypeNode) {
          visitType(
            checker.getTypeFromTypeNode(node),
            await tsgo.json('getTypeFromTypeNode', { ...base, location }),
            `type of type node ${location}`,
          );
        }
        const contextual = checker.getContextualType(node);
        const refContextual = await tsgo.json('getContextualType', { ...base, location });
        visitType(contextual, refContextual, `contextual type at ${location}`);
        expect(
          checker.getConstantValue(node) ?? null,
          (await tsgo.json('getConstantValue', { ...base, location }))?.value ?? null,
          `constant value at ${location}`,
        );
        expect(
          describeSymbol(checker.getShorthandAssignmentValueSymbol(node)),
          describeTsgoSymbol(await tsgo.json('getShorthandAssignmentValueSymbol', { ...base, location })),
          `shorthand value symbol at ${location}`,
        );
        if (signatureDeclarationKinds.has(node.kind)) {
          const signature = checker.getSignatureFromDeclaration(node);
          const refSignature = await tsgo.json('getSignatureFromDeclaration', { ...base, location });
          expect(
            signature === undefined ? null : [signature.flags, handle(signature.declaration)],
            refSignature === null ? null : [refSignature.flags, refSignature.declaration],
            `signature of declaration ${location}`,
          );
        }
        if (node.kind === api.SyntaxKind.Identifier) {
          expect(
            describeSymbol(checker.getResolvedSymbol(node)),
            describeTsgoSymbol(
              await tsgo.json('resolveName', {
                ...base,
                name: node.text,
                location,
                meaning: api.SymbolFlags.Value | api.SymbolFlags.ExportValue,
              }),
            ),
            `resolved symbol at ${location}`,
          );
          for (const excludeGlobals of [false, true])
            expect(
              describeSymbol(checker.resolveName('Math', api.SymbolFlags.Value, node, excludeGlobals)),
              describeTsgoSymbol(
                await tsgo.json('resolveName', {
                  ...base,
                  name: 'Math',
                  location,
                  meaning: api.SymbolFlags.Value,
                  excludeGlobals,
                }),
              ),
              `resolveName Math ${excludeGlobals} at ${location}`,
            );
          if (symbol !== undefined && refSymbol !== null)
            visitType(
              checker.getTypeOfSymbolAtLocation(symbol, node),
              await tsgo.json('getTypeOfSymbolAtLocation', { ...base, symbol: refSymbol.reference, location }),
              `type of symbol at location ${location}`,
            );
        }
      }
    }
    expect(
      describeSymbol(checker.resolveName('Math', api.SymbolFlags.Value)),
      describeTsgoSymbol(await tsgo.json('resolveName', { ...base, name: 'Math', meaning: api.SymbolFlags.Value })),
      'resolveName Math without a location',
    );

    // The intrinsic types.
    for (const name of ['Any', 'Unknown', 'Never', 'String', 'Number', 'BigInt', 'Boolean'])
      visitType(checker[`get${name}Type`](), await tsgo.json(`get${name}Type`, base), `${name} type`);

    // Symbols: their types, aliases, parents, members and exports.
    for (const [symbol, ref, location] of symbols.slice(0, 600)) {
      visitType(
        checker.getTypeOfSymbol(symbol),
        await tsgo.json('getTypeOfSymbol', { ...base, symbol: ref.reference }),
        `type of symbol at ${location}`,
      );
      visitType(
        checker.getDeclaredTypeOfSymbol(symbol),
        await tsgo.json('getDeclaredTypeOfSymbol', { ...base, symbol: ref.reference }),
        `declared type of symbol at ${location}`,
      );
      // getAliasedSymbol takes an alias; tsgo panics on any other symbol, and the library throws.
      if ((symbol.flags & api.SymbolFlags.Alias) !== 0)
        expect(
          describeSymbol(checker.getAliasedSymbol(symbol)),
          describeTsgoSymbol(await tsgo.json('getAliasedSymbol', { ...base, symbol: ref.reference })),
          `aliased symbol at ${location}`,
        );
      else if (!nonAliasChecked) {
        nonAliasChecked = true;
        assert.throws(() => checker.getAliasedSymbol(symbol), api.InternalCompilerError);
        await assert.rejects(tsgo.json('getAliasedSymbol', { ...base, symbol: ref.reference }), /panic/);
      }
      expect(
        describeSymbol(symbol.getParent()),
        describeTsgoSymbol(
          ref.parent === undefined ? null : await tsgo.json('getParentOfSymbol', { symbol: ref.reference }),
        ),
        `parent at ${location}`,
      );
      expect(
        describeSymbol(symbol.getExportSymbol()),
        describeTsgoSymbol(
          ref.exportSymbol === undefined ? ref : await tsgo.json('getExportSymbolOfSymbol', { symbol: ref.reference }),
        ),
        `export symbol at ${location}`,
      );
      expect(
        [...symbol.getMembers().keys()].sort(),
        (await tsgo.json('getMembersOfSymbol', { symbol: ref.reference })).map((m) => m.name).sort(),
        `members at ${location}`,
      );
      expect(
        [...symbol.getExports().keys()].sort(),
        (await tsgo.json('getExportsOfSymbol', { symbol: ref.reference })).map((m) => m.name).sort(),
        `exports at ${location}`,
      );
    }

    // Types: their parts, properties, signatures and index infos.
    for (let i = 0; i < pairs.length; i++) {
      const [lib, ref, what, objectFlags] = pairs[i];
      expect(
        { flags: lib.flags >>> 0, objectFlags, text: typeText(lib) },
        { flags: ref.flags >>> 0, objectFlags: ref.objectFlags >>> 0, text: await tsgoText(ref) },
        what,
      );
      expect(
        describeSymbol(lib.getSymbol()),
        describeTsgoSymbol(
          ref.symbol === undefined ? null : await tsgo.json('getSymbolOfType', { ...base, objectId: ref.id }),
        ),
        `symbol of ${what}`,
      );
      expect(
        describeSymbol(lib.getAliasSymbol()),
        describeTsgoSymbol(
          ref.aliasSymbol === undefined ? null : await tsgo.json('getAliasSymbolOfType', { ...base, objectId: ref.id }),
        ),
        `alias symbol of ${what}`,
      );
      expect(
        Object.fromEntries(kindGuards.map(([guard]) => [guard, lib[guard]()])),
        Object.fromEntries(kindGuards.map(([guard, test]) => [guard, test(ref)])),
        `kind guards of ${what}`,
      );
      if (lib.isLiteralType())
        expect(typeof lib.value === 'bigint' ? lib.value.toString() : lib.value, ref.value, `value of ${what}`);
      if (lib.isIntrinsicType()) expect(lib.intrinsicName, ref.intrinsicName, `intrinsic name of ${what}`);
      if (lib.isTypeParameter()) expect(lib.isThisType, ref.isThisType, `this type ${what}`);
      if (lib.isTemplateLiteralType()) expect(lib.texts, ref.texts, `texts of ${what}`);
      if (lib.isTupleType())
        expect(
          [lib.elementFlags, lib.fixedLength, lib.readonly],
          [ref.elementFlags, ref.fixedLength, ref.readonly],
          `tuple ${what}`,
        );
      for (const [part, method, field, live] of [
        ['Target', 'getTargetOfType', 'target'],
        ['FreshType', 'getFreshTypeOfType', 'freshType', true],
        ['RegularType', 'getRegularTypeOfType', 'regularType', true],
        ['ObjectType', 'getObjectTypeOfType', 'objectType'],
        ['IndexType', 'getIndexTypeOfType', 'indexType'],
        ['CheckType', 'getCheckTypeOfType', 'checkType'],
        ['ExtendsType', 'getExtendsTypeOfType', 'extendsType'],
        ['BaseType', 'getBaseTypeOfType', 'baseType'],
        ['Constraint', 'getConstraintOfType', 'substConstraint'],
      ])
        visitType(
          lib[`get${part}`](),
          ref[field] === undefined && !(live && lib.isLiteralType())
            ? null
            : await tsgo.json(method, { ...base, objectId: ref.id }),
          `${part} of ${what}`,
        );
      if (lib.isConditionalType()) {
        visitType(
          lib.getTrueType(),
          await tsgo.json('getTrueTypeOfConditionalType', { ...base, objectId: ref.id }),
          `true type of ${what}`,
        );
        visitType(
          lib.getFalseType(),
          await tsgo.json('getFalseTypeOfConditionalType', { ...base, objectId: ref.id }),
          `false type of ${what}`,
        );
      }
      for (const [part, method, field] of [
        ['Types', 'getTypesOfType', undefined],
        ['TypeParameters', 'getTypeParametersOfType', 'typeParameters'],
        ['OuterTypeParameters', 'getOuterTypeParametersOfType', 'outerTypeParameters'],
        ['LocalTypeParameters', 'getLocalTypeParametersOfType', 'localTypeParameters'],
        ['AliasTypeArguments', 'getAliasTypeArgumentsOfType', 'aliasTypeArguments'],
      ]) {
        const own = lib[`get${part}`]();
        if (field !== undefined && ref[field] === undefined) {
          expect(own.length, 0, `${part} of ${what}`);
          continue;
        }
        if (field === undefined && !(lib.isUnionType() || lib.isIntersectionType() || lib.isTemplateLiteralType())) {
          expect(own.length, 0, `${part} of ${what}`);
          continue;
        }
        const refs = await tsgo.json(method, { ...base, objectId: ref.id });
        expect(own.length, refs.length, `${part} of ${what}`);
        for (let k = 0; k < Math.min(own.length, refs.length); k++)
          visitType(own[k], refs[k], `${part}[${k}] of ${what}`);
      }
      if (lib.isClassOrInterface()) {
        const own = lib.getBaseTypes();
        const refs = await tsgo.json('getBaseTypes', { ...base, type: ref.id });
        expect(own.length, refs.length, `base types of ${what}`);
        for (let k = 0; k < Math.min(own.length, refs.length); k++)
          visitType(own[k], refs[k], `base type ${k} of ${what}`);
      }
      if (lib.isTypeReference()) {
        const own = checker.getTypeArguments(lib);
        const refs = await tsgo.json('getTypeArguments', { ...base, type: ref.id });
        expect(own.length, refs.length, `type arguments of ${what}`);
        for (let k = 0; k < Math.min(own.length, refs.length); k++)
          visitType(own[k], refs[k], `type argument ${k} of ${what}`);
      }
      if (i < 300) {
        const props = checker.getPropertiesOfType(lib);
        const refProps = await tsgo.json('getPropertiesOfType', { ...base, type: ref.id });
        expect(props.map(describeSymbol), refProps.map(describeTsgoSymbol), `properties of ${what}`);
        const infos = checker.getIndexInfosOfType(lib);
        const refInfos = await tsgo.json('getIndexInfosOfType', { ...base, type: ref.id });
        expect(infos.length, refInfos.length, `index infos of ${what}`);
        for (let k = 0; k < Math.min(infos.length, refInfos.length); k++) {
          expect(infos[k].isReadonly, refInfos[k].isReadonly, `index info ${k} of ${what}`);
          visitType(infos[k].keyType, refInfos[k].keyType, `index key ${k} of ${what}`);
          visitType(infos[k].type, refInfos[k].valueType, `index value ${k} of ${what}`);
        }
        for (const kind of [api.SignatureKind.Call, api.SignatureKind.Construct]) {
          const signatures = checker.getSignaturesOfType(lib, kind);
          const refSignatures = await tsgo.json('getSignaturesOfType', { ...base, type: ref.id, kind });
          expect(signatures.length, refSignatures.length, `signatures ${kind} of ${what}`);
          for (let k = 0; k < Math.min(signatures.length, refSignatures.length); k++) {
            const sig = signatures[k];
            const refSig = refSignatures[k];
            const where = `signature ${kind}/${k} of ${what}`;
            expect(
              [sig.flags, sig.declaration === undefined ? null : handle(sig.declaration)],
              [refSig.flags, refSig.declaration ?? null],
              where,
            );
            expect(
              sig.getParameters().map(describeSymbol),
              (await tsgo.json('getParametersOfSignature', { ...base, objectId: refSig.id })).map(describeTsgoSymbol),
              `parameters of ${where}`,
            );
            visitType(
              checker.getReturnTypeOfSignature(sig),
              await tsgo.json('getReturnTypeOfSignature', { ...base, objectId: refSig.id }),
              `return type of ${where}`,
            );
            const predicate = checker.getTypePredicateOfSignature(sig);
            const refPredicate = await tsgo.json('getTypePredicateOfSignature', { ...base, signature: refSig.id });
            expect(
              predicate === undefined
                ? null
                : [predicate.kind, predicate.parameterIndex, predicate.parameterName ?? null],
              refPredicate === null
                ? null
                : [refPredicate.kind, refPredicate.parameterIndex, refPredicate.parameterName ?? null],
              `predicate of ${where}`,
            );
            expect(
              describeSymbol(sig.getThisParameter()),
              describeTsgoSymbol(await tsgo.json('getThisParameterOfSignature', { ...base, objectId: refSig.id })),
              `this parameter of ${where}`,
            );
            const target = sig.getTarget();
            const refTarget = await tsgo.json('getTargetOfSignature', { ...base, objectId: refSig.id });
            expect(
              target === undefined
                ? null
                : [target.flags, target.declaration === undefined ? null : handle(target.declaration)],
              refTarget === null ? null : [refTarget.flags, refTarget.declaration ?? null],
              `target of ${where}`,
            );
          }
        }
        // Properties by name, and a name the type doesn't have. Unique symbol names hold process ids.
        for (const property of props) {
          const name = api.symbolName(property);
          if (name.startsWith('__@')) continue;
          expect(
            describeSymbol(checker.getPropertyOfType(lib, name)),
            describeTsgoSymbol(await tsgo.json('getPropertyOfType', { ...base, type: ref.id, name })),
            `property ${name} of ${what}`,
          );
        }
        expect(
          describeSymbol(checker.getPropertyOfType(lib, 'missing')),
          describeTsgoSymbol(await tsgo.json('getPropertyOfType', { ...base, type: ref.id, name: 'missing' })),
          `property missing of ${what}`,
        );
        for (const name of ['isArrayType', 'isArrayLikeType'])
          expect(checker[name](lib), await tsgo.json(name, { ...base, type: ref.id }), `${name} ${what}`);
        expect(checker.isTupleType(lib), ref.isTupleType, `isTupleType ${what}`);
        visitType(
          checker.getBaseTypeOfLiteralType(lib),
          await tsgo.json('getBaseTypeOfLiteralType', { ...base, type: ref.id }),
          `literal base of ${what}`,
        );
        visitType(
          checker.getNonNullableType(lib),
          await tsgo.json('getNonNullableType', { ...base, objectId: ref.id }),
          `non-nullable ${what}`,
        );
      }
    }
    const sample = pairs.slice(0, 24);
    for (const [source, refSource, sourceWhat] of sample)
      for (const [target, refTarget, targetWhat] of sample)
        expect(
          checker.isTypeAssignableTo(source, target),
          await tsgo.json('isTypeAssignableTo', { ...base, source: refSource.id, target: refTarget.id }),
          `${sourceWhat} assignable to ${targetWhat}`,
        );
    assert.deepEqual(
      failures.slice(0, Number(process.env.SHOW_FAILURES ?? 30)),
      [],
      `${failures.length} differences in ${pairs.length} types and ${symbols.length} symbols`,
    );
    assert.ok(pairs.length > 200, `${pairs.length} types compared`);
  } finally {
    await tsgo.close();
  }
});

test('parseSourceFile parses as a one-file project of tsc --api', { skip, timeout: 300_000 }, async () => {
  const api = await load('library/index.js');
  const { encodeSourceFile } = await load('compiler/encoder.js');
  const dir = tempDir('tsc-ts-parse-');
  const write = (name, text) => {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  const sources = {
    'plain.ts': 'const a = 1;\n/** doc */\nfunction f(x: number) { return x; }\n',
    'script.js': '// @ts-check\n/** @type {number} */\nvar n = 1;\nmodule.exports = { n };\n',
    'node_modules/esm/package.json': '{ "name": "esm", "type": "module" }',
    'node_modules/esm/index.js': 'const value = 1;\n/** @param {string} s */\nfunction g(s) { return s; }\n',
    'view.tsx': 'const v = <div className="a">{1}</div>;\n',
    'module.mts': 'const m = 1;\n',
  };
  for (const [name, text] of Object.entries(sources)) write(name, text);
  const options = {
    target: 99,
    module: 99,
    jsx: 1,
    allowJs: true,
    noResolve: true,
    noLib: true,
    types: [],
    noEmit: true,
  };
  const tsgo = new Client([realTsc], dir);
  try {
    await tsgo.json('initialize');
    for (const name of Object.keys(sources).filter((n) => !n.endsWith('.json'))) {
      const fileName = join(dir, name);
      const config = join(dir, `tsconfig.${name.replaceAll('/', '_')}.json`);
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            target: 'esnext',
            module: 'esnext',
            jsx: 'preserve',
            allowJs: true,
            noResolve: true,
            noLib: true,
            types: [],
            noEmit: true,
          },
          files: [fileName],
        }),
      );
      const update = await tsgo.snapshot({ openProjects: [config] });
      const reply = await tsgo.request('getSourceFile', {
        snapshot: update.snapshot,
        project: update.projects.find((p) => p.configFileName === config)?.id ?? config,
        file: fileName,
      });
      const parsed = api.parseSourceFile(fileName, readFileSync(fileName, 'utf8'), {
        compilerOptions: options,
        host: hostFor(dir),
      });
      // tsgo's encoding names the file by its node id (bytes 44 to 51), where the library's has none.
      const expected = Buffer.from(reply.payload);
      expected.fill(0, 44, 52);
      assert.deepEqual(Buffer.from(encodeSourceFile(parsed)), expected, name);
    }
  } finally {
    await tsgo.close();
  }
});

test('failures inside the compiler throw InternalCompilerError; disposed programs refuse calls', { skip }, async () => {
  const api = await load('library/index.js');
  const dir = tempDir('tsc-ts-library-');
  cpSync(join(root, 'tests/fixtures/library'), dir, { recursive: true });
  const program = api.createProgramFromConfigFile(join(dir, 'tsconfig.json'), hostFor(dir));
  const checker = program.getTypeChecker();
  assert.throws(
    () => checker.getSymbolAtLocation(null),
    (e) => e instanceof api.InternalCompilerError && e.message.startsWith('panic: ') && e.cause instanceof TypeError,
  );
  program.dispose();
  assert.throws(
    () => program.getSourceFiles(),
    (e) => !(e instanceof api.InternalCompilerError) && /disposed/.test(e.message),
  );
});

test('a disposed program keeps no files alive', { skip }, async () => {
  const { setFlagsFromString } = await import('node:v8');
  const { runInNewContext } = await import('node:vm');
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const api = await load('library/index.js');
  const dir = tempDir('tsc-ts-library-');
  cpSync(join(root, 'tests/fixtures/library'), dir, { recursive: true });
  const refs = (() => {
    const program = api.createProgramFromConfigFile(join(dir, 'tsconfig.json'), hostFor(dir));
    program.getSemanticDiagnostics();
    program.getTypeChecker().getStringType();
    const files = program.getSourceFiles();
    const result = [new WeakRef(files.find((f) => program.isSourceFileDefaultLibrary(f))), new WeakRef(files.at(-1))];
    program.dispose();
    return result;
  })();
  for (let i = 0; i < 5 && refs.some((r) => r.deref() !== undefined); i++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  assert.deepEqual(
    refs.map((r) => r.deref() === undefined),
    [true, true],
  );
});

/** Diagnostics in tsc-ts's order: by file name, position, end and code, then text; without duplicates. */
function sortedUnique(diagnostics) {
  const key = (d) => JSON.stringify([d.fileName ?? '', d.pos, d.end, d.code, d.text]);
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const compare = (a, b) =>
    order(a.fileName ?? '', b.fileName ?? '') ||
    a.pos - b.pos ||
    a.end - b.end ||
    a.code - b.code ||
    order(a.text, b.text);
  const result = [];
  for (const d of [...diagnostics].sort(compare))
    if (result.length === 0 || key(result.at(-1)) !== key(d)) result.push(d);
  return result;
}

test('getPreEmitDiagnostics gives the diagnostics tsc --api gives, sorted', { skip, timeout: 300_000 }, async () => {
  const { api, dir, program, tsgo, base } = await open('library-errors');
  try {
    const methods = [
      'getConfigFileParsingDiagnostics',
      'getProgramDiagnostics',
      'getSyntacticDiagnostics',
      'getGlobalDiagnostics',
      'getSemanticDiagnostics',
    ];
    const reference = async (file) => {
      const all = [];
      for (const method of methods) {
        const perFile =
          file !== undefined && (method === 'getSyntacticDiagnostics' || method === 'getSemanticDiagnostics');
        all.push(...withoutPositions(await tsgo.json(method, perFile ? { ...base, files: [file.fileName] } : base)));
      }
      return sortedUnique(all);
    };
    const all = wire(api.getPreEmitDiagnostics(program));
    assert.deepEqual(all, await reference(undefined));
    assert.deepEqual(
      all.map((d) => d.code),
      [2339, 2322, 1109, 2322, 5023, 5102],
    );
    for (const file of program.getSourceFiles())
      if (file.fileName.startsWith(dir))
        assert.deepEqual(wire(api.getPreEmitDiagnostics(program, file)), await reference(file), file.fileName);
    assert.throws(() => api.getPreEmitDiagnostics({}), TypeError);
  } finally {
    await tsgo.close();
  }
});

test('getTextOfNode and getSourceFileOfNode give what TypeScript gives', { skip }, async () => {
  const ts5 = (await import('typescript')).default;
  const api = await load('library/index.js');
  const dir = tempDir('tsc-ts-library-');
  cpSync(join(root, 'tests/fixtures/library'), dir, { recursive: true });
  const program = api.createProgramFromConfigFile(join(dir, 'tsconfig.json'), hostFor(dir));
  let compared = 0;
  const failures = [];
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(dir)) continue;
    const reference = ts5.createSourceFile(file.fileName, file.text, ts5.ScriptTarget.ESNext, true);
    const texts = new Map();
    const visit = (node) => {
      texts.set(`${node.pos}:${node.end}`, node.getText(reference));
      ts5.forEachChild(node, visit);
    };
    ts5.forEachChild(reference, visit);
    api.walkPreorder(file, (node) => {
      if (api.getSourceFileOfNode(node) !== file) failures.push(`source file of ${node.kind} at ${node.pos}`);
      if (node === file) return;
      const text = texts.get(`${node.pos}:${node.end}`);
      if (text === undefined) return;
      compared++;
      if (api.getTextOfNode(node) !== text)
        failures.push(
          `${node.kind} at ${node.pos}: ${JSON.stringify(api.getTextOfNode(node))} != ${JSON.stringify(text)}`,
        );
    });
  }
  program.dispose();
  assert.deepEqual(failures.slice(0, 20), []);
  assert.ok(compared > 300, `${compared} nodes compared`);
});

test('a program takes a file parse threads prepared only when the host gives the same text', { skip }, async () => {
  const api = await load('library/index.js');
  const { parallelParse, PreparedFile } = await load('compiler/parallel-parse.js');
  const { parseSourceFile } = await load('compiler/parser.js');
  const { ParseOptions } = await load('compiler/ast.js');
  const dir = tempDir('tsc-ts-library-');
  cpSync(join(root, 'tests/fixtures/library'), dir, { recursive: true });
  const fileName = join(dir, 'src/main.ts');
  const diskText = readFileSync(fileName, 'utf8');
  // What a parse thread prepares: the file, parsed with the inputs the program's loader uses (the fixture's
  // `module: nodenext` makes every file a module: `force`).
  const prepare = (text) => {
    const options = { jsx: false, force: true };
    const file = parseSourceFile(fileName, text, new ParseOptions(fileName, api.ScriptKind.Unknown, options));
    parallelParse.files.set(fileName, new PreparedFile(fileName, fileName, false, true, file, '', ''));
    return file;
  };
  try {
    const same = prepare(diskText);
    const program = api.createProgramFromConfigFile(join(dir, 'tsconfig.json'), hostFor(dir));
    assert.ok(program.getSourceFile(fileName) === same, 'the prepared file');
    program.dispose();

    const other = prepare('export const prepared = 1;\n');
    const second = api.createProgramFromConfigFile(join(dir, 'tsconfig.json'), hostFor(dir));
    const file = second.getSourceFile(fileName);
    assert.ok(file !== other, 'not the prepared file');
    assert.equal(file.text, diskText);
    second.dispose();
  } finally {
    parallelParse.files.clear();
    parallelParse.taken.clear();
  }
});
