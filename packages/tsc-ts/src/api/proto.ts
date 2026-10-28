// Request parameters and responses of the API, as sent over the wire.
// Fields are declared in the order tsc --api writes them.
import type { CompilerOptions, LiteralValue } from './backend.js';

// A file name, or a document URI.
export type DocumentIdentifier = string | { uri: string };

export type NodeHandle = string;

// Params

export interface UpdateSnapshotParams {
  openProjects?: DocumentIdentifier[];
  closeProjects?: DocumentIdentifier[];
  fileChanges?: FileChanges;
  openFiles?: DocumentIdentifier[];
  closeFiles?: DocumentIdentifier[];
}

export interface FileChanges {
  invalidateAll?: boolean;
  changed?: DocumentIdentifier[];
  created?: DocumentIdentifier[];
  deleted?: DocumentIdentifier[];
}

export interface ReleaseParams {
  snapshot?: number;
}

export interface FileParams {
  file: DocumentIdentifier;
}

export interface SnapshotFileParams {
  snapshot?: number;
  file: DocumentIdentifier;
}

export interface ProjectParams {
  snapshot?: number;
  project?: string;
}

export interface ProjectFileParams extends ProjectParams {
  file: DocumentIdentifier;
}

export interface OptionalFileParams extends ProjectParams {
  file?: DocumentIdentifier | null;
}

export interface FilesParams extends ProjectParams {
  files?: DocumentIdentifier[];
}

export interface CheckedFileDiagnosticsResponse {
  files: DiagnosticResponse[][];
  global: DiagnosticResponse[];
}

export interface PositionParams extends ProjectFileParams {
  position?: number;
}

export interface CompletionsParams extends ProjectFileParams {
  position?: number;
  triggerCharacter?: string;
  includeSymbol?: boolean;
}

export interface CompletionEntryResponse {
  name: string;
  kind?: number;
  sortText?: string;
  insertText?: string;
  filterText?: string;
  detail?: string;
  labelDetails?: { detail?: string; description?: string };
  symbol?: SymbolResponse;
}

export interface CompletionInfoResponse {
  isIncomplete: boolean;
  entries: CompletionEntryResponse[];
}

export interface PositionsParams extends ProjectFileParams {
  positions?: number[];
}

export interface LocationParams extends ProjectParams {
  location?: NodeHandle;
}

export interface LocationsParams extends ProjectParams {
  locations?: NodeHandle[];
}

export interface SymbolParams extends ProjectParams {
  symbol?: number;
}

export interface SymbolsParams extends ProjectParams {
  symbols?: number[];
}

export interface TypeParams extends ProjectParams {
  type?: number;
}

export interface TypesParams extends ProjectParams {
  types?: number[];
}

// Parameters of the get*Of* property methods, which name the object `objectId`.
export interface ObjectParams extends ProjectParams {
  objectId?: number;
}

export interface SignatureParams extends ProjectParams {
  signature?: number;
}

export interface SignaturesParams extends ProjectParams {
  signatures?: number[];
}

export interface SymbolAtLocationParams extends ProjectParams {
  symbol?: number;
  location?: NodeHandle;
}

export interface NamedTypeParams extends TypeParams {
  name?: string;
}

export interface NamedSymbolParams extends SymbolParams {
  name?: string;
}

export interface SignaturesOfTypeParams extends TypeParams {
  kind?: number;
}

export interface SignaturesOfTypesParams extends TypesParams {
  kind?: number;
}

export interface ParameterTypeParams extends SignatureParams {
  index?: number;
}

export interface AssignabilityParams extends ProjectParams {
  source?: number;
  target?: number;
}

export interface ResolveNameParams extends ProjectParams {
  name?: string;
  location?: NodeHandle;
  file?: DocumentIdentifier | null;
  position?: number | null;
  meaning?: number;
  excludeGlobals?: boolean;
}

export interface TypeToTypeNodeParams extends TypeParams {
  location?: NodeHandle;
  flags?: number;
}

export interface SignatureToDeclarationParams extends SignatureParams {
  kind?: number;
  location?: NodeHandle;
  flags?: number;
}

export interface PrintNodeParams {
  data?: string;
  preserveSourceNewlines?: boolean;
  neverAsciiEscape?: boolean;
  terminateUnterminatedLiterals?: boolean;
}

export interface InitializeParams {
  // Whether replies may name objects the client already holds by their ids (TypeReply, SymbolReply, SignatureReply).
  objectReferences?: boolean;
}

// Responses

export interface InitializeResponse {
  useCaseSensitiveFileNames: boolean;
  currentDirectory: string;
  // Whether replies name objects the client already holds by their ids: true when the client asked for it.
  objectReferences?: boolean;
}

// A reply that is a type, or an array of types, carries each as a TypeResponse. When the client asked for object
// references, a type an earlier reply carried for the same snapshot and project is its id instead. Types inside other
// response objects are always TypeResponses. SymbolReply and SignatureReply do the same; symbols are kept per snapshot.
export type TypeReply = TypeResponse | number;
export type SymbolReply = SymbolResponse | number;
export type SignatureReply = SignatureResponse | number;

export interface UpdateSnapshotResponse {
  snapshot: number;
  projects: ProjectResponse[];
  changes?: SnapshotChanges;
}

export interface SnapshotChanges {
  changedProjects?: Record<string, ProjectFileChanges>;
  removedProjects?: string[];
}

export interface ProjectFileChanges {
  changedFiles?: string[];
  deletedFiles?: string[];
}

export interface ProjectResponse {
  id: string;
  configFileName: string;
  rootFiles: string[];
  compilerOptions: CompilerOptions;
}

export interface ConfigFileResponse {
  fileNames: string[];
  options: CompilerOptions;
}

export interface SymbolResponse {
  id: number;
  project: string;
  name: string;
  flags: number;
  checkFlags: number;
  declarations?: NodeHandle[];
  valueDeclaration?: NodeHandle;
  parent?: number;
  exportSymbol?: number;
}

export interface TypeResponse {
  id: number;
  flags: number;
  objectFlags: number;
  value: LiteralValueResponse;
  target?: number;
  typeParameters?: number[];
  outerTypeParameters?: number[];
  localTypeParameters?: number[];
  elementFlags?: number[];
  fixedLength?: number;
  readonly?: boolean;
  objectType?: number;
  indexType?: number;
  checkType?: number;
  extendsType?: number;
  baseType?: number;
  substConstraint?: number;
  texts?: string[];
  freshType?: number;
  regularType?: number;
  isThisType: boolean;
  intrinsicName?: string;
  aliasTypeArguments?: number[];
  aliasSymbol?: number;
  symbol?: number;
}

// Literal values on the wire: bigints are decimal strings.
export type LiteralValueResponse = string | number | boolean | null;

export interface SignatureResponse {
  id: number;
  flags: number;
  declaration?: NodeHandle;
  typeParameters?: number[];
  parameters?: number[];
  thisParameter?: number;
  target?: number;
}

export interface SourceFileMetadataResponse {
  isDefaultLibrary: boolean;
  isFromExternalLibrary: boolean;
  packageJsonType: string;
  packageJsonDirectory: string;
  impliedNodeFormat: number;
}

export interface IndexInfoResponse {
  keyType: TypeResponse;
  valueType: TypeResponse;
  isReadonly?: boolean;
  declaration?: NodeHandle;
}

export interface TypePredicateResponse {
  kind: number;
  parameterIndex: number;
  parameterName?: string;
  type?: TypeResponse;
}

export interface WellKnownSymbolsResponse {
  unknown: number;
  undefined: number;
  arguments: number;
}

export interface DiagnosticResponse {
  fileName?: string;
  pos: number;
  end: number;
  code: number;
  category: number;
  text: string;
  reportsUnnecessary?: boolean;
  reportsDeprecated?: boolean;
  messageChain?: DiagnosticResponse[];
  relatedInformation?: DiagnosticResponse[];
}

export function literalValueResponse(value: LiteralValue): LiteralValueResponse {
  if (value !== null && typeof value === 'object') return value.bigint;
  return value;
}

export interface JSDocTagInfo {
  name: string;
  text?: string;
}

export interface SymbolFileParams extends SymbolParams {
  file: DocumentIdentifier;
}

export interface ReferencedSymbolsParams extends ProjectParams {
  node?: NodeHandle;
  position?: number;
}

export interface ReferencedSymbolEntry {
  definition: NodeHandle;
  symbol?: SymbolResponse;
  references?: NodeHandle[];
}

export interface SignatureUsagesParams extends ProjectParams {
  signatureDecl?: NodeHandle;
}

export interface SignatureUsageResponse {
  name: NodeHandle;
  call?: NodeHandle;
}
