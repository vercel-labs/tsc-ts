// The compiler behind the API server. Everything it exports is plain data or
// an opaque reference that callers pass back in.
import {
  type ExternalModuleIndicatorOptions,
  getLocals,
  getLocalSymbol,
  getSymbol,
  type Node as AstNode,
  ParseOptions,
  ScriptKind,
  type SourceFile as AstSourceFile,
} from '../compiler/ast.js';
import { getTouchingPropertyName } from '../compiler/astnav.js';
import { hash128String, toHex } from '../compiler/xxh3.js';
import { getSourceFileOfNode } from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import {
  getBaseTypes,
  getConstraintOfTypeParameter,
  getDeclaredTypeOfSymbol,
} from '../compiler/checker-declared-types.js';
import { getNonNullableType } from '../compiler/checker-flow.js';
import { isContextSensitive } from '../compiler/checker-functions.js';
import {
  getApparentType,
  getBaseConstraintOfType,
  getIndexInfosOfType,
  getPropertiesOfType,
  getPropertyOfType,
  getSignaturesOfType,
  isArrayLikeType,
} from '../compiler/checker-members.js';
import {
  getConstantValue,
  getExportSpecifierLocalTargetSymbol,
  getExportsOfModuleAsArray,
  getImmediateAliasedSymbol,
  getRestTypeOfSignature,
  getShorthandAssignmentValueSymbol,
  getSymbolAtLocation,
  getTypeAtLocation,
  getTypeOfSymbolAtLocation,
  queryContextualType,
  queryResolvedSignature,
  querySignatureFromDeclaration,
  tryGetMemberInModuleExports,
} from '../compiler/checker-services.js';
import {
  getReturnTypeOfSignature,
  getTypeAtPosition,
  getTypePredicateOfSignature,
} from '../compiler/checker-signatures.js';
import { getTypeOfSymbol, getWidenedType } from '../compiler/checker-symbol-types.js';
import { resolveAlias, resolveName as checkerResolveName } from '../compiler/checker-symbols.js';
import {
  getBaseTypeOfLiteralType,
  compareSymbols,
  getTypeArguments,
  isArrayType as checkerIsArrayType,
  isTupleType as checkerIsTupleType,
} from '../compiler/checker-type-factory.js';
import { getTypeFromTypeNode } from '../compiler/checker-type-nodes.js';
import {
  getConstraintTypeFromMappedType,
  getFalseTypeFromConditionalType,
  getNameTypeFromMappedType,
  getTemplateTypeFromMappedType,
  getTrueTypeFromConditionalType,
  getTypeParameterFromMappedType,
} from '../compiler/checker-type-operators.js';
import {
  type ConditionalType,
  type IndexedAccessType,
  type InterfaceType,
  type IntrinsicType,
  type LiteralType,
  type MappedType,
  ObjectFlags,
  type Signature as CheckerSignature,
  SignatureKind as CheckerSignatureKind,
  type StringMappingType,
  type SubstitutionType,
  type TemplateLiteralType,
  type TupleType,
  type Type as CheckerType,
  TypeFlags,
  type TypeParameter,
  type TypeReference,
  type IndexType,
  type UnionOrIntersectionType,
} from '../compiler/checker-types.js';
import { decodeNodes } from '../compiler/decoder.js';
import { type Diagnostic as CompilerDiagnostic, Locale } from '../compiler/diagnostics.js';
import { encodeNode, encodeSourceFile as encodeFile, NodeIndexTable } from '../compiler/encoder.js';
import { CompilerHost } from '../compiler/file-loader.js';
import { CachedFileSystem, DirectoryEntries, FileSystem } from '../compiler/file-system.js';
import { signatureToSignatureDeclaration, typeToStringFromTypeNode, typeToTypeNode } from '../compiler/node-builder.js';
import {
  type CompilerOptions as CompilerOptionsValue,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
} from '../compiler/options.js';
import { parseSourceFile } from '../compiler/parser.js';
import { EmitContext } from '../compiler/printer/emit-context.js';
import { Printer, PrinterOptions } from '../compiler/printer/printer.js';
import { Program } from '../compiler/program.js';
import { CheckedProgram } from '../compiler/program-checker.js';
import { type ApiCompilerOptions as CompilerOptions, compilerOptionsOf } from '../library/options.js';
export type { ApiCompilerOptions as CompilerOptions } from '../library/options.js';
import { checkedFileDiagnostics, type DiagnosticKind, programDiagnostics } from '../library/diagnostics.js';
import {
  getDeclarations,
  getSymbolId,
  type Symbol as CompilerSymbol,
  SymbolFlags,
  type SymbolTable,
} from '../compiler/symbol.js';
import type { SyntaxKind } from '../compiler/syntax-kind.js';
import { ConfigParser, JsonArray, JsonObject, type JsonValue, ParsedCommandLine } from '../compiler/tsconfig.js';
import { isTypeAssignableTo } from '../compiler/relations.js';
import { typeToString } from '../compiler/type-printer.js';
import { type CompletionList, getCompletionsAtPosition } from '../services/completions.js';
import {
  getReferencedSymbolsForNode,
  getReferencesToSymbolInFile,
  getSignatureUsages,
} from '../services/find-references.js';
import { getSymbolDocumentationComment, getSymbolJSDocTags, type JSDocTagInfo } from '../services/jsdoc.js';
import type { ClientFileSystem } from './fs.js';

export type { CompletionEntry, CompletionList } from '../services/completions.js';
export { NeedsAutoImports } from '../services/completions.js';

// Opaque references. Callers compare them by identity and pass them back.
export type Type = CheckerType;
export type Symbol = CompilerSymbol;
export type Signature = CheckerSignature;
export type Node = AstNode;
export type SourceFile = AstSourceFile;

// Where projects are loaded from.
export interface ProjectHost {
  fs: ClientFileSystem;
  currentDirectory: string;
  defaultLibraryPath: string;
  useCaseSensitiveFileNames: boolean;
  /** The session's files; without them, every read goes to `fs`. */
  files?: SessionFiles;
}

// A literal type's value, as sent to API clients.
export type LiteralValue = string | number | boolean | BigIntLiteral | null;

// A bigint literal, sent as decimal text.
export interface BigIntLiteral {
  bigint: string;
}

export interface ReferencedSymbol {
  definition: Node;
  symbol: Symbol | undefined;
  references: Node[];
}

export interface SignatureUsage {
  name: Node;
  call: Node | undefined;
}

export interface SourceFileMetadata {
  isDefaultLibrary: boolean;
  isFromExternalLibrary: boolean;
  packageJsonType: string;
  packageJsonDirectory: string;
  impliedNodeFormat: number;
}

/**
 * A diagnostic as the API answers it. One in a file also has the zero-based lines and UTF-16 characters of `pos` and
 * `end`, and the source lines to show it with: each from the first to the last, or the first two and the last two
 * of five or more, as TypeScript 7.1 sends them.
 */
export interface Diagnostic {
  readonly fileName: string | undefined;
  readonly pos: number;
  readonly end: number;
  readonly startPosition: DiagnosticPosition | undefined;
  readonly endPosition: DiagnosticPosition | undefined;
  readonly sourceLines: readonly DiagnosticSourceLine[];
  readonly code: number;
  readonly category: number;
  readonly text: string;
  readonly reportsUnnecessary: boolean;
  readonly reportsDeprecated: boolean;
  readonly messageChain: readonly Diagnostic[];
  readonly relatedInformation: readonly Diagnostic[];
}

export interface DiagnosticPosition {
  readonly line: number;
  readonly character: number;
}

export interface DiagnosticSourceLine {
  readonly line: number;
  readonly text: string;
}

export type { DiagnosticKind } from '../library/diagnostics.js';

export interface IndexInfo {
  keyType: Type;
  valueType: Type;
  isReadonly: boolean;
  declaration: Node | undefined;
}

export interface TypePredicate {
  kind: number;
  parameterIndex: number;
  parameterName: string;
  type: Type | undefined;
}

export interface TupleInfo {
  elementFlags: number[];
  fixedLength: number;
  readonly: boolean;
}

export const enum SignatureKind {
  Call = 0,
  Construct = 1,
}

// A configured project: a tsconfig.json, its program and a type checker for
// queries. Diagnostics come from a separate checker, as in tsc --api.
export class Project {
  private readonly checker: Checker;

  private constructor(
    private readonly config: ParsedCommandLine,
    // The paths of the files read or looked up for the config.
    private readonly configSeen: readonly string[],
    private readonly checked: CheckedProgram,
    // The file system the program's files were loaded through, with the files it looked up.
    private readonly loadedThrough: CachedFileSystem,
  ) {
    this.checker = checked.createChecker();
  }

  private static load(config: ParsedCommandLine, host: ProjectHost, configSeen: readonly string[]): Project {
    const fs = new CachedFileSystem(new HostFileSystem(host));
    const program = new Program(config, projectCompilerHost(fs, host));
    return new Project(config, configSeen, new CheckedProgram(program), fs);
  }

  static open(host: ProjectHost, configFileName: string): Project {
    const errors: CompilerDiagnostic[] = [];
    const seen = new Set<string>();
    const fs = new HostFileSystem(host, seen);
    const config =
      new ConfigParser(fs, host.currentDirectory).parseConfigFile(configFileName, undefined, undefined, errors) ??
      new ParsedCommandLine(
        {},
        undefined,
        [],
        [],
        undefined,
        errors,
        host.currentDirectory,
        host.useCaseSensitiveFileNames,
        0,
      );
    return Project.load(config, host, Array.from(seen));
  }

  // The project of open files that no config file contains, with tsgo's
  // default inferred project options.
  static openInferred(host: ProjectHost, rootFileNames: string[]): Project {
    const options: CompilerOptionsValue = {
      allowJs: true,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      target: ScriptTarget.LatestStandard,
      jsx: JsxEmit.ReactJSX,
      allowImportingTsExtensions: true,
      strictNullChecks: true,
      strictFunctionTypes: true,
      sourceMap: true,
      allowNonTsExtensions: true,
      resolveJsonModule: true,
    };
    const config = new ParsedCommandLine(
      options,
      undefined,
      rootFileNames,
      [],
      undefined,
      [],
      host.currentDirectory,
      host.useCaseSensitiveFileNames,
      rootFileNames.length,
    );
    return Project.load(config, host, []);
  }

  private get program(): Program {
    return this.checked.program;
  }

  rootFiles(): string[] {
    return this.config.fileNames.slice();
  }

  /**
   * Whether a change to the file at `path` can affect the project: the config read it, the program has it,
   * or loading the program looked it up (a package.json or a module resolution candidate; the compiler
   * reads no other file without looking it up first).
   */
  depends(path: string): boolean {
    return (
      this.configSeen.includes(path) ||
      this.loadedThrough.lookedUpFile(path) ||
      this.program.getSourceFileByPath(path) !== undefined
    );
  }

  /** Whether reading the config read or looked up the file at `path`. */
  configDepends(path: string): boolean {
    return this.configSeen.includes(path);
  }

  /**
   * The project with a new program from the same config, for changes that leave the config's files and
   * the files its patterns match as they were.
   */
  reload(host: ProjectHost): Project {
    return Project.load(this.config, host, this.configSeen);
  }

  /**
   * The project after a change to the program file at `path` alone, which leaves the config as it was: its
   * program with the file read again (`Program.updateFile`), or else a new program, as tsgo updates a project
   * with one changed file.
   */
  update(host: ProjectHost, path: string): Project {
    const program = this.program.updateFile(
      path,
      projectCompilerHost(new CachedFileSystem(new HostFileSystem(host)), host),
    );
    if (program === undefined) return this.reload(host);
    return new Project(this.config, this.configSeen, new CheckedProgram(program), this.loadedThrough);
  }

  compilerOptions(): CompilerOptions {
    return compilerOptionsOf(this.config.options);
  }

  /** The project's parsed config, as projects in snapshot answers have it (parsedCommandLine). */
  configFileData(): ConfigFileData {
    return configFileDataOf(this.config);
  }

  /** The directory the project's file names are relative to: its config's, or the session's for the inferred one. */
  currentDirectory(): string {
    return this.config.currentDirectory;
  }

  sourceFiles(): SourceFile[] {
    return this.program.getSourceFiles().slice();
  }

  sourceFile(fileName: string): SourceFile | undefined {
    return this.program.getSourceFile(fileName);
  }

  sourceFileByPath(path: string): SourceFile | undefined {
    return this.program.getSourceFileByPath(path);
  }

  sourceFileMetadata(file: SourceFile): SourceFileMetadata {
    const program = this.program;
    const metadata = program.sourceFileMetadata(file.path);
    return {
      isDefaultLibrary: program.isSourceFileDefaultLibrary(file.path),
      isFromExternalLibrary: program.isSourceFileFromExternalLibrary(file),
      packageJsonType: metadata.packageJsonType,
      packageJsonDirectory: metadata.packageJsonDirectory,
      impliedNodeFormat: metadata.impliedNodeFormat,
    };
  }

  diagnostics(kind: DiagnosticKind, file: SourceFile | undefined): Diagnostic[] {
    return programDiagnostics(this.checked, kind, file).map(apiDiagnosticOf);
  }

  /** The semantic diagnostics of each of `files` and the global diagnostics, after checking only them. */
  checkedFileDiagnostics(files: readonly SourceFile[]): { files: Diagnostic[][]; global: Diagnostic[] } {
    const result = checkedFileDiagnostics(this.checked, files);
    return {
      files: result.files.map((list) => list.map(apiDiagnosticOf)),
      global: result.global.map(apiDiagnosticOf),
    };
  }

  /** Completions at a UTF-16 position; throws `NeedsAutoImports` where tsgo needs its auto-import registry. */
  completionsAtPosition(
    file: SourceFile,
    position: number,
    triggerCharacter: string | undefined,
    includeSymbols: boolean,
  ): CompletionList | undefined {
    return getCompletionsAtPosition(this.checker, this.program, file, position, triggerCharacter, includeSymbols);
  }

  // The node at a UTF-16 position: the touching property name or token.
  nodeAtPosition(file: SourceFile, position: number): Node | undefined {
    return getTouchingPropertyName(file, position);
  }

  symbolAtLocation(node: Node): Symbol | undefined {
    return getSymbolAtLocation(this.checker, node);
  }

  typeOfSymbol(symbol: Symbol): Type | undefined {
    return getTypeOfSymbol(this.checker, symbol);
  }

  declaredTypeOfSymbol(symbol: Symbol): Type | undefined {
    return getDeclaredTypeOfSymbol(this.checker, symbol);
  }

  resolveName(name: string, location: Node | undefined, meaning: number, excludeGlobals: boolean): Symbol | undefined {
    return checkerResolveName(this.checker, location, name, meaning, undefined, false, excludeGlobals);
  }

  signaturesOfType(type: Type, kind: SignatureKind): Signature[] {
    return getSignaturesOfType(
      this.checker,
      type,
      kind === SignatureKind.Call ? CheckerSignatureKind.Call : CheckerSignatureKind.Construct,
    ).slice();
  }

  resolvedSignature(node: Node): Signature | undefined {
    return queryResolvedSignature(this.checker, node);
  }

  typeAtLocation(node: Node): Type | undefined {
    return getTypeAtLocation(this.checker, node);
  }

  contextualType(node: Node): Type | undefined {
    return queryContextualType(this.checker, node);
  }

  baseTypeOfLiteralType(type: Type): Type | undefined {
    return getBaseTypeOfLiteralType(this.checker, type);
  }

  nonNullableType(type: Type): Type | undefined {
    return getNonNullableType(this.checker, type);
  }

  typeFromTypeNode(node: Node): Type | undefined {
    return getTypeFromTypeNode(this.checker, node);
  }

  widenedType(type: Type): Type | undefined {
    return getWidenedType(this.checker, type);
  }

  typeAtPosition(signature: Signature, index: number): Type | undefined {
    return getTypeAtPosition(this.checker, signature, index);
  }

  isArrayLikeType(type: Type): boolean {
    return isArrayLikeType(this.checker, type);
  }

  isTypeAssignableTo(source: Type, target: Type): boolean {
    return isTypeAssignableTo(this.checker, source, target);
  }

  shorthandAssignmentValueSymbol(node: Node): Symbol | undefined {
    return getShorthandAssignmentValueSymbol(this.checker, node);
  }

  typeOfSymbolAtLocation(symbol: Symbol, node: Node): Type | undefined {
    return getTypeOfSymbolAtLocation(this.checker, symbol, node);
  }

  // Encodes the type node TypeScript would write for type.
  typeToTypeNode(type: Type, enclosing: Node | undefined, flags: number): Uint8Array | undefined {
    const node = typeToTypeNode(this.checker, type, enclosing, flags);
    // The builder keeps the positions of nodes it reuses from the enclosing declaration's file.
    return node === undefined
      ? undefined
      : encodeNode(node, enclosing === undefined ? undefined : getSourceFileOfNode(enclosing));
  }

  signatureToSignatureDeclaration(
    signature: Signature,
    kind: number,
    enclosing: Node | undefined,
    flags: number,
  ): Uint8Array | undefined {
    const node = signatureToSignatureDeclaration(this.checker, signature, kind as SyntaxKind, enclosing, flags);
    return node === undefined
      ? undefined
      : encodeNode(node, enclosing === undefined ? undefined : getSourceFileOfNode(enclosing));
  }

  typeToString(type: Type, enclosing: Node | undefined, flags: number): string {
    return (
      typeToStringFromTypeNode(this.checker, type, enclosing, flags) ??
      typeToString(this.checker, type, enclosing, flags)
    );
  }

  isContextSensitive(node: Node): boolean {
    return isContextSensitive(this.checker, node);
  }

  returnTypeOfSignature(signature: Signature): Type | undefined {
    return getReturnTypeOfSignature(this.checker, signature);
  }

  restTypeOfSignature(signature: Signature): Type | undefined {
    return getRestTypeOfSignature(this.checker, signature);
  }

  typePredicateOfSignature(signature: Signature): TypePredicate | undefined {
    const predicate = getTypePredicateOfSignature(this.checker, signature);
    if (predicate === undefined) return undefined;
    return {
      kind: predicate.kind,
      parameterIndex: predicate.parameterIndex,
      parameterName: predicate.parameterName,
      type: predicate.type,
    };
  }

  isArrayType(type: Type): boolean {
    return checkerIsArrayType(this.checker, type);
  }

  baseTypes(type: Type): Type[] {
    return getBaseTypes(this.checker, type).slice();
  }

  propertiesOfType(type: Type): Symbol[] {
    return getPropertiesOfType(this.checker, type).slice();
  }

  apparentType(type: Type): Type | undefined {
    return getApparentType(this.checker, type);
  }

  indexInfosOfType(type: Type): IndexInfo[] {
    return getIndexInfosOfType(this.checker, type).map((info) => ({
      keyType: info.keyType,
      valueType: info.valueType,
      isReadonly: info.isReadonly,
      declaration: info.declaration,
    }));
  }

  constraintOfTypeParameter(type: Type): Type | undefined {
    return getConstraintOfTypeParameter(this.checker, type);
  }

  baseConstraintOfType(type: Type): Type | undefined {
    return getBaseConstraintOfType(this.checker, type);
  }

  propertyOfType(type: Type, name: string): Symbol | undefined {
    return getPropertyOfType(this.checker, type, name);
  }

  constantValue(node: Node): LiteralValue {
    const value = getConstantValue(this.checker, node);
    return value === undefined ? null : value;
  }

  signatureFromDeclaration(node: Node): Signature | undefined {
    return querySignatureFromDeclaration(this.checker, node);
  }

  exportSpecifierLocalTargetSymbol(node: Node): Symbol | undefined {
    return getExportSpecifierLocalTargetSymbol(this.checker, node);
  }

  aliasedSymbol(symbol: Symbol): Symbol | undefined {
    return resolveAlias(this.checker, symbol);
  }

  immediateAliasedSymbol(symbol: Symbol): Symbol | undefined {
    return getImmediateAliasedSymbol(this.checker, symbol);
  }

  exportsOfModule(symbol: Symbol): Symbol[] {
    return this.sortSymbols(getExportsOfModuleAsArray(this.checker, symbol));
  }

  memberInModuleExports(symbol: Symbol, name: string): Symbol | undefined {
    return tryGetMemberInModuleExports(this.checker, name, symbol);
  }

  typeArguments(type: Type): Type[] {
    return getTypeArguments(this.checker, type).slice();
  }

  trueTypeOfConditionalType(type: Type): Type | undefined {
    return getTrueTypeFromConditionalType(this.checker, type as ConditionalType);
  }

  falseTypeOfConditionalType(type: Type): Type | undefined {
    return getFalseTypeFromConditionalType(this.checker, type as ConditionalType);
  }

  intrinsicType(name: IntrinsicTypeName): Type | undefined {
    const c = this.checker;
    switch (name) {
      case 'any':
        return c.anyType;
      case 'string':
        return c.stringType;
      case 'number':
        return c.numberType;
      case 'boolean':
        return c.booleanType;
      case 'void':
        return c.voidType;
      case 'undefined':
        return c.undefinedType;
      case 'null':
        return c.nullType;
      case 'never':
        return c.neverType;
      case 'unknown':
        return c.unknownType;
      case 'bigint':
        return c.bigintType;
      case 'symbol':
        return c.esSymbolType;
    }
  }

  jsDocTags(symbol: Symbol): JSDocTagInfo[] {
    return getSymbolJSDocTags(symbol);
  }

  documentationComment(symbol: Symbol): string {
    return getSymbolDocumentationComment(this.checker, symbol);
  }

  referencesToSymbolInFile(file: SourceFile, symbol: Symbol): Node[] {
    return getReferencesToSymbolInFile(this.checker, file, symbol);
  }

  referencedSymbolsForNode(node: Node, position: number): ReferencedSymbol[] {
    const result: ReferencedSymbol[] = [];
    for (const entry of getReferencedSymbolsForNode(
      this.checker,
      this.program,
      position,
      node,
      this.program.getSourceFiles(),
    )) {
      const definition = entry.definitionNode();
      if (definition === undefined) continue;
      const references: Node[] = [];
      for (const ref of entry.references) if (ref.node !== undefined) references.push(ref.node);
      result.push({ definition, symbol: entry.definition.symbol, references });
    }
    return result;
  }

  signatureUsages(declaration: Node): SignatureUsage[] {
    return getSignatureUsages(this.checker, this.program, declaration);
  }

  unknownSymbol(): Symbol {
    return this.checker.unknownSymbol;
  }

  undefinedSymbol(): Symbol {
    return this.checker.undefinedSymbol;
  }

  argumentsSymbol(): Symbol {
    return this.checker.argumentsSymbol;
  }

  /** A mapped type's type parameter, constraint, name and template types, resolved as tsc resolves them. */
  mappedTypeComponents(type: Type): {
    typeParameter: Type;
    constraintType: Type;
    nameType: Type | undefined;
    templateType: Type;
  } {
    const c = this.checker;
    const mapped = type as MappedType;
    return {
      typeParameter: getTypeParameterFromMappedType(c, mapped),
      constraintType: getConstraintTypeFromMappedType(c, mapped),
      nameType: getNameTypeFromMappedType(c, mapped),
      templateType: getTemplateTypeFromMappedType(c, mapped),
    };
  }

  // Sorts symbols in the checker's declaration order.
  sortSymbols(symbols: Symbol[]): Symbol[] {
    const c = this.checker;
    return symbols.sort((a, b) => compareSymbols(c, a, b));
  }
}

/** A parsed config as the API answers it (ConfigFileResponse). */
export interface ConfigFileData {
  fileNames: string[];
  options: CompilerOptions;
  projectReferences: ProjectReferenceData[];
  typeAcquisition: TypeAcquisitionData | undefined;
  /** For a config file: its `compileOnSave`, or false. */
  compileOnSave: boolean | undefined;
  /** The config file's JSON, or undefined without one. */
  raw: unknown;
  /** The errors of its options, without those of its syntax. */
  errors: Diagnostic[];
}

export interface ProjectReferenceData {
  path: string;
  originalPath: string;
  circular: boolean;
}

export interface TypeAcquisitionData {
  enable?: boolean;
  include?: string[];
  exclude?: string[];
  disableFilenameBasedTypeAcquisition?: boolean;
}

function configFileDataOf(config: ParsedCommandLine): ConfigFileData {
  const raw = config.raw;
  const rawObject = raw instanceof JsonObject ? raw : undefined;
  const compileOnSave = rawObject?.entries.get('compileOnSave');
  const typeAcquisition = config.typeAcquisition;
  return {
    fileNames: config.fileNames.slice(),
    options: compilerOptionsOf(config.options),
    projectReferences: config.projectReferences.map((reference) => ({
      path: reference.path,
      originalPath: reference.originalPath,
      circular: reference.circular,
    })),
    typeAcquisition:
      rawObject?.entries.has('typeAcquisition') === true && typeAcquisition !== undefined
        ? { ...typeAcquisition }
        : undefined,
    compileOnSave: config.configFile === undefined ? undefined : typeof compileOnSave === 'boolean' && compileOnSave,
    raw: raw === undefined ? undefined : plainJson(raw),
    errors: config.errors.map(apiDiagnosticOf),
  };
}

/** A config file's JSON as plain values, in source order. */
function plainJson(value: JsonValue): unknown {
  if (value instanceof JsonArray) return value.items.map(plainJson);
  if (value instanceof JsonObject) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value.entries) out[key] = plainJson(item);
    return out;
  }
  return value;
}

// Parses a config file without loading its program; undefined if it can't
// be read.
export function parseConfigFile(host: ProjectHost, configFileName: string): ConfigFileData | undefined {
  const config = new ConfigParser(new HostFileSystem(host), host.currentDirectory).parseConfigFile(
    configFileName,
    undefined,
    undefined,
    [],
  );
  return config === undefined ? undefined : configFileDataOf(config);
}

/**
 * The file contents and parsed files a session keeps across snapshots, as tsgo does. A file read
 * once is read again only after the client reports it changed, created or deleted (`fileChanges`) or
 * sends `invalidateAll`; until then it exists with the contents first read. A file reported deleted
 * is missing until the client reports it changed or created, or sends `invalidateAll`. A file read through a symbolic
 * link in node_modules is also invalidated by a change reported for its real path. A parsed file is
 * reused while its name, path, module detection options and text are unchanged: a file parses the same
 * for the same inputs, and binding a bound file does nothing.
 */
export class SessionFiles {
  private readonly contents = new Map<string, string>();
  // Paths the client reported deleted.
  private readonly deleted = new Set<string>();
  // The paths of files read through a symbolic link in node_modules, by real path.
  private readonly linkedPaths = new Map<string, string[]>();
  // Paths `realpath` returned, which are their own real paths.
  private readonly realPaths = new Set<string>();
  private readonly parsed = new Map<string, SourceFile>();
  // The parsed files of live snapshots and leases, by the inputs they were parsed with; a reparsed file's older
  // versions stay while something keeps them.
  private readonly retained = new Map<string, SourceFile[]>();
  // The node IDs of the files the client was told about, assigned on first use. A file parsed again gets a new one,
  // as tsc's node IDs do; a client of `--listen` sees the IDs a new server would give.
  private readonly nodeIds = new Map<SourceFile, number>();
  private nextNodeId = 1;

  constructor(
    private readonly toPath: (fileName: string) => string,
    private readonly useCaseSensitiveFileNames: boolean,
  ) {}

  /** The path of a file name from the compiler, which is absolute and normalized. */
  pathOf(fileName: string): string {
    return this.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
  }

  /** The text of `fileName`, whose path is `path`. */
  readFile(fs: ClientFileSystem, fileName: string, path: string): string | undefined {
    if (this.deleted.has(path)) return undefined;
    const cached = this.contents.get(path);
    if (cached !== undefined) return cached;
    const text = fs.readFile(fileName);
    if (text === undefined) return undefined;
    this.contents.set(path, text);
    if (path.includes('/node_modules/') && !this.realPaths.has(path)) {
      const realPath = this.toPath(fs.realpath(fileName));
      if (realPath !== path) {
        const paths = this.linkedPaths.get(realPath);
        if (paths === undefined) this.linkedPaths.set(realPath, [path]);
        else if (!paths.includes(path)) paths.push(path);
      }
    }
    return text;
  }

  /** The real path of `fileName`, recorded so that reading it later needs no `realpath`. */
  realpath(fs: ClientFileSystem, fileName: string): string {
    const realPath = fs.realpath(fileName);
    this.realPaths.add(this.toPath(realPath));
    return realPath;
  }

  /** Whether `fileName`, whose path is `path`, exists. */
  fileExists(fs: ClientFileSystem, fileName: string, path: string): boolean {
    if (this.deleted.has(path)) return false;
    return this.contents.has(path) || fs.fileExists(fileName);
  }

  /**
   * Forgets the contents of changed, created or deleted files, and marks `deleted` files missing or the
   * others not; returns their paths, with the paths they were read through in node_modules.
   */
  invalidate(fileNames: readonly string[], deleted: boolean): string[] {
    const paths: string[] = [];
    for (const fileName of fileNames) {
      const path = this.toPath(fileName);
      paths.push(path);
      for (const linked of this.linkedPaths.get(path) ?? []) paths.push(linked);
    }
    for (const path of paths) {
      this.contents.delete(path);
      if (deleted) this.deleted.add(path);
      else this.deleted.delete(path);
    }
    return paths;
  }

  /** Forgets the contents of every file, and which files were reported deleted. */
  invalidateAll(): void {
    this.contents.clear();
    this.deleted.clear();
  }

  /** Forgets every file's contents, the deleted and linked paths, and the real paths, keeping the parsed files. */
  reset(): void {
    this.invalidateAll();
    this.linkedPaths.clear();
    this.realPaths.clear();
    this.nodeIds.clear();
    this.nextNodeId = 1;
    this.retained.clear();
  }

  /** The node ID of a parsed file, which names it in API answers (SourceFileDescriptor, getSourceFile). */
  nodeId(file: SourceFile): number {
    let id = this.nodeIds.get(file);
    if (id === undefined) {
      id = this.nextNodeId++;
      this.nodeIds.set(file, id);
    }
    return id;
  }

  /** The parsed file of `text`, reused from an earlier parse with the same inputs. */
  sourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
    text: string,
  ): SourceFile {
    const key = parsedKey(fileName, path, externalModuleIndicatorOptions.jsx, externalModuleIndicatorOptions.force);
    const cached = this.parsed.get(key);
    if (cached !== undefined && cached.text === text) return cached;
    // A file a snapshot or lease still keeps is taken again for the same text, as tsc's parse cache keys files by
    // their text: undoing an edit gives back the earlier file.
    for (const retained of this.retained.get(key) ?? []) {
      if (retained.text === text) {
        this.parsed.set(key, retained);
        return retained;
      }
    }
    const file = parseSourceFile(
      fileName,
      text,
      new ParseOptions(path, ScriptKind.Unknown, externalModuleIndicatorOptions),
    );
    this.parsed.set(key, file);
    return file;
  }

  /**
   * The parsed file of a live snapshot or lease with these inputs, text hash (`sourceFileHash`) and script kind, as
   * tsc's parse cache keys files. `parseOptionsKey` holds the module detection options as `sourceFileParseOptionsKey`
   * gives them. An older version of a file stays available while a snapshot or lease keeps it.
   */
  cachedSourceFile(
    fileName: string,
    path: string,
    parseOptionsKey: number,
    contentHash: string,
    scriptKind: number,
  ): SourceFile | undefined {
    const key = parsedKey(fileName, path, (parseOptionsKey & 1) !== 0, (parseOptionsKey & 2) !== 0);
    for (const file of this.retained.get(key) ?? []) {
      if (file.scriptKind === scriptKind && sourceFileHash(file) === contentHash) return file;
    }
    return undefined;
  }

  /** Keeps only the parsed files of `projects`, the projects of live snapshots, and `files`. */
  retain(projects: readonly Project[], files: readonly SourceFile[]): void {
    const used = new Set<SourceFile>(files);
    for (const project of projects) for (const file of project.sourceFiles()) used.add(file);
    const unused: string[] = [];
    for (const [key, file] of this.parsed) if (!used.has(file)) unused.push(key);
    for (const key of unused) this.parsed.delete(key);
    this.retained.clear();
    for (const file of used) {
      const options = file.externalModuleIndicatorOptions;
      const key = parsedKey(file.fileName, file.path, options.jsx, options.force);
      const versions = this.retained.get(key);
      if (versions === undefined) this.retained.set(key, [file]);
      else versions.push(file);
    }
    const unnamed: SourceFile[] = [];
    for (const file of this.nodeIds.keys()) if (!used.has(file)) unnamed.push(file);
    for (const file of unnamed) this.nodeIds.delete(file);
  }
}

function parsedKey(fileName: string, path: string, jsx: boolean, force: boolean): string {
  return fileName + '\u0000' + path + (jsx ? '\u0000j' : '\u0000') + (force ? 'f' : '');
}

function projectCompilerHost(fs: CachedFileSystem, host: ProjectHost): ProjectCompilerHost {
  return new ProjectCompilerHost(fs, host.currentDirectory, host.defaultLibraryPath, host.files);
}

// A compiler host that takes parsed files from the session's files.
class ProjectCompilerHost extends CompilerHost {
  constructor(
    fs: FileSystem,
    currentDirectory: string,
    defaultLibraryPath: string,
    private readonly files: SessionFiles | undefined,
  ) {
    super(fs, currentDirectory, defaultLibraryPath);
  }

  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    if (this.files === undefined) return super.getSourceFile(fileName, path, externalModuleIndicatorOptions);
    const text = this.fs.readFile(fileName);
    if (text === undefined) return undefined;
    return this.files.sourceFile(fileName, path, externalModuleIndicatorOptions, text);
  }
}

// The client's file system, as the compiler reads it, with the session's file contents. With `seen`, it
// records the paths of the files it reads or looks up.
class HostFileSystem extends FileSystem {
  private readonly fs: ClientFileSystem;
  private readonly files: SessionFiles | undefined;

  constructor(
    host: ProjectHost,
    private readonly seen?: Set<string>,
  ) {
    super(host.useCaseSensitiveFileNames);
    this.fs = host.fs;
    this.files = host.files;
  }

  fileExists(path: string): boolean {
    if (this.files === undefined) return this.fs.fileExists(path);
    const key = this.files.pathOf(path);
    this.seen?.add(key);
    return this.files.fileExists(this.fs, path, key);
  }

  directoryExists(path: string): boolean {
    return this.fs.directoryExists(path);
  }

  readFile(path: string): string | undefined {
    if (this.files === undefined) return this.fs.readFile(path);
    const key = this.files.pathOf(path);
    this.seen?.add(key);
    return this.files.readFile(this.fs, path, key);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const entries = this.fs.getAccessibleEntries(path);
    return new DirectoryEntries(entries.files, entries.directories, undefined);
  }

  realpath(path: string): string {
    return this.files !== undefined ? this.files.realpath(this.fs, path) : this.fs.realpath(path);
  }
}

export type IntrinsicTypeName =
  | 'any'
  | 'string'
  | 'number'
  | 'boolean'
  | 'void'
  | 'undefined'
  | 'null'
  | 'never'
  | 'unknown'
  | 'bigint'
  | 'symbol';

// Source files.

export function fileName(file: SourceFile): string {
  return file.fileName;
}

export function filePath(file: SourceFile): string {
  return file.path;
}

// Whether two versions of a file have the same contents.
export function sameFileContent(a: SourceFile, b: SourceFile): boolean {
  return a === b || a.text === b.text;
}

// Encodes a source file in the API's binary AST format. The encoding's header names the file by its node ID
// (`SessionFiles.nodeId`), as tsc's getSourceFile answer does.
export function encodeSourceFile(file: SourceFile, nodeId: number): Uint8Array {
  return withSourceFileId(encodeFile(file), nodeId);
}

// The file's encoding, made on first use and kept on the file. A parsed file's encoding does not change: lazily
// parsed JSDoc encodes the same whenever it is parsed, and its node ID stays.
export function keptEncodingOf(file: SourceFile, nodeId: number): Uint8Array {
  return withSourceFileId((file.apiEncoding ??= encodeFile(file)), nodeId);
}

// Header bytes 44 to 51: the source file ID, a little-endian u64.
function withSourceFileId(data: Uint8Array, id: number): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setUint32(44, id >>> 0, true);
  view.setUint32(48, Math.floor(id / 0x100000000), true);
  return data;
}

// Decodes a node from the API's binary AST format; throws on malformed data.
export function decodeNode(data: Uint8Array): Node {
  return decodeNodes(data);
}

// Prints a decoded node.
export function printNode(
  node: Node,
  preserveSourceNewlines: boolean,
  neverAsciiEscape: boolean,
  terminateUnterminatedLiterals: boolean,
): string {
  const options = new PrinterOptions();
  options.preserveSourceNewlines = preserveSourceNewlines;
  options.neverAsciiEscape = neverAsciiEscape;
  options.terminateUnterminatedLiterals = terminateUnterminatedLiterals;
  return new Printer(options, new EmitContext()).emit(node, undefined);
}

// Nodes.

export function nodeKind(node: Node): number {
  return node.kind;
}

export function nodePos(node: Node): number {
  return node.pos;
}

export function sourceFileOfNode(node: Node): SourceFile {
  return getSourceFileOfNode(node);
}

const nodeIndexTables = new Map<SourceFile, NodeIndexTable>();

function nodeIndexTable(file: SourceFile): NodeIndexTable {
  let table = nodeIndexTables.get(file);
  if (table === undefined) {
    table = new NodeIndexTable(file);
    nodeIndexTables.set(file, table);
  }
  return table;
}

// The node's position in its file's node index table; node handles use it.
export function nodeIndex(node: Node): number {
  return nodeIndexTable(getSourceFileOfNode(node)).indexOf(node);
}

export function nodeAtIndex(file: SourceFile, index: number): Node | undefined {
  const nodes = nodeIndexTable(file).nodes;
  return index < nodes.length ? nodes[index] : undefined;
}

// Source files as API references name them (SourceFileDescriptor).

/** The xxh3-128 hash of the file's text, as 32 hexadecimal digits, computed once per file. */
export function sourceFileHash(file: SourceFile): string {
  if (file.apiContentHash === '') file.apiContentHash = toHex(hash128String(file.text));
  return file.apiContentHash;
}

/** The file's module detection options as tsc encodes them: 1 for `jsx`, 2 for `force`. */
export function sourceFileParseOptionsKey(file: SourceFile): number {
  const options = file.externalModuleIndicatorOptions;
  return (options.jsx ? 1 : 0) | (options.force ? 2 : 0);
}

export function sourceFileScriptKind(file: SourceFile): number {
  return file.scriptKind;
}

/**
 * The source file that owns a symbol's identity for clients, or undefined when its snapshot owns it: a transient
 * symbol (a merged or checker-made one), or one without a declaring file. A class's prototype, which has no
 * declaration, belongs to its class's file.
 */
export function symbolOwnerFile(symbol: Symbol): SourceFile | undefined {
  if ((symbol.flags & SymbolFlags.Transient) !== 0) return undefined;
  let declaring: Symbol | undefined = symbol;
  if (getDeclarations(symbol).length === 0) {
    if ((symbol.flags & SymbolFlags.Prototype) === 0) return undefined;
    declaring = symbol.parent;
    if (declaring === undefined || (declaring.flags & SymbolFlags.Transient) !== 0) return undefined;
  }
  const declarations = getDeclarations(declaring);
  return declarations.length === 0 ? undefined : getSourceFileOfNode(declarations[0]);
}

/**
 * The symbols a file owns, by id: those of its nodes (their symbols, local symbols and locals), their parents,
 * export symbols, members and exports, its global exports and its pattern ambient modules, as tsc indexes them to
 * resolve file references.
 */
export function fileSymbolIndex(file: SourceFile): Map<number, Symbol> {
  const index = file.apiSymbolIndex;
  if (index !== undefined) return index;
  const symbols = new Map<number, Symbol>();
  const add = (symbol: Symbol | undefined): void => {
    if (symbol === undefined || (symbol.flags & SymbolFlags.Transient) !== 0) return;
    if (symbolOwnerFile(symbol) !== file) return;
    const id = getSymbolId(symbol);
    if (symbols.has(id)) return;
    symbols.set(id, symbol);
    add(symbol.parent);
    add(symbol.exportSymbol);
    if (symbol.members !== undefined) for (const member of symbol.members.values()) add(member);
    if (symbol.exports !== undefined) for (const exported of symbol.exports.values()) add(exported);
  };
  for (const node of nodeIndexTable(file).nodes) {
    if (node === undefined) continue;
    add(getSymbol(node));
    add(getLocalSymbol(node));
    const locals = getLocals(node);
    if (locals !== undefined) for (const local of locals.values()) add(local);
  }
  if (file.globalExports !== undefined) for (const exported of file.globalExports.values()) add(exported);
  for (const module of file.patternAmbientModules) add(module.symbol);
  file.apiSymbolIndex = symbols;
  return symbols;
}

// Symbols.

export function symbolId(symbol: Symbol): number {
  return getSymbolId(symbol);
}

export function symbolName(symbol: Symbol): string {
  return escapeSymbolName(symbol.name);
}

// Internal names start with U+FFFE; the API writes them with `__`, and doubles
// the leading underscore of names that already start with `__`.
function escapeSymbolName(name: string): string {
  if (name.charCodeAt(0) === 0xfffe) return '__' + name.slice(1);
  if (name.startsWith('__')) return '_' + name;
  return name;
}

export function symbolFlags(symbol: Symbol): number {
  return symbol.flags >>> 0;
}

export function symbolCheckFlags(symbol: Symbol): number {
  return symbol.checkFlags >>> 0;
}

export function symbolDeclarations(symbol: Symbol): Node[] {
  return getDeclarations(symbol).slice();
}

export function symbolValueDeclaration(symbol: Symbol): Node | undefined {
  return symbol.valueDeclaration;
}

export function symbolParent(symbol: Symbol): Symbol | undefined {
  return symbol.parent;
}

export function symbolExportSymbol(symbol: Symbol): Symbol | undefined {
  return symbol.exportSymbol;
}

export function symbolMembers(symbol: Symbol): Symbol[] {
  return tableSymbols(symbol.members);
}

export function symbolExports(symbol: Symbol): Symbol[] {
  return tableSymbols(symbol.exports);
}

function tableSymbols(table: SymbolTable | undefined): Symbol[] {
  return table === undefined ? [] : Array.from(table.values());
}

// Types.

export function typeId(type: Type): number {
  return type.id;
}

export function typeFlags(type: Type): number {
  return type.flags >>> 0;
}

export function objectFlags(type: Type): number {
  return type.objectFlags >>> 0;
}

export function typeSymbol(type: Type): Symbol | undefined {
  return type.symbol;
}

export function aliasSymbol(type: Type): Symbol | undefined {
  return type.alias?.symbol;
}

export function aliasTypeArguments(type: Type): Type[] {
  const alias = type.alias;
  return alias === undefined ? [] : alias.typeArguments.slice();
}

export function literalTypeValue(type: Type): LiteralValue {
  const literal = type as LiteralType;
  const flags = type.flags;
  if ((flags & TypeFlags.StringLiteral) !== 0) return literal.stringValue;
  if ((flags & TypeFlags.NumberLiteral) !== 0) return literal.numberValue;
  if ((flags & TypeFlags.BigIntLiteral) !== 0) return { bigint: literal.stringValue };
  if ((flags & TypeFlags.BooleanLiteral) !== 0) return literal.stringValue === 'true';
  return null;
}

export function freshType(type: Type): Type | undefined {
  return (type as LiteralType).freshType;
}

export function regularType(type: Type): Type | undefined {
  return (type as LiteralType).regularType;
}

// The target of a type reference, index type or string mapping type.
export function typeTarget(type: Type): Type | undefined {
  const flags = type.flags;
  if ((flags & TypeFlags.Index) !== 0) return (type as IndexType).target;
  if ((flags & TypeFlags.StringMapping) !== 0) return (type as StringMappingType).target;
  if ((flags & TypeFlags.Object) !== 0 && (type.objectFlags & ObjectFlags.Reference) !== 0) {
    return (type as TypeReference).target;
  }
  return undefined;
}

export function referenceTarget(type: Type): Type | undefined {
  return (type as TypeReference).target;
}

export function tupleInfo(type: Type): TupleInfo {
  const tuple = type as TupleType;
  return {
    elementFlags: tuple.elementInfos.map((info) => info.flags),
    fixedLength: tuple.fixedLength,
    readonly: tuple.readonly,
  };
}

export function typeParameters(type: Type): Type[] {
  return (type as InterfaceType).typeParameters();
}

export function outerTypeParameters(type: Type): Type[] {
  return (type as InterfaceType).outerTypeParameters();
}

export function localTypeParameters(type: Type): Type[] {
  return (type as InterfaceType).localTypeParameters();
}

// The members of a union, intersection or template literal type.
export function typesOfType(type: Type): Type[] {
  if ((type.flags & TypeFlags.TemplateLiteral) !== 0) return (type as TemplateLiteralType).types.slice();
  return (type as UnionOrIntersectionType).types.slice();
}

export function indexedAccessObjectType(type: Type): Type | undefined {
  return (type as IndexedAccessType).objectType;
}

export function indexedAccessIndexType(type: Type): Type | undefined {
  return (type as IndexedAccessType).indexType;
}

export function conditionalCheckType(type: Type): Type | undefined {
  return (type as ConditionalType).checkType;
}

export function conditionalExtendsType(type: Type): Type | undefined {
  return (type as ConditionalType).extendsType;
}

export function substitutionBaseType(type: Type): Type | undefined {
  return (type as SubstitutionType).baseType;
}

export function substitutionConstraint(type: Type): Type | undefined {
  return (type as SubstitutionType).constraint;
}

export function templateLiteralTexts(type: Type): string[] {
  return (type as TemplateLiteralType).texts.slice();
}

export function isThisType(type: Type): boolean {
  return (type as TypeParameter).isThisType;
}

export function intrinsicName(type: Type): string {
  return (type as IntrinsicType).intrinsicName;
}

export function isTupleType(type: Type): boolean {
  return checkerIsTupleType(type);
}

/** Whether `type` is a tuple type itself, the target of the references to it. */
export function isTupleTypeTarget(type: Type): boolean {
  return checkerIsTupleType(type) && (type as TypeReference).target === type;
}

/** The declarations of a tuple type's labeled elements, by element; undefined for an element without a label. */
export function tupleLabeledDeclarations(type: Type): (Node | undefined)[] {
  return (type as TupleType).elementInfos.map((info) => info.labeledDeclaration);
}

export function interfaceThisType(type: Type): Type | undefined {
  return (type as InterfaceType).thisType;
}

export function isMappedType(type: Type): boolean {
  return (type.objectFlags & ObjectFlags.Mapped) !== 0;
}

// Signatures.

export function signatureId(signature: Signature): number {
  return signature.id;
}

export function signatureFlags(signature: Signature): number {
  return signature.flags >>> 0;
}

export function signatureDeclaration(signature: Signature): Node | undefined {
  return signature.declaration;
}

export function signatureTypeParameters(signature: Signature): Type[] {
  return signature.typeParameters.slice();
}

export function signatureParameters(signature: Signature): Symbol[] {
  return signature.parameters.slice();
}

export function signatureThisParameter(signature: Signature): Symbol | undefined {
  return signature.thisParameter;
}

export function signatureTarget(signature: Signature): Signature | undefined {
  return signature.target;
}

// Conversions.

// Describes an exception thrown by the compiler, like a Go panic message.
export function panicMessage(e: unknown): string {
  return 'panic: ' + (e instanceof Error ? e.message : String(e));
}

// Diagnostics.

function apiDiagnosticOf(d: CompilerDiagnostic): Diagnostic {
  const file = d.file;
  let pos = d.pos;
  let end = d.end;
  let startPosition: DiagnosticPosition | undefined = undefined;
  let endPosition: DiagnosticPosition | undefined = undefined;
  let sourceLines: DiagnosticSourceLine[] = [];
  if (file !== undefined) {
    const length = file.text.length;
    pos = Math.max(0, Math.min(pos, length));
    end = Math.max(pos, Math.min(end, length));
    const lineStarts = file.getLineStarts();
    const startLine = lineOfPosition(lineStarts, pos);
    const endLine = lineOfPosition(lineStarts, end);
    startPosition = { line: startLine, character: pos - lineStarts[startLine] };
    endPosition = { line: endLine, character: end - lineStarts[endLine] };
    sourceLines = diagnosticSourceLines(file.text, lineStarts, startLine, endLine);
  }
  return {
    fileName: file?.fileName,
    pos,
    end,
    startPosition,
    endPosition,
    sourceLines,
    code: d.code,
    category: d.category,
    text: d.localize(Locale.Default),
    reportsUnnecessary: d.reportsUnnecessary,
    reportsDeprecated: d.reportsDeprecated,
    messageChain: d.messageChain.map(apiDiagnosticOf),
    relatedInformation: d.relatedInformation.map(apiDiagnosticOf),
  };
}

/** The line of `position`: the last line starting at or before it. */
function lineOfPosition(lineStarts: readonly number[], position: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (lineStarts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

function diagnosticSourceLines(
  text: string,
  lineStarts: readonly number[],
  firstLine: number,
  lastLine: number,
): DiagnosticSourceLine[] {
  const lines: number[] = [];
  if (lastLine - firstLine >= 4) lines.push(firstLine, firstLine + 1, lastLine - 1, lastLine);
  else for (let line = firstLine; line <= lastLine; line++) lines.push(line);
  return lines.map((line) => ({
    line,
    text: text.slice(lineStarts[line], line + 1 < lineStarts.length ? lineStarts[line + 1] : text.length),
  }));
}
