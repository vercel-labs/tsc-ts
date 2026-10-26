/**
 * tsconfig.json: options, `extends`, `files`/`include`/`exclude` and project references, with tsgo's diagnostics.
 *
 * ```ts
 * const errors: Diagnostic[] = [];
 * const config = new ConfigParser(fs, '/app').parseConfigFile('/app/tsconfig.json', {}, undefined, errors);
 * ```
 */
import {
  ArrayLiteralExpression,
  ComputedPropertyName,
  ExpressionStatement,
  ExternalModuleIndicatorOptions,
  getText,
  Identifier,
  NumericLiteral,
  ObjectLiteralExpression,
  ParseOptions,
  PrefixUnaryExpression,
  PropertyAssignment,
  ScriptKind,
  StringLiteral,
  type Node,
  type SourceFile,
  propertyAssignmentPostfixToken,
} from './ast.js';
import { enumNamesList } from './command-line.js';
import {
  compareCodePoints,
  createCompilerDiagnostic,
  Diagnostic,
  Diagnostics,
  type DiagnosticMessage,
} from './diagnostics.js';
import type { FileSystem } from './file-system.js';
import { isValidLocale } from './locale.js';
import { ModuleResolutionHost, resolveConfig } from './module-resolution.js';
import {
  compilerOptionsByName,
  OptionNameMap,
  optionsForCompiler,
  typeAcquisitionDeclarations,
  type OptionDeclaration,
} from './option-declarations.js';
import {
  getAllowJS,
  getResolveJsonModule,
  mergeCompilerOptions,
  PluginImport,
  setCompilerOption,
  setTypeAcquisitionOption,
  type CompilerOptions,
  type OptionValue,
  type TypeAcquisition,
} from './options.js';
import {
  getBuildInfoFileName,
  getCommonSourceDirectory,
  getOutputDeclarationFileName,
  type OutputPathsHost,
} from './output-paths.js';
import { parseSourceFile } from './parser.js';
import {
  changeExtension,
  combinePaths,
  containsPath,
  fileExtensionIs,
  fileExtensionIsOneOf,
  getBaseFileName,
  getCanonicalFileName,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getPathComponentsRelativeTo,
  getPathFromPathComponents,
  hasJSFileExtension,
  isDeclarationFileName,
  isNetworkPathValue,
  isRootedDiskPath,
  normalizePath,
  normalizeSlashes,
  toPath,
} from './path.js';
import { skipTrivia } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import { hasExtension, MatchUsage, readDirectory, SpecMatcher, unlimitedDepth } from './vfs-match.js';

// ---- JSON values

/** A value of a config file as JSON: `null`, a primitive, an array or an object. */
export type JsonValue = null | boolean | number | string | JsonArray | JsonObject;

export class JsonArray {
  constructor(
    readonly items: JsonValue[],
    /** A non-empty array whose items were all `null` or invalid, which tsgo treats like a missing array. */
    readonly dropped = false,
  ) {}
}

/** Entries in source order; a repeated key keeps its first position and its last value. */
export class JsonObject {
  readonly entries = new Map<string, JsonValue>();
}

function stringItems(value: JsonValue | undefined): string[] | undefined {
  if (!(value instanceof JsonArray) || value.dropped) return undefined;
  const result: string[] = [];
  for (const item of value.items) if (typeof item === 'string') result.push(item);
  return result;
}

// ---- Supported extensions

const supportedTSExtensions: readonly (readonly string[])[] = [
  ['.ts', '.tsx', '.d.ts'],
  ['.cts', '.d.cts'],
  ['.mts', '.d.mts'],
];
const allSupportedExtensions: readonly (readonly string[])[] = [
  ['.ts', '.tsx', '.d.ts', '.js', '.jsx'],
  ['.cts', '.d.cts', '.cjs'],
  ['.mts', '.d.mts', '.mjs'],
];
const supportedTSExtensionsWithJson: readonly (readonly string[])[] = [...supportedTSExtensions, ['.json']];
const allSupportedExtensionsWithJson: readonly (readonly string[])[] = [...allSupportedExtensions, ['.json']];

/** Extensions of root files, in priority groups. */
export function getSupportedExtensions(options: CompilerOptions): readonly (readonly string[])[] {
  return getAllowJS(options) ? allSupportedExtensions : supportedTSExtensions;
}

export function getSupportedExtensionsWithJsonIfResolveJsonModule(
  options: CompilerOptions,
): readonly (readonly string[])[] {
  if (!getResolveJsonModule(options)) return getSupportedExtensions(options);
  return getAllowJS(options) ? allSupportedExtensionsWithJson : supportedTSExtensionsWithJson;
}

export function flattenExtensions(groups: readonly (readonly string[])[]): string[] {
  const result: string[] = [];
  for (const group of groups) for (const extension of group) result.push(extension);
  return result;
}

// ---- Parsed configuration

export class ProjectReference {
  constructor(
    /** Absolute path of the referenced config file or directory. */
    readonly path: string,
    readonly originalPath: string,
    readonly circular: boolean,
  ) {}
}

/** The config file `path` of a reference names: itself if a `.json` file, else its `tsconfig.json`. */
export function resolveProjectReferencePath(reference: ProjectReference): string {
  return fileExtensionIs(reference.path, '.json') ? reference.path : combinePaths(reference.path, 'tsconfig.json');
}

/** `files`, `include` and `exclude` after validation. */
export class ConfigFileSpecs {
  constructor(
    readonly validatedFilesSpec: readonly string[],
    readonly validatedIncludeSpecs: readonly string[],
    readonly validatedExcludeSpecs: readonly string[],
    readonly validatedFilesSpecBeforeSubstitution: readonly string[],
    readonly validatedIncludeSpecsBeforeSubstitution: readonly string[],
    readonly isDefaultIncludeSpec: boolean,
  ) {}

  matchesExclude(fileName: string, currentDirectory: string, useCaseSensitiveFileNames: boolean): boolean {
    if (this.validatedExcludeSpecs.length === 0) return false;
    const matcher = SpecMatcher.create(
      this.validatedExcludeSpecs,
      currentDirectory,
      MatchUsage.Exclude,
      useCaseSensitiveFileNames,
    );
    if (matcher === undefined) return false;
    if (matcher.matches(fileName)) return true;
    return !hasExtension(fileName) && matcher.matches(fileName + '/');
  }

  /** The `include` spec (as written) matching `fileName`, or `''`. */
  getMatchedIncludeSpec(fileName: string, currentDirectory: string, useCaseSensitiveFileNames: boolean): string {
    for (let i = 0; i < this.validatedIncludeSpecs.length; i++) {
      const matcher = SpecMatcher.create(
        [this.validatedIncludeSpecs[i]],
        currentDirectory,
        MatchUsage.Files,
        useCaseSensitiveFileNames,
      );
      if (matcher !== undefined && matcher.matches(fileName)) return this.validatedIncludeSpecsBeforeSubstitution[i];
    }
    return '';
  }

  /** The `files` entry (as written) naming `fileName`, or `''`. */
  getMatchedFileSpec(fileName: string, currentDirectory: string, useCaseSensitiveFileNames: boolean): string {
    const path = toPath(fileName, currentDirectory, useCaseSensitiveFileNames);
    for (let i = 0; i < this.validatedFilesSpec.length; i++) {
      if (toPath(this.validatedFilesSpec[i], currentDirectory, useCaseSensitiveFileNames) === path) {
        return this.validatedFilesSpecBeforeSubstitution[i];
      }
    }
    return '';
  }
}

/** A parsed config file: its syntax tree and the config files it extends. */
export class TsConfigSourceFile {
  /** Every config file this one extends, directly or not, sorted. */
  extendedSourceFiles: string[] = [];
  configFileSpecs: ConfigFileSpecs | undefined = undefined;

  constructor(readonly sourceFile: SourceFile) {}
}

/** Options, root files and references of a project, from a config file or the command line. */
export class ParsedCommandLine implements OutputPathsHost {
  /** The config file name, or `''`. */
  readonly configName: string;
  /** Where `getOutputDeclarationFileName` maps sources of this project, once computed. */
  private sourceToReference: Map<string, SourceOutputAndProjectReference> | undefined = undefined;
  private outputDtsToReference: Map<string, SourceOutputAndProjectReference> | undefined = undefined;
  private commonSourceDirectoryValue: string | undefined = undefined;
  private referencePaths: string[] | undefined = undefined;

  constructor(
    readonly options: CompilerOptions,
    readonly typeAcquisition: TypeAcquisition | undefined,
    readonly fileNames: readonly string[],
    readonly projectReferences: readonly ProjectReference[],
    readonly configFile: TsConfigSourceFile | undefined,
    readonly errors: Diagnostic[],
    /** The config's directory, or the current directory without a config. */
    readonly currentDirectory: string,
    readonly useCaseSensitiveFileNames: boolean,
    /** How many of `fileNames` come from `files`. */
    readonly literalFileNamesLength: number,
  ) {
    this.configName = configFile === undefined ? '' : configFile.sourceFile.fileName;
  }

  /** Config file paths of the references. */
  resolvedProjectReferencePaths(): readonly string[] {
    if (this.referencePaths === undefined) {
      this.referencePaths = [];
      for (const reference of this.projectReferences) this.referencePaths.push(resolveProjectReferencePath(reference));
    }
    return this.referencePaths;
  }

  /** Diagnostics of reading the config: syntax errors, then option errors. */
  configFileParsingDiagnostics(): readonly Diagnostic[] {
    if (this.configFile === undefined) return this.errors;
    return [...this.configFile.sourceFile.diagnostics, ...this.errors];
  }

  getMatchedFileSpec(fileName: string): string {
    const specs = this.configFile?.configFileSpecs;
    if (specs === undefined) return '';
    return specs.getMatchedFileSpec(fileName, this.currentDirectory, this.useCaseSensitiveFileNames);
  }

  /** The `include` spec matching `fileName`, or `''`; the default spec `**\/*` matches everything. */
  getMatchedIncludeSpec(fileName: string): string {
    const specs = this.configFile?.configFileSpecs;
    if (specs === undefined || specs.validatedIncludeSpecs.length === 0) return '';
    if (specs.isDefaultIncludeSpec) return specs.validatedIncludeSpecs[0];
    return specs.getMatchedIncludeSpec(fileName, this.currentDirectory, this.useCaseSensitiveFileNames);
  }

  isDefaultIncludeSpec(): boolean {
    const specs = this.configFile?.configFileSpecs;
    return specs !== undefined && specs.isDefaultIncludeSpec && specs.validatedIncludeSpecs.length > 0;
  }

  /** The directory outputs are laid out relative to (with a trailing `/`), or `''`. */
  commonSourceDirectory(): string {
    if (this.commonSourceDirectoryValue === undefined) {
      this.commonSourceDirectoryValue = getCommonSourceDirectory(
        this.options,
        () => this.emittedRootFiles(),
        this.currentDirectory,
        this.useCaseSensitiveFileNames,
        (files, root) => this.checkSourceFilesBelongToPath(files, root),
      );
    }
    return this.commonSourceDirectoryValue;
  }

  private emittedRootFiles(): string[] {
    const files: string[] = [];
    for (const file of this.fileNames) {
      if (this.options.noEmitForJsFiles === true && hasJSFileExtension(file)) continue;
      if (!isDeclarationFileName(file)) files.push(file);
    }
    return files;
  }

  private checkSourceFilesBelongToPath(files: readonly string[], root: string): void {
    for (const file of files) {
      if (containsPath(root, file, this.useCaseSensitiveFileNames, this.currentDirectory)) continue;
      const absolute = getCanonicalFileName(
        getNormalizedAbsolutePath(file, this.currentDirectory),
        this.useCaseSensitiveFileNames,
      );
      this.errors.push(
        createCompilerDiagnostic(
          Diagnostics.File_0_is_not_under_rootDir_1_rootDir_is_expected_to_contain_all_source_files,
          absolute,
          root,
        ),
      );
    }
  }

  /** Maps each source of this project to its declaration output and back. */
  sourceToProjectReference(): ReadonlyMap<string, SourceOutputAndProjectReference> {
    this.parseInputOutputNames();
    return this.sourceToReference ?? new Map();
  }

  outputDtsToProjectReference(): ReadonlyMap<string, SourceOutputAndProjectReference> {
    this.parseInputOutputNames();
    return this.outputDtsToReference ?? new Map();
  }

  private parseInputOutputNames(): void {
    if (this.sourceToReference !== undefined) return;
    const sourceToReference = new Map<string, SourceOutputAndProjectReference>();
    const outputDtsToReference = new Map<string, SourceOutputAndProjectReference>();
    for (const fileName of this.fileNames) {
      const outputDts =
        isDeclarationFileName(fileName) || fileExtensionIs(fileName, '.json')
          ? ''
          : getOutputDeclarationFileName(fileName, this.options, this);
      const reference = new SourceOutputAndProjectReference(fileName, outputDts, this);
      if (outputDts !== '') {
        outputDtsToReference.set(toPath(outputDts, this.currentDirectory, this.useCaseSensitiveFileNames), reference);
      }
      sourceToReference.set(toPath(fileName, this.currentDirectory, this.useCaseSensitiveFileNames), reference);
    }
    this.sourceToReference = sourceToReference;
    this.outputDtsToReference = outputDtsToReference;
  }

  /** The `.tsbuildinfo` file of an incremental build, or `''`. */
  buildInfoFileName(): string {
    return getBuildInfoFileName(this.options, this.currentDirectory, this.useCaseSensitiveFileNames);
  }
}

/** A source file of a referenced project and its declaration output. */
export class SourceOutputAndProjectReference {
  constructor(
    readonly source: string,
    /** `''` for declaration and JSON sources. */
    readonly outputDts: string,
    readonly resolved: ParsedCommandLine,
  ) {}
}

// ---- Root option declarations

const rootDeclaration: OptionDeclaration = { name: 'undefined', kind: 'object' };
const compilerOptionsDeclaration: OptionDeclaration = { name: 'compilerOptions', kind: 'object' };
const typeAcquisitionDeclaration: OptionDeclaration = { name: 'typeAcquisition', kind: 'object' };
const extendsDeclaration: OptionDeclaration = {
  name: 'extends',
  kind: 'listOrElement',
  element: { name: 'extends', kind: 'string' },
};
const rootOptions = new OptionNameMap([
  compilerOptionsDeclaration,
  typeAcquisitionDeclaration,
  extendsDeclaration,
  { name: 'references', kind: 'list', element: { name: 'references', kind: 'object' } },
  { name: 'files', kind: 'list', element: { name: 'files', kind: 'string' } },
  { name: 'include', kind: 'list', element: { name: 'include', kind: 'string' } },
  { name: 'exclude', kind: 'list', element: { name: 'exclude', kind: 'string' } },
  { name: 'compileOnSave', kind: 'boolean' },
]);
const typeAcquisitionOptions = new OptionNameMap(typeAcquisitionDeclarations);

/** Declarations of the keys of an object option, if they are checked. */
function elementOptions(option: OptionDeclaration): OptionNameMap | undefined {
  if (option === rootDeclaration) return rootOptions;
  if (option === compilerOptionsDeclaration) return compilerOptionsByName;
  if (option === typeAcquisitionDeclaration) return typeAcquisitionOptions;
  return undefined;
}

function unknownKeyMessage(parent: OptionDeclaration): DiagnosticMessage | undefined {
  if (parent === compilerOptionsDeclaration) return Diagnostics.Unknown_compiler_option_0;
  if (parent === typeAcquisitionDeclaration) return Diagnostics.Unknown_type_acquisition_option_0;
  return undefined;
}

function unknownKeyDidYouMeanMessage(parent: OptionDeclaration): DiagnosticMessage {
  return parent === compilerOptionsDeclaration
    ? Diagnostics.Unknown_compiler_option_0_Did_you_mean_1
    : Diagnostics.Unknown_type_acquisition_option_0_Did_you_mean_1;
}

function valueTypeName(option: OptionDeclaration): string {
  if (option.kind === 'list') return 'Array';
  if (option.kind === 'listOrElement') return (option.element?.kind ?? 'string') + ' or Array';
  return option.kind;
}

// ---- Diagnostics at syntax

/** A diagnostic at `node` without its leading trivia, or a compiler diagnostic without a node. */
export function diagnosticAtNode(
  file: SourceFile | undefined,
  node: Node | undefined,
  message: DiagnosticMessage,
  ...args: string[]
): Diagnostic {
  if (file === undefined || node === undefined) return createCompilerDiagnostic(message, ...args);
  return new Diagnostic(file.diagnosticFile(), skipTrivia(file.text, node.pos), node.end, message, args);
}

/** A diagnostic spanning `node` including its leading trivia. */
function diagnosticAtRange(file: SourceFile, node: Node, message: DiagnosticMessage, ...args: string[]): Diagnostic {
  return new Diagnostic(file.diagnosticFile(), node.pos, node.end, message, args);
}

/** The root object of a config file. */
export function getTsConfigObjectLiteral(file: SourceFile | undefined): ObjectLiteralExpression | undefined {
  if (file === undefined || file.statements.nodes.length === 0) return undefined;
  const statement = file.statements.nodes[0];
  if (statement instanceof ExpressionStatement && statement.expression instanceof ObjectLiteralExpression) {
    return statement.expression;
  }
  return undefined;
}

/** The first property assignment of `object` named `key` (or `key2`). */
export function findPropertyAssignment(
  object: ObjectLiteralExpression | undefined,
  key: string,
  key2 = '',
): PropertyAssignment | undefined {
  if (object === undefined) return undefined;
  for (const property of object.properties.nodes) {
    if (!(property instanceof PropertyAssignment)) continue;
    const name = propertyNameText(property.name);
    // `as`: scriptc loses instanceof narrowing of loop variables.
    if (name !== undefined && (name === key || (key2 !== '' && name === key2))) return property as PropertyAssignment;
  }
  return undefined;
}

/**
 * A diagnostic at property `propertyName` of the `index`th project reference: at its value, else at the
 * reference, else a compiler diagnostic. As in tsgo, `index` counts the references the JSON value kept.
 */
function diagnosticAtProjectReferenceProperty(
  file: SourceFile | undefined,
  index: number,
  propertyName: string,
  message: DiagnosticMessage,
  ...args: string[]
): Diagnostic {
  let node: Node | undefined;
  const root = getTsConfigObjectLiteral(file);
  if (root !== undefined)
    for (const property of root.properties.nodes) {
      if (!(property instanceof PropertyAssignment) || propertyNameText(property.name) !== 'references') continue;
      const initializer = (property as PropertyAssignment).initializer;
      if (!(initializer instanceof ArrayLiteralExpression)) continue;
      const elements = initializer.elements.nodes;
      if (index >= elements.length || !(elements[index] instanceof ObjectLiteralExpression)) continue;
      const element = elements[index] as ObjectLiteralExpression;
      node = findPropertyAssignment(element, propertyName)?.initializer ?? element;
      break;
    }
  return diagnosticAtNode(file, node, message, ...args);
}

/** The string literal `value` in the array of the root property `key`. */
export function findTsConfigArrayElement(
  file: SourceFile | undefined,
  key: string,
  value: string,
): StringLiteral | undefined {
  return findArrayElement(findPropertyAssignment(getTsConfigObjectLiteral(file), key), value);
}

/** The string literal `value` in the array initializing `property`. */
export function findArrayElement(property: PropertyAssignment | undefined, value: string): StringLiteral | undefined {
  if (property === undefined || !(property.initializer instanceof ArrayLiteralExpression)) return undefined;
  for (const element of property.initializer.elements.nodes) {
    if (element instanceof StringLiteral && element.text === value) return element;
  }
  return undefined;
}

/** The text of a property name, or `undefined` for computed names that aren't literals. */
export function propertyNameText(name: Node): string | undefined {
  // Separate tests: scriptc can't access members through a union of classes.
  if (name instanceof Identifier) return name.text;
  if (name instanceof StringLiteral) return name.text;
  if (name instanceof NumericLiteral) return name.text;
  if (name instanceof ComputedPropertyName) {
    const expression = name.expression;
    if (expression instanceof StringLiteral) return expression.text;
    if (expression instanceof NumericLiteral) return expression.text;
    return undefined;
  }
  if (name.kind === SyntaxKind.PrivateIdentifier || name.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return getText(name);
  }
  return undefined;
}

// ---- Spec validation

/**
 * Rejects specs that resolve to a network root (`basePath` given), specs ending in `**` (for `include`) and `..`
 * after a `**`. `?` is a wildcard in specs, so only UNC and device roots name a network path there.
 */
export function specToDiagnostic(
  spec: string,
  disallowTrailingRecursion: boolean,
  basePath?: string,
): DiagnosticMessage | undefined {
  if (basePath !== undefined && getNormalizedAbsolutePath(spec, basePath).startsWith('//'))
    return Diagnostics.Network_path_0_is_not_supported;
  if (disallowTrailingRecursion) {
    const trimmed = spec.endsWith('/') ? spec.slice(0, -1) : spec;
    if (trimmed === '**' || trimmed.endsWith('/**')) {
      return Diagnostics.File_specification_cannot_end_in_a_recursive_directory_wildcard_Asterisk_Asterisk_Colon_0;
    }
  }
  const wildcard = spec.startsWith('**/') ? 0 : spec.indexOf('/**/');
  if (wildcard === -1) return undefined;
  const lastDotDot = spec.endsWith('/..') ? spec.length : spec.lastIndexOf('/../');
  return lastDotDot > wildcard
    ? Diagnostics.File_specification_cannot_contain_a_parent_directory_that_appears_after_a_recursive_directory_wildcard_Asterisk_Asterisk_Colon_0
    : undefined;
}

function validateSpecs(
  specs: readonly JsonValue[],
  disallowTrailingRecursion: boolean,
  basePath: string,
  file: SourceFile,
  key: string,
  errors: Diagnostic[],
): string[] {
  const result: string[] = [];
  for (const spec of specs) {
    if (typeof spec !== 'string') continue;
    const message = specToDiagnostic(spec, disallowTrailingRecursion, basePath);
    if (message === undefined) result.push(spec);
    else errors.push(diagnosticAtNode(file, findTsConfigArrayElement(file, key, spec), message, spec));
  }
  return result;
}

// ---- ${configDir}

const configDirTemplate = '$' + '{configDir}';
const configDirTemplateLower = configDirTemplate.toLowerCase();

function startsWithConfigDirTemplate(value: string): boolean {
  return (
    value.length >= configDirTemplate.length &&
    value.slice(0, configDirTemplate.length).toLowerCase() === configDirTemplateLower
  );
}

function substituteConfigDir(value: string, basePath: string): string {
  return getNormalizedAbsolutePath(value.replace(configDirTemplate, './'), basePath);
}

/** `list` with `${configDir}` substituted, or `undefined` if no item uses it. */
function substituteConfigDirInList(list: readonly string[] | undefined, basePath: string): string[] | undefined {
  if (list === undefined) return undefined;
  let result: string[] | undefined;
  for (let i = 0; i < list.length; i++) {
    if (!startsWithConfigDirTemplate(list[i])) continue;
    if (result === undefined) result = list.slice();
    result[i] = substituteConfigDir(list[i], basePath);
  }
  return result;
}

function substituteConfigDirInPath(value: string | undefined, basePath: string): string | undefined {
  return value !== undefined && startsWithConfigDirTemplate(value) ? substituteConfigDir(value, basePath) : value;
}

function substituteConfigDirInOptions(options: CompilerOptions, basePath: string): void {
  const paths = options.paths;
  if (paths !== undefined) {
    let substitutedPaths: Map<string, string[] | undefined> | undefined;
    for (const [key, value] of paths) {
      const substituted = substituteConfigDirInList(value, basePath);
      if (substituted === undefined) continue;
      if (substitutedPaths === undefined) substitutedPaths = new Map(paths);
      substitutedPaths.set(key, substituted);
    }
    if (substitutedPaths !== undefined) options.paths = substitutedPaths;
  }
  options.rootDirs = substituteConfigDirInList(options.rootDirs, basePath) ?? options.rootDirs;
  options.typeRoots = substituteConfigDirInList(options.typeRoots, basePath) ?? options.typeRoots;
  options.generateCpuProfile = substituteConfigDirInPath(options.generateCpuProfile, basePath);
  options.generateTrace = substituteConfigDirInPath(options.generateTrace, basePath);
  options.outFile = substituteConfigDirInPath(options.outFile, basePath);
  options.outDir = substituteConfigDirInPath(options.outDir, basePath);
  options.rootDir = substituteConfigDirInPath(options.rootDir, basePath);
  options.tsBuildInfoFile = substituteConfigDirInPath(options.tsBuildInfoFile, basePath);
  options.baseUrl = substituteConfigDirInPath(options.baseUrl, basePath);
  options.declarationDir = substituteConfigDirInPath(options.declarationDir, basePath);
}

function nullKeysOfCompilerOptions(raw: JsonValue | undefined): Set<string> | undefined {
  if (!(raw instanceof JsonObject)) return undefined;
  const compilerOptions = raw.entries.get('compilerOptions');
  if (!(compilerOptions instanceof JsonObject)) return undefined;
  let result: Set<string> | undefined;
  for (const [key, value] of compilerOptions.entries) {
    if (value !== null) continue;
    if (result === undefined) result = new Set();
    result.add(key);
  }
  return result;
}

/** Names of options given as `null` on the command line. */
export function nullKeysOfCommandLine(raw: ReadonlyMap<string, OptionValue> | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;
  let result: Set<string> | undefined;
  for (const [key, value] of raw) {
    if (value !== null) continue;
    if (result === undefined) result = new Set();
    result.add(key);
  }
  return result;
}

// ---- File names

function hasFileWithHigherPriorityExtension(
  file: string,
  extensions: readonly (readonly string[])[],
  literalFiles: ReadonlyMap<string, string>,
  wildcardFiles: ReadonlyMap<string, string>,
  useCaseSensitiveFileNames: boolean,
): boolean {
  const group = extensionGroupOf(file, extensions);
  for (const extension of group) {
    // `a.d.ts` also ends in `.ts`; it only yields to `a.ts` and `a.tsx` by the order below.
    if (fileExtensionIs(file, extension) && (extension !== '.ts' || !fileExtensionIs(file, '.d.ts'))) return false;
    const key = getCanonicalFileName(changeExtension(file, extension), useCaseSensitiveFileNames);
    if (literalFiles.has(key) || wildcardFiles.has(key)) {
      // Declarations next to JavaScript are kept, as in TypeScript.
      if (extension === '.d.ts' && (fileExtensionIs(file, '.js') || fileExtensionIs(file, '.jsx'))) continue;
      return true;
    }
  }
  return false;
}

function removeWildcardFilesWithLowerPriorityExtension(
  file: string,
  wildcardFiles: Map<string, string>,
  extensions: readonly (readonly string[])[],
  useCaseSensitiveFileNames: boolean,
): void {
  const group = extensionGroupOf(file, extensions);
  for (let i = group.length - 1; i >= 0; i--) {
    const extension = group[i];
    if (fileExtensionIs(file, extension)) return;
    wildcardFiles.delete(getCanonicalFileName(changeExtension(file, extension), useCaseSensitiveFileNames));
  }
}

/** The extensions of every group containing the extension of `file`. */
function extensionGroupOf(file: string, extensions: readonly (readonly string[])[]): string[] {
  const result: string[] = [];
  for (const group of extensions) {
    if (fileExtensionIsOneOf(file, group)) for (const extension of group) result.push(extension);
  }
  return result;
}

/** A root list of the raw config: its items, and whether it was given as an array. */
class RawList {
  constructor(
    /** `undefined` for a missing or non-array value, or an array whose items were all dropped. */
    readonly items: readonly JsonValue[] | undefined,
    readonly isArray: boolean,
  ) {}
}

function rawList(raw: JsonValue | undefined, key: string): RawList {
  if (raw instanceof JsonObject) {
    const value = raw.entries.get(key);
    if (value instanceof JsonArray) return new RawList(value.dropped ? undefined : value.items, true);
  }
  return new RawList(undefined, false);
}

/** tsgo's JSON encoding of a list, where missing arrays are `[]`. */
function jsonList(items: readonly JsonValue[] | undefined): string {
  if (items === undefined) return '[]';
  const parts: string[] = [];
  for (const item of items) parts.push(jsonText(item));
  return '[' + parts.join(',') + ']';
}

function jsonText(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value instanceof JsonArray) return jsonList(value.dropped ? undefined : value.items);
  const parts: string[] = [];
  for (const [key, item] of value.entries) parts.push(jsonText(key) + ':' + jsonText(item));
  return '{' + parts.join(',') + '}';
}

// ---- Parsing

/** A module resolution host reading a file system, for `extends` of packages. */
class FileSystemResolutionHost extends ModuleResolutionHost {
  constructor(
    private readonly fs: FileSystem,
    private readonly currentDirectory: string,
  ) {
    super();
  }

  useCaseSensitiveFileNames(): boolean {
    return this.fs.useCaseSensitiveFileNames;
  }

  getCurrentDirectory(): string {
    return this.currentDirectory;
  }

  fileExists(path: string): boolean {
    return this.fs.fileExists(path);
  }

  directoryExists(path: string): boolean {
    return this.fs.directoryExists(path);
  }

  readFile(path: string): string | undefined {
    return this.fs.readFile(path);
  }

  realpath(path: string): string {
    return this.fs.realpath(path);
  }

  getDirectories(path: string): readonly string[] {
    return this.fs.getAccessibleEntries(path).directories;
  }
}

/** One config file's own settings, before applying the configs it extends. */
class OwnConfig {
  constructor(
    /** `null` for a config in an `extends` cycle. */
    readonly raw: JsonValue,
    /** `undefined` for a config in an `extends` cycle. */
    public options: CompilerOptions | undefined,
    readonly typeAcquisition: TypeAcquisition | undefined,
    /** Resolved `extends` paths; `undefined` without `extends`. */
    readonly extendedConfigPaths: readonly string[] | undefined,
  ) {}
}

/** A parsed extended config, shared by every config that extends it. */
class ExtendedConfig {
  constructor(
    readonly file: TsConfigSourceFile,
    readonly config: OwnConfig | undefined,
    readonly errors: readonly Diagnostic[],
  ) {}
}

/** What the configs extended by one config contribute to it. */
class ExtendsResult {
  readonly options: CompilerOptions = {};
  include: JsonArray | undefined = undefined;
  exclude: JsonArray | undefined = undefined;
  files: JsonArray | undefined = undefined;
  compileOnSave = false;
  readonly extendedSourceFiles = new Set<string>();
}

/** Converts a config file's syntax tree into JSON, applying options as they are found. */
class ConfigFileConverter {
  readonly options: CompilerOptions;
  readonly typeAcquisition: TypeAcquisition = {};
  extendedConfigPaths: string[] | undefined = undefined;
  /** Names of compiler options written at the root instead of in `compilerOptions`. */
  readonly rootCompilerOptions: Node[] = [];

  constructor(
    private readonly parser: ConfigParser,
    private readonly file: SourceFile,
    private readonly basePath: string,
    private readonly configFileName: string,
    private readonly errors: Diagnostic[],
  ) {
    this.options = {};
    if (configFileName !== '' && getBaseFileName(configFileName) === 'jsconfig.json') {
      this.options.allowJs = true;
      this.options.maxNodeModuleJsDepth = 2;
      this.options.skipLibCheck = true;
      this.options.noEmit = true;
      this.typeAcquisition.enable = true;
    }
  }

  /** The root value, which must be an object; recovers the first object of an array. */
  convertRoot(): JsonValue {
    const statements = this.file.statements.nodes;
    const statement = statements.length > 0 ? statements[0] : undefined;
    const root = statement instanceof ExpressionStatement ? statement.expression : undefined;
    if (root === undefined) return new JsonObject();
    if (!(root instanceof ObjectLiteralExpression)) {
      // Error recovery may wrap the object in an array: use its first object, without reporting the root.
      if (root instanceof ArrayLiteralExpression) {
        for (const element of root.elements.nodes) {
          if (element instanceof ObjectLiteralExpression) {
            return this.convertObject(element as ObjectLiteralExpression, rootDeclaration);
          }
        }
      }
      const name = getBaseFileName(this.file.fileName) === 'jsconfig.json' ? 'jsconfig.json' : 'tsconfig.json';
      this.errors.push(
        diagnosticAtNode(this.file, root, Diagnostics.The_root_value_of_a_0_file_must_be_an_object, name),
      );
      return new JsonObject();
    }
    return this.convertObject(root, rootDeclaration);
  }

  private convertValue(expression: Node, option: OptionDeclaration | undefined): JsonValue {
    switch (expression.kind) {
      case SyntaxKind.TrueKeyword:
        return true;
      case SyntaxKind.FalseKeyword:
        return false;
      case SyntaxKind.NullKeyword:
        return null;
      case SyntaxKind.StringLiteral:
        if (expression instanceof StringLiteral) return expression.text;
        break;
      case SyntaxKind.NumericLiteral:
        if (expression instanceof NumericLiteral) return Number(expression.text);
        break;
      case SyntaxKind.PrefixUnaryExpression:
        if (
          expression instanceof PrefixUnaryExpression &&
          expression.operator === SyntaxKind.MinusToken &&
          expression.operand instanceof NumericLiteral
        ) {
          return -Number(expression.operand.text);
        }
        break;
      case SyntaxKind.ObjectLiteralExpression:
        if (expression instanceof ObjectLiteralExpression) return this.convertObject(expression, option);
        break;
      case SyntaxKind.ArrayLiteralExpression:
        if (expression instanceof ArrayLiteralExpression) return this.convertArray(expression, option);
        break;
    }
    this.errors.push(
      option !== undefined
        ? diagnosticAtRange(
            this.file,
            expression,
            Diagnostics.Compiler_option_0_requires_a_value_of_type_1,
            option.name,
            valueTypeName(option),
          )
        : diagnosticAtRange(
            this.file,
            expression,
            Diagnostics.Property_value_can_only_be_string_literal_numeric_literal_true_false_null_object_literal_or_array_literal,
          ),
    );
    return null;
  }

  private convertArray(node: ArrayLiteralExpression, option: OptionDeclaration | undefined): JsonArray {
    const elements = node.elements.nodes;
    const items: JsonValue[] = [];
    for (const element of elements) {
      const value = this.convertValue(element, option);
      if (value !== null) items.push(value);
    }
    return new JsonArray(items, elements.length > 0 && items.length === 0);
  }

  private convertObject(node: ObjectLiteralExpression, objectOption: OptionDeclaration | undefined): JsonObject {
    const result = new JsonObject();
    const known = objectOption === undefined ? undefined : elementOptions(objectOption);
    for (const element of node.properties.nodes) {
      if (!(element instanceof PropertyAssignment)) {
        this.errors.push(diagnosticAtRange(this.file, element, Diagnostics.Property_assignment_expected));
        continue;
      }
      const postfix = propertyAssignmentPostfixToken(element);
      if (postfix !== undefined && postfix.kind === SyntaxKind.QuestionToken) {
        this.errors.push(
          diagnosticAtRange(this.file, postfix, Diagnostics.The_0_modifier_can_only_be_used_in_TypeScript_files, '?'),
        );
      }
      const key = propertyNameText(element.name) ?? '';
      let option = key !== '' && known !== undefined ? known.get(key) : undefined;
      if (option !== undefined && option.name !== key) option = undefined;
      const value = this.convertValue(element.initializer, option);
      if (key !== '') {
        result.entries.set(key, value);
        this.onPropertySet(key, value, element as PropertyAssignment, objectOption, option);
      }
    }
    return result;
  }

  private onPropertySet(
    key: string,
    value: JsonValue,
    property: PropertyAssignment,
    parent: OptionDeclaration | undefined,
    option: OptionDeclaration | undefined,
  ): void {
    if (option !== undefined && option !== extendsDeclaration) {
      value = this.parser.convertOption(
        option,
        value,
        this.basePath,
        property,
        property.initializer,
        this.file,
        this.errors,
      );
    }
    if (parent !== undefined && parent !== rootDeclaration && value !== null) {
      if (option !== undefined) {
        if (parent === compilerOptionsDeclaration) setCompilerOptionFromJson(this.options, option, value);
        else if (parent === typeAcquisitionDeclaration) setTypeAcquisitionFromJson(this.typeAcquisition, option, value);
        return;
      }
      const unknownMessage = unknownKeyMessage(parent);
      if (unknownMessage === undefined) return;
      const possible = elementOptions(parent)?.get(key);
      if (possible !== undefined && possible.name !== key) {
        this.errors.push(
          diagnosticAtNode(this.file, property.name, unknownKeyDidYouMeanMessage(parent), key, possible.name),
        );
      } else {
        this.errors.push(diagnosticAtNode(this.file, property.name, unknownMessage, key));
      }
    } else if (parent === rootDeclaration) {
      if (option === extendsDeclaration) {
        this.extendedConfigPaths = this.parser.getExtendsConfigPaths(
          value,
          this.basePath,
          this.configFileName,
          property,
          property.initializer,
          this.file,
          this.errors,
        );
      } else if (option === undefined) {
        if (key === 'excludes')
          this.errors.push(
            diagnosticAtNode(this.file, property.name, Diagnostics.Unknown_option_excludes_Did_you_mean_exclude),
          );
        for (const compilerOption of optionsForCompiler)
          if (compilerOption.name === key) {
            this.rootCompilerOptions.push(property.name);
            break;
          }
      }
    }
  }
}

function setCompilerOptionFromJson(options: CompilerOptions, option: OptionDeclaration, value: JsonValue): void {
  if (option.name === 'paths') {
    if (!(value instanceof JsonObject)) return;
    const paths = new Map<string, string[] | undefined>();
    for (const [key, substitutions] of value.entries) paths.set(key, stringItems(substitutions));
    options.paths = paths;
    return;
  }
  if (option.name === 'plugins') {
    if (!(value instanceof JsonArray)) return;
    options.plugins = value.items.map((item) => {
      const name = item instanceof JsonObject ? item.entries.get('name') : undefined;
      return new PluginImport(typeof name === 'string' ? name : '');
    });
    return;
  }
  setCompilerOption(options, option.name, toOptionValue(option, value));
}

function setTypeAcquisitionFromJson(options: TypeAcquisition, option: OptionDeclaration, value: JsonValue): void {
  setTypeAcquisitionOption(options, option.name, toOptionValue(option, value));
}

function toOptionValue(option: OptionDeclaration, value: JsonValue): OptionValue {
  if (value instanceof JsonArray) return stringItems(value) ?? null;
  if (value instanceof JsonObject) return null;
  if (typeof value === 'number' && option.kind === 'number') return Math.trunc(value);
  return value;
}

/** Reads config files with a file system, sharing parsed `extends` targets. */
export class ConfigParser {
  private readonly extendedConfigs = new Map<string, ExtendedConfig>();
  private readonly resolutionHost: FileSystemResolutionHost;
  /**
   * Whether parsed configs list their root files. Parse threads (parallel-parse.ts), which get the
   * files to load from the main thread, read the config without matching `include` patterns.
   */
  expandFileNames = true;
  /**
   * Called once, with the options of the config, before its `include` patterns are matched; what it
   * returns is called with each root file name as it is found: literal `files` first, then the matched
   * files a directory at a time, without those that a file of the same name with a higher priority
   * extension leaves out.
   */
  beforeRootFiles: ((options: CompilerOptions) => ((fileName: string) => void) | undefined) | undefined = undefined;

  constructor(
    readonly fs: FileSystem,
    readonly currentDirectory: string,
  ) {
    this.resolutionHost = new FileSystemResolutionHost(fs, currentDirectory);
  }

  /**
   * Reads `configFileName` and applies command-line `options` (`raw` as given, for `null` resets) over it.
   * Returns `undefined`, with `errors`, if the file can't be read.
   */
  parseConfigFile(
    configFileName: string,
    options: CompilerOptions | undefined,
    raw: ReadonlyMap<string, OptionValue> | undefined,
    errors: Diagnostic[],
  ): ParsedCommandLine | undefined {
    const fileName = getNormalizedAbsolutePath(configFileName, this.currentDirectory);
    const text = this.fs.readFile(fileName);
    if (text === undefined) {
      errors.push(createCompilerDiagnostic(Diagnostics.Cannot_read_file_0, fileName));
      return undefined;
    }
    const path = toPath(fileName, this.currentDirectory, this.fs.useCaseSensitiveFileNames);
    const file = new TsConfigSourceFile(parseConfigText(fileName, path, text));
    return this.parseConfigFileContent(file, getDirectoryPath(fileName), options, raw, fileName);
  }

  /** Converts a parsed config file into options and root files. */
  parseConfigFileContent(
    file: TsConfigSourceFile,
    basePath: string,
    existingOptions: CompilerOptions | undefined,
    existingRaw: ReadonlyMap<string, OptionValue> | undefined,
    configFileName: string,
  ): ParsedCommandLine {
    const cs = this.fs.useCaseSensitiveFileNames;
    const basePathForFileNames = normalizePath(
      configFileName !== '' ? getDirectoryPath(getNormalizedAbsolutePath(configFileName, basePath)) : basePath,
    );
    const errors: Diagnostic[] = [];
    const parsed = this.parseConfig(file, basePath, configFileName, [], errors);
    const options = parsed.options ?? {};
    if (existingOptions !== undefined)
      mergeCompilerOptions(options, existingOptions, nullKeysOfCommandLine(existingRaw));
    substituteConfigDirInOptions(options, basePathForFileNames);
    if (configFileName !== '') options.configFilePath = normalizeSlashes(configFileName);
    const raw = parsed.raw;

    const references = rawList(raw, 'references');
    const files = rawList(raw, 'files');
    if (files.isArray) {
      const referenceCount = references.items === undefined ? 0 : references.items.length;
      const extendsValue = raw instanceof JsonObject ? (raw.entries.get('extends') ?? null) : null;
      if (files.items !== undefined && files.items.length === 0 && referenceCount === 0 && extendsValue === null) {
        const filesProperty = findPropertyAssignment(getTsConfigObjectLiteral(file.sourceFile), 'files');
        errors.push(
          diagnosticAtNode(
            file.sourceFile,
            filesProperty?.initializer,
            Diagnostics.The_files_list_in_config_file_0_is_empty,
            configFileName !== '' ? configFileName : 'tsconfig.json',
          ),
        );
      }
    }
    let include = rawList(raw, 'include');
    let exclude = rawList(raw, 'exclude');
    let isDefaultIncludeSpec = false;
    if (!exclude.isArray && (options.outDir !== undefined || options.declarationDir !== undefined)) {
      const defaults: JsonValue[] = [];
      if (options.outDir !== undefined) defaults.push(options.outDir);
      if (options.declarationDir !== undefined) defaults.push(options.declarationDir);
      exclude = new RawList(defaults, true);
    }
    if (files.items === undefined && include.items === undefined) {
      include = new RawList(['**/*'], true);
      isDefaultIncludeSpec = true;
    }

    let validatedIncludeBeforeSubstitution: string[] = [];
    let validatedInclude: string[] = [];
    if (include.items !== undefined) {
      validatedIncludeBeforeSubstitution = validateSpecs(
        include.items,
        true,
        basePathForFileNames,
        file.sourceFile,
        'include',
        errors,
      );
      validatedInclude =
        substituteConfigDirInList(validatedIncludeBeforeSubstitution, basePathForFileNames) ??
        validatedIncludeBeforeSubstitution;
    }
    let validatedExclude: string[] = [];
    if (exclude.items !== undefined) {
      validatedExclude = validateSpecs(exclude.items, false, basePathForFileNames, file.sourceFile, 'exclude', errors);
      validatedExclude = substituteConfigDirInList(validatedExclude, basePathForFileNames) ?? validatedExclude;
    }
    let validatedFilesBeforeSubstitution: string[] = [];
    let validatedFiles: string[] = [];
    if (files.items !== undefined) {
      for (const spec of files.items) {
        if (typeof spec !== 'string') continue;
        if (isNetworkPathValue(spec, basePathForFileNames)) {
          errors.push(
            diagnosticAtNode(
              file.sourceFile,
              findTsConfigArrayElement(file.sourceFile, 'files', spec),
              Diagnostics.Network_path_0_is_not_supported,
              spec,
            ),
          );
          continue;
        }
        validatedFilesBeforeSubstitution.push(spec);
      }
      validatedFiles =
        substituteConfigDirInList(validatedFilesBeforeSubstitution, basePathForFileNames) ??
        validatedFilesBeforeSubstitution;
    }
    const specs = new ConfigFileSpecs(
      validatedFiles,
      validatedInclude,
      validatedExclude,
      validatedFilesBeforeSubstitution,
      validatedIncludeBeforeSubstitution,
      isDefaultIncludeSpec,
    );
    file.configFileSpecs = specs;

    const literalFiles = new Map<string, string>();
    const beforeRootFiles = this.beforeRootFiles;
    this.beforeRootFiles = undefined;
    const fileNames = this.expandFileNames
      ? this.getFileNamesFromConfigSpecs(
          specs,
          basePathForFileNames,
          options,
          literalFiles,
          beforeRootFiles === undefined ? undefined : beforeRootFiles(options),
        )
      : [];
    const canReportNoInputFiles =
      !(raw instanceof JsonObject) || (!raw.entries.has('files') && !raw.entries.has('references'));
    if (this.expandFileNames && fileNames.length === 0 && canReportNoInputFiles) {
      errors.push(
        createCompilerDiagnostic(
          Diagnostics.No_inputs_were_found_in_config_file_0_Specified_include_paths_were_1_and_exclude_paths_were_2,
          configFileName,
          jsonList(include.items),
          jsonList(exclude.items),
        ),
      );
    }

    const projectReferences: ProjectReference[] = [];
    if (references.items !== undefined) {
      const items = references.items;
      for (let index = 0; index < items.length; index++) {
        const reference = items[index];
        if (!(reference instanceof JsonObject)) continue;
        const path = reference.entries.get('path');
        if (typeof path !== 'string') {
          errors.push(
            diagnosticAtProjectReferenceProperty(
              file.sourceFile,
              index,
              'path',
              Diagnostics.Compiler_option_0_requires_a_value_of_type_1,
              'reference.path',
              'string',
            ),
          );
          continue;
        }
        if (path === '') {
          errors.push(
            diagnosticAtProjectReferenceProperty(
              file.sourceFile,
              index,
              'path',
              Diagnostics.Compiler_option_0_cannot_be_given_an_empty_string,
              'reference.path',
            ),
          );
          continue;
        }
        if (isNetworkPathValue(path, basePathForFileNames)) {
          errors.push(
            diagnosticAtProjectReferenceProperty(
              file.sourceFile,
              index,
              'path',
              Diagnostics.Network_path_0_is_not_supported,
              path,
            ),
          );
          continue;
        }
        const circular = reference.entries.get('circular');
        if (circular !== undefined && typeof circular !== 'boolean')
          errors.push(
            diagnosticAtProjectReferenceProperty(
              file.sourceFile,
              index,
              'circular',
              Diagnostics.Compiler_option_0_requires_a_value_of_type_1,
              'reference.circular',
              'boolean',
            ),
          );
        projectReferences.push(
          new ProjectReference(getNormalizedAbsolutePath(path, basePathForFileNames), path, circular === true),
        );
      }
    }

    return new ParsedCommandLine(
      options,
      parsed.typeAcquisition,
      fileNames,
      projectReferences,
      file,
      errors,
      basePathForFileNames,
      cs,
      literalFiles.size,
    );
  }

  /** A config file's options with what it extends applied. */
  private parseConfig(
    file: TsConfigSourceFile,
    basePath: string,
    configFileName: string,
    resolutionStack: readonly string[],
    errors: Diagnostic[],
  ): OwnConfig {
    basePath = normalizeSlashes(basePath);
    const resolvedPath = toPath(configFileName, basePath, this.fs.useCaseSensitiveFileNames);
    if (resolutionStack.includes(resolvedPath)) {
      errors.push(createCompilerDiagnostic(Diagnostics.Circularity_detected_while_resolving_configuration_Colon_0));
      return new OwnConfig(null, undefined, undefined, undefined);
    }

    const converter = new ConfigFileConverter(this, file.sourceFile, basePath, configFileName, errors);
    const raw = converter.convertRoot();
    // A compiler option at the root is reported once, unless there's a `compilerOptions` too.
    const rootOption = converter.rootCompilerOptions.length > 0 ? converter.rootCompilerOptions[0] : undefined;
    if (rootOption !== undefined && raw instanceof JsonObject && !raw.entries.has('compilerOptions'))
      errors.push(
        diagnosticAtNode(
          file.sourceFile,
          rootOption,
          Diagnostics.X_0_should_be_set_inside_the_compilerOptions_object_of_the_config_json_file,
          propertyNameText(rootOption) ?? '',
        ),
      );
    const own = new OwnConfig(raw, converter.options, converter.typeAcquisition, converter.extendedConfigPaths);
    const ownOptions = converter.options;
    // `paths` may be inherited, so remember which directory it is relative to.
    if (ownOptions.paths !== undefined) ownOptions.pathsBasePath = basePath;

    const extendedPaths = own.extendedConfigPaths;
    if (extendedPaths === undefined) return own;
    const stack = [...resolutionStack, resolvedPath];
    const result = new ExtendsResult();
    for (const extendedPath of extendedPaths)
      this.applyExtendedConfig(raw, basePath, extendedPath, stack, result, errors);
    if (raw instanceof JsonObject) {
      if (result.include !== undefined) raw.entries.set('include', result.include);
      if (result.exclude !== undefined) raw.entries.set('exclude', result.exclude);
      if (result.files !== undefined) raw.entries.set('files', result.files);
      if (result.compileOnSave && !raw.entries.has('compileOnSave')) raw.entries.set('compileOnSave', true);
    }
    const extendedSourceFiles = new Set(file.extendedSourceFiles);
    for (const name of result.extendedSourceFiles) extendedSourceFiles.add(name);
    file.extendedSourceFiles = [...extendedSourceFiles].sort(compareCodePoints);
    own.options = mergeCompilerOptions(result.options, ownOptions, nullKeysOfCompilerOptions(raw));
    return own;
  }

  private applyExtendedConfig(
    ownRaw: JsonValue,
    basePath: string,
    extendedConfigPath: string,
    stack: readonly string[],
    result: ExtendsResult,
    errors: Diagnostic[],
  ): void {
    const extended = this.getExtendedConfig(extendedConfigPath, stack);
    for (const error of extended.errors) errors.push(error);
    result.extendedSourceFiles.add(extended.file.sourceFile.fileName);
    for (const name of extended.file.extendedSourceFiles) result.extendedSourceFiles.add(name);
    const config = extended.config;
    if (config === undefined || config.options === undefined) return;
    const extendsRaw = config.raw;
    let relativeDifference: string | undefined;
    const ownObject = ownRaw instanceof JsonObject ? ownRaw : undefined;
    for (const key of ['include', 'exclude', 'files']) {
      if (ownObject !== undefined && ownObject.entries.has(key)) continue;
      if (!(extendsRaw instanceof JsonObject)) continue;
      const value = extendsRaw.entries.get(key);
      if (!(value instanceof JsonArray) || value.dropped) continue;
      const items: JsonValue[] = [];
      for (const item of value.items) {
        if (typeof item !== 'string' || startsWithConfigDirTemplate(item) || isRootedDiskPath(item)) {
          items.push(item);
          continue;
        }
        if (relativeDifference === undefined) {
          relativeDifference = convertToRelativePath(
            getDirectoryPath(extendedConfigPath),
            basePath,
            this.fs.useCaseSensitiveFileNames,
          );
        }
        items.push(combinePaths(relativeDifference, item));
      }
      const array = new JsonArray(items);
      if (key === 'include') result.include = array;
      else if (key === 'exclude') result.exclude = array;
      else result.files = array;
    }
    if (extendsRaw instanceof JsonObject) {
      const compileOnSave = extendsRaw.entries.get('compileOnSave');
      if (typeof compileOnSave === 'boolean') result.compileOnSave = compileOnSave;
    }
    mergeCompilerOptions(result.options, config.options, nullKeysOfCompilerOptions(extendsRaw));
  }

  /** A parsed extended config; cached unless it is part of an `extends` cycle. */
  private getExtendedConfig(fileName: string, stack: readonly string[]): ExtendedConfig {
    const path = toPath(fileName, this.currentDirectory, this.fs.useCaseSensitiveFileNames);
    if (stack.includes(path)) return this.parseExtendedConfig(fileName, path, stack);
    let extended = this.extendedConfigs.get(path);
    if (extended === undefined) {
      extended = this.parseExtendedConfig(fileName, path, stack);
      this.extendedConfigs.set(path, extended);
    }
    return extended;
  }

  private parseExtendedConfig(fileName: string, path: string, stack: readonly string[]): ExtendedConfig {
    const text = this.fs.readFile(fileName);
    if (text === undefined) {
      const error = createCompilerDiagnostic(Diagnostics.Cannot_read_file_0, fileName);
      const file = new TsConfigSourceFile(parseConfigText(fileName, path, ''));
      file.sourceFile.diagnostics = [error];
      return new ExtendedConfig(file, undefined, [error]);
    }
    const file = new TsConfigSourceFile(parseConfigText(fileName, path, text));
    if (file.sourceFile.diagnostics.length > 0) return new ExtendedConfig(file, undefined, file.sourceFile.diagnostics);
    const errors: Diagnostic[] = [];
    const config = this.parseConfig(file, getDirectoryPath(fileName), getBaseFileName(fileName), stack, errors);
    return new ExtendedConfig(file, config, errors);
  }

  /** Converts a value of `option`, reporting invalid values at `valueExpression`. */
  convertOption(
    option: OptionDeclaration,
    value: JsonValue,
    basePath: string,
    property: PropertyAssignment | undefined,
    valueExpression: Node | undefined,
    file: SourceFile | undefined,
    errors: Diagnostic[],
  ): JsonValue {
    if (option.isCommandLineOnly === true) {
      errors.push(
        diagnosticAtNode(file, property?.name, Diagnostics.Option_0_can_only_be_specified_on_command_line, option.name),
      );
      return null;
    }
    if (!isOptionValue(option, value)) {
      errors.push(
        diagnosticAtNode(
          file,
          valueExpression,
          Diagnostics.Compiler_option_0_requires_a_value_of_type_1,
          option.name,
          valueTypeName(option),
        ),
      );
      return null;
    }
    const element = option.element;
    if (option.kind === 'list' || (option.kind === 'listOrElement' && value instanceof JsonArray)) {
      return element === undefined
        ? null
        : this.convertListOption(option, element, value, basePath, property, valueExpression, file, errors);
    }
    if (option.kind === 'listOrElement') {
      return element === undefined
        ? null
        : this.convertOption(element, value, basePath, property, valueExpression, file, errors);
    }
    if (option.kind === 'enum') {
      return typeof value === 'string' ? convertEnumOption(option, value, valueExpression, file, errors) : null;
    }
    const validated = validateOptionValue(option, value, valueExpression, file, errors);
    if (validated === null || option.isFilePath !== true || typeof validated !== 'string') return validated;
    if (isNetworkPathValue(validated, basePath)) {
      errors.push(diagnosticAtNode(file, valueExpression, Diagnostics.Network_path_0_is_not_supported, validated));
      return null;
    }
    let path = normalizeSlashes(validated);
    if (!startsWithConfigDirTemplate(path)) path = getNormalizedAbsolutePath(path, basePath);
    return path === '' ? '.' : path;
  }

  private convertListOption(
    option: OptionDeclaration,
    element: OptionDeclaration,
    values: JsonValue,
    basePath: string,
    property: PropertyAssignment | undefined,
    valueExpression: Node | undefined,
    file: SourceFile | undefined,
    errors: Diagnostic[],
  ): JsonValue {
    if (!(values instanceof JsonArray) || values.dropped) return null;
    // Items are matched to elements by index, though `null` items were dropped (as in tsgo).
    const elements = valueExpression instanceof ArrayLiteralExpression ? valueExpression.elements.nodes : undefined;
    const items: JsonValue[] = [];
    for (let i = 0; i < values.items.length; i++) {
      const expression = elements !== undefined && i < elements.length ? elements[i] : undefined;
      const item = this.convertOption(element, values.items[i], basePath, property, expression, file, errors);
      if (option.listPreserveFalsyValues === true || (item !== null && item !== false && item !== '')) items.push(item);
    }
    return new JsonArray(items);
  }

  /** Resolves `extends`: a path, a package, or an array of those. */
  getExtendsConfigPaths(
    value: JsonValue,
    basePath: string,
    configFileName: string,
    property: PropertyAssignment,
    valueExpression: Node,
    file: SourceFile,
    errors: Diagnostic[],
  ): string[] {
    const paths: string[] = [];
    const newBase =
      configFileName !== '' ? getDirectoryPath(getNormalizedAbsolutePath(configFileName, basePath)) : basePath;
    if (typeof value === 'string') {
      const path = this.getExtendsConfigPath(value, newBase, valueExpression, file, errors);
      if (path !== '') paths.push(path);
      return paths;
    }
    if (value instanceof JsonArray) {
      const elements = valueExpression instanceof ArrayLiteralExpression ? valueExpression.elements.nodes : undefined;
      for (let i = 0; i < value.items.length; i++) {
        const item = value.items[i];
        const expression = elements !== undefined && i < elements.length ? elements[i] : undefined;
        if (typeof item === 'string') {
          const path = this.getExtendsConfigPath(item, newBase, expression, file, errors);
          if (path !== '') paths.push(path);
        } else if (extendsDeclaration.element !== undefined) {
          // tsgo checks the whole array against the element type here.
          this.convertOption(extendsDeclaration.element, value, basePath, property, expression, file, errors);
        }
      }
      return paths;
    }
    this.convertOption(extendsDeclaration, value, basePath, property, valueExpression, file, errors);
    return paths;
  }

  private getExtendsConfigPath(
    extendedConfig: string,
    basePath: string,
    valueExpression: Node | undefined,
    file: SourceFile,
    errors: Diagnostic[],
  ): string {
    extendedConfig = normalizeSlashes(extendedConfig);
    if (isNetworkPathValue(extendedConfig, basePath)) {
      errors.push(diagnosticAtNode(file, valueExpression, Diagnostics.Network_path_0_is_not_supported, extendedConfig));
      return '';
    }
    if (isRootedDiskPath(extendedConfig) || extendedConfig.startsWith('./') || extendedConfig.startsWith('../')) {
      let path = getNormalizedAbsolutePath(extendedConfig, basePath);
      if (!this.fs.fileExists(path) && !path.endsWith('.json')) {
        path += '.json';
        if (!this.fs.fileExists(path)) {
          errors.push(diagnosticAtNode(file, valueExpression, Diagnostics.File_0_not_found, extendedConfig));
          return '';
        }
      }
      return path;
    }
    const resolved = resolveConfig(extendedConfig, combinePaths(basePath, 'tsconfig.json'), this.resolutionHost);
    if (resolved.resolvedFileName !== '') return resolved.resolvedFileName;
    errors.push(
      extendedConfig === ''
        ? diagnosticAtNode(
            file,
            valueExpression,
            Diagnostics.Compiler_option_0_cannot_be_given_an_empty_string,
            'extends',
          )
        : diagnosticAtNode(file, valueExpression, Diagnostics.File_0_not_found, extendedConfig),
    );
    return '';
  }

  /** Root files: `files` as given, then `include` matches not excluded, then JSON files matched explicitly. */
  private getFileNamesFromConfigSpecs(
    specs: ConfigFileSpecs,
    basePath: string,
    options: CompilerOptions,
    literalFiles: Map<string, string>,
    onRootFile?: (fileName: string) => void,
  ): string[] {
    basePath = normalizePath(basePath);
    const cs = this.fs.useCaseSensitiveFileNames;
    const wildcardFiles = new Map<string, string>();
    const wildcardJsonFiles = new Map<string, string>();
    const supportedExtensions = getSupportedExtensions(options);
    const extensionsWithJson = getSupportedExtensionsWithJsonIfResolveJsonModule(options);
    // Literal files are keyed by path, so `a.ts` and `./a.ts` are one file, also when `include` matches it.
    for (const fileName of specs.validatedFilesSpec) {
      const file = getNormalizedAbsolutePath(fileName, basePath);
      literalFiles.set(getCanonicalFileName(file, cs), file);
    }
    if (onRootFile !== undefined) for (const fileName of literalFiles.values()) onRootFile(fileName);

    const includes = specs.validatedIncludeSpecs;
    if (includes.length > 0) {
      // Matches go to `onRootFile` a directory at a time, without the literal files, which it has, and those that a
      // file of the same name with a higher priority extension leaves out below.
      let directory = '';
      let pending: string[] = [];
      const flush = (): void => {
        if (onRootFile === undefined || pending.length === 0) return;
        const siblings = new Map<string, string>();
        for (const file of pending) siblings.set(getCanonicalFileName(file, cs), file);
        for (const file of pending) {
          if (literalFiles.has(getCanonicalFileName(file, cs))) continue;
          if (!hasFileWithHigherPriorityExtension(file, supportedExtensions, literalFiles, siblings, cs))
            onRootFile(file);
        }
        pending = [];
      };
      const onMatch =
        onRootFile === undefined
          ? undefined
          : (file: string): void => {
              const fileDirectory = getDirectoryPath(file);
              if (fileDirectory !== directory) {
                flush();
                directory = fileDirectory;
              }
              pending.push(file);
            };
      const matched = readDirectory(
        this.fs,
        basePath,
        basePath,
        flattenExtensions(extensionsWithJson),
        specs.validatedExcludeSpecs,
        includes,
        unlimitedDepth,
        onMatch,
      );
      flush();
      let jsonIncludes: SpecMatcher | undefined;
      for (const file of matched) {
        if (fileExtensionIs(file, '.json')) {
          if (jsonIncludes === undefined) {
            const jsonSpecs: string[] = [];
            for (const include of includes) if (include.endsWith('.json')) jsonSpecs.push(include);
            jsonIncludes = SpecMatcher.create(jsonSpecs, basePath, MatchUsage.Files, cs);
          }
          if (jsonIncludes !== undefined && jsonIncludes.matchIndex(file) !== -1) {
            const key = getCanonicalFileName(file, cs);
            if (!literalFiles.has(key) && !wildcardJsonFiles.has(key)) wildcardJsonFiles.set(key, file);
          }
          continue;
        }
        // Skip outputs of other matched files, like `a.d.ts` next to `a.ts`.
        if (hasFileWithHigherPriorityExtension(file, supportedExtensions, literalFiles, wildcardFiles, cs)) continue;
        removeWildcardFilesWithLowerPriorityExtension(file, wildcardFiles, supportedExtensions, cs);
        const key = getCanonicalFileName(file, cs);
        if (!literalFiles.has(key) && !wildcardFiles.has(key)) wildcardFiles.set(key, file);
      }
    }
    const files: string[] = [];
    for (const file of literalFiles.values()) files.push(file);
    for (const file of wildcardFiles.values()) files.push(file);
    for (const file of wildcardJsonFiles.values()) files.push(file);
    return files;
  }
}

function parseConfigText(fileName: string, path: string, text: string): SourceFile {
  return parseSourceFile(
    fileName,
    text,
    new ParseOptions(path, ScriptKind.JSON, new ExternalModuleIndicatorOptions(false, false)),
  );
}

function isOptionValue(option: OptionDeclaration, value: JsonValue): boolean {
  if (value === null) return option !== extendsDeclaration;
  switch (option.kind) {
    case 'list':
      return value instanceof JsonArray;
    case 'listOrElement':
      return value instanceof JsonArray || (option.element !== undefined && isOptionValue(option.element, value));
    case 'string':
    case 'enum':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'object':
      return value instanceof JsonObject;
  }
  return false;
}

function validateOptionValue(
  option: OptionDeclaration,
  value: JsonValue,
  valueExpression: Node | undefined,
  file: SourceFile | undefined,
  errors: Diagnostic[],
): JsonValue {
  if (value === null || typeof value !== 'string') return value;
  if (option.extraValidation === 'spec') {
    const message = specToDiagnostic(value, false);
    if (message !== undefined) {
      errors.push(diagnosticAtNode(file, valueExpression, message, value));
      return null;
    }
  } else if (option.extraValidation === 'locale' && !isValidLocale(value)) {
    errors.push(
      diagnosticAtNode(
        file,
        valueExpression,
        Diagnostics.Locale_must_be_an_IETF_BCP_47_language_tag_Examples_Colon_0_1,
        'en',
        'ja-jp',
      ),
    );
    return null;
  }
  return value;
}

function convertEnumOption(
  option: OptionDeclaration,
  value: string,
  valueExpression: Node | undefined,
  file: SourceFile | undefined,
  errors: Diagnostic[],
): JsonValue {
  if (value === '') return null;
  const enumValue = option.values?.get(value.toLowerCase());
  if (enumValue !== undefined) return validateOptionValue(option, enumValue, valueExpression, file, errors);
  errors.push(
    diagnosticAtNode(
      file,
      valueExpression,
      Diagnostics.Argument_for_0_option_must_be_Colon_1,
      '--' + option.name,
      enumNamesList(option),
    ),
  );
  return null;
}

/** `path` relative to `currentDirectory` if absolute. */
function convertToRelativePath(path: string, currentDirectory: string, useCaseSensitiveFileNames: boolean): string {
  if (!isRootedDiskPath(path)) return path;
  return getPathFromPathComponents(
    getPathComponentsRelativeTo(currentDirectory, path, useCaseSensitiveFileNames, currentDirectory),
  );
}
