/**
 * Option and syntax queries of program construction: libraries, module formats and resolution modes.
 */
import {
  ExportDeclaration,
  ExternalModuleIndicatorOptions,
  Identifier,
  ImportAttribute,
  ImportAttributes,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportTypeNode,
  JSDocImportTag,
  LiteralTypeNode,
  NoSubstitutionTemplateLiteral,
  ParenthesizedExpression,
  ScriptKind,
  StringLiteral,
  type Node,
  type SourceFile,
} from './ast.js';
import { isImportCall, isRequireCall } from './ast-utilities.js';
import { libMap } from './option-declarations.js';
import {
  getEmitModuleDetectionKind,
  getEmitModuleKind,
  getEmitScriptTarget,
  getModuleResolutionKind,
  getResolvePackageJsonExports,
  getResolvePackageJsonImports,
  JsxEmit,
  ModuleDetectionKind,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  type CompilerOptions,
} from './options.js';
import { fileExtensionIsOneOf, isDeclarationFileName, toFileNameLowerCase } from './path.js';
import { SyntaxKind } from './syntax-kind.js';

// ---- Libraries

/** `--lib` names in declaration order. */
export const libNames: readonly string[] = [...libMap.keys()];

const libFileNames = new Set<string>();
for (const value of libMap.values()) if (typeof value === 'string') libFileNames.add(value);

/** The bundled file of a `lib` name or file name, or `''`. */
export function getLibFileName(name: string): string {
  const lower = toFileNameLowerCase(name);
  if (libFileNames.has(lower)) return lower;
  const fileName = libMap.get(lower);
  return typeof fileName === 'string' ? fileName : '';
}

/** The library included by default for the target. */
export function getDefaultLibFileName(options: CompilerOptions): string {
  switch (getEmitScriptTarget(options)) {
    case ScriptTarget.ESNext:
      return 'lib.esnext.full.d.ts';
    case ScriptTarget.ES2026:
      return 'lib.es2026.full.d.ts';
    case ScriptTarget.ES2025:
      return 'lib.es2025.full.d.ts';
    case ScriptTarget.ES2024:
      return 'lib.es2024.full.d.ts';
    case ScriptTarget.ES2023:
      return 'lib.es2023.full.d.ts';
    case ScriptTarget.ES2022:
      return 'lib.es2022.full.d.ts';
    case ScriptTarget.ES2021:
      return 'lib.es2021.full.d.ts';
    case ScriptTarget.ES2020:
      return 'lib.es2020.full.d.ts';
    case ScriptTarget.ES2019:
      return 'lib.es2019.full.d.ts';
    case ScriptTarget.ES2018:
      return 'lib.es2018.full.d.ts';
    case ScriptTarget.ES2017:
      return 'lib.es2017.full.d.ts';
    case ScriptTarget.ES2016:
      return 'lib.es2016.full.d.ts';
    case ScriptTarget.ES2015:
      // Not `lib.es2015.full.d.ts`, which would be a breaking change.
      return 'lib.es6.d.ts';
    default:
      return 'lib.d.ts';
  }
}

// ---- Enum names, as tsgo prints them

export function scriptTargetName(target: ScriptTarget): string {
  switch (target) {
    case ScriptTarget.ES5:
      return 'ES5';
    case ScriptTarget.ES2015:
      return 'ES2015';
    case ScriptTarget.ES2016:
      return 'ES2016';
    case ScriptTarget.ES2017:
      return 'ES2017';
    case ScriptTarget.ES2018:
      return 'ES2018';
    case ScriptTarget.ES2019:
      return 'ES2019';
    case ScriptTarget.ES2020:
      return 'ES2020';
    case ScriptTarget.ES2021:
      return 'ES2021';
    case ScriptTarget.ES2022:
      return 'ES2022';
    case ScriptTarget.ES2023:
      return 'ES2023';
    case ScriptTarget.ES2024:
      return 'ES2024';
    case ScriptTarget.ES2025:
      return 'ES2025';
    case ScriptTarget.ES2026:
      return 'ES2026';
    case ScriptTarget.ESNext:
      return 'ESNext';
    case ScriptTarget.JSON:
      return 'JSON';
  }
  return '';
}

export function moduleKindName(kind: ModuleKind): string {
  switch (kind) {
    case ModuleKind.None:
      return 'None';
    case ModuleKind.CommonJS:
      return 'CommonJS';
    case ModuleKind.AMD:
      return 'AMD';
    case ModuleKind.UMD:
      return 'UMD';
    case ModuleKind.System:
      return 'System';
    case ModuleKind.ES2015:
      return 'ES2015';
    case ModuleKind.ES2020:
      return 'ES2020';
    case ModuleKind.ES2022:
      return 'ES2022';
    case ModuleKind.ESNext:
      return 'ESNext';
    case ModuleKind.Node16:
      return 'Node16';
    case ModuleKind.Node18:
      return 'Node18';
    case ModuleKind.Node20:
      return 'Node20';
    case ModuleKind.NodeNext:
      return 'NodeNext';
    case ModuleKind.Preserve:
      return 'Preserve';
  }
  return '';
}

export function jsxEmitName(jsx: JsxEmit): string {
  switch (jsx) {
    case JsxEmit.Preserve:
      return 'preserve';
    case JsxEmit.ReactNative:
      return 'react-native';
    case JsxEmit.React:
      return 'react';
    case JsxEmit.ReactJSX:
      return 'react-jsx';
    case JsxEmit.ReactJSXDev:
      return 'react-jsxdev';
  }
  return '';
}

// ---- Module formats

/** What a file's nearest `package.json` says about its module format. */
export class SourceFileMetadata {
  constructor(
    /** `type` of the nearest `package.json`, where it applies; `''` otherwise. */
    readonly packageJsonType: string,
    /** Directory of the nearest `package.json`, or `''`. */
    readonly packageJsonDirectory: string,
    /** `ESNext`, `CommonJS` or `None` (formats other than JavaScript and TypeScript). */
    readonly impliedNodeFormat: ModuleKind,
  ) {}
}

export const libFileMetadata = new SourceFileMetadata('', '', ModuleKind.CommonJS);

export function getImpliedNodeFormatForFile(path: string, packageJsonType: string): ModuleKind {
  if (fileExtensionIsOneOf(path, ['.d.mts', '.mts', '.mjs'])) return ModuleKind.ESNext;
  if (fileExtensionIsOneOf(path, ['.d.cts', '.cts', '.cjs'])) return ModuleKind.CommonJS;
  if (fileExtensionIsOneOf(path, ['.d.ts', '.ts', '.tsx', '.js', '.jsx'])) {
    return packageJsonType === 'module' ? ModuleKind.ESNext : ModuleKind.CommonJS;
  }
  return ModuleKind.None;
}

/** The format a file is emitted in when it differs from `module`, else `None`. */
export function getImpliedNodeFormatForEmit(
  fileName: string,
  emitModuleKind: ModuleKind,
  metadata: SourceFileMetadata,
): ModuleKind {
  if (ModuleKind.Node16 <= emitModuleKind && emitModuleKind <= ModuleKind.NodeNext) return metadata.impliedNodeFormat;
  if (
    metadata.impliedNodeFormat === ModuleKind.CommonJS &&
    (metadata.packageJsonType === 'commonjs' || fileExtensionIsOneOf(fileName, ['.cjs', '.cts']))
  ) {
    return ModuleKind.CommonJS;
  }
  if (
    metadata.impliedNodeFormat === ModuleKind.ESNext &&
    (metadata.packageJsonType === 'module' || fileExtensionIsOneOf(fileName, ['.mjs', '.mts']))
  ) {
    return ModuleKind.ESNext;
  }
  return ModuleKind.None;
}

export function getEmitModuleFormatOfFile(
  fileName: string,
  options: CompilerOptions,
  metadata: SourceFileMetadata,
): ModuleKind {
  const result = getImpliedNodeFormatForEmit(fileName, getEmitModuleKind(options), metadata);
  return result !== ModuleKind.None ? result : getEmitModuleKind(options);
}

/** What makes a file a module, besides imports and exports. */
export function getExternalModuleIndicatorOptions(
  fileName: string,
  options: CompilerOptions,
  metadata: SourceFileMetadata,
): ExternalModuleIndicatorOptions {
  if (isDeclarationFileName(fileName)) return new ExternalModuleIndicatorOptions(false, false);
  switch (getEmitModuleDetectionKind(options)) {
    case ModuleDetectionKind.Force:
      return new ExternalModuleIndicatorOptions(false, true);
    case ModuleDetectionKind.Auto: {
      const jsx = options.jsx === JsxEmit.ReactJSX || options.jsx === JsxEmit.ReactJSXDev;
      const forced =
        getImpliedNodeFormatForEmit(fileName, getEmitModuleKind(options), metadata) === ModuleKind.ESNext ||
        fileExtensionIsOneOf(fileName, ['.cjs', '.cts', '.mjs', '.mts']);
      return new ExternalModuleIndicatorOptions(jsx, forced);
    }
    default:
      return new ExternalModuleIndicatorOptions(false, false);
  }
}

export function isExternalModule(file: SourceFile): boolean {
  return file.externalModuleIndicator !== undefined;
}

export function isExternalOrCommonJSModule(file: SourceFile): boolean {
  return file.externalModuleIndicator !== undefined || file.commonJSModuleIndicator !== undefined;
}

export function isSourceFileJS(file: SourceFile): boolean {
  return file.scriptKind === ScriptKind.JS || file.scriptKind === ScriptKind.JSX;
}

export function isCheckJsEnabledForFile(file: SourceFile, options: CompilerOptions): boolean {
  if (file.checkJsDirective !== undefined) return file.checkJsDirective.enabled;
  return options.checkJs === true;
}

// ---- JSX runtime

function pragmaArgument(file: SourceFile, name: string, argument: string): string | undefined {
  let result: string | undefined;
  // The last pragma wins.
  for (const pragma of file.pragmas) {
    if (pragma.name === name) result = pragma.args.get(argument)?.value ?? '';
  }
  return result;
}

/** The package providing the JSX runtime, or `''` when JSX compiles to factory calls. */
export function getJSXImplicitImportBase(options: CompilerOptions, file: SourceFile): string {
  const importSource = pragmaArgument(file, 'jsximportsource', 'factory');
  const runtime = pragmaArgument(file, 'jsxruntime', 'factory');
  if (runtime === 'classic') return '';
  if (
    options.jsx === JsxEmit.ReactJSX ||
    options.jsx === JsxEmit.ReactJSXDev ||
    options.jsxImportSource !== undefined ||
    importSource !== undefined ||
    runtime === 'automatic'
  ) {
    if (importSource !== undefined && importSource !== '') return importSource;
    return options.jsxImportSource ?? 'react';
  }
  return '';
}

export function getJSXRuntimeImport(base: string, options: CompilerOptions): string {
  if (base === '') return '';
  return base + '/' + (options.jsx === JsxEmit.ReactJSXDev ? 'jsx-dev-runtime' : 'jsx-runtime');
}

// ---- Resolution modes

function isStringLiteralLike(node: Node | undefined): boolean {
  return node instanceof StringLiteral || node instanceof NoSubstitutionTemplateLiteral;
}

function literalText(node: Node): string {
  if (node instanceof StringLiteral) return node.text;
  if (node instanceof NoSubstitutionTemplateLiteral) return node.text;
  return '';
}

/** The `resolution-mode` of `import type` attributes, or `None`. */
export function getResolutionModeOverride(attributes: ImportAttributes | undefined): ModuleKind {
  const attribute = resolutionModeAttribute(attributes);
  if (attribute === undefined || !isStringLiteralLike(attribute.value)) return ModuleKind.None;
  const text = literalText(attribute.value);
  if (text === 'import') return ModuleKind.ESNext;
  if (text === 'require') return ModuleKind.CommonJS;
  return ModuleKind.None;
}

/** The `resolution-mode` attribute among import attributes, as tsgo's `GetResolutionModeOverride` finds it. */
export function resolutionModeAttribute(attributes: ImportAttributes | undefined): ImportAttribute | undefined {
  if (attributes === undefined) return undefined;
  for (const attribute of attributes.attributes.nodes) {
    if (!(attribute instanceof ImportAttribute)) continue;
    const name = attribute.name;
    if (name === undefined) continue;
    const text = name instanceof Identifier ? name.text : literalText(name);
    if (text === 'resolution-mode') return attribute;
  }
  return undefined;
}

/** The attributes of an import or export declaration or a JSDoc `@import`, if any. */
function importOrExportAttributes(node: Node | undefined): ImportAttributes | undefined {
  if (node instanceof ImportDeclaration) return node.attributes;
  if (node instanceof ExportDeclaration) return node.attributes;
  if (node instanceof JSDocImportTag) return node.attributes;
  return undefined;
}

function isClauseTypeOnly(clause: ImportClause | undefined): boolean {
  return clause !== undefined && clause.phaseModifier === SyntaxKind.TypeKeyword;
}

function isExclusivelyTypeOnlyImportOrExport(node: Node): boolean {
  if (node instanceof ExportDeclaration) return node.isTypeOnly;
  if (node instanceof ImportDeclaration) return isClauseTypeOnly(node.importClause);
  if (node instanceof JSDocImportTag) return isClauseTypeOnly(node.importClause);
  return false;
}

/** Whether `import` syntax decides how a specifier resolves: Node16-style resolution or `exports`/`imports`. */
export function importSyntaxAffectsModuleResolution(options: CompilerOptions): boolean {
  const kind = getModuleResolutionKind(options);
  return (
    (ModuleResolutionKind.Node16 <= kind && kind <= ModuleResolutionKind.NodeNext) ||
    getResolvePackageJsonExports(options) ||
    getResolvePackageJsonImports(options)
  );
}

/** The mode a module specifier resolves in: from attributes, the import syntax, or the file's format. */
export function getModeForUsageLocation(
  fileName: string,
  metadata: SourceFileMetadata,
  usage: Node,
  options: CompilerOptions,
): ModuleKind {
  const parent = usage.parent;
  const attributes = importOrExportAttributes(parent);
  if (attributes !== undefined && parent !== undefined && isExclusivelyTypeOnlyImportOrExport(parent)) {
    const override = getResolutionModeOverride(attributes);
    if (override !== ModuleKind.None) return override;
  }
  if (parent instanceof LiteralTypeNode && parent.parent instanceof ImportTypeNode) {
    const override = getResolutionModeOverride(parent.parent.attributes);
    if (override !== ModuleKind.None) return override;
  }
  if (importSyntaxAffectsModuleResolution(options))
    return getEmitSyntaxForUsageLocation(fileName, metadata, usage, options);
  return ModuleKind.None;
}

function walkUpParenthesizedExpressions(node: Node | undefined): Node | undefined {
  while (node instanceof ParenthesizedExpression) node = node.parent;
  return node;
}

export function getEmitSyntaxForUsageLocation(
  fileName: string,
  metadata: SourceFileMetadata,
  usage: Node,
  options: CompilerOptions,
): ModuleKind {
  const parent = usage.parent;
  if (parent === undefined) return ModuleKind.None;
  if (
    isRequireCall(parent, false) ||
    (parent.kind === SyntaxKind.ExternalModuleReference && parent.parent instanceof ImportEqualsDeclaration)
  ) {
    return ModuleKind.CommonJS;
  }
  const fileEmitMode = getEmitModuleFormatOfFile(fileName, options, metadata);
  const call = walkUpParenthesizedExpressions(parent);
  if (call !== undefined && isImportCall(call)) {
    return shouldTransformImportCall(options, fileEmitMode) ? ModuleKind.CommonJS : ModuleKind.ESNext;
  }
  if (fileEmitMode === ModuleKind.CommonJS) return ModuleKind.CommonJS;
  if (
    (ModuleKind.ES2015 <= fileEmitMode && fileEmitMode <= ModuleKind.ESNext) ||
    fileEmitMode === ModuleKind.Preserve
  ) {
    return ModuleKind.ESNext;
  }
  return ModuleKind.None;
}

function shouldTransformImportCall(options: CompilerOptions, impliedNodeFormatForEmit: ModuleKind): boolean {
  const moduleKind = getEmitModuleKind(options);
  if ((ModuleKind.Node16 <= moduleKind && moduleKind <= ModuleKind.NodeNext) || moduleKind === ModuleKind.Preserve) {
    return false;
  }
  return impliedNodeFormatForEmit < ModuleKind.ES2015;
}

export function getDefaultResolutionModeForFile(
  fileName: string,
  metadata: SourceFileMetadata,
  options: CompilerOptions,
): ModuleKind {
  return importSyntaxAffectsModuleResolution(options)
    ? getImpliedNodeFormatForEmit(fileName, getEmitModuleKind(options), metadata)
    : ModuleKind.None;
}
