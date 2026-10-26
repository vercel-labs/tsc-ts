/**
 * Why each file is in a program, as `--explainFiles` prints it, and diagnostics explaining file inclusion.
 */
import { ObjectLiteralExpression, StringLiteral, type FileReference, type Node, type SourceFile } from './ast.js';
import { createCompilerDiagnostic, Diagnostic, Diagnostics, type DiagnosticMessage } from './diagnostics.js';
import { packageIdToString, type PackageId } from './module-resolution-types.js';
import { ModuleKind } from './options.js';
import { getNormalizedAbsolutePath, toFileNameLowerCase } from './path.js';
import { isExternalOrCommonJSModule, libNames, scriptTargetName } from './program-utilities.js';
import type { Program } from './program.js';
import { skipTrivia } from './scanner.js';
import { getSpellingSuggestion } from './spelling.js';
import {
  diagnosticAtNode,
  findArrayElement,
  findPropertyAssignment,
  findTsConfigArrayElement,
  getTsConfigObjectLiteral,
} from './tsconfig.js';

export const enum FileIncludeKind {
  // References from a file.
  Import,
  ReferenceFile,
  TypeReferenceDirective,
  LibReferenceDirective,

  RootFile,
  LibFile,
  AutomaticTypeDirectiveFile,
}

/**
 * One reason a file is in the program. Reasons are immutable, so the program's loader takes the
 * reasons a parse thread found as they are; what they compute for a program is kept by its
 * IncludeProcessor (`ReasonCache`).
 */
export class FileIncludeReason {
  private constructor(
    readonly kind: FileIncludeKind,
    /** The referencing file's path, for references from a file. */
    readonly file: string,
    /** The root file, `lib` entry or reference index; -1 for the default library. */
    readonly index: number,
    /** The synthesized specifier of an `importHelpers` or JSX runtime import. */
    readonly synthetic: StringLiteral | undefined,
    /** The `types` entry, for automatic type directives. */
    readonly typeReference: string,
    readonly packageId: PackageId | undefined,
  ) {}

  static rootFile(index: number): FileIncludeReason {
    return new FileIncludeReason(FileIncludeKind.RootFile, '', index, undefined, '', undefined);
  }

  /** A `lib` entry, or the default library with `index` -1. */
  static libFile(index: number): FileIncludeReason {
    return new FileIncludeReason(FileIncludeKind.LibFile, '', index, undefined, '', undefined);
  }

  static automaticTypeDirective(typeReference: string, packageId: PackageId | undefined): FileIncludeReason {
    return new FileIncludeReason(
      FileIncludeKind.AutomaticTypeDirectiveFile,
      '',
      -1,
      undefined,
      typeReference,
      packageId,
    );
  }

  /** An import (`index` into the file's imports and module augmentations, -1 if `synthetic`) or a `///` reference. */
  static reference(
    kind: FileIncludeKind,
    file: string,
    index: number,
    synthetic: StringLiteral | undefined,
  ): FileIncludeReason {
    return new FileIncludeReason(kind, file, index, synthetic, '', undefined);
  }

  /** The same reason as a new object (`IncludeProcessor.copy`). */
  copy(): FileIncludeReason {
    return new FileIncludeReason(this.kind, this.file, this.index, this.synthetic, this.typeReference, this.packageId);
  }

  isReferencedFile(): boolean {
    return this.kind <= FileIncludeKind.LibReferenceDirective;
  }

  getReferencedLocation(program: Program): ReferenceFileLocation {
    const cache = program.includeProcessor.cacheOf(this);
    if (cache !== undefined && cache.location !== undefined) return cache.location;
    const file = program.getSourceFileByPath(this.file);
    if (file === undefined) throw new Error('referencing file is not in the program');
    let location: ReferenceFileLocation;
    switch (this.kind) {
      case FileIncludeKind.Import: {
        let specifier: Node | undefined;
        if (this.synthetic !== undefined) specifier = this.synthetic;
        else if (this.index < file.imports.length) specifier = file.imports[this.index];
        else {
          let index = file.imports.length;
          for (const augmentation of file.moduleAugmentations) {
            if (!(augmentation instanceof StringLiteral)) continue;
            if (index === this.index) {
              specifier = augmentation;
              break;
            }
            index++;
          }
        }
        if (specifier === undefined) throw new Error('missing import specifier');
        const resolution = program.getResolvedModuleFromModuleSpecifier(file, specifier);
        location = new ReferenceFileLocation(
          file,
          specifier,
          undefined,
          resolution?.packageId,
          this.synthetic !== undefined,
        );
        break;
      }
      case FileIncludeKind.ReferenceFile:
        location = new ReferenceFileLocation(file, undefined, file.referencedFiles[this.index], undefined, false);
        break;
      case FileIncludeKind.TypeReferenceDirective:
        location = new ReferenceFileLocation(
          file,
          undefined,
          file.typeReferenceDirectives[this.index],
          undefined,
          false,
        );
        break;
      default:
        location = new ReferenceFileLocation(
          file,
          undefined,
          file.libReferenceDirectives[this.index],
          undefined,
          false,
        );
    }
    if (!program.isShared()) program.includeProcessor.newCacheOf(this).location = location;
    return location;
  }

  /** The reason as a message, with file names relative to the current directory if `relative`. */
  toDiagnostic(program: Program, relative: boolean): Diagnostic {
    const cache = program.includeProcessor.cacheOf(this);
    const cached = cache === undefined ? undefined : relative ? cache.relativeDiagnostic : cache.absoluteDiagnostic;
    if (cached !== undefined) return cached;
    const diagnostic = this.computeDiagnostic(program, relative);
    if (program.isShared()) return diagnostic;
    const own = program.includeProcessor.newCacheOf(this);
    if (relative) own.relativeDiagnostic = diagnostic;
    else own.absoluteDiagnostic = diagnostic;
    return diagnostic;
  }

  private computeDiagnostic(program: Program, relative: boolean): Diagnostic {
    if (this.isReferencedFile()) return this.computeReferenceDiagnostic(program, relative);
    switch (this.kind) {
      case FileIncludeKind.RootFile: {
        const config = program.commandLine;
        if (config.configFile === undefined)
          return createCompilerDiagnostic(Diagnostics.Root_file_specified_for_compilation);
        const fileName = getNormalizedAbsolutePath(config.fileNames[this.index], program.currentDirectory);
        const matchedFileSpec = config.getMatchedFileSpec(fileName);
        if (matchedFileSpec !== '') {
          return createCompilerDiagnostic(
            Diagnostics.Part_of_files_list_in_tsconfig_json,
            matchedFileSpec,
            program.displayFileName(fileName, relative),
          );
        }
        const matchedIncludeSpec = config.getMatchedIncludeSpec(fileName);
        if (matchedIncludeSpec !== '') {
          if (config.isDefaultIncludeSpec()) {
            return createCompilerDiagnostic(
              Diagnostics.Matched_by_default_include_pattern_Asterisk_Asterisk_Slash_Asterisk,
            );
          }
          return createCompilerDiagnostic(
            Diagnostics.Matched_by_include_pattern_0_in_1,
            matchedIncludeSpec,
            program.displayFileName(config.configName, relative),
          );
        }
        return createCompilerDiagnostic(Diagnostics.Root_file_specified_for_compilation);
      }
      case FileIncludeKind.AutomaticTypeDirectiveFile: {
        const usesWildcardTypes = program.options.types?.includes('*') === true;
        const packageId = this.packageId;
        if (!usesWildcardTypes) {
          return packageId !== undefined
            ? createCompilerDiagnostic(
                Diagnostics.Entry_point_of_type_library_0_specified_in_compilerOptions_with_packageId_1,
                this.typeReference,
                packageIdToString(packageId),
              )
            : createCompilerDiagnostic(
                Diagnostics.Entry_point_of_type_library_0_specified_in_compilerOptions,
                this.typeReference,
              );
        }
        return packageId !== undefined
          ? createCompilerDiagnostic(
              Diagnostics.Entry_point_for_implicit_type_library_0_with_packageId_1,
              this.typeReference,
              packageIdToString(packageId),
            )
          : createCompilerDiagnostic(Diagnostics.Entry_point_for_implicit_type_library_0, this.typeReference);
      }
      default: {
        const lib = program.options.lib;
        if (this.index >= 0 && lib !== undefined) {
          return createCompilerDiagnostic(Diagnostics.Library_0_specified_in_compilerOptions, lib[this.index]);
        }
        return createCompilerDiagnostic(
          Diagnostics.Default_library_for_target_0,
          scriptTargetName(program.emitScriptTarget()),
        );
      }
    }
  }

  private computeReferenceDiagnostic(program: Program, relative: boolean): Diagnostic {
    const location = program.includeProcessor.getReferenceLocation(this, program);
    const text = location.text();
    const fileName = program.displayFileName(location.file.fileName, relative);
    const packageId = location.packageId;
    switch (this.kind) {
      case FileIncludeKind.Import: {
        if (!location.isSynthetic) {
          return packageId !== undefined
            ? createCompilerDiagnostic(
                Diagnostics.Imported_via_0_from_file_1_with_packageId_2,
                text,
                fileName,
                packageIdToString(packageId),
              )
            : createCompilerDiagnostic(Diagnostics.Imported_via_0_from_file_1, text, fileName);
        }
        if (program.importHelpersImportSpecifier(location.file.path) === location.node) {
          return packageId !== undefined
            ? createCompilerDiagnostic(
                Diagnostics.Imported_via_0_from_file_1_with_packageId_2_to_import_importHelpers_as_specified_in_compilerOptions,
                text,
                fileName,
                packageIdToString(packageId),
              )
            : createCompilerDiagnostic(
                Diagnostics.Imported_via_0_from_file_1_to_import_importHelpers_as_specified_in_compilerOptions,
                text,
                fileName,
              );
        }
        return packageId !== undefined
          ? createCompilerDiagnostic(
              Diagnostics.Imported_via_0_from_file_1_with_packageId_2_to_import_jsx_and_jsxs_factory_functions,
              text,
              fileName,
              packageIdToString(packageId),
            )
          : createCompilerDiagnostic(
              Diagnostics.Imported_via_0_from_file_1_to_import_jsx_and_jsxs_factory_functions,
              text,
              fileName,
            );
      }
      case FileIncludeKind.ReferenceFile:
        return createCompilerDiagnostic(Diagnostics.Referenced_via_0_from_file_1, text, fileName);
      case FileIncludeKind.TypeReferenceDirective:
        return packageId !== undefined
          ? createCompilerDiagnostic(
              Diagnostics.Type_library_referenced_via_0_from_file_1_with_packageId_2,
              text,
              fileName,
              packageIdToString(packageId),
            )
          : createCompilerDiagnostic(Diagnostics.Type_library_referenced_via_0_from_file_1, text, fileName);
      default:
        return createCompilerDiagnostic(Diagnostics.Library_referenced_via_0_from_file_1, text, fileName);
    }
  }

  /** Where in the config or a file this reason is written, as related information; `undefined` if nowhere. */
  toRelatedInfo(program: Program): Diagnostic | undefined {
    const cache = program.includeProcessor.cacheOf(this);
    if (cache !== undefined && cache.relatedInfo !== undefined) return cache.relatedInfo ?? undefined;
    const info = this.computeRelatedInfo(program);
    if (!program.isShared()) program.includeProcessor.newCacheOf(this).relatedInfo = info ?? null;
    return info;
  }

  private computeRelatedInfo(program: Program): Diagnostic | undefined {
    if (this.isReferencedFile()) {
      const location = program.includeProcessor.getReferenceLocation(this, program);
      if (location.isSynthetic) return undefined;
      switch (this.kind) {
        case FileIncludeKind.Import:
          return location.diagnosticAt(Diagnostics.File_is_included_via_import_here);
        case FileIncludeKind.ReferenceFile:
          return location.diagnosticAt(Diagnostics.File_is_included_via_reference_here);
        case FileIncludeKind.TypeReferenceDirective:
          return location.diagnosticAt(Diagnostics.File_is_included_via_type_library_reference_here);
        default:
          return location.diagnosticAt(Diagnostics.File_is_included_via_library_reference_here);
      }
    }
    const config = program.commandLine;
    const configFile = config.configFile?.sourceFile;
    if (configFile === undefined) return undefined;
    switch (this.kind) {
      case FileIncludeKind.RootFile: {
        const fileName = getNormalizedAbsolutePath(config.fileNames[this.index], program.currentDirectory);
        const matchedFileSpec = config.getMatchedFileSpec(fileName);
        if (matchedFileSpec !== '') {
          const node = findTsConfigArrayElement(configFile, 'files', matchedFileSpec);
          return node === undefined
            ? undefined
            : diagnosticAtNode(configFile, node, Diagnostics.File_is_matched_by_files_list_specified_here);
        }
        const matchedIncludeSpec = config.getMatchedIncludeSpec(fileName);
        if (matchedIncludeSpec !== '' && !config.isDefaultIncludeSpec()) {
          const node = findTsConfigArrayElement(configFile, 'include', matchedIncludeSpec);
          return node === undefined
            ? undefined
            : diagnosticAtNode(configFile, node, Diagnostics.File_is_matched_by_include_pattern_specified_here);
        }
        return undefined;
      }
      case FileIncludeKind.AutomaticTypeDirectiveFile: {
        if (program.options.types?.includes('*') === true) return undefined;
        const node = findArrayElement(
          findPropertyAssignment(program.includeProcessor.compilerOptionsSyntax(program), 'types'),
          this.typeReference,
        );
        return node === undefined
          ? undefined
          : diagnosticAtNode(configFile, node, Diagnostics.File_is_entry_point_of_type_library_specified_here);
      }
      default: {
        const lib = program.options.lib;
        const compilerOptions = program.includeProcessor.compilerOptionsSyntax(program);
        if (this.index >= 0 && lib !== undefined) {
          const node = findArrayElement(findPropertyAssignment(compilerOptions, 'lib'), lib[this.index]);
          return node === undefined
            ? undefined
            : diagnosticAtNode(configFile, node, Diagnostics.File_is_library_specified_here);
        }
        const target = scriptTargetName(program.emitScriptTarget());
        const property = findPropertyAssignment(compilerOptions, 'target');
        const value = property?.initializer;
        if (!(value instanceof StringLiteral) || value.text !== target) return undefined;
        return diagnosticAtNode(configFile, value, Diagnostics.File_is_default_library_for_target_specified_here);
      }
    }
  }
}

/** Where a reference from a file is written. */
export class ReferenceFileLocation {
  constructor(
    readonly file: SourceFile,
    /** The module specifier, for imports. */
    readonly node: Node | undefined,
    /** The `///` directive, for references. */
    readonly ref: FileReference | undefined,
    readonly packageId: PackageId | undefined,
    readonly isSynthetic: boolean,
  ) {}

  text(): string {
    const node = this.node;
    if (node !== undefined) {
      if (node.pos >= 0 && node.end >= 0) {
        const start = skipTrivia(this.file.text, node.pos);
        return this.file.text.slice(start, node.end);
      }
      return '"' + (node instanceof StringLiteral ? node.text : '') + '"';
    }
    const ref = this.ref;
    return ref === undefined ? '' : this.file.text.slice(ref.pos, ref.end);
  }

  diagnosticAt(message: DiagnosticMessage, ...args: string[]): Diagnostic {
    if (this.node !== undefined) return diagnosticAtNode(this.file, this.node, message, ...args);
    const ref = this.ref;
    return new Diagnostic(this.file.diagnosticFile(), ref?.pos ?? 0, ref?.end ?? 0, message, args);
  }
}

export const enum ProcessingDiagnosticKind {
  /** A `/// <reference types>` or `/// <reference lib>` that could not be found. */
  UnknownReference,
  ExplainingFileInclude,
}

/** A diagnostic found while loading files, explained with why the file is in the program once loading is done. */
export class ProcessingDiagnostic {
  private constructor(
    readonly kind: ProcessingDiagnosticKind,
    /** The path of the file explained; `''` if none. */
    readonly file: string,
    readonly reason: FileIncludeReason | undefined,
    readonly message: DiagnosticMessage | undefined,
    readonly args: readonly string[],
  ) {}

  static unknownReference(reason: FileIncludeReason): ProcessingDiagnostic {
    return new ProcessingDiagnostic(ProcessingDiagnosticKind.UnknownReference, '', reason, undefined, []);
  }

  static explainingFileInclude(
    file: string,
    reason: FileIncludeReason | undefined,
    message: DiagnosticMessage,
    args: readonly string[],
  ): ProcessingDiagnostic {
    return new ProcessingDiagnostic(ProcessingDiagnosticKind.ExplainingFileInclude, file, reason, message, args);
  }

  /** The same diagnostic with a copy of its reason (`FileIncludeReason.copy`). */
  copy(): ProcessingDiagnostic {
    return new ProcessingDiagnostic(this.kind, this.file, this.reason?.copy(), this.message, this.args);
  }

  /** This diagnostic with `renew(reason)` for its reason; itself when that is its reason. */
  withReason(renew: (reason: FileIncludeReason) => FileIncludeReason): ProcessingDiagnostic {
    const reason = this.reason === undefined ? undefined : renew(this.reason);
    return reason === this.reason
      ? this
      : new ProcessingDiagnostic(this.kind, this.file, reason, this.message, this.args);
  }

  toDiagnostic(program: Program): Diagnostic {
    const reason = this.reason;
    if (this.kind === ProcessingDiagnosticKind.UnknownReference && reason !== undefined) {
      const location = reason.getReferencedLocation(program);
      const fileName = location.ref?.fileName ?? '';
      if (reason.kind === FileIncludeKind.TypeReferenceDirective) {
        return location.diagnosticAt(Diagnostics.Cannot_find_type_definition_file_for_0, fileName);
      }
      const libName = toFileNameLowerCase(fileName);
      const unqualified = stripLibAffixes(libName);
      const suggestion = getSpellingSuggestion(unqualified, libNames);
      return suggestion !== ''
        ? location.diagnosticAt(Diagnostics.Cannot_find_lib_definition_for_0_Did_you_mean_1, libName, suggestion)
        : location.diagnosticAt(Diagnostics.Cannot_find_lib_definition_for_0, libName, suggestion);
    }
    return this.explainFile(program);
  }

  private explainFile(program: Program): Diagnostic {
    const processor = program.includeProcessor;
    const includeDetails: Diagnostic[] = [];
    const relatedInfo: Diagnostic[] = [];
    const seen = new Set<FileIncludeReason>();
    let preferred: FileIncludeReason | undefined;
    let hasDetails = false;
    const reason = this.reason;
    if (
      reason !== undefined &&
      reason.isReferencedFile() &&
      !processor.getReferenceLocation(reason, program).isSynthetic
    ) {
      preferred = reason;
    }
    const processInclude = (include: FileIncludeReason): void => {
      if (seen.has(include)) return;
      seen.add(include);
      includeDetails.push(include.toDiagnostic(program, false));
      if (
        preferred === undefined &&
        include.isReferencedFile() &&
        !processor.getReferenceLocation(include, program).isSynthetic
      ) {
        preferred = include;
      } else if (preferred !== include) {
        const info = include.toRelatedInfo(program);
        if (info !== undefined) relatedInfo.push(info);
      }
    };
    let redirectInfo: readonly Diagnostic[] = [];
    if (this.file !== '') {
      hasDetails = true;
      for (const include of processor.reasonsOf(this.file)) processInclude(include);
      redirectInfo = processor.explainRedirectAndImpliedFormat(program, this.file, false);
    }
    if (reason !== undefined) {
      hasDetails = true;
      processInclude(reason);
    }
    const chain: Diagnostic[] = [];
    if (hasDetails && (preferred === undefined || seen.size !== 1)) {
      const fileReason = createCompilerDiagnostic(Diagnostics.The_file_is_in_the_program_because_Colon);
      fileReason.messageChain = includeDetails;
      chain.push(fileReason);
    }
    for (const info of redirectInfo) chain.push(info);
    const message = this.message ?? Diagnostics.The_file_is_in_the_program_because_Colon;
    const result =
      preferred !== undefined
        ? processor.getReferenceLocation(preferred, program).diagnosticAt(message, ...this.args)
        : createCompilerDiagnostic(message, ...this.args);
    if (chain.length > 0) result.messageChain = chain;
    if (relatedInfo.length > 0) result.relatedInformation = relatedInfo;
    return result;
  }
}

/** `lib.dom.d.ts` to `dom`. */
function stripLibAffixes(name: string): string {
  let result = name.startsWith('lib.') ? name.slice(4) : name;
  if (result.endsWith('.d.ts')) result = result.slice(0, -5);
  return result;
}

/** Include reasons of every file and the diagnostics found while loading them. */
/** What a reason computed for the program of an IncludeProcessor. */
class ReasonCache {
  relativeDiagnostic: Diagnostic | undefined = undefined;
  absoluteDiagnostic: Diagnostic | undefined = undefined;
  location: ReferenceFileLocation | undefined = undefined;
  relatedInfo: Diagnostic | null | undefined = undefined;
}

export class IncludeProcessor {
  private computed: Diagnostic[] | undefined = undefined;
  /** What each reason computed for this processor's program, once it computed something. */
  private readonly reasonCaches = new Map<FileIncludeReason, ReasonCache>();
  private compilerOptionsObject: ObjectLiteralExpression | undefined = undefined;
  private compilerOptionsComputed = false;
  private readonly redirectAndFileFormat = new Map<string, readonly Diagnostic[]>();
  /** The number of processing diagnostics when the program was created (`noteProgramCreated`). */
  private createdCount: number | undefined = undefined;

  constructor(
    readonly fileIncludeReasons = new Map<string, FileIncludeReason[]>(),
    readonly processingDiagnostics: ProcessingDiagnostic[] = [],
  ) {}

  /** What `reason` computed for this processor's program, if anything. */
  cacheOf(reason: FileIncludeReason): ReasonCache | undefined {
    return this.reasonCaches.get(reason);
  }

  /** The cache of `reason`, created if needed. */
  newCacheOf(reason: FileIncludeReason): ReasonCache {
    let cache = this.reasonCaches.get(reason);
    if (cache === undefined) {
      cache = new ReasonCache();
      this.reasonCaches.set(reason, cache);
    }
    return cache;
  }

  /**
   * A processor with these reasons and the processing diagnostics its program was created with, whose diagnostics are
   * computed for another program. Computing the common source directory later adds diagnostics that the program
   * does not report (`Program.commonSourceDirectory`), and those of a program shared with checker threads are
   * immutable, so the copy has its own list. The reasons written in `replaced`, the path of the file
   * `Program.updateFile` swaps in, are new: a reason keeps where its file writes it, which the new text may move. Each
   * is copied once, so a diagnostic and the file's reasons still share it.
   */
  copy(replaced?: string): IncludeProcessor {
    const created = this.processingDiagnostics.slice(0, this.createdCount ?? this.processingDiagnostics.length);
    if (replaced === undefined) return new IncludeProcessor(this.fileIncludeReasons, created);
    const copies = new Map<FileIncludeReason, FileIncludeReason>();
    const renew = (reason: FileIncludeReason): FileIncludeReason => {
      if (reason.file !== replaced) return reason;
      let copy = copies.get(reason);
      if (copy === undefined) {
        copy = reason.copy();
        copies.set(reason, copy);
      }
      return copy;
    };
    const reasons = new Map<string, FileIncludeReason[]>();
    for (const [path, list] of this.fileIncludeReasons)
      reasons.set(path, list.some((reason) => reason.file === replaced) ? list.map(renew) : list);
    return new IncludeProcessor(
      reasons,
      created.map((diagnostic) => diagnostic.withReason(renew)),
    );
  }

  /** The program is created: the processing diagnostics so far are those a copy takes. */
  noteProgramCreated(): void {
    this.createdCount = this.processingDiagnostics.length;
  }

  reasonsOf(path: string): readonly FileIncludeReason[] {
    return this.fileIncludeReasons.get(path) ?? [];
  }

  /** Adds an include reason of the file at `path`; returns the file's reasons. */
  addReason(path: string, reason: FileIncludeReason): FileIncludeReason[] {
    const reasons = this.fileIncludeReasons.get(path);
    if (reasons === undefined) {
      const added = [reason];
      this.fileIncludeReasons.set(path, added);
      return added;
    }
    reasons.push(reason);
    return reasons;
  }

  addProcessingDiagnostic(diagnostic: ProcessingDiagnostic): void {
    this.processingDiagnostics.push(diagnostic);
  }

  /** Reports a file name that differs from an included one only in casing. */
  addCasingDiagnostic(
    file: string,
    existingCasing: string,
    currentCasing: string,
    reason: FileIncludeReason | undefined,
  ): void {
    let referenced = false;
    for (const existing of this.reasonsOf(file)) if (existing.isReferencedFile()) referenced = true;
    const reasonIsReference = reason !== undefined && reason.isReferencedFile();
    if (!reasonIsReference && referenced) {
      this.addProcessingDiagnostic(
        ProcessingDiagnostic.explainingFileInclude(
          file,
          reason,
          Diagnostics.Already_included_file_name_0_differs_from_file_name_1_only_in_casing,
          [existingCasing, currentCasing],
        ),
      );
    } else {
      this.addProcessingDiagnostic(
        ProcessingDiagnostic.explainingFileInclude(
          file,
          reason,
          Diagnostics.File_name_0_differs_from_already_included_file_name_1_only_in_casing,
          [currentCasing, existingCasing],
        ),
      );
    }
  }

  getReferenceLocation(reason: FileIncludeReason, program: Program): ReferenceFileLocation {
    return reason.getReferencedLocation(program);
  }

  /** Processing and resolution diagnostics, sorted by file. */
  diagnostics(program: Program): readonly Diagnostic[] {
    if (this.computed === undefined) {
      const computed: Diagnostic[] = [];
      for (const diagnostic of this.processingDiagnostics) computed.push(diagnostic.toDiagnostic(program));
      for (const diagnostic of program.resolutionDiagnostics()) computed.push(diagnostic);
      this.computed = computed;
    }
    return this.computed;
  }

  /** The compiler options object of the config file. */
  compilerOptionsSyntax(program: Program): ObjectLiteralExpression | undefined {
    if (this.compilerOptionsComputed) return this.compilerOptionsObject;
    const property = findPropertyAssignment(
      getTsConfigObjectLiteral(program.commandLine.configFile?.sourceFile),
      'compilerOptions',
    );
    const initializer = property?.initializer;
    // `as`: scriptc loses instanceof narrowing here.
    const object =
      initializer instanceof ObjectLiteralExpression ? (initializer as ObjectLiteralExpression) : undefined;
    if (!program.isShared()) {
      this.compilerOptionsComputed = true;
      this.compilerOptionsObject = object;
    }
    return object;
  }

  /**
   * Notes on a file's origin and module format. Cached per file: the first caller's choice of relative or
   * absolute file names sticks, as in tsgo. A shared program keeps what was cached before sharing; after that,
   * only `--explainFiles` asks, once per file, and the result is not kept.
   */
  explainRedirectAndImpliedFormat(program: Program, path: string, relative: boolean): readonly Diagnostic[] {
    const cached = this.redirectAndFileFormat.get(path);
    if (cached !== undefined) return cached;
    const result: Diagnostic[] = [];
    const redirect = program.redirectFile(path);
    const sourceFile = redirect === undefined ? program.getSourceFileByPath(path) : undefined;
    if (redirect === undefined && sourceFile === undefined) return result;
    const fileName = redirect !== undefined ? redirect.fileName : (sourceFile?.fileName ?? '');
    const source = program.getSourceOfProjectReferenceIfOutputIncluded(path, fileName);
    if (source !== fileName) {
      result.push(
        createCompilerDiagnostic(
          Diagnostics.File_is_output_of_project_reference_source_0,
          program.displayFileName(source, relative),
        ),
      );
    }
    if (redirect !== undefined) {
      const target = program.getSourceFileByPath(redirect.target);
      result.push(
        createCompilerDiagnostic(
          Diagnostics.File_redirects_to_file_0,
          program.displayFileName(target?.fileName ?? '', relative),
        ),
      );
    }
    if (sourceFile !== undefined && isExternalOrCommonJSModule(sourceFile)) {
      const metadata = program.sourceFileMetadata(path);
      const packageJson = metadata.packageJsonDirectory + '/package.json';
      const format = program.getImpliedNodeFormatForEmit(sourceFile);
      if (format === ModuleKind.ESNext) {
        if (metadata.packageJsonType === 'module') {
          result.push(
            createCompilerDiagnostic(
              Diagnostics.File_is_ECMAScript_module_because_0_has_field_type_with_value_module,
              program.displayFileName(packageJson, relative),
            ),
          );
        }
      } else if (format === ModuleKind.CommonJS) {
        if (metadata.packageJsonType !== '') {
          result.push(
            createCompilerDiagnostic(
              Diagnostics.File_is_CommonJS_module_because_0_has_field_type_whose_value_is_not_module,
              program.displayFileName(packageJson, relative),
            ),
          );
        } else if (metadata.packageJsonDirectory !== '') {
          result.push(
            createCompilerDiagnostic(
              Diagnostics.File_is_CommonJS_module_because_0_does_not_have_field_type,
              program.displayFileName(packageJson, relative),
            ),
          );
        } else {
          result.push(createCompilerDiagnostic(Diagnostics.File_is_CommonJS_module_because_package_json_was_not_found));
        }
      }
    }
    if (!program.isShared()) this.redirectAndFileFormat.set(path, result);
    return result;
  }
}
