// An API session: snapshots of opened projects, and the handles given to the
// client for symbols, types, signatures and nodes within each snapshot.
import * as backend from './backend.js';
import type { Node, Project, Signature, SourceFile, Symbol, Type } from './backend.js';
import { ApiError, ClientError, InvalidRequestError } from './errors.js';
import type { Reply, Response } from './connection.js';
import type { ClientFileSystem } from './fs.js';
import { normalizeAbsolutePath, toPath, uriToFileName } from './paths.js';
import { literalValueResponse } from './proto.js';
import type * as proto from './proto.js';
import { decodeText } from './protocol.js';

export interface SessionOptions {
  fs: ClientFileSystem;
  currentDirectory: string;
  defaultLibraryPath: string;
  useCaseSensitiveFileNames: boolean;
}

// A loaded tsconfig.json. Snapshots share it until its files change.
interface LoadedProject {
  id: string;
  configFileName: string;
  project: Project;
}

interface OpenFile {
  fileName: string;
  configPath: string | undefined;
}

// The project of open files outside every config file, as in tsgo.
const inferredProjectName = '/dev/null/inferred';

// Types and signatures have per-checker ids, so each project has its own table.
interface Registry {
  types: Map<number, Type>;
  signatures: Map<number, Signature>;
}

class SnapshotData {
  readonly symbols = new Map<number, Symbol>();
  // The project each symbol was first returned from.
  readonly symbolProjects = new Map<number, string>();
  readonly registries = new Map<string, Registry>();

  constructor(
    readonly id: number,
    // Sorted by config file name.
    readonly projects: LoadedProject[],
  ) {}

  project(id: string | undefined): LoadedProject {
    for (const p of this.projects) if (p.id === id) return p;
    throw new ClientError(`project ${id ?? ''} not found`);
  }

  registry(projectId: string): Registry {
    let registry = this.registries.get(projectId);
    if (registry === undefined) {
      registry = { types: new Map(), signatures: new Map() };
      this.registries.set(projectId, registry);
    }
    return registry;
  }
}

// Type flags and object flags that decide which type data is sent.
const enum TypeFlags {
  Freshable = 80896,
  Literal = 15360,
  Object = 1048576,
  UnionOrIntersection = 402653184,
  Index = 2097152,
  IndexedAccess = 33554432,
  Conditional = 67108864,
  Substitution = 16777216,
  TemplateLiteral = 4194304,
  StringMapping = 8388608,
  TypeParameter = 524288,
  Intrinsic = 393983,
}

const enum ObjectFlags {
  ClassOrInterface = 3,
  Reference = 4,
  Tuple = 8,
}

// TypeFormatFlags.AllowUniqueESSymbolType | UseAliasDefinedOutsideCurrentScope
const defaultTypeFormatFlags = 0x100000 | 0x4000;

interface TimingEntry {
  method: string;
  processingTimeMs: number;
  timestamp: number;
}

interface ServerTiming {
  enabled: boolean;
  totals: { requestCount: number; totalProcessingTimeMs: number };
  recentRequests: TimingEntry[];
}

// A per-request query context: the snapshot and the project it targets.
class Query {
  constructor(
    readonly snapshot: SnapshotData,
    readonly loaded: LoadedProject,
  ) {}

  get project(): Project {
    return this.loaded.project;
  }

  get projectId(): string {
    return this.loaded.id;
  }

  type(id: number | undefined): Type {
    return resolveType(this.snapshot, this.projectId, id);
  }

  symbol(id: number | undefined): Symbol {
    return resolveSymbol(this.snapshot, id);
  }

  signature(id: number | undefined): Signature {
    return resolveSignature(this.snapshot, this.projectId, id);
  }

  node(handle: proto.NodeHandle | undefined): Node {
    return resolveNode(this.project, handle ?? '');
  }

  typeResponse(type: Type | undefined): proto.TypeResponse | null {
    return type === undefined ? null : typeResponse(this.snapshot, this.projectId, type);
  }

  typeResponses(types: Type[]): proto.TypeResponse[] {
    return types.map((t) => typeResponse(this.snapshot, this.projectId, t));
  }

  symbolResponse(symbol: Symbol | undefined): proto.SymbolResponse | null {
    return symbol === undefined ? null : symbolResponse(this.snapshot, symbol, this.projectId);
  }

  symbolResponses(symbols: Symbol[]): proto.SymbolResponse[] {
    return symbols.map((s) => symbolResponse(this.snapshot, s, this.projectId));
  }

  signatureResponse(signature: Signature | undefined): proto.SignatureResponse | null {
    return signature === undefined ? null : signatureResponse(this.snapshot, this.projectId, signature);
  }

  sourceFile(file: proto.DocumentIdentifier): SourceFile {
    const sourceFile = this.project.sourceFile(documentFileName(file));
    if (sourceFile === undefined) throw new ClientError(`source file not found: ${documentString(file)}`);
    return sourceFile;
  }

  optionalSourceFile(file: proto.DocumentIdentifier | null | undefined): SourceFile | undefined {
    return file === undefined || file === null ? undefined : this.sourceFile(file);
  }
}

export class Session {
  private readonly snapshots = new Map<number, SnapshotData>();
  private latestSnapshot = 0;
  private nextSnapshotId = 1;
  // Loaded configured projects, by config path.
  private readonly loaded = new Map<string, LoadedProject>();
  // Config paths the client opened.
  private readonly openProjects = new Set<string>();
  // Files the client opened, by path, with the config path of their project;
  // undefined puts the file in the inferred project.
  private readonly openFiles = new Map<string, OpenFile>();
  private inferred: LoadedProject | undefined;
  private timing: ServerTiming | undefined;
  // File contents and parsed files kept across snapshots.
  private readonly files: backend.SessionFiles;

  constructor(
    private readonly options: SessionOptions,
    collectTiming: boolean,
  ) {
    this.files = new backend.SessionFiles((fileName) => this.toPath(fileName), options.useCaseSensitiveFileNames);
    if (collectTiming) {
      this.timing = { enabled: true, totals: { requestCount: 0, totalProcessingTimeMs: 0 }, recentRequests: [] };
    }
  }

  // Ends a client's session (`--listen`): drops its snapshots, projects, open files and timing, and forgets the file
  // contents and real paths it read, so the next client sees what a new server would. Parsed files stay, and a later
  // project reuses one whose text is unchanged.
  reset(): void {
    this.snapshots.clear();
    this.latestSnapshot = 0;
    this.nextSnapshotId = 1;
    this.loaded.clear();
    this.openProjects.clear();
    this.openFiles.clear();
    this.inferred = undefined;
    this.files.reset();
    this.resetServerTiming();
  }

  // Handles a request whose payload is its JSON params, or for `echo`, any bytes.
  handle(method: string, payload: Uint8Array): Response {
    if (method === 'getServerTiming') return { ok: true, reply: JSON.stringify(this.serverTiming()) };
    if (method === 'resetServerTiming') {
      this.resetServerTiming();
      return { ok: true, reply: 'null' };
    }
    const start = this.timing === undefined ? 0 : Date.now();
    try {
      // As tsgo, echo returns the payload's bytes as they are, which need not be UTF-8 text.
      if (method === 'echo') return { ok: true, reply: payload.slice() };
      return { ok: true, reply: this.dispatch(method, decodeText(payload)) };
    } catch (e) {
      // Classified here: natively, a caught value passed on loses its class.
      // Compiler failures read like Go panics.
      if (e instanceof ApiError) return { ok: false, error: e.message };
      if (e instanceof SyntaxError) {
        return {
          ok: false,
          error: new InvalidRequestError(`failed to unmarshal ${method} params: ${e.message}`).message,
        };
      }
      return { ok: false, error: backend.panicMessage(e) };
    } finally {
      if (this.timing !== undefined) this.record(method, Date.now() - start);
    }
  }

  private dispatch(method: string, params: string): Reply {
    switch (method) {
      case 'ping':
        return '"pong"';
      case 'initialize':
        return JSON.stringify(this.initialize());
      case 'updateSnapshot':
        return JSON.stringify(this.updateSnapshot(JSON.parse(params) as proto.UpdateSnapshotParams | null));
      case 'release':
        return JSON.stringify(this.release(JSON.parse(params) as proto.ReleaseParams | null));
      case 'parseConfigFile':
        return JSON.stringify(this.parseConfigFile(JSON.parse(params) as proto.FileParams));
      case 'getDefaultProjectForFile':
        return JSON.stringify(this.defaultProjectForFile(JSON.parse(params) as proto.SnapshotFileParams));
      case 'getSourceFile':
        return this.sourceFile(JSON.parse(params) as proto.ProjectFileParams);
      case 'getSourceFileNames':
        return JSON.stringify(this.sourceFileNames(JSON.parse(params) as proto.ProjectParams));
      case 'getSourceFileMetadata':
        return JSON.stringify(this.sourceFileMetadata(JSON.parse(params) as proto.ProjectFileParams));
      case 'getSymbolAtPosition':
        return JSON.stringify(this.symbolAtPosition(JSON.parse(params) as proto.PositionParams));
      case 'getSymbolsAtPositions':
        return JSON.stringify(this.symbolsAtPositions(JSON.parse(params) as proto.PositionsParams));
      case 'getSymbolAtLocation':
        return JSON.stringify(this.symbolAtLocation(JSON.parse(params) as proto.LocationParams));
      case 'getSymbolsAtLocations':
        return JSON.stringify(this.symbolsAtLocations(JSON.parse(params) as proto.LocationsParams));
      case 'getTypeOfSymbol':
        return JSON.stringify(this.typeOfSymbol(JSON.parse(params) as proto.SymbolParams, false));
      case 'getDeclaredTypeOfSymbol':
        return JSON.stringify(this.typeOfSymbol(JSON.parse(params) as proto.SymbolParams, true));
      case 'getTypesOfSymbols':
        return JSON.stringify(this.typesOfSymbols(JSON.parse(params) as proto.SymbolsParams));
      case 'resolveName':
        return JSON.stringify(this.resolveName(JSON.parse(params) as proto.ResolveNameParams));
      case 'getSignaturesOfTypes':
        return JSON.stringify(this.signaturesOfTypes(JSON.parse(params) as proto.SignaturesOfTypesParams));
      case 'getSignaturesOfType':
        return JSON.stringify(this.signaturesOfType(JSON.parse(params) as proto.SignaturesOfTypeParams));
      case 'getResolvedSignature':
        return JSON.stringify(this.resolvedSignature(JSON.parse(params) as proto.LocationParams));
      case 'getResolvedSignatures':
        return JSON.stringify(this.resolvedSignatures(JSON.parse(params) as proto.LocationsParams));
      case 'getContextualTypes':
        return JSON.stringify(this.contextualTypes(JSON.parse(params) as proto.LocationsParams));
      case 'getTypeAtLocation':
        return JSON.stringify(this.typeAtLocation(JSON.parse(params) as proto.LocationParams));
      case 'getTypeAtLocations':
        return JSON.stringify(this.typeAtLocations(JSON.parse(params) as proto.LocationsParams));
      case 'getTypeAtPosition':
        return JSON.stringify(this.typeAtPosition(JSON.parse(params) as proto.PositionParams));
      case 'getTypesAtPositions':
        return JSON.stringify(this.typesAtPositions(JSON.parse(params) as proto.PositionsParams));
      case 'getParentOfSymbol':
      case 'getExportSymbolOfSymbol':
        return JSON.stringify(this.symbolOfSymbol(method, JSON.parse(params) as proto.ObjectParams));
      case 'getMembersOfSymbol':
      case 'getExportsOfSymbol':
        return JSON.stringify(this.symbolTableOfSymbol(method, JSON.parse(params) as proto.ObjectParams));
      case 'getSymbolOfType':
      case 'getAliasSymbolOfType':
        return JSON.stringify(this.symbolOfType(method, JSON.parse(params) as proto.ObjectParams));
      case 'getTargetOfType':
      case 'getFreshTypeOfType':
      case 'getRegularTypeOfType':
      case 'getObjectTypeOfType':
      case 'getIndexTypeOfType':
      case 'getCheckTypeOfType':
      case 'getExtendsTypeOfType':
      case 'getBaseTypeOfType':
      case 'getConstraintOfType':
        return JSON.stringify(this.typeOfType(method, JSON.parse(params) as proto.ObjectParams));
      case 'getTypesOfType':
      case 'getTypeParametersOfType':
      case 'getOuterTypeParametersOfType':
      case 'getLocalTypeParametersOfType':
      case 'getAliasTypeArgumentsOfType':
        return JSON.stringify(this.typesOfType(method, JSON.parse(params) as proto.ObjectParams));
      case 'getTypeParametersOfSignature':
        return JSON.stringify(this.typeParametersOfSignature(JSON.parse(params) as proto.ObjectParams));
      case 'getParametersOfSignature':
        return JSON.stringify(this.parametersOfSignature(JSON.parse(params) as proto.ObjectParams));
      case 'getThisParameterOfSignature':
        return JSON.stringify(this.thisParameterOfSignature(JSON.parse(params) as proto.ObjectParams));
      case 'getTargetOfSignature':
        return JSON.stringify(this.targetOfSignature(JSON.parse(params) as proto.ObjectParams));
      case 'getContextualType':
        return JSON.stringify(this.contextualType(JSON.parse(params) as proto.LocationParams));
      case 'getBaseTypesOfLiteralTypes':
        return JSON.stringify(this.baseTypesOfLiteralTypes(JSON.parse(params) as proto.TypesParams));
      case 'getBaseTypeOfLiteralType':
      case 'getNonNullableType':
      case 'getWidenedType':
      case 'getApparentType':
      case 'getConstraintOfTypeParameter':
      case 'getBaseConstraintOfType':
        return JSON.stringify(this.checkerTypeOfType(method, JSON.parse(params) as proto.TypeParams));
      case 'getTypeFromTypeNode':
        return JSON.stringify(this.typeFromTypeNode(JSON.parse(params) as proto.LocationParams));
      case 'getParameterType':
        return JSON.stringify(this.parameterType(JSON.parse(params) as proto.ParameterTypeParams));
      case 'isArrayLikeType':
      case 'isArrayType':
      case 'isTupleType':
        return JSON.stringify(this.typePredicate(method, JSON.parse(params) as proto.TypeParams));
      case 'isArrayTypes':
      case 'isTupleTypes':
        return JSON.stringify(this.typePredicates(method, JSON.parse(params) as proto.TypesParams));
      case 'isTypeAssignableTo':
        return JSON.stringify(this.isTypeAssignableTo(JSON.parse(params) as proto.AssignabilityParams));
      case 'getShorthandAssignmentValueSymbol':
        return JSON.stringify(this.shorthandAssignmentValueSymbol(JSON.parse(params) as proto.LocationParams));
      case 'getTypeOfSymbolAtLocation':
        return JSON.stringify(this.typeOfSymbolAtLocation(JSON.parse(params) as proto.SymbolAtLocationParams));
      case 'typeToTypeNode':
        return this.typeToTypeNode(JSON.parse(params) as proto.TypeToTypeNodeParams);
      case 'signatureToSignatureDeclaration':
        return this.signatureToSignatureDeclaration(JSON.parse(params) as proto.SignatureToDeclarationParams);
      case 'typeToString':
        return JSON.stringify(this.typeToString(JSON.parse(params) as proto.TypeToTypeNodeParams));
      case 'printNode':
        return JSON.stringify(this.printNode(JSON.parse(params) as proto.PrintNodeParams));
      case 'isContextSensitive':
        return JSON.stringify(this.isContextSensitive(JSON.parse(params) as proto.LocationParams));
      case 'getReturnTypeOfSignature':
      case 'getRestTypeOfSignature':
        return JSON.stringify(this.typeOfSignature(method, JSON.parse(params) as proto.SignatureParams));
      case 'getReturnTypesOfSignatures':
        return JSON.stringify(this.returnTypesOfSignatures(JSON.parse(params) as proto.SignaturesParams));
      case 'getTypePredicateOfSignature':
        return JSON.stringify(this.typePredicateOfSignature(JSON.parse(params) as proto.SignatureParams));
      case 'getBaseTypes':
      case 'getTypeArguments':
        return JSON.stringify(this.checkerTypesOfType(method, JSON.parse(params) as proto.TypeParams));
      case 'getPropertiesOfType':
        return JSON.stringify(this.propertiesOfType(JSON.parse(params) as proto.TypeParams));
      case 'getPropertiesOfTypes':
        return JSON.stringify(this.propertiesOfTypes(JSON.parse(params) as proto.TypesParams));
      case 'getPropertyOfType':
        return JSON.stringify(this.propertyOfType(JSON.parse(params) as proto.NamedTypeParams));
      case 'getIndexInfosOfType':
        return JSON.stringify(this.indexInfosOfType(JSON.parse(params) as proto.TypeParams));
      case 'getTrueTypeOfConditionalType':
      case 'getFalseTypeOfConditionalType':
        return JSON.stringify(this.branchOfConditionalType(method, JSON.parse(params) as proto.ObjectParams));
      case 'getConstantValue':
        return JSON.stringify(this.constantValue(JSON.parse(params) as proto.LocationParams));
      case 'getConstantValues':
        return JSON.stringify(this.constantValues(JSON.parse(params) as proto.LocationsParams));
      case 'getSignatureFromDeclaration':
        return JSON.stringify(this.signatureFromDeclaration(JSON.parse(params) as proto.LocationParams));
      case 'getSignaturesFromDeclarations':
        return JSON.stringify(this.signaturesFromDeclarations(JSON.parse(params) as proto.LocationsParams));
      case 'getExportSpecifierLocalTargetSymbol':
        return JSON.stringify(this.exportSpecifierLocalTargetSymbol(JSON.parse(params) as proto.LocationParams));
      case 'getAliasedSymbol':
      case 'getImmediateAliasedSymbol':
        return JSON.stringify(this.aliasedSymbol(method, JSON.parse(params) as proto.SymbolParams));
      case 'getAliasedSymbols':
        return JSON.stringify(this.aliasedSymbols(JSON.parse(params) as proto.SymbolsParams));
      case 'getExportsOfModule':
        return JSON.stringify(this.exportsOfModule(JSON.parse(params) as proto.SymbolParams));
      case 'getMemberInModuleExports':
        return JSON.stringify(this.memberInModuleExports(JSON.parse(params) as proto.NamedSymbolParams));
      case 'getAnyType':
        return JSON.stringify(this.intrinsicType('any', JSON.parse(params) as proto.ProjectParams));
      case 'getStringType':
        return JSON.stringify(this.intrinsicType('string', JSON.parse(params) as proto.ProjectParams));
      case 'getNumberType':
        return JSON.stringify(this.intrinsicType('number', JSON.parse(params) as proto.ProjectParams));
      case 'getBooleanType':
        return JSON.stringify(this.intrinsicType('boolean', JSON.parse(params) as proto.ProjectParams));
      case 'getVoidType':
        return JSON.stringify(this.intrinsicType('void', JSON.parse(params) as proto.ProjectParams));
      case 'getUndefinedType':
        return JSON.stringify(this.intrinsicType('undefined', JSON.parse(params) as proto.ProjectParams));
      case 'getNullType':
        return JSON.stringify(this.intrinsicType('null', JSON.parse(params) as proto.ProjectParams));
      case 'getNeverType':
        return JSON.stringify(this.intrinsicType('never', JSON.parse(params) as proto.ProjectParams));
      case 'getUnknownType':
        return JSON.stringify(this.intrinsicType('unknown', JSON.parse(params) as proto.ProjectParams));
      case 'getBigIntType':
        return JSON.stringify(this.intrinsicType('bigint', JSON.parse(params) as proto.ProjectParams));
      case 'getESSymbolType':
        return JSON.stringify(this.intrinsicType('symbol', JSON.parse(params) as proto.ProjectParams));
      case 'getWellKnownSymbols':
        return JSON.stringify(this.wellKnownSymbols(JSON.parse(params) as proto.ProjectParams));
      case 'getSyntacticDiagnostics':
        return JSON.stringify(this.fileDiagnostics('syntactic', JSON.parse(params) as proto.OptionalFileParams));
      case 'getBindDiagnostics':
        return JSON.stringify(this.fileDiagnostics('bind', JSON.parse(params) as proto.OptionalFileParams));
      case 'getSemanticDiagnostics':
        return JSON.stringify(this.fileDiagnostics('semantic', JSON.parse(params) as proto.OptionalFileParams));
      case 'getSuggestionDiagnostics':
        return JSON.stringify(this.fileDiagnostics('suggestion', JSON.parse(params) as proto.OptionalFileParams));
      case 'getDeclarationDiagnostics':
        return JSON.stringify(this.fileDiagnostics('declaration', JSON.parse(params) as proto.OptionalFileParams));
      case 'getDiagnosticsOfCheckedFiles':
        return JSON.stringify(this.diagnosticsOfCheckedFiles(JSON.parse(params) as proto.FilesParams));
      case 'getConfigFileParsingDiagnostics':
        return JSON.stringify(this.projectDiagnostics('config', JSON.parse(params) as proto.ProjectParams));
      case 'getProgramDiagnostics':
        return JSON.stringify(this.projectDiagnostics('program', JSON.parse(params) as proto.ProjectParams));
      case 'getGlobalDiagnostics':
        return JSON.stringify(this.projectDiagnostics('global', JSON.parse(params) as proto.ProjectParams));
      case 'getCompletionsAtPosition':
        return JSON.stringify(this.completionsAtPosition(JSON.parse(params) as proto.CompletionsParams));
      case 'getJsDocTags':
        return JSON.stringify(this.jsDocTags(JSON.parse(params) as proto.SymbolParams));
      case 'getDocumentationComment':
        return JSON.stringify(this.documentationComment(JSON.parse(params) as proto.SymbolParams));
      case 'getReferencesToSymbolInFile':
        return JSON.stringify(this.referencesToSymbolInFile(JSON.parse(params) as proto.SymbolFileParams));
      case 'getReferencedSymbolsForNode':
        return JSON.stringify(this.referencedSymbolsForNode(JSON.parse(params) as proto.ReferencedSymbolsParams));
      case 'getSignatureUsages':
        return JSON.stringify(this.signatureUsages(JSON.parse(params) as proto.SignatureUsagesParams));
      case 'startCPUProfile':
      case 'stopCPUProfile':
      case 'saveHeapProfile':
        throw new Error(`${method} is not supported`);
    }
    throw new InvalidRequestError(`unknown API method "${method}"`);
  }

  // Lifecycle

  private initialize(): proto.InitializeResponse {
    return {
      useCaseSensitiveFileNames: this.options.useCaseSensitiveFileNames,
      currentDirectory: this.options.currentDirectory,
    };
  }

  private updateSnapshot(params: proto.UpdateSnapshotParams | null): proto.UpdateSnapshotResponse {
    const cwd = this.options.currentDirectory;
    this.applyFileChanges(params?.fileChanges);
    for (const doc of params?.openProjects ?? []) {
      const configFileName = normalizeAbsolutePath(documentFileName(doc), cwd);
      this.openProjects.add(this.loadProject(configFileName).id);
    }
    for (const doc of params?.closeProjects ?? []) this.openProjects.delete(this.toPath(documentFileName(doc)));
    for (const doc of params?.openFiles ?? []) this.openFile(normalizeAbsolutePath(documentFileName(doc), cwd));
    for (const doc of params?.closeFiles ?? []) this.openFiles.delete(this.toPath(documentFileName(doc)));
    this.unloadUnusedProjects();
    this.updateInferredProject();

    // Every update makes a new snapshot; unchanged projects carry over.
    const previous = this.snapshots.get(this.latestSnapshot);
    const projects = [...this.loaded.values()].sort((a, b) => compareStrings(a.configFileName, b.configFileName));
    if (this.inferred !== undefined) projects.push(this.inferred);
    const snapshot = new SnapshotData(this.nextSnapshotId++, projects);
    this.snapshots.set(snapshot.id, snapshot);
    this.files.retain(projects.map((p) => p.project));
    this.latestSnapshot = snapshot.id;
    return {
      snapshot: snapshot.id,
      projects: snapshot.projects.map((p) => projectResponse(p)),
      changes: previous === undefined ? undefined : snapshotChanges(previous, snapshot),
    };
  }

  private release(params: proto.ReleaseParams | null): boolean {
    const id = params?.snapshot ?? 0;
    if (id === 0) throw new ClientError('empty handle');
    const snapshot = this.snapshots.get(id);
    if (snapshot === undefined) throw new ClientError(`snapshot ${id} not found`);
    this.snapshots.delete(id);
    return true;
  }

  // Loads a configured project unless it is already loaded.
  private loadProject(configFileName: string): LoadedProject {
    const id = this.toPath(configFileName);
    let loaded = this.loaded.get(id);
    if (loaded === undefined) {
      loaded = { id, configFileName, project: backend.Project.open(this.projectHost(), configFileName) };
      this.loaded.set(id, loaded);
    }
    return loaded;
  }

  // Assigns an opened file to the nearest tsconfig.json or jsconfig.json
  // above it that contains it, or to the inferred project.
  private openFile(fileName: string): void {
    const path = this.toPath(fileName);
    if (this.openFiles.has(path)) return;
    const fs = this.options.fs;
    let dir = parentDirectory(fileName);
    for (;;) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const configFileName = dir === '/' ? '/' + name : dir + '/' + name;
        if (!fs.fileExists(configFileName)) continue;
        const wasLoaded = this.loaded.has(this.toPath(configFileName));
        const loaded = this.loadProject(configFileName);
        if (containsFile(loaded, path)) {
          this.openFiles.set(path, { fileName, configPath: loaded.id });
          return;
        }
        if (!wasLoaded) this.loaded.delete(loaded.id);
      }
      const parent = parentDirectory(dir);
      if (parent === dir) break;
      dir = parent;
    }
    this.openFiles.set(path, { fileName, configPath: undefined });
  }

  private unloadUnusedProjects(): void {
    const used = new Set(this.openProjects);
    for (const file of this.openFiles.values()) if (file.configPath !== undefined) used.add(file.configPath);
    for (const id of Array.from(this.loaded.keys())) if (!used.has(id)) this.loaded.delete(id);
  }

  // Rebuilds the inferred project when its root files change.
  private updateInferredProject(): void {
    const roots: string[] = [];
    for (const file of this.openFiles.values()) if (file.configPath === undefined) roots.push(file.fileName);
    if (roots.length === 0) {
      this.inferred = undefined;
      return;
    }
    if (this.inferred !== undefined && this.inferred.project.rootFiles().join('\n') === roots.join('\n')) return;
    this.inferred = this.loadInferredProject(roots);
  }

  private loadInferredProject(roots: string[]): LoadedProject {
    return {
      id: inferredProjectName,
      configFileName: inferredProjectName,
      project: backend.Project.openInferred(this.projectHost(), roots),
    };
  }

  // Reloads the projects a set of file changes can affect.
  private applyFileChanges(changes: proto.FileChanges | undefined): void {
    if (changes === undefined) return;
    const fileNames = (documents: proto.DocumentIdentifier[] | undefined): string[] =>
      (documents ?? []).map((d) => normalizeAbsolutePath(documentFileName(d), this.options.currentDirectory));
    if (changes.invalidateAll === true) this.files.invalidateAll();
    const changed = [
      ...this.files.invalidate([...fileNames(changes.changed), ...fileNames(changes.created)], false),
      ...this.files.invalidate(fileNames(changes.deleted), true),
    ];
    const reloadAll = changes.invalidateAll === true || (changes.created ?? []).length > 0;
    if (!reloadAll && changed.length === 0) return;
    // A change affects the projects that read or looked up the file, as their config, an extended config,
    // a source file, a package.json or a module resolution candidate.
    const affected = (loaded: LoadedProject): boolean =>
      reloadAll || changed.some((path) => loaded.project.depends(path));
    // Without created or deleted files, a project whose config files are unchanged keeps its config.
    const keepsConfig = (loaded: LoadedProject): boolean =>
      !reloadAll && (changes.deleted ?? []).length === 0 && !changed.some((path) => loaded.project.configDepends(path));
    // A project that keeps its config takes a change to one of its program files alone, other than a
    // package.json, into its program (Project.update), as tsgo does.
    const updated = (loaded: LoadedProject): backend.Project => {
      const paths = changed.filter((path) => loaded.project.depends(path));
      const host = this.projectHost();
      if (paths.length === 1 && containsFile(loaded, paths[0]) && !paths[0].endsWith('/package.json'))
        return loaded.project.update(host, paths[0]);
      return loaded.project.reload(host);
    };
    // Reloading re-inserts entries, so iterate over a copy.
    for (const loaded of Array.from(this.loaded.values())) {
      if (!affected(loaded)) continue;
      if (keepsConfig(loaded)) {
        this.loaded.set(loaded.id, { id: loaded.id, configFileName: loaded.configFileName, project: updated(loaded) });
        continue;
      }
      this.loaded.delete(loaded.id);
      this.loadProject(loaded.configFileName);
    }
    const inferred = this.inferred;
    if (inferred !== undefined && affected(inferred)) {
      this.inferred = keepsConfig(inferred)
        ? { id: inferred.id, configFileName: inferred.configFileName, project: updated(inferred) }
        : this.loadInferredProject(inferred.project.rootFiles());
    }
  }

  private parseConfigFile(params: proto.FileParams): proto.ConfigFileResponse {
    const fileName = normalizeAbsolutePath(documentFileName(params.file), this.options.currentDirectory);
    // The config is read again, not taken from the session's files.
    const config = backend.parseConfigFile({ ...this.projectHost(), files: undefined }, fileName);
    if (config === undefined) throw new ClientError(`could not read file "${fileName}"`);
    return { fileNames: config.fileNames, options: config.options };
  }

  private defaultProjectForFile(params: proto.SnapshotFileParams): proto.ProjectResponse | null {
    const snapshot = this.snapshot(params.snapshot);
    const path = this.toPath(documentFileName(params.file));
    for (const p of snapshot.projects) if (containsFile(p, path)) return projectResponse(p);
    return null;
  }

  // Source files

  private sourceFile(params: proto.ProjectFileParams): Reply {
    const loaded = this.snapshot(params.snapshot).project(params.project);
    const file = loaded.project.sourceFile(documentFileName(params.file));
    return file === undefined ? new Uint8Array(0) : backend.encodeSourceFile(file);
  }

  private sourceFileNames(params: proto.ProjectParams): string[] {
    const loaded = this.snapshot(params.snapshot).project(params.project);
    return loaded.project.sourceFiles().map(backend.fileName);
  }

  private sourceFileMetadata(params: proto.ProjectFileParams): proto.SourceFileMetadataResponse | null {
    const loaded = this.snapshot(params.snapshot).project(params.project);
    const file = loaded.project.sourceFile(documentFileName(params.file));
    return file === undefined ? null : loaded.project.sourceFileMetadata(file);
  }

  // Symbols and types at locations

  private symbolAtPosition(params: proto.PositionParams): proto.SymbolResponse | null {
    const q = this.query(params);
    const node = q.project.nodeAtPosition(q.sourceFile(params.file), params.position ?? 0);
    return node === undefined ? null : q.symbolResponse(q.project.symbolAtLocation(node));
  }

  private symbolsAtPositions(params: proto.PositionsParams): (proto.SymbolResponse | null)[] {
    const q = this.query(params);
    const file = q.sourceFile(params.file);
    return (params.positions ?? []).map((position) => {
      const node = q.project.nodeAtPosition(file, position);
      return node === undefined ? null : q.symbolResponse(q.project.symbolAtLocation(node));
    });
  }

  private symbolAtLocation(params: proto.LocationParams): proto.SymbolResponse | null {
    const q = this.query(params);
    return q.symbolResponse(q.project.symbolAtLocation(q.node(params.location)));
  }

  private symbolsAtLocations(params: proto.LocationsParams): (proto.SymbolResponse | null)[] {
    const q = this.query(params);
    return (params.locations ?? []).map((handle) => q.symbolResponse(q.project.symbolAtLocation(q.node(handle))));
  }

  private typeOfSymbol(params: proto.SymbolParams, declared: boolean): proto.TypeResponse | null {
    const q = this.query(params);
    const symbol = q.symbol(params.symbol);
    return q.typeResponse(declared ? q.project.declaredTypeOfSymbol(symbol) : q.project.typeOfSymbol(symbol));
  }

  private typesOfSymbols(params: proto.SymbolsParams): (proto.TypeResponse | null)[] {
    const q = this.query(params);
    return (params.symbols ?? []).map((id) => q.typeResponse(q.project.typeOfSymbol(q.symbol(id))));
  }

  private resolveName(params: proto.ResolveNameParams): proto.SymbolResponse | null {
    const q = this.query(params);
    let location: Node | undefined;
    if (params.location !== undefined && params.location !== '') {
      location = q.node(params.location);
    } else if (
      params.file !== undefined &&
      params.file !== null &&
      params.position !== undefined &&
      params.position !== null
    ) {
      location = q.project.nodeAtPosition(q.sourceFile(params.file), params.position);
    }
    const symbol = q.project.resolveName(
      params.name ?? '',
      location,
      params.meaning ?? 0,
      params.excludeGlobals === true,
    );
    return q.symbolResponse(symbol);
  }

  private signaturesOfType(params: proto.SignaturesOfTypeParams): (proto.SignatureResponse | null)[] {
    const q = this.query(params);
    const kind = params.kind === 1 ? backend.SignatureKind.Construct : backend.SignatureKind.Call;
    return q.project.signaturesOfType(q.type(params.type), kind).map((s) => q.signatureResponse(s));
  }

  private signaturesOfTypes(params: proto.SignaturesOfTypesParams): (proto.SignatureResponse | null)[][] {
    const q = this.query(params);
    const kind = params.kind === 1 ? backend.SignatureKind.Construct : backend.SignatureKind.Call;
    return (params.types ?? []).map((id) =>
      q.project.signaturesOfType(q.type(id), kind).map((s) => q.signatureResponse(s)),
    );
  }

  private resolvedSignature(params: proto.LocationParams): proto.SignatureResponse | null {
    const q = this.query(params);
    return q.signatureResponse(q.project.resolvedSignature(q.node(params.location)));
  }

  private resolvedSignatures(params: proto.LocationsParams): (proto.SignatureResponse | null)[] {
    const q = this.query(params);
    return (params.locations ?? []).map((handle) => q.signatureResponse(q.project.resolvedSignature(q.node(handle))));
  }

  private contextualTypes(params: proto.LocationsParams): (proto.TypeResponse | null)[] {
    const q = this.query(params);
    return (params.locations ?? []).map((handle) => q.typeResponse(q.project.contextualType(q.node(handle))));
  }

  private typeAtLocation(params: proto.LocationParams): proto.TypeResponse | null {
    const q = this.query(params);
    return q.typeResponse(q.project.typeAtLocation(q.node(params.location)));
  }

  private typeAtLocations(params: proto.LocationsParams): (proto.TypeResponse | null)[] {
    const q = this.query(params);
    return (params.locations ?? []).map((handle) => q.typeResponse(q.project.typeAtLocation(q.node(handle))));
  }

  private completionsAtPosition(params: proto.CompletionsParams): proto.CompletionInfoResponse | null {
    const q = this.query(params);
    const file = q.project.sourceFile(documentFileName(params.file));
    if (file === undefined) return null;
    let list: backend.CompletionList | undefined;
    try {
      list = q.project.completionsAtPosition(
        file,
        params.position ?? 0,
        params.triggerCharacter,
        params.includeSymbol === true,
      );
    } catch (e) {
      if (e instanceof backend.NeedsAutoImports) throw new ApiError(e.message);
      throw e;
    }
    if (list === undefined) return null;
    return {
      isIncomplete: list.isIncomplete,
      entries: list.entries.map((entry) => {
        const response: proto.CompletionEntryResponse = { name: entry.name, kind: entry.kind };
        response.sortText = entry.sortText;
        if (entry.insertText !== undefined) response.insertText = entry.insertText;
        if (entry.filterText !== undefined) response.filterText = entry.filterText;
        if (entry.detail !== undefined) response.detail = entry.detail;
        if (entry.labelDetails !== undefined) response.labelDetails = entry.labelDetails;
        if (entry.symbol !== undefined) response.symbol = q.symbolResponse(entry.symbol) ?? undefined;
        return response;
      }),
    };
  }

  private typeAtPosition(params: proto.PositionParams): proto.TypeResponse | null {
    const q = this.query(params);
    const node = q.project.nodeAtPosition(q.sourceFile(params.file), params.position ?? 0);
    return node === undefined ? null : q.typeResponse(q.project.typeAtLocation(node));
  }

  private typesAtPositions(params: proto.PositionsParams): (proto.TypeResponse | null)[] {
    const q = this.query(params);
    const file = q.sourceFile(params.file);
    return (params.positions ?? []).map((position) => {
      const node = q.project.nodeAtPosition(file, position);
      return node === undefined ? null : q.typeResponse(q.project.typeAtLocation(node));
    });
  }

  // Properties of symbols, types and signatures

  private symbolOfSymbol(method: string, params: proto.ObjectParams): proto.SymbolResponse | null {
    const snapshot = this.snapshot(params.snapshot);
    const symbol = resolveSymbol(snapshot, params.objectId);
    const result = method === 'getParentOfSymbol' ? backend.symbolParent(symbol) : backend.symbolExportSymbol(symbol);
    return result === undefined ? null : symbolResponse(snapshot, result, params.project ?? '');
  }

  private symbolTableOfSymbol(method: string, params: proto.ObjectParams): proto.SymbolResponse[] {
    const snapshot = this.snapshot(params.snapshot);
    const symbol = resolveSymbol(snapshot, params.objectId);
    const symbols = method === 'getMembersOfSymbol' ? backend.symbolMembers(symbol) : backend.symbolExports(symbol);
    if (symbols.length <= 1) return symbols.map((s) => symbolResponse(snapshot, s, params.project ?? ''));
    const q = this.query(params);
    return q.symbolResponses(q.project.sortSymbols(symbols));
  }

  private symbolOfType(method: string, params: proto.ObjectParams): proto.SymbolResponse | null {
    const snapshot = this.snapshot(params.snapshot);
    const projectId = params.project ?? '';
    const type = resolveType(snapshot, projectId, params.objectId);
    const result = method === 'getSymbolOfType' ? backend.typeSymbol(type) : backend.aliasSymbol(type);
    return result === undefined ? null : symbolResponse(snapshot, result, projectId);
  }

  private typeOfType(method: string, params: proto.ObjectParams): proto.TypeResponse | null {
    const snapshot = this.snapshot(params.snapshot);
    const projectId = params.project ?? '';
    const type = resolveType(snapshot, projectId, params.objectId);
    const result = typeProperty(method, type);
    return result === undefined ? null : typeResponse(snapshot, projectId, result);
  }

  private typesOfType(method: string, params: proto.ObjectParams): proto.TypeResponse[] {
    const snapshot = this.snapshot(params.snapshot);
    const projectId = params.project ?? '';
    const type = resolveType(snapshot, projectId, params.objectId);
    return typeListProperty(method, type).map((t) => typeResponse(snapshot, projectId, t));
  }

  private signatureOf(params: proto.ObjectParams): { snapshot: SnapshotData; projectId: string; signature: Signature } {
    const snapshot = this.snapshot(params.snapshot);
    const projectId = params.project ?? '';
    return { snapshot, projectId, signature: resolveSignature(snapshot, projectId, params.objectId) };
  }

  private typeParametersOfSignature(params: proto.ObjectParams): proto.TypeResponse[] {
    const { snapshot, projectId, signature } = this.signatureOf(params);
    return backend.signatureTypeParameters(signature).map((t) => typeResponse(snapshot, projectId, t));
  }

  private parametersOfSignature(params: proto.ObjectParams): proto.SymbolResponse[] {
    const { snapshot, projectId, signature } = this.signatureOf(params);
    return backend.signatureParameters(signature).map((s) => symbolResponse(snapshot, s, projectId));
  }

  private thisParameterOfSignature(params: proto.ObjectParams): proto.SymbolResponse | null {
    const { snapshot, projectId, signature } = this.signatureOf(params);
    const symbol = backend.signatureThisParameter(signature);
    return symbol === undefined ? null : symbolResponse(snapshot, symbol, projectId);
  }

  private targetOfSignature(params: proto.ObjectParams): proto.SignatureResponse | null {
    const { snapshot, projectId, signature } = this.signatureOf(params);
    const target = backend.signatureTarget(signature);
    return target === undefined ? null : signatureResponse(snapshot, projectId, target);
  }

  // Checker queries

  private contextualType(params: proto.LocationParams): proto.TypeResponse | null {
    const q = this.query(params);
    return q.typeResponse(q.project.contextualType(q.node(params.location)));
  }

  private checkerTypeOfType(method: string, params: proto.TypeParams): proto.TypeResponse | null {
    const q = this.query(params);
    const type = q.type(params.type);
    const project = q.project;
    switch (method) {
      case 'getBaseTypeOfLiteralType':
        return q.typeResponse(project.baseTypeOfLiteralType(type));
      case 'getNonNullableType':
        return q.typeResponse(project.nonNullableType(type));
      case 'getWidenedType':
        return q.typeResponse(project.widenedType(type));
      case 'getApparentType':
        return q.typeResponse(project.apparentType(type));
      case 'getConstraintOfTypeParameter':
        return q.typeResponse(project.constraintOfTypeParameter(type));
    }
    return q.typeResponse(project.baseConstraintOfType(type));
  }

  private baseTypesOfLiteralTypes(params: proto.TypesParams): (proto.TypeResponse | null)[] {
    const q = this.query(params);
    return (params.types ?? []).map((id) => q.typeResponse(q.project.baseTypeOfLiteralType(q.type(id))));
  }

  private typeFromTypeNode(params: proto.LocationParams): proto.TypeResponse | null {
    const q = this.query(params);
    return q.typeResponse(q.project.typeFromTypeNode(q.node(params.location)));
  }

  private parameterType(params: proto.ParameterTypeParams): proto.TypeResponse | null {
    const q = this.query(params);
    const signature = q.signature(params.signature);
    const index = params.index ?? 0;
    if (index < 0) throw new ClientError('invalid parameter index');
    return q.typeResponse(q.project.typeAtPosition(signature, index));
  }

  private typePredicate(method: string, params: proto.TypeParams): boolean {
    const q = this.query(params);
    const type = q.type(params.type);
    if (method === 'isArrayLikeType') return q.project.isArrayLikeType(type);
    if (method === 'isArrayType') return q.project.isArrayType(type);
    return backend.isTupleType(type);
  }

  private typePredicates(method: string, params: proto.TypesParams): boolean[] {
    const q = this.query(params);
    return (params.types ?? []).map((id) => {
      const type = q.type(id);
      return method === 'isArrayTypes' ? q.project.isArrayType(type) : backend.isTupleType(type);
    });
  }

  private isTypeAssignableTo(params: proto.AssignabilityParams): boolean {
    const q = this.query(params);
    return q.project.isTypeAssignableTo(q.type(params.source), q.type(params.target));
  }

  private shorthandAssignmentValueSymbol(params: proto.LocationParams): proto.SymbolResponse | null {
    const q = this.query(params);
    return q.symbolResponse(q.project.shorthandAssignmentValueSymbol(q.node(params.location)));
  }

  private typeOfSymbolAtLocation(params: proto.SymbolAtLocationParams): proto.TypeResponse | null {
    const q = this.query(params);
    const symbol = q.symbol(params.symbol);
    return q.typeResponse(q.project.typeOfSymbolAtLocation(symbol, q.node(params.location)));
  }

  private typeToTypeNode(params: proto.TypeToTypeNodeParams): Reply {
    const q = this.query(params);
    const type = q.type(params.type);
    const enclosing = optionalNode(q, params.location);
    return q.project.typeToTypeNode(type, enclosing, params.flags ?? 0) ?? 'null';
  }

  private signatureToSignatureDeclaration(params: proto.SignatureToDeclarationParams): Reply {
    const q = this.query(params);
    const signature = q.signature(params.signature);
    const enclosing = optionalNode(q, params.location);
    const data = q.project.signatureToSignatureDeclaration(signature, params.kind ?? 0, enclosing, params.flags ?? 0);
    return data ?? 'null';
  }

  private typeToString(params: proto.TypeToTypeNodeParams): string {
    const q = this.query(params);
    const type = q.type(params.type);
    const enclosing = optionalNode(q, params.location);
    const flags = params.flags !== undefined && params.flags !== 0 ? params.flags : defaultTypeFormatFlags;
    return q.project.typeToString(type, enclosing, flags);
  }

  private printNode(params: proto.PrintNodeParams): string {
    const data = decodeBase64(params.data ?? '');
    if (!data.ok) throw new ClientError(`invalid base64 data: illegal base64 data at input byte ${data.offset}`);
    let node: Node;
    try {
      node = backend.decodeNode(data.bytes);
    } catch (e) {
      throw new ClientError(`failed to decode AST: ${e instanceof Error ? e.message : String(e)}`);
    }
    return backend.printNode(
      node,
      params.preserveSourceNewlines === true,
      params.neverAsciiEscape === true,
      params.terminateUnterminatedLiterals === true,
    );
  }

  private isContextSensitive(params: proto.LocationParams): boolean {
    const q = this.query(params);
    return q.project.isContextSensitive(q.node(params.location));
  }

  private typeOfSignature(method: string, params: proto.SignatureParams): proto.TypeResponse | null {
    const q = this.query(params);
    const signature = q.signature(params.signature);
    return q.typeResponse(
      method === 'getReturnTypeOfSignature'
        ? q.project.returnTypeOfSignature(signature)
        : q.project.restTypeOfSignature(signature),
    );
  }

  private returnTypesOfSignatures(params: proto.SignaturesParams): (proto.TypeResponse | null)[] {
    const q = this.query(params);
    return (params.signatures ?? []).map((id) => q.typeResponse(q.project.returnTypeOfSignature(q.signature(id))));
  }

  private typePredicateOfSignature(params: proto.SignatureParams): proto.TypePredicateResponse | null {
    const q = this.query(params);
    const predicate = q.project.typePredicateOfSignature(q.signature(params.signature));
    if (predicate === undefined) return null;
    return {
      kind: predicate.kind,
      parameterIndex: predicate.parameterIndex,
      parameterName: predicate.parameterName === '' ? undefined : predicate.parameterName,
      type: predicate.type === undefined ? undefined : typeResponse(q.snapshot, q.projectId, predicate.type),
    };
  }

  private checkerTypesOfType(method: string, params: proto.TypeParams): proto.TypeResponse[] {
    const q = this.query(params);
    const type = q.type(params.type);
    return q.typeResponses(method === 'getBaseTypes' ? q.project.baseTypes(type) : q.project.typeArguments(type));
  }

  private propertiesOfType(params: proto.TypeParams): proto.SymbolResponse[] {
    const q = this.query(params);
    return q.symbolResponses(q.project.propertiesOfType(q.type(params.type)));
  }

  private propertiesOfTypes(params: proto.TypesParams): proto.SymbolResponse[][] {
    const q = this.query(params);
    return (params.types ?? []).map((id) => q.symbolResponses(q.project.propertiesOfType(q.type(id))));
  }

  private propertyOfType(params: proto.NamedTypeParams): proto.SymbolResponse | null {
    const q = this.query(params);
    return q.symbolResponse(q.project.propertyOfType(q.type(params.type), params.name ?? ''));
  }

  private indexInfosOfType(params: proto.TypeParams): proto.IndexInfoResponse[] {
    const q = this.query(params);
    return q.project.indexInfosOfType(q.type(params.type)).map((info) => ({
      keyType: typeResponse(q.snapshot, q.projectId, info.keyType),
      valueType: typeResponse(q.snapshot, q.projectId, info.valueType),
      isReadonly: info.isReadonly,
      declaration: info.declaration === undefined ? undefined : nodeHandle(info.declaration),
    }));
  }

  private branchOfConditionalType(method: string, params: proto.ObjectParams): proto.TypeResponse | null {
    const q = this.query(params);
    const type = q.type(params.objectId);
    return q.typeResponse(
      method === 'getTrueTypeOfConditionalType'
        ? q.project.trueTypeOfConditionalType(type)
        : q.project.falseTypeOfConditionalType(type),
    );
  }

  private constantValue(params: proto.LocationParams): proto.LiteralValueResponse {
    const q = this.query(params);
    return literalValueResponse(q.project.constantValue(q.node(params.location)));
  }

  private constantValues(params: proto.LocationsParams): proto.LiteralValueResponse[] {
    const q = this.query(params);
    return (params.locations ?? []).map((handle) => literalValueResponse(q.project.constantValue(q.node(handle))));
  }

  private signatureFromDeclaration(params: proto.LocationParams): proto.SignatureResponse | null {
    const q = this.query(params);
    return q.signatureResponse(q.project.signatureFromDeclaration(q.node(params.location)));
  }

  private signaturesFromDeclarations(params: proto.LocationsParams): (proto.SignatureResponse | null)[] {
    const q = this.query(params);
    return (params.locations ?? []).map((handle) =>
      q.signatureResponse(q.project.signatureFromDeclaration(q.node(handle))),
    );
  }

  private exportSpecifierLocalTargetSymbol(params: proto.LocationParams): proto.SymbolResponse | null {
    const q = this.query(params);
    return q.symbolResponse(q.project.exportSpecifierLocalTargetSymbol(q.node(params.location)));
  }

  private aliasedSymbol(method: string, params: proto.SymbolParams): proto.SymbolResponse | null {
    const q = this.query(params);
    const symbol = q.symbol(params.symbol);
    return q.symbolResponse(
      method === 'getAliasedSymbol' ? q.project.aliasedSymbol(symbol) : q.project.immediateAliasedSymbol(symbol),
    );
  }

  private aliasedSymbols(params: proto.SymbolsParams): (proto.SymbolResponse | null)[] {
    const q = this.query(params);
    return (params.symbols ?? []).map((id) => q.symbolResponse(q.project.aliasedSymbol(q.symbol(id))));
  }

  private exportsOfModule(params: proto.SymbolParams): proto.SymbolResponse[] {
    const q = this.query(params);
    return q.symbolResponses(q.project.exportsOfModule(q.symbol(params.symbol)));
  }

  private memberInModuleExports(params: proto.NamedSymbolParams): proto.SymbolResponse | null {
    const q = this.query(params);
    return q.symbolResponse(q.project.memberInModuleExports(q.symbol(params.symbol), params.name ?? ''));
  }

  private jsDocTags(params: proto.SymbolParams): proto.JSDocTagInfo[] {
    const q = this.query(params);
    const tags = q.project.jsDocTags(q.symbol(params.symbol));
    return tags.map((t) => (t.text === '' ? { name: t.name } : { name: t.name, text: t.text }));
  }

  private documentationComment(params: proto.SymbolParams): string {
    const q = this.query(params);
    return q.project.documentationComment(q.symbol(params.symbol));
  }

  private referencesToSymbolInFile(params: proto.SymbolFileParams): proto.NodeHandle[] {
    const q = this.query(params);
    const symbol = q.symbol(params.symbol);
    return q.project.referencesToSymbolInFile(q.sourceFile(params.file), symbol).map(nodeHandle);
  }

  private referencedSymbolsForNode(params: proto.ReferencedSymbolsParams): proto.ReferencedSymbolEntry[] {
    const q = this.query(params);
    const node = q.node(params.node);
    return q.project.referencedSymbolsForNode(node, params.position ?? 0).map((entry) => {
      const response: proto.ReferencedSymbolEntry = { definition: nodeHandle(entry.definition) };
      if (entry.symbol !== undefined) response.symbol = q.symbolResponse(entry.symbol)!;
      response.references = entry.references.map(nodeHandle);
      return response;
    });
  }

  private signatureUsages(params: proto.SignatureUsagesParams): proto.SignatureUsageResponse[] {
    const q = this.query(params);
    return q.project
      .signatureUsages(q.node(params.signatureDecl))
      .map((usage) =>
        usage.call === undefined
          ? { name: nodeHandle(usage.name) }
          : { name: nodeHandle(usage.name), call: nodeHandle(usage.call) },
      );
  }

  private intrinsicType(name: backend.IntrinsicTypeName, params: proto.ProjectParams): proto.TypeResponse | null {
    const q = this.query(params);
    return q.typeResponse(q.project.intrinsicType(name));
  }

  private wellKnownSymbols(params: proto.ProjectParams): proto.WellKnownSymbolsResponse {
    const q = this.query(params);
    return {
      unknown: registerSymbol(q.snapshot, q.project.unknownSymbol(), q.projectId),
      undefined: registerSymbol(q.snapshot, q.project.undefinedSymbol(), q.projectId),
      arguments: registerSymbol(q.snapshot, q.project.argumentsSymbol(), q.projectId),
    };
  }

  // Diagnostics

  private fileDiagnostics(kind: backend.DiagnosticKind, params: proto.OptionalFileParams): proto.DiagnosticResponse[] {
    const q = this.query(params);
    return q.project.diagnostics(kind, q.optionalSourceFile(params.file)).map(diagnosticResponse);
  }

  private diagnosticsOfCheckedFiles(params: proto.FilesParams): proto.CheckedFileDiagnosticsResponse {
    const q = this.query(params);
    const result = q.project.checkedFileDiagnostics((params.files ?? []).map((file) => q.sourceFile(file)));
    return {
      files: result.files.map((list) => list.map(diagnosticResponse)),
      global: result.global.map(diagnosticResponse),
    };
  }

  private projectDiagnostics(kind: backend.DiagnosticKind, params: proto.ProjectParams): proto.DiagnosticResponse[] {
    const q = this.query(params);
    return q.project.diagnostics(kind, undefined).map(diagnosticResponse);
  }

  // Timing

  private serverTiming(): ServerTiming {
    return this.timing ?? { enabled: false, totals: { requestCount: 0, totalProcessingTimeMs: 0 }, recentRequests: [] };
  }

  private resetServerTiming(): void {
    if (this.timing === undefined) return;
    this.timing.totals = { requestCount: 0, totalProcessingTimeMs: 0 };
    this.timing.recentRequests = [];
  }

  private record(method: string, ms: number): void {
    const timing = this.timing!;
    timing.totals.requestCount++;
    timing.totals.totalProcessingTimeMs += ms;
    timing.recentRequests.push({ method, processingTimeMs: ms, timestamp: Date.now() });
    if (timing.recentRequests.length > 5) timing.recentRequests.shift();
  }

  // Helpers

  private snapshot(id: number | undefined): SnapshotData {
    const snapshot = this.snapshots.get(id ?? 0);
    if (snapshot === undefined) throw new ClientError(`snapshot ${id ?? 0} not found`);
    return snapshot;
  }

  private query(params: proto.ProjectParams): Query {
    const snapshot = this.snapshot(params.snapshot);
    return new Query(snapshot, snapshot.project(params.project));
  }

  private projectHost(): backend.ProjectHost {
    return {
      fs: this.options.fs,
      currentDirectory: this.options.currentDirectory,
      defaultLibraryPath: this.options.defaultLibraryPath,
      useCaseSensitiveFileNames: this.options.useCaseSensitiveFileNames,
      files: this.files,
    };
  }

  private toPath(fileName: string): string {
    return toPath(fileName, this.options.currentDirectory, this.options.useCaseSensitiveFileNames);
  }
}

// Registries

function registerSymbol(snapshot: SnapshotData, symbol: Symbol, projectId: string): number {
  const id = backend.symbolId(symbol);
  if (!snapshot.symbols.has(id)) snapshot.symbols.set(id, symbol);
  if (!snapshot.symbolProjects.has(id)) snapshot.symbolProjects.set(id, projectId);
  return id;
}

function resolveSymbol(snapshot: SnapshotData, id: number | undefined): Symbol {
  if (id === undefined || id === 0) throw new ClientError('empty symbol handle');
  const symbol = snapshot.symbols.get(id);
  if (symbol === undefined) throw new ClientError(`symbol handle ${id} not found in snapshot registry`);
  return symbol;
}

function resolveType(snapshot: SnapshotData, projectId: string, id: number | undefined): Type {
  if (id === undefined || id === 0) throw new ClientError('empty type handle');
  if (projectId === '') throw new ClientError(`empty project ID for type handle ${id}`);
  const registry = snapshot.registries.get(projectId);
  if (registry === undefined) {
    throw new ClientError(`type handle ${id} not found (no registry for project ${projectId})`);
  }
  const type = registry.types.get(id);
  if (type === undefined) throw new ClientError(`type handle ${id} not found in project registry`);
  return type;
}

function resolveSignature(snapshot: SnapshotData, projectId: string, id: number | undefined): Signature {
  if (id === undefined || id === 0) throw new ClientError('empty signature handle');
  if (projectId === '') throw new ClientError(`empty project ID for signature handle ${id}`);
  const registry = snapshot.registries.get(projectId);
  if (registry === undefined) {
    throw new ClientError(`signature handle ${id} not found (no registry for project ${projectId})`);
  }
  const signature = registry.signatures.get(id);
  if (signature === undefined) throw new ClientError(`signature handle ${id} not found in project registry`);
  return signature;
}

// Node handles are `index.kind.path`, with index into the file's node table.

function nodeHandle(node: Node): proto.NodeHandle {
  const file = backend.sourceFileOfNode(node);
  return `${backend.nodeIndex(node)}.${backend.nodeKind(node)}.${backend.filePath(file)}`;
}

function resolveNode(project: Project, handle: proto.NodeHandle): Node {
  const first = handle.indexOf('.');
  const second = first < 0 ? -1 : handle.indexOf('.', first + 1);
  if (second < 0) throw new ClientError(`invalid node handle ${JSON.stringify(handle)}`);
  const indexText = handle.slice(0, first);
  const index = Number(indexText);
  if (!/^[0-9]+$/.test(indexText) || index > 0xffffffff) {
    throw new ClientError(`invalid node handle ${JSON.stringify(handle)}: invalid syntax`);
  }
  const file = project.sourceFileByPath(handle.slice(second + 1));
  const node = file === undefined ? undefined : backend.nodeAtIndex(file, index);
  if (node === undefined) {
    throw new ClientError(
      `node handle ${JSON.stringify(handle)} could not be resolved (file may not be loaded or handle may be stale)`,
    );
  }
  return node;
}

function optionalNode(q: Query, handle: proto.NodeHandle | undefined): Node | undefined {
  return handle === undefined || handle === '' ? undefined : q.node(handle);
}

// Responses

function symbolResponse(snapshot: SnapshotData, symbol: Symbol, projectId: string): proto.SymbolResponse {
  const id = registerSymbol(snapshot, symbol, projectId);
  const declarations = backend.symbolDeclarations(symbol);
  const valueDeclaration = backend.symbolValueDeclaration(symbol);
  const parent = backend.symbolParent(symbol);
  const exportSymbol = backend.symbolExportSymbol(symbol);
  return {
    id,
    project: snapshot.symbolProjects.get(id) ?? projectId,
    name: backend.symbolName(symbol),
    flags: backend.symbolFlags(symbol),
    checkFlags: backend.symbolCheckFlags(symbol),
    declarations: declarations.length > 0 ? declarations.map(nodeHandle) : undefined,
    valueDeclaration: valueDeclaration === undefined ? undefined : nodeHandle(valueDeclaration),
    parent: parent === undefined ? undefined : backend.symbolId(parent),
    exportSymbol: exportSymbol === undefined ? undefined : backend.symbolId(exportSymbol),
  };
}

function typeResponse(snapshot: SnapshotData, projectId: string, type: Type): proto.TypeResponse {
  const id = backend.typeId(type);
  const registry = snapshot.registry(projectId);
  if (!registry.types.has(id)) registry.types.set(id, type);
  const flags = backend.typeFlags(type);
  const symbol = backend.typeSymbol(type);
  const aliasSymbol = backend.aliasSymbol(type);
  // Every field is listed so the JSON keeps tsc's field order.
  const r: proto.TypeResponse = {
    id,
    flags,
    objectFlags: 0,
    value: null,
    target: undefined,
    typeParameters: undefined,
    outerTypeParameters: undefined,
    localTypeParameters: undefined,
    elementFlags: undefined,
    fixedLength: undefined,
    readonly: undefined,
    objectType: undefined,
    indexType: undefined,
    checkType: undefined,
    extendsType: undefined,
    baseType: undefined,
    substConstraint: undefined,
    texts: undefined,
    freshType: undefined,
    regularType: undefined,
    isThisType: false,
    intrinsicName: undefined,
    aliasTypeArguments: typeIds(backend.aliasTypeArguments(type)),
    aliasSymbol: aliasSymbol === undefined ? undefined : backend.symbolId(aliasSymbol),
    symbol: symbol === undefined ? undefined : backend.symbolId(symbol),
  };
  if (flags & TypeFlags.Freshable) {
    if (flags & TypeFlags.Literal) r.value = literalValueResponse(backend.literalTypeValue(type));
    r.freshType = optionalTypeId(backend.freshType(type));
    r.regularType = optionalTypeId(backend.regularType(type));
  } else if (flags & TypeFlags.Object) {
    const objectFlags = backend.objectFlags(type);
    r.objectFlags = objectFlags;
    if (objectFlags & ObjectFlags.Reference) {
      if (objectFlags & ObjectFlags.Tuple) {
        const tuple = backend.tupleInfo(type);
        r.elementFlags = tuple.elementFlags.length > 0 ? tuple.elementFlags : undefined;
        r.fixedLength = tuple.fixedLength;
        r.readonly = tuple.readonly;
      }
      r.target = optionalTypeId(backend.referenceTarget(type));
    }
    if (objectFlags & ObjectFlags.ClassOrInterface) {
      r.typeParameters = typeIds(backend.typeParameters(type));
      r.outerTypeParameters = typeIds(backend.outerTypeParameters(type));
      r.localTypeParameters = typeIds(backend.localTypeParameters(type));
    }
  } else if (flags & TypeFlags.UnionOrIntersection) {
    // Member types are fetched with getTypesOfType.
  } else if (flags & TypeFlags.Index) {
    r.target = optionalTypeId(backend.typeTarget(type));
  } else if (flags & TypeFlags.IndexedAccess) {
    r.objectType = optionalTypeId(backend.indexedAccessObjectType(type));
    r.indexType = optionalTypeId(backend.indexedAccessIndexType(type));
  } else if (flags & TypeFlags.Conditional) {
    r.checkType = optionalTypeId(backend.conditionalCheckType(type));
    r.extendsType = optionalTypeId(backend.conditionalExtendsType(type));
  } else if (flags & TypeFlags.Substitution) {
    r.baseType = optionalTypeId(backend.substitutionBaseType(type));
    r.substConstraint = optionalTypeId(backend.substitutionConstraint(type));
  } else if (flags & TypeFlags.TemplateLiteral) {
    const texts = backend.templateLiteralTexts(type);
    r.texts = texts.length > 0 ? texts : undefined;
  } else if (flags & TypeFlags.StringMapping) {
    r.target = optionalTypeId(backend.typeTarget(type));
  } else if (flags & TypeFlags.TypeParameter) {
    r.isThisType = backend.isThisType(type);
  } else if (flags & TypeFlags.Intrinsic) {
    const name = backend.intrinsicName(type);
    r.intrinsicName = name === '' ? undefined : name;
  }
  return r;
}

function signatureResponse(snapshot: SnapshotData, projectId: string, signature: Signature): proto.SignatureResponse {
  const id = backend.signatureId(signature);
  const registry = snapshot.registry(projectId);
  if (!registry.signatures.has(id)) registry.signatures.set(id, signature);
  const declaration = backend.signatureDeclaration(signature);
  const parameters = backend.signatureParameters(signature);
  const thisParameter = backend.signatureThisParameter(signature);
  const target = backend.signatureTarget(signature);
  return {
    id,
    flags: backend.signatureFlags(signature),
    declaration: declaration === undefined ? undefined : nodeHandle(declaration),
    typeParameters: typeIds(backend.signatureTypeParameters(signature)),
    parameters: parameters.length > 0 ? parameters.map(backend.symbolId) : undefined,
    thisParameter: thisParameter === undefined ? undefined : backend.symbolId(thisParameter),
    target: target === undefined ? undefined : backend.signatureId(target),
  };
}

function typeIds(types: Type[]): number[] | undefined {
  return types.length > 0 ? types.map(backend.typeId) : undefined;
}

function optionalTypeId(type: Type | undefined): number | undefined {
  return type === undefined ? undefined : backend.typeId(type);
}

// The single-type properties of a type that the get*OfType methods return.
function typeProperty(method: string, type: Type): Type | undefined {
  switch (method) {
    case 'getTargetOfType':
      return backend.typeTarget(type);
    case 'getFreshTypeOfType':
      return backend.freshType(type);
    case 'getRegularTypeOfType':
      return backend.regularType(type);
    case 'getObjectTypeOfType':
      return backend.indexedAccessObjectType(type);
    case 'getIndexTypeOfType':
      return backend.indexedAccessIndexType(type);
    case 'getCheckTypeOfType':
      return backend.conditionalCheckType(type);
    case 'getExtendsTypeOfType':
      return backend.conditionalExtendsType(type);
    case 'getBaseTypeOfType':
      return backend.substitutionBaseType(type);
  }
  return backend.substitutionConstraint(type);
}

function typeListProperty(method: string, type: Type): Type[] {
  switch (method) {
    case 'getTypesOfType':
      return backend.typesOfType(type);
    case 'getTypeParametersOfType':
      return backend.typeParameters(type);
    case 'getOuterTypeParametersOfType':
      return backend.outerTypeParameters(type);
    case 'getLocalTypeParametersOfType':
      return backend.localTypeParameters(type);
  }
  return backend.aliasTypeArguments(type);
}

function projectResponse(p: LoadedProject): proto.ProjectResponse {
  return {
    id: p.id,
    configFileName: p.configFileName,
    rootFiles: p.project.rootFiles(),
    compilerOptions: p.project.compilerOptions(),
  };
}

function diagnosticResponse(d: backend.Diagnostic): proto.DiagnosticResponse {
  return {
    fileName: d.fileName === '' ? undefined : d.fileName,
    pos: d.pos,
    end: d.end,
    code: d.code,
    category: d.category,
    text: d.text,
    reportsUnnecessary: d.reportsUnnecessary ? true : undefined,
    reportsDeprecated: d.reportsDeprecated ? true : undefined,
    messageChain: d.messageChain.length > 0 ? d.messageChain.map(diagnosticResponse) : undefined,
    relatedInformation: d.relatedInformation.length > 0 ? d.relatedInformation.map(diagnosticResponse) : undefined,
  };
}

// Reports which files changed in projects present in both snapshots, and
// which projects were removed.
function snapshotChanges(previous: SnapshotData, next: SnapshotData): proto.SnapshotChanges | undefined {
  let changedProjects: Record<string, proto.ProjectFileChanges> | undefined;
  const removedProjects: string[] = [];
  for (const old of previous.projects) {
    const current = next.projects.find((p) => p.id === old.id);
    if (current === undefined) {
      removedProjects.push(old.id);
      continue;
    }
    if (current.project === old.project) continue;
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];
    for (const file of old.project.sourceFiles()) {
      const path = backend.filePath(file);
      const updated = current.project.sourceFileByPath(path);
      if (updated === undefined) deletedFiles.push(path);
      else if (!backend.sameFileContent(file, updated)) changedFiles.push(path);
    }
    if (changedFiles.length === 0 && deletedFiles.length === 0) continue;
    changedProjects ??= {};
    changedProjects[current.id] = {
      changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
      deletedFiles: deletedFiles.length > 0 ? deletedFiles : undefined,
    };
  }
  // An empty change set is omitted.
  if (changedProjects === undefined && removedProjects.length === 0) return undefined;
  return { changedProjects, removedProjects: removedProjects.length > 0 ? removedProjects : undefined };
}

// Documents

function documentFileName(doc: proto.DocumentIdentifier): string {
  return typeof doc === 'string' ? doc : uriToFileName(doc.uri);
}

function documentString(doc: proto.DocumentIdentifier): string {
  return typeof doc === 'string' ? doc : doc.uri;
}

function containsFile(loaded: LoadedProject, path: string): boolean {
  return loaded.project.sourceFileByPath(path) !== undefined;
}

function parentDirectory(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

type Base64Result = { ok: true; bytes: Uint8Array } | { ok: false; offset: number };

// Decodes standard padded base64, reporting where malformed input starts.
function decodeBase64(text: string): Base64Result {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const end = text.length - padding;
  for (let i = 0; i < end; i++) if (base64Alphabet.indexOf(text[i]) < 0) return { ok: false, offset: i };
  if (text.length % 4 !== 0) return { ok: false, offset: text.length - (text.length % 4) };
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    let chunk = 0;
    for (let j = 0; j < 4; j++) chunk = (chunk << 6) | (i + j < end ? base64Alphabet.indexOf(text[i + j]) : 0);
    if (at < bytes.length) bytes[at++] = chunk >>> 16;
    if (at < bytes.length) bytes[at++] = (chunk >>> 8) & 0xff;
    if (at < bytes.length) bytes[at++] = chunk & 0xff;
  }
  return { ok: true, bytes };
}
