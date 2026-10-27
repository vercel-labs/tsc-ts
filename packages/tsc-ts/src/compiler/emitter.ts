// Emits JavaScript and declarations for source files: runs the transforms, prints, and writes
// the output, source map and `//# sourceMappingURL` comment.
import { ScriptKind, type SourceFile } from './ast.js';
import { compareDiagnostics, equalDiagnostics, type Diagnostic } from './diagnostics.js';
import { type CompilerOptions, JsxEmit, NewLineKind, getEmitScriptTarget, getIsolatedModules } from './options.js';
import { LanguageVariant } from './types.js';
import { type OutputPathsHost, getOutputPathsFor } from './output-paths.js';
import {
  combinePaths,
  fileExtensionIs,
  getBaseFileName,
  getDirectoryPath,
  getRootLength,
  normalizePath,
  normalizeSlashes,
  ensureTrailingDirectorySeparator,
  containsPath,
  getNormalizedAbsolutePath,
} from './path.js';
import { EmitContext } from './printer/emit-context.js';
import { Printer, PrinterOptions } from './printer/printer.js';
import { TextWriter } from './printer/text-writer.js';
import { SourceMapGenerator, getRelativePathToDirectoryOrUrl } from './sourcemap.js';
import { DeclarationEmitResolver } from './transformers/declarations-resolver.js';
import { DeclarationTransformer } from './transformers/declarations.js';
import type { EmitResolver } from './transformers/emit-resolver.js';
import { ImportElision } from './transformers/import-elision.js';
import { type ModuleFormatHost, UseStrictTransformer, createModuleTransformer } from './transformers/module.js';
import type { Transformer } from './transformers/transformer.js';
import { TypeEraser } from './transformers/type-eraser.js';
import { TypeScriptFacts } from './transformers/subtree-facts.js';
import { RuntimeSyntax } from './transformers/runtime-syntax.js';
import { ConstEnumInliner } from './transformers/const-enum-inliner.js';
import { addDownlevelTransformers } from './transformers/downlevel.js';
import { JsxTransformer } from './transformers/jsx.js';
import { SyntaxFacts } from './transformers/syntax-facts.js';
import { LegacyDecorators } from './transformers/legacy-decorators.js';
import { DecoratorMetadata } from './transformers/decorator-metadata.js';

/** The program as emit sees it. */
export abstract class EmitHost implements OutputPathsHost {
  readonly options: CompilerOptions;
  readonly currentDirectory: string;
  readonly useCaseSensitiveFileNames: boolean;
  private readonly commonSourceDirectoryPath: string;
  readonly resolver: EmitResolver;
  readonly formats: ModuleFormatHost;

  constructor(
    options: CompilerOptions,
    resolver: EmitResolver,
    formats: ModuleFormatHost,
    commonSourceDirectory: string,
    currentDirectory: string,
    useCaseSensitiveFileNames: boolean,
  ) {
    this.options = options;
    this.resolver = resolver;
    this.formats = formats;
    this.currentDirectory = currentDirectory;
    this.useCaseSensitiveFileNames = useCaseSensitiveFileNames;
    this.commonSourceDirectoryPath = commonSourceDirectory;
  }

  /** With a trailing `/`. */
  commonSourceDirectory(): string {
    return this.commonSourceDirectoryPath;
  }

  /**
   * Writes an output file; returns an error message, or `''`. `declarationDiagnostics` are the
   * declaration emit errors of a declaration file written by a forced declaration emit.
   * Returning `skippedWrite` leaves a file unwritten without an error.
   */
  abstract writeFile(fileName: string, text: string, declarationDiagnostics?: readonly Diagnostic[]): string;

  /** Whether writing a file is blocked, as when it would overwrite an input; false by default. */
  isEmitBlocked(_fileName: string): boolean {
    return false;
  }

  /**
   * Whether the program found `file` through a module or type reference resolved in `node_modules`
   * (`Program.isSourceFileFromExternalLibrary`); such files are not emitted. False by default.
   */
  isSourceFileFromExternalLibrary(_file: SourceFile): boolean {
    return false;
  }
}

/** What `EmitHost.writeFile` returns for a file it chose not to write. */
export const skippedWrite = '\u0000';

export class EmitResult {
  readonly emittedFiles: string[];
  readonly errors: string[];
  /** Files not emitted because they use syntax emit doesn't support yet, with the reason. */
  readonly unsupported: string[];
  /** Declaration emit errors; a file with any gets no declaration file. */
  readonly diagnostics: Diagnostic[];
  /**
   * For each declaration file a checker thread wrote for an incremental program, its name, its signature
   * and the signature compared for composite projects (`DeclarationSignatureWriter`).
   */
  readonly declarationSignatures: string[];
  /**
   * Under `noEmitOnError`, the outputs a checker thread emitted without writing them, as file name and
   * text alternately: the main thread writes them once it knows there are no errors (`writeHeldOutputs`).
   */
  readonly heldOutputs: string[];
  emitSkipped: boolean;
  /**
   * Whether the declaration transform ran, so that `diagnostics` holds the declaration diagnostics of
   * the files emitted (only declaration emit reports diagnostics).
   */
  declarationTransformed: boolean;

  constructor() {
    this.emittedFiles = [];
    this.errors = [];
    this.unsupported = [];
    this.diagnostics = [];
    this.declarationSignatures = [];
    this.heldOutputs = [];
    this.emitSkipped = false;
    this.declarationTransformed = false;
  }
}

export function sourceFileMayBeEmitted(file: SourceFile, options: CompilerOptions): boolean {
  if (file.isDeclarationFile) return false;
  if (file.scriptKind === ScriptKind.JSON) return options.outDir !== undefined && options.outDir !== '';
  return true;
}

/** Which outputs to emit. */
export const enum EmitOnly {
  All,
  Js,
  Dts,
  /**
   * The declaration file alone, even without `declaration` and despite errors, for the shape
   * signature of incremental builds; it is written with its errors and without a map.
   */
  ForcedDts,
}

export function emitFiles(host: EmitHost, files: readonly SourceFile[], emitOnly: EmitOnly = EmitOnly.All): EmitResult {
  const result = new EmitResult();
  const options = host.options;
  const forced = emitOnly === EmitOnly.ForcedDts;
  if (options.noEmit === true && !forced) {
    result.emitSkipped = true;
    return result;
  }
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!sourceFileMayBeEmitted(file, options) || host.isSourceFileFromExternalLibrary(file)) continue;
    const paths = getOutputPathsFor(file.fileName, file.scriptKind === ScriptKind.JSON, options, host, forced);
    // As in tsgo, a file's JavaScript and declarations share one emit context: emit flags that JavaScript
    // transforms set on the file's own nodes, such as a decorated parameter's name, also apply to its declarations.
    const context = new EmitContext();
    if (paths.jsFilePath !== '' && (emitOnly === EmitOnly.All || emitOnly === EmitOnly.Js)) {
      if (host.isEmitBlocked(paths.jsFilePath)) result.emitSkipped = true;
      else emitJSFile(host, context, file, paths.jsFilePath, paths.sourceMapFilePath, result);
    }
    if (paths.declarationFilePath !== '' && emitOnly !== EmitOnly.Js) {
      if (!forced && host.isEmitBlocked(paths.declarationFilePath)) result.emitSkipped = true;
      else
        emitDeclarationFile(host, context, file, paths.declarationFilePath, paths.declarationMapPath, result, forced);
    }
  }
  return result;
}

/** Emits a declaration file; the host's resolver must be a `DeclarationEmitResolver`. */
function emitDeclarationFile(
  host: EmitHost,
  context: EmitContext,
  file: SourceFile,
  declarationFilePath: string,
  declarationMapPath: string,
  result: EmitResult,
  forced: boolean,
): boolean {
  const resolver = host.resolver;
  if (!(resolver instanceof DeclarationEmitResolver)) {
    result.errors.push(file.fileName + ': declaration emit needs a declaration resolver');
    return false;
  }
  const options = host.options;
  const transformer = new DeclarationTransformer(context, host, options, resolver, declarationFilePath);
  const transformed = transformer.transformSourceFile(file);
  result.declarationTransformed = true;
  const diagnostics = transformer.diagnostics;
  for (let i = 0; i < diagnostics.length; i++) result.diagnostics.push(diagnostics[i]);
  if (diagnostics.length > 0 && !forced) {
    result.emitSkipped = true;
    return false;
  }
  const printerOptions = new PrinterOptions();
  printerOptions.removeComments = options.removeComments === true;
  printerOptions.newLine = options.newLine === NewLineKind.CRLF ? '\r\n' : '\n';
  printerOptions.noEmitHelpers = true;
  printerOptions.target = getEmitScriptTarget(options);
  const declarationMap = options.declarationMap === true && !forced;
  printerOptions.sourceMap = declarationMap;
  printerOptions.onlyPrintJSDocStyle = true;
  printerOptions.omitBraceSourceMapPositions = true;
  const printer = new Printer(printerOptions, context);
  const emitSourceMaps = declarationMap && !fileExtensionIs(file.fileName, '.json');
  return printSourceFile(
    host,
    declarationFilePath,
    forced ? '' : declarationMapPath,
    transformed,
    printer,
    emitSourceMaps,
    false,
    result,
    emitterDiagnostics(diagnostics),
  );
}

/**
 * Declaration diagnostics as tsgo's emitter collects them: sorted, without repeats of an equal
 * diagnostic. They are part of the file's signature in build info.
 */
function emitterDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  if (diagnostics.length < 2) return diagnostics;
  const sorted = diagnostics.toSorted(compareDiagnostics);
  const result: Diagnostic[] = [];
  for (const diagnostic of sorted) {
    // Equal diagnostics compare as 0, so a repeat is among the last ones kept that compare as 0.
    let repeated = false;
    for (let i = result.length - 1; i >= 0 && compareDiagnostics(result[i], diagnostic) === 0; i--) {
      if (equalDiagnostics(result[i], diagnostic)) {
        repeated = true;
        break;
      }
    }
    if (!repeated) result.push(diagnostic);
  }
  return result;
}

function getScriptTransformers(host: EmitHost, context: EmitContext, file: SourceFile): Transformer[] {
  const options = host.options;
  const facts = new TypeScriptFacts();
  const syntax = new SyntaxFacts();
  const transformers: Transformer[] = [];
  if (options.emitDecoratorMetadata === true)
    transformers.push(new DecoratorMetadata(context, options, host.resolver, syntax));
  transformers.push(new TypeEraser(context, options, facts));
  if (options.verbatimModuleSyntax !== true && !file.isJS())
    transformers.push(new ImportElision(context, options, host.resolver));
  transformers.push(new RuntimeSyntax(context, options, facts, host.resolver));
  if (options.experimentalDecorators === true)
    transformers.push(new LegacyDecorators(context, options, host.resolver, syntax));
  if (isJsxTransformEnabled(options) && file.languageVariant === LanguageVariant.JSX)
    transformers.push(new JsxTransformer(context, options, syntax, host.resolver));
  addDownlevelTransformers(transformers, context, options, syntax, host.resolver);
  transformers.push(new UseStrictTransformer(context, options, host.formats));
  transformers.push(createModuleTransformer(context, options, host.resolver, host.formats));
  if (!getIsolatedModules(options)) transformers.push(new ConstEnumInliner(context, options, host.resolver));
  return transformers;
}

function isJsxTransformEnabled(options: CompilerOptions): boolean {
  const jsx = options.jsx;
  return jsx === JsxEmit.React || jsx === JsxEmit.ReactJSX || jsx === JsxEmit.ReactJSXDev;
}

function emitJSFile(
  host: EmitHost,
  context: EmitContext,
  file: SourceFile,
  jsFilePath: string,
  sourceMapFilePath: string,
  result: EmitResult,
): boolean {
  const options = host.options;
  let transformed = file;
  const transformers = getScriptTransformers(host, context, file);
  for (let i = 0; i < transformers.length; i++) {
    const transformer = transformers[i];
    if (transformer.unsupported === '') transformed = transformer.transformSourceFile(transformed);
    if (transformer.unsupported !== '') {
      result.unsupported.push(file.fileName + ': ' + transformer.unsupported);
      return false;
    }
  }
  const printerOptions = new PrinterOptions();
  printerOptions.removeComments = options.removeComments === true;
  printerOptions.newLine = options.newLine === NewLineKind.CRLF ? '\r\n' : '\n';
  printerOptions.noEmitHelpers = options.noEmitHelpers === true;
  printerOptions.sourceMap = options.sourceMap === true;
  printerOptions.inlineSourceMap = options.inlineSourceMap === true;
  printerOptions.inlineSources = options.inlineSources === true;
  // The target option as given, as tsgo's JavaScript printer takes it: without one, the printer's default
  // removes numeric separators, although the transforms target the default target.
  if (options.target !== undefined) printerOptions.target = options.target;
  const printer = new Printer(printerOptions, context);
  const emitSourceMaps =
    (options.sourceMap === true || options.inlineSourceMap === true) && !fileExtensionIs(file.fileName, '.json');
  const inline = options.inlineSourceMap === true;
  return printSourceFile(host, jsFilePath, sourceMapFilePath, transformed, printer, emitSourceMaps, inline, result);
}

function printSourceFile(
  host: EmitHost,
  jsFilePath: string,
  sourceMapFilePath: string,
  file: SourceFile,
  printer: Printer,
  emitSourceMaps: boolean,
  inlineSourceMap: boolean,
  result: EmitResult,
  declarationDiagnostics: readonly Diagnostic[] = [],
): boolean {
  const options = host.options;
  const writer = new TextWriter(printer.options.newLine, 4);
  const generator = emitSourceMaps
    ? new SourceMapGenerator(
        getBaseFileName(normalizeSlashes(jsFilePath)),
        getSourceRoot(options),
        getSourceMapDirectory(host, jsFilePath, file),
        host.useCaseSensitiveFileNames,
        host.currentDirectory,
      )
    : undefined;
  printer.write(file, file, writer, generator);
  if (generator !== undefined) {
    const url = getSourceMappingURL(host, generator, jsFilePath, sourceMapFilePath, file, inlineSourceMap);
    if (url !== '') {
      if (!writer.isAtStartOfLine()) writer.rawWrite(options.newLine === NewLineKind.CRLF ? '\r\n' : '\n');
      writer.writeComment('//# sourceMappingURL=');
      writer.writeComment(url);
    }
    if (sourceMapFilePath !== '') {
      const error = host.writeFile(sourceMapFilePath, generator.toJSON());
      if (error !== '') result.errors.push(error);
      else result.emittedFiles.push(sourceMapFilePath);
    }
  } else writer.writeLine(false);
  let text = writer.getText();
  if (options.emitBOM === true) text = '\uFEFF' + text;
  const error = host.writeFile(jsFilePath, text, declarationDiagnostics);
  if (error === skippedWrite) return true;
  if (error !== '') result.errors.push(error);
  else result.emittedFiles.push(jsFilePath);
  return error === '';
}

/** `fileName` moved from the common source directory to `newDirectory`. */
function getSourceFilePathInNewDir(
  fileName: string,
  newDirectory: string,
  currentDirectory: string,
  commonSourceDirectory: string,
  useCaseSensitiveFileNames: boolean,
): string {
  let path = getNormalizedAbsolutePath(fileName, currentDirectory);
  const common = ensureTrailingDirectorySeparator(commonSourceDirectory);
  if (containsPath(common, path, useCaseSensitiveFileNames, currentDirectory)) path = path.slice(common.length);
  return combinePaths(newDirectory, path);
}

function getSourceRoot(options: CompilerOptions): string {
  const root = normalizeSlashes(options.sourceRoot !== undefined ? options.sourceRoot : '');
  return root !== '' ? ensureTrailingDirectorySeparator(root) : root;
}

function mapRootDirectory(host: EmitHost, mapRoot: string, file: SourceFile): string {
  let directory = normalizeSlashes(mapRoot);
  directory = getDirectoryPath(
    getSourceFilePathInNewDir(
      file.fileName,
      directory,
      host.currentDirectory,
      host.commonSourceDirectory(),
      host.useCaseSensitiveFileNames,
    ),
  );
  return directory;
}

function getSourceMapDirectory(host: EmitHost, jsFilePath: string, file: SourceFile): string {
  const options = host.options;
  if (options.sourceRoot !== undefined && options.sourceRoot !== '') return host.commonSourceDirectory();
  if (options.mapRoot !== undefined && options.mapRoot !== '') {
    const directory = mapRootDirectory(host, options.mapRoot, file);
    return getRootLength(directory) === 0 ? combinePaths(host.commonSourceDirectory(), directory) : directory;
  }
  return getDirectoryPath(normalizePath(jsFilePath));
}

function getSourceMappingURL(
  host: EmitHost,
  generator: SourceMapGenerator,
  jsFilePath: string,
  sourceMapFilePath: string,
  file: SourceFile,
  inlineSourceMap: boolean,
): string {
  const options = host.options;
  if (inlineSourceMap) return generator.toBase64DataURL();
  const mapFile = getBaseFileName(normalizeSlashes(sourceMapFilePath));
  if (options.mapRoot !== undefined && options.mapRoot !== '') {
    const directory = mapRootDirectory(host, options.mapRoot, file);
    if (getRootLength(directory) === 0)
      return encodeURI(
        getRelativePathToDirectoryOrUrl(
          getDirectoryPath(normalizePath(jsFilePath)),
          combinePaths(combinePaths(host.commonSourceDirectory(), directory), mapFile),
          host.useCaseSensitiveFileNames,
          host.currentDirectory,
        ),
      );
    return encodeURI(combinePaths(directory, mapFile));
  }
  return encodeURI(mapFile);
}

const hexDigits = '0123456789ABCDEF';

/** Percent-encodes the bytes of `s` that `encodeURI` would, by UTF-8 byte as tsgo does. */
function encodeURI(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (
      (ch >= 0x41 && ch <= 0x5a) ||
      (ch >= 0x61 && ch <= 0x7a) ||
      (ch >= 0x30 && ch <= 0x39) ||
      ";,/?:@&=+$-_.!~*'()#".indexOf(String.fromCharCode(ch)) >= 0
    ) {
      out += String.fromCharCode(ch);
      continue;
    }
    const bytes = utf8Of(s, i);
    if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < s.length) i++;
    for (let b = 0; b < bytes.length; b++)
      out += '%' + hexDigits.charAt(bytes[b] >> 4) + hexDigits.charAt(bytes[b] & 15);
  }
  return out;
}

function utf8Of(s: string, i: number): number[] {
  let c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const low = s.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff) c = (c - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
  }
  if (c < 0x80) return [c];
  if (c < 0x800) return [0xc0 | (c >> 6), 0x80 | (c & 63)];
  if (c < 0x10000) return [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
  return [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
}
