// Request parameters and responses of TypeScript 7.1's API, as sent over the wire.
// Fields are declared in the order tsc --api writes them.
import type { CompilerOptions, LiteralValue, ProjectReferenceData, TypeAcquisitionData } from './backend.js';

// A file name, or a document URI.
export type DocumentIdentifier = string | { uri: string };

export type NodeHandle = string;

// Params

// The changes a snapshot makes to its base (createSnapshot has none).
export interface SnapshotChangesParams {
  openProjects?: DocumentIdentifier[] | null;
  closeProjects?: DocumentIdentifier[] | null;
  openFiles?: DocumentIdentifier[] | null;
  closeFiles?: DocumentIdentifier[] | null;
  // `true` updates every project's program; a list, those projects'.
  ensurePrograms?: boolean | string[] | null;
  fileNotifications?: FileNotifications | null;
}

export interface UpdateSnapshotParams {
  snapshot?: number;
  changes?: SnapshotChangesParams | null;
}

export interface FileNotifications {
  invalidateAll?: boolean;
  changed?: DocumentIdentifier[] | null;
  created?: DocumentIdentifier[] | null;
  deleted?: DocumentIdentifier[] | null;
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

// A symbol of a source file (kind 0), named by the file and its id there, or of a snapshot's project (kind 1).
export interface SymbolReference {
  kind?: number;
  file?: SourceFileDescriptor;
  snapshot?: number;
  project?: string;
  id?: number;
}

// A source file as references name it. Each field is optional in requests, where a missing one is empty, as in tsc.
export interface SourceFileDescriptor {
  fileName?: string;
  path?: string;
  contentHash?: string;
  parseOptionsKey?: string;
  scriptKind?: number;
  nodeId?: string;
}

// A link to a symbol: its id, and for a file's symbol the file's node id.
export interface CompactSymbolReference {
  id: number;
  file?: string;
}

export interface SymbolParams extends ProjectParams {
  symbol?: SymbolReference | null;
}

export interface SymbolsParams extends ProjectParams {
  symbols?: (SymbolReference | null)[];
}

// Parameters of the symbol property methods: a symbol reference, without a snapshot or project.
export interface SymbolPropertyParams {
  symbol?: SymbolReference | null;
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
  symbol?: SymbolReference | null;
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

// Responses

export interface InitializeResponse {
  // 0 for case-insensitive file names, 1 for case-sensitive ones.
  caseSensitivity: number;
  currentDirectory: string;
}

export interface SnapshotResponse {
  snapshot: number;
  // Every project of a new snapshot, or those added or replaced relative to the base.
  projects: ProjectResponse[];
  changes?: SnapshotChanges;
  operation: SnapshotOperationResponse;
}

export interface SnapshotOperationResponse {
  openedFiles?: { project: string }[];
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
  // Absent for the inferred project.
  configFileName?: string;
  currentDirectory: string;
  // The program does not have the changes reported since it was made.
  dirty: boolean;
  parsedCommandLine: ConfigFileResponse;
}

export interface ConfigFileResponse {
  fileNames: string[];
  options: CompilerOptions;
  projectReferences?: ProjectReferenceData[];
  typeAcquisition?: TypeAcquisitionData;
  compileOnSave?: boolean;
  raw?: unknown;
  errors: DiagnosticResponse[];
}

export interface SymbolResponse {
  reference: SymbolReference;
  name: string;
  flags: number;
  checkFlags: number;
  declarations?: NodeHandle[];
  valueDeclaration?: NodeHandle;
  parent?: CompactSymbolReference;
  exportSymbol?: CompactSymbolReference;
}

export interface TypeResponse {
  id: number;
  flags: number;
  objectFlags: number;
  isTupleType: boolean;
  value: LiteralValueResponse;
  target?: number;
  typeParameters?: number[];
  outerTypeParameters?: number[];
  localTypeParameters?: number[];
  elementFlags?: number[];
  fixedLength?: number;
  readonly?: boolean;
  // The declarations of labeled elements; "" for an element without a label.
  labeledElementDeclarations?: NodeHandle[];
  objectType?: number;
  indexType?: number;
  checkType?: number;
  extendsType?: number;
  baseType?: number;
  substConstraint?: number;
  typeParameter?: number;
  constraintType?: number;
  nameType?: number;
  templateType?: number;
  texts?: string[];
  freshType?: number;
  regularType?: number;
  isThisType: boolean;
  thisType?: number;
  intrinsicName?: string;
  aliasTypeArguments?: number[];
  aliasSymbol?: CompactSymbolReference;
  symbol?: CompactSymbolReference;
}

// An enum member's or constant's value, and whether it is a number.
export interface ConstantValueResponse {
  isNumber: boolean;
  value: LiteralValueResponse;
}

// Literal values on the wire: bigints are decimal strings.
export type LiteralValueResponse = string | number | boolean | null;

export interface SignatureResponse {
  id: number;
  flags: number;
  declaration?: NodeHandle;
  typeParameters?: number[];
  parameters?: CompactSymbolReference[];
  thisParameter?: CompactSymbolReference;
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
  startPosition?: { line: number; character: number };
  endPosition?: { line: number; character: number };
  sourceLines?: { line: number; text: string }[];
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

export interface RetainSourceFileParams {
  file?: SourceFileDescriptor | null;
}

export interface RetainSourceFileResponse {
  lease: number;
}

export interface ReleaseSourceFileParams {
  lease?: number;
}
