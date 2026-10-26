/**
 * Incremental compilation: the state of a program between builds (file versions and shape
 * signatures, references, cached diagnostics and pending emit), what a change affects, and the
 * `.tsbuildinfo` that stores it, like tsgo's `incremental` package.
 *
 * ```ts
 * const old = readBuildInfoProgram(config, reader, defaultLibraryPath);
 * const program = new IncrementalProgram(checked, times, old, host);
 * ```
 */
import { publish } from '@scriptc/threads';
import { lastNodeIdValue, type Node, type SourceFile } from './ast.js';
import { SyntaxKind } from './syntax-kind.js';
import { isAmbientModule, isGlobalScopeAugmentation } from './ast-utilities.js';
import { getSourceFileOfNode, isExternalOrCommonJSModule, isJsonSourceFile } from './binder-utilities.js';
import {
  BuildInfo,
  BuildInfoDiagnostic,
  BuildInfoDiagnosticsOfFile,
  BuildInfoEmitSignature,
  BuildInfoFileInfo,
  BuildInfoFilePendingEmit,
  BuildInfoOption,
  BuildInfoReference,
  BuildInfoResolvedRoot,
  BuildInfoRoot,
  BuildInfoSemanticDiagnostic,
  buildInfoToJson,
  compilerOptionDeclarationsInFieldOrder,
  compilerOptionValue,
  FileEmitKind,
  FileInfoForm,
  getFileEmitKind,
  getPendingEmitKind,
  getPendingEmitKindWithOptions,
  isBuildInfoFileNameDefaultLibrary,
  parseBuildInfo,
} from './build-info.js';
import {
  type DiagnosticDetails,
  modeMismatchDetails,
  moduleNotFoundDetails,
  resolveExternalModuleName,
  getImportAttributesTypeForModuleSpecifier,
} from './checker-modules.js';
import { getSymbolAtLocation } from './checker-services.js';
import { resolveAlias } from './checker-symbols.js';
import {
  CompilerProgram,
  CompileTimes,
  combineEmitResults,
  declarationDiagnosticsOfFile,
  handleNoEmitOnError,
  OutputWriter,
  ProgramEmitter,
  writeHeldOutputs,
} from './compile-program.js';
import {
  categoryName,
  createCompilerDiagnostic,
  Diagnostic,
  Diagnostics,
  messageForKey,
  messageKey,
  RepopulateKind,
  type RepopulateInfo,
} from './diagnostics.js';
import { EmitOnly, EmitResult, skippedWrite, sourceFileMayBeEmitted } from './emitter.js';
import type { FileSystem } from './file-system.js';
import { version } from './help.js';
import { Affects, type OptionDeclaration } from './option-declarations.js';
import {
  getAllowJS,
  getEmitDeclarations,
  getStrictOptionValue,
  isIncremental,
  ModuleKind,
  type CompilerOptions,
  type CompilerOptionValue,
} from './options.js';
import type { Program } from './program.js';
import { CheckedProgram, ProgramCheckerHost } from './program-checker.js';
import {
  combinePaths,
  ensurePathIsNonModuleName,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getRelativePathFromDirectory,
  getRootLength,
  isDeclarationFileName,
  toPath,
} from './path.js';
import type { ParsedCommandLine } from './tsconfig.js';
import { hash128String, toHex } from './xxh3.js';
import { preparedVersion } from './parallel-parse.js';
import { getDeclarations, lastSymbolIdValue, type Symbol, SymbolFlags } from './symbol.js';

/** The hash of file text that build info records as a version or signature. */
export function computeHash(text: string): string {
  return toHex(hash128String(text));
}

export class FileInfo {
  constructor(
    readonly version: string,
    public signature: string,
    readonly affectsGlobalScope: boolean,
    readonly impliedNodeFormat: number,
  ) {}
}

/** The file info a build info records; `undefined` stays `undefined`. */
export function fileInfoFromBuildInfo(info: BuildInfoFileInfo): FileInfo {
  switch (info.form) {
    case FileInfoForm.Short:
      return new FileInfo(info.version, info.version, false, ModuleKind.CommonJS);
    case FileInfoForm.NoSignature:
      return new FileInfo(info.version, '', info.affectsGlobalScope, info.impliedNodeFormat);
    default:
      return new FileInfo(
        info.version,
        info.signature === '' ? info.version : info.signature,
        info.affectsGlobalScope,
        info.impliedNodeFormat,
      );
  }
}

function toBuildInfoFileInfo(info: FileInfo): BuildInfoFileInfo {
  if (info.version === info.signature) {
    if (!info.affectsGlobalScope && info.impliedNodeFormat === ModuleKind.CommonJS) {
      return new BuildInfoFileInfo(FileInfoForm.Short, info.signature, info.signature, false, ModuleKind.CommonJS);
    }
  } else if (info.signature === '') {
    return new BuildInfoFileInfo(
      FileInfoForm.NoSignature,
      info.version,
      '',
      info.affectsGlobalScope,
      info.impliedNodeFormat,
    );
  }
  return new BuildInfoFileInfo(
    FileInfoForm.Full,
    info.version,
    info.signature === info.version ? '' : info.signature,
    info.affectsGlobalScope,
    info.impliedNodeFormat,
  );
}

/** The hash of a declaration file, recorded for composite projects to tell whether it changed. */
class EmitSignature {
  constructor(
    /** `''` when emitted with different `declarationMap`. */
    readonly signature: string,
    /** The signature when emitted with different `declarationMap`, else `undefined`. */
    readonly signatureWithDifferentOptions: string | undefined,
  ) {}

  /** This signature as seen with `newOptions`: the forms swap when `declarationMap` changed. */
  getNewEmitSignature(oldOptions: CompilerOptions, newOptions: CompilerOptions): EmitSignature {
    if ((oldOptions.declarationMap === true) === (newOptions.declarationMap === true)) return this;
    const different = this.signatureWithDifferentOptions;
    if (different === undefined) return new EmitSignature('', this.signature);
    return new EmitSignature(different, undefined);
  }
}

/** A diagnostic read from build info, resolved against the program when needed. */
class StoredDiagnostic {
  constructor(
    /** Path of the file if not the one it is stored for. */
    readonly file: string,
    readonly stored: BuildInfoDiagnostic,
    readonly messageChain: StoredDiagnostic[],
    readonly relatedInformation: StoredDiagnostic[],
  ) {}

  toDiagnostic(program: Program, file: SourceFile | undefined): Diagnostic | undefined {
    let fileForDiagnostic: SourceFile | undefined = undefined;
    if (this.file !== '') fileForDiagnostic = program.getSourceFileByPath(this.file);
    else if (!this.stored.noFile) fileForDiagnostic = file;
    const d = this.stored;
    const repopulate = d.repopulateInfo;
    if (repopulate !== undefined && fileForDiagnostic !== undefined) {
      const details = repopulatedDetails(program, fileForDiagnostic, repopulate);
      if (details !== undefined) {
        // The entry as the program now has it, with the rest of the chain as stored.
        const diagnosticFile = fileForDiagnostic.diagnosticFile();
        const result = new Diagnostic(
          diagnosticFile,
          diagnosticFile.fromUtf8Offset(d.pos),
          diagnosticFile.fromUtf8Offset(d.end),
          details.message,
          details.args,
        );
        for (const chain of this.messageChain) result.addMessageChain(chain.toDiagnostic(program, fileForDiagnostic));
        return result;
      }
    }
    const message = messageForKey(d.messageKey);
    if (message === undefined) return undefined;
    const diagnosticFile = fileForDiagnostic === undefined ? undefined : fileForDiagnostic.diagnosticFile();
    const result = new Diagnostic(
      diagnosticFile,
      diagnosticFile === undefined ? d.pos : diagnosticFile.fromUtf8Offset(d.pos),
      diagnosticFile === undefined ? d.end : diagnosticFile.fromUtf8Offset(d.end),
      message,
      d.messageArgs,
    );
    result.code = d.code;
    result.category = d.category;
    result.skippedOnNoEmit = d.skippedOnNoEmit;
    for (const chain of this.messageChain) result.addMessageChain(chain.toDiagnostic(program, fileForDiagnostic));
    for (const related of this.relatedInformation) {
      result.addRelatedInfo(related.toDiagnostic(program, fileForDiagnostic));
    }
    return result;
  }
}

/**
 * The message and arguments of a message chain entry of `file` that depends on the program, as the
 * program now has them (tsgo's `repopulateDiagnosticChain`); `undefined` for an unknown kind.
 */
function repopulatedDetails(program: Program, file: SourceFile, info: RepopulateInfo): DiagnosticDetails | undefined {
  const host = new ProgramCheckerHost(program);
  switch (info.kind) {
    case RepopulateKind.ModeMismatch:
      return modeMismatchDetails(host, file);
    case RepopulateKind.ModuleNotFound:
      return moduleNotFoundDetails(
        host,
        file,
        info.moduleReference,
        info.mode,
        info.packageName === '' ? info.moduleReference : info.packageName,
      );
  }
  return undefined;
}

/**
 * The computed diagnostics of `file` from the previous state, with the message chain entries that
 * depend on the program recomputed (tsgo's `repopulateDiagnosticsOfFile`). Diagnostics as read from
 * build info are recomputed when they are converted (`StoredDiagnostic.toDiagnostic`).
 */
function repopulateFileDiagnostics(diagnostics: FileDiagnostics, program: Program, file: SourceFile): FileDiagnostics {
  const computed = diagnostics.computed;
  if (computed === undefined) return diagnostics;
  let changed = false;
  const result: Diagnostic[] = [];
  for (const d of computed) {
    const chain = repopulateChain(d.messageChain, program, file);
    if (chain === undefined) result.push(d);
    else {
      const copy = d.clone();
      copy.messageChain = chain;
      result.push(copy);
      changed = true;
    }
  }
  return changed ? FileDiagnostics.of(result) : diagnostics;
}

/** `chain` with the entries that depend on the program recomputed; `undefined` if none do. */
function repopulateChain(chain: readonly Diagnostic[], program: Program, file: SourceFile): Diagnostic[] | undefined {
  let changed = false;
  const result: Diagnostic[] = [];
  for (const entry of chain) {
    if (entry.repopulateInfo !== undefined) {
      result.push(repopulatedEntry(entry, program, file));
      changed = true;
      continue;
    }
    const nested = repopulateChain(entry.messageChain, program, file);
    if (nested === undefined) result.push(entry);
    else {
      const copy = entry.clone();
      copy.messageChain = nested;
      result.push(copy);
      changed = true;
    }
  }
  return changed ? result : undefined;
}

/**
 * A message chain entry of `file` as tsgo recomputes it: the program's message for an entry that
 * depends on it, and only the location, message and chain of the entries below.
 */
function repopulatedEntry(entry: Diagnostic, program: Program, file: SourceFile): Diagnostic {
  const info = entry.repopulateInfo;
  const details = info === undefined ? undefined : repopulatedDetails(program, file, info);
  const result =
    details === undefined
      ? new Diagnostic(file.diagnosticFile(), entry.pos, entry.end, entry.message, entry.args)
      : new Diagnostic(file.diagnosticFile(), entry.pos, entry.end, details.message, details.args);
  if (details === undefined) {
    result.code = entry.code;
    result.category = entry.category;
  }
  for (const nested of entry.messageChain) result.addMessageChain(repopulatedEntry(nested, program, file));
  return result;
}

/** Diagnostics of a file: computed, or still as read from build info. */
class FileDiagnostics {
  constructor(
    private diagnostics: Diagnostic[] | undefined,
    readonly stored: StoredDiagnostic[] | undefined,
  ) {}

  static of(diagnostics: Diagnostic[]): FileDiagnostics {
    return new FileDiagnostics(diagnostics, undefined);
  }

  get computed(): Diagnostic[] | undefined {
    return this.diagnostics;
  }

  isEmpty(): boolean {
    const diagnostics = this.diagnostics;
    if (diagnostics !== undefined) return diagnostics.length === 0;
    const stored = this.stored;
    return stored === undefined || stored.length === 0;
  }

  getDiagnostics(program: Program, file: SourceFile): Diagnostic[] {
    const existing = this.diagnostics;
    if (existing !== undefined) return existing;
    const result: Diagnostic[] = [];
    const stored = this.stored;
    if (stored !== undefined) {
      for (const d of stored) {
        const diagnostic = d.toDiagnostic(program, file);
        if (diagnostic !== undefined) result.push(diagnostic);
      }
    }
    this.diagnostics = result;
    return result;
  }
}

/** Files and the files they reference, for finding what a change affects. */
class ReferenceMap {
  readonly references = new Map<string, Set<string>>();
  private referencedBy: Map<string, Set<string>> | undefined = undefined;
  /** The number of references in `references`, once computed (`getReferencedBy`). */
  private referenceCount = -1;
  /** The number of sets `getReferencedBy` looked into before building `referencedBy`. */
  private setsScanned = 0;

  /**
   * The files that reference `path`, in the order of `references`. The first queries look into each
   * set; once those have looked into as many sets as there are references, the inverse map is built.
   */
  getReferencedBy(path: string): string[] {
    let referencedBy = this.referencedBy;
    if (referencedBy === undefined) {
      if (this.referenceCount < 0) {
        let count = 0;
        for (const references of this.references.values()) count += references.size;
        this.referenceCount = count;
      }
      if (this.setsScanned + this.references.size <= this.referenceCount) {
        this.setsScanned += this.references.size;
        const result: string[] = [];
        for (const [key, references] of this.references) if (references.has(path)) result.push(key);
        return result;
      }
      referencedBy = new Map();
      for (const [key, references] of this.references) {
        for (const reference of references) {
          let set = referencedBy.get(reference);
          if (set === undefined) {
            set = new Set();
            referencedBy.set(reference, set);
          }
          set.add(key);
        }
      }
      this.referencedBy = referencedBy;
    }
    const result = referencedBy.get(path);
    return result === undefined ? [] : [...result];
  }
}

/**
 * The `fileIdsList` of a build info that was read: the paths of its file ids, the set of paths the
 * snapshot read from it has for each list, and the list of each file of its referenced map.
 */
class FileIdLists {
  readonly listOfFile = new Map<string, number>();
  /** `hashOfIds` of each list. */
  readonly hashes: number[] = [];
  /** The last id of each list whose ids are ascending from 1 (0 for an empty list), and -1 for the others. */
  readonly lastIds: number[] = [];
  /**
   * The ids of every list, one after another, and where each list starts in them (with the end of the
   * last list after the last start), in shared memory that reference threads read
   * (`compareReferencesOnThreads`).
   */
  readonly listStarts: Int32Array;
  readonly listIds: Int32Array;
  private readonly pathIndexes = new Map<string, number>();

  constructor(
    readonly filePaths: readonly string[],
    readonly ids: readonly number[][],
    readonly sets: readonly ReadonlySet<string>[],
    /** The ids of each list joined with commas, as read (`BuildInfo.fileIdsListText`), or empty. */
    readonly texts: readonly string[],
  ) {
    let total = 0;
    for (const list of ids) {
      this.hashes.push(hashOfIds(list));
      let previous = 0;
      for (const id of list) {
        if (id <= previous) {
          previous = -1;
          break;
        }
        previous = id;
      }
      this.lastIds.push(previous);
      total += list.length;
    }
    const starts = new Int32Array(new SharedArrayBuffer(4 * (ids.length + 1)));
    const all = new Int32Array(new SharedArrayBuffer(4 * total));
    this.listStarts = starts;
    this.listIds = all;
    let at = 0;
    for (let k = 0; k < ids.length; k++) {
      starts[k] = at;
      // An id with no path is 0, as is one outside of the int32 range.
      for (const id of ids[k]) all[at++] = id >= 1 && id <= filePaths.length ? id : 0;
    }
    starts[ids.length] = at;
    for (let i = 0; i < filePaths.length; i++) this.pathIndexes.set(filePaths[i], i);
  }

  /** The index in `filePaths` of each path; `undefined` where two file ids have the same path. */
  indexOfPath(): Map<string, number> | undefined {
    return this.pathIndexes.size === this.filePaths.length ? this.pathIndexes : undefined;
  }

  /** The index of the list whose set is `references`, the old references of the file at `path`; -1 if none or empty. */
  listOf(path: string, references: ReadonlySet<string> | undefined): number {
    const index = this.listOfFile.get(path);
    if (index === undefined || references === undefined || references.size === 0) return -1;
    return this.sets[index] === references ? index : -1;
  }
}

/**
 * Compares the references of files (`getReferencedFiles`) with their lists of file ids in the build
 * info read (`FileIdLists`) by the indexes of the paths, without collecting each file's references
 * into a set. Every file references the files that declare ambient modules: those of a list are
 * counted as the list is read. Reference threads compare with their own comparer of the same lists
 * (`compareReferencesOnThreads`).
 */
class ReferenceListComparer {
  /** For each index, the comparison whose list has it. */
  private readonly listed: Int32Array;
  /** For each index, 1 where its file is in the old state and not in the program, 2 where not, 0 if not known yet. */
  private readonly missing: Uint8Array;
  private comparison = 0;

  constructor(
    /** The number of file ids. */
    readonly count: number,
    /** `FileIdLists.listStarts` and `FileIdLists.listIds`. */
    readonly listStarts: Int32Array,
    readonly listIds: Int32Array,
    readonly indexOfPath: ReadonlyMap<string, number>,
    /** 1 at the index of each file that declares ambient modules, in shared memory. */
    readonly declaresAmbientModules: Uint8Array,
    readonly ambientModuleFileCount: number,
    /** Whether a file that declares ambient modules has no file id. */
    readonly ambientModuleFileNotListed: boolean,
  ) {
    this.listed = new Int32Array(count);
    this.missing = new Uint8Array(count);
  }

  /** The comparer of `lists` for a program whose files that declare ambient modules are `ambientModuleFiles`. */
  static of(
    lists: FileIdLists,
    indexOfPath: ReadonlyMap<string, number>,
    ambientModuleFiles: readonly string[],
  ): ReferenceListComparer {
    const count = lists.filePaths.length;
    const declaresAmbientModules = new Uint8Array(new SharedArrayBuffer(count));
    let ambientModuleFileCount = 0;
    let ambientModuleFileNotListed = false;
    for (const path of ambientModuleFiles) {
      const index = indexOfPath.get(path);
      if (index === undefined) ambientModuleFileNotListed = true;
      else {
        declaresAmbientModules[index] = 1;
        ambientModuleFileCount++;
      }
    }
    return new ReferenceListComparer(
      count,
      lists.listStarts,
      lists.listIds,
      indexOfPath,
      declaresAmbientModules,
      ambientModuleFileCount,
      ambientModuleFileNotListed,
    );
  }

  /**
   * Whether the references of `file` are the paths of the list at `listIndex`. `undefined` where the
   * list has an id with no path, whose set has the path '', or where `file` has no file id.
   */
  sameReferences(checked: CheckedProgram, file: SourceFile, listIndex: number): boolean | undefined {
    const selfIndex = this.indexOfPath.get(file.path);
    if (selfIndex === undefined) return undefined;
    // A file that declares ambient modules and has no file id is not in the list, and is not `file`.
    if (this.ambientModuleFileNotListed) return false;
    const count = this.count;
    const listed = this.listed;
    const listIds = this.listIds;
    const declaresAmbientModules = this.declaresAmbientModules;
    const comparison = ++this.comparison;
    let listedCount = 0;
    let listedAmbientModuleFiles = 0;
    const end = this.listStarts[listIndex + 1];
    for (let k = this.listStarts[listIndex]; k < end; k++) {
      const id = listIds[k];
      if (id < 1 || id > count) return undefined;
      const index = id - 1;
      if (listed[index] !== comparison) {
        listed[index] = comparison;
        listedCount++;
        if (declaresAmbientModules[index] === 1 && index !== selfIndex) listedAmbientModuleFiles++;
      }
    }
    // Each file that declares ambient modules, other than `file`, is in the list.
    const ambientModuleFiles = this.ambientModuleFileCount - declaresAmbientModules[selfIndex];
    if (listedAmbientModuleFiles !== ambientModuleFiles) return false;
    // Each of the other references is in the list, and the list has no more paths.
    let otherReferences = 0;
    const ownReferences = new Set<string>();
    addOwnReferencedFiles(checked, file, ownReferences);
    for (const path of ownReferences) {
      const index = this.indexOfPath.get(path);
      if (index === undefined || listed[index] !== comparison) return false;
      if (declaresAmbientModules[index] === 0 || index === selfIndex) otherReferences++;
    }
    return listedCount === ambientModuleFiles + otherReferences;
  }

  /**
   * Whether a file of the list at `listIndex` of `lists` is not in `program` and is in `oldSnapshot`,
   * as for the references of a file that are the list's paths.
   */
  hasMissingFile(listIndex: number, lists: FileIdLists, program: Program, oldSnapshot: Snapshot): boolean {
    const filePaths = lists.filePaths;
    const missing = this.missing;
    const listIds = this.listIds;
    const end = this.listStarts[listIndex + 1];
    for (let k = this.listStarts[listIndex]; k < end; k++) {
      const index = listIds[k] - 1;
      let state = missing[index];
      if (state === 0) {
        const path = filePaths[index];
        state = program.getSourceFileByPath(path) === undefined && oldSnapshot.fileInfos.has(path) ? 1 : 2;
        missing[index] = state;
      }
      if (state === 1) return true;
    }
    return false;
  }
}

// ---- Reference threads

/**
 * What a reference thread reads (`compareReferencesOfThread`): the shared, published program, where its
 * ids continue (above `nodeIds` and `symbolIds`), the comparer's lists (`ReferenceListComparer`), the list
 * of each program file by file index (-1 for none), the shared counter of the chunks taken and the index
 * of the file the main thread is at, and where it writes the verdict of each file (`ReferenceVerdict`).
 */
export type ReferenceJob = {
  readonly program: Program;
  readonly index: number;
  readonly nodeIds: number;
  readonly symbolIds: number;
  readonly count: number;
  readonly listStarts: SharedArrayBuffer;
  readonly listIds: SharedArrayBuffer;
  readonly paths: PathIndexes;
  readonly declaresAmbientModules: SharedArrayBuffer;
  readonly ambientModuleFileCount: number;
  readonly lists: SharedArrayBuffer;
  readonly verdicts: SharedArrayBuffer;
  readonly counter: SharedArrayBuffer;
  readonly progress: SharedArrayBuffer;
};

/** `FileIdLists.indexOfPath`, published for reference threads (a published map alone is not sent). */
class PathIndexes {
  constructor(readonly indexOfPath: ReadonlyMap<string, number>) {}
}

/** Starts a reference thread with `job` (main.ts owns the worker entry point). */
export type ReferenceSpawn = (job: ReferenceJob) => void;

export class ReferenceThreads {
  /** Set where reference threads can be started: in scriptc builds, which share the program with threads. */
  spawn: ReferenceSpawn | undefined = undefined;
}

export const referenceThreads = new ReferenceThreads();

/** The result of `ReferenceListComparer.sameReferences` for a file, by file index. */
const enum ReferenceVerdict {
  NotCompared,
  Same,
  Different,
  Unknown,
}

/** The files a thread takes at a time. */
const referenceChunk = 32;

/**
 * The fewest files compared per reference thread, unless the number of checkers was given
 * (`--checkers`): starting a thread takes about as long as comparing that many files.
 */
const filesPerReferenceThread = 256;

/**
 * The lists of the files of a program (`FileIdLists.listOf`) and the verdicts of reference threads, by
 * file index, and the index of the file this thread is at.
 */
class ReferenceVerdicts {
  constructor(
    readonly lists: Int32Array,
    readonly verdicts: Int32Array,
    private readonly progress: Int32Array,
  ) {}

  /**
   * `ReferenceListComparer.sameReferences` of the file at `index` with the list at `listIndex`, as a
   * thread found it, or as `comparer` finds it if no thread has yet. Threads skip the files before
   * `index` from then on.
   */
  sameReferences(
    comparer: ReferenceListComparer,
    checked: CheckedProgram,
    file: SourceFile,
    index: number,
    listIndex: number,
  ): boolean | undefined {
    Atomics.store(this.progress, 0, index + 1);
    const verdict = Atomics.load(this.verdicts, index);
    if (verdict === ReferenceVerdict.Same) return true;
    if (verdict === ReferenceVerdict.Different) return false;
    if (verdict === ReferenceVerdict.Unknown) return undefined;
    return comparer.sameReferences(checked, file, listIndex);
  }

  /** Stops the threads once this thread has compared every file it needs to. */
  done(): void {
    Atomics.store(this.progress, 0, this.lists.length);
  }
}

/**
 * A reference thread: compares the references of the files of `job` with their lists with its own
 * checker, a chunk of files at a time from the last file back, and writes each verdict, until it reaches
 * the files the main thread compared (`ReferenceVerdicts.sameReferences`).
 */
export function compareReferencesOfThread(program: Program, job: ReferenceJob): void {
  const comparer = new ReferenceListComparer(
    job.count,
    new Int32Array(job.listStarts),
    new Int32Array(job.listIds),
    job.paths.indexOfPath,
    new Uint8Array(job.declaresAmbientModules),
    job.ambientModuleFileCount,
    false,
  );
  const checked = new CheckedProgram(program);
  const lists = new Int32Array(job.lists);
  const verdicts = new Int32Array(job.verdicts);
  const counter = new Int32Array(job.counter);
  const progress = new Int32Array(job.progress);
  const files = program.getSourceFiles();
  for (;;) {
    const end = files.length - Atomics.add(counter, 0, 1) * referenceChunk;
    if (end <= Atomics.load(progress, 0)) return;
    const start = Math.max(end - referenceChunk, 0);
    for (let i = start; i < end; i++) {
      const listIndex = lists[i];
      if (listIndex < 0) continue;
      const same = comparer.sameReferences(checked, files[i]!, listIndex);
      Atomics.store(
        verdicts,
        i,
        same === undefined ? ReferenceVerdict.Unknown : same ? ReferenceVerdict.Same : ReferenceVerdict.Different,
      );
    }
  }
}

/**
 * Where the program of `checked` is shared with threads (`CheckedProgram.referenceThreads`), starts
 * reference threads that compare the references of its files with their lists of file ids in
 * `oldSnapshot`, from the last file back, while this thread compares them from the first file
 * (`ReferenceVerdicts.sameReferences`) until it reaches those the threads compared. `undefined` where no
 * threads start: without them, or with too few files to compare (`filesPerReferenceThread`).
 */
function compareReferencesOnThreads(
  checked: CheckedProgram,
  comparer: ReferenceListComparer,
  lists: FileIdLists,
  oldSnapshot: Snapshot,
): ReferenceVerdicts | undefined {
  const spawn = referenceThreads.spawn;
  const available = checked.referenceThreads - 1;
  if (spawn === undefined || available < 1 || !checked.sharedWithCheckers || comparer.ambientModuleFileNotListed)
    return undefined;
  const program = checked.program;
  const files = program.getSourceFiles();
  const listsBuffer = new SharedArrayBuffer(4 * files.length);
  const listOfFiles = new Int32Array(listsBuffer);
  let compared = 0;
  for (let i = 0; i < files.length; i++) {
    const path = files[i]!.path;
    const listIndex = lists.listOf(path, oldSnapshot.referencedMap.references.get(path));
    listOfFiles[i] = listIndex;
    if (listIndex >= 0) compared++;
  }
  const threads = Math.min(
    available,
    program.options.checkers !== undefined
      ? Math.ceil(compared / referenceChunk)
      : Math.floor(compared / filesPerReferenceThread),
  );
  if (threads < 1) return undefined;
  const paths = publish(new PathIndexes(comparer.indexOfPath));
  const verdictsBuffer = new SharedArrayBuffer(4 * files.length);
  const counterBuffer = new SharedArrayBuffer(4);
  const progressBuffer = new SharedArrayBuffer(4);
  for (let index = 1; index <= threads; index++)
    spawn({
      program,
      index,
      nodeIds: lastNodeIdValue(),
      symbolIds: lastSymbolIdValue(),
      count: comparer.count,
      listStarts: comparer.listStarts.buffer as SharedArrayBuffer,
      listIds: comparer.listIds.buffer as SharedArrayBuffer,
      paths,
      declaresAmbientModules: comparer.declaresAmbientModules.buffer as SharedArrayBuffer,
      ambientModuleFileCount: comparer.ambientModuleFileCount,
      lists: listsBuffer,
      verdicts: verdictsBuffer,
      counter: counterBuffer,
      progress: progressBuffer,
    });
  return new ReferenceVerdicts(listOfFiles, new Int32Array(verdictsBuffer), new Int32Array(progressBuffer));
}

/** A hash of `ids`, for finding lists of file ids with the same ids. */
function hashOfIds(ids: readonly number[]): number {
  let hash = 0x811c9dc5 ^ ids.length;
  for (const id of ids) hash = Math.imul(hash ^ id, 0x01000193);
  return hash;
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameSet(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Whether `path` is `..` or a sequence of `../` up from a directory. */
function isParentDirectoryPath(path: string): boolean {
  for (let i = 0; i < path.length; i += 3) {
    if (!path.startsWith('..', i) || (i + 2 < path.length && path[i + 2] !== '/')) return false;
  }
  return true;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True, false or not computed yet. */
const enum Tristate {
  Unknown,
  False,
  True,
}

/** The state of an incremental program. */
export class Snapshot {
  readonly fileInfos = new Map<string, FileInfo>();
  options: CompilerOptions;
  readonly referencedMap = new ReferenceMap();
  /**
   * The lists of file ids of the build info read last, whose sets of paths the referenced map keeps
   * for files whose references did not change.
   */
  fileIdLists: FileIdLists | undefined = undefined;
  readonly semanticDiagnosticsPerFile = new Map<string, FileDiagnostics>();
  readonly emitDiagnosticsPerFile = new Map<string, FileDiagnostics>();
  changedFilesSet = new Set<string>();
  readonly affectedFilesPendingEmit = new Map<string, number>();
  latestChangedDtsFile = '';
  readonly emitSignatures = new Map<string, EmitSignature>();
  hasErrors = Tristate.Unknown;
  hasSemanticErrors = false;
  checkPending = false;
  packageJsons: string[] | undefined = undefined;
  missingPackageJsons: string[] = [];

  buildInfoEmitPending = false;
  hasErrorsFromOldState = Tristate.Unknown;
  hasSemanticErrorsFromOldState = false;
  packageJsonsFromOldState: string[] = [];
  missingPackageJsonsFromOldState: string[] = [];
  private allFilesExcludingDefaultLibraryFile: SourceFile[] | undefined = undefined;
  hasChangedDtsFile = false;
  hasEmitDiagnostics = false;
  /**
   * The version (`computeHash` of the text) of each source file of the program, by file: a watch
   * rebuild reuses the files that did not change, and takes their versions from here.
   */
  readonly versionsByFile = new Map<SourceFile, string>();

  constructor(options: CompilerOptions) {
    this.options = options;
  }

  addFileToChangeSet(path: string): void {
    this.changedFilesSet.add(path);
    this.buildInfoEmitPending = true;
  }

  addFileToAffectedFilesPendingEmit(path: string, emitKind: number): void {
    const existing = this.affectedFilesPendingEmit.get(path) ?? 0;
    this.affectedFilesPendingEmit.set(path, existing | emitKind);
    if ((emitKind & FileEmitKind.DtsErrors) !== 0) this.emitDiagnosticsPerFile.delete(path);
    this.buildInfoEmitPending = true;
  }

  getAllFilesExcludingDefaultLibraryFile(program: Program, firstSourceFile: SourceFile | undefined): SourceFile[] {
    let result = this.allFilesExcludingDefaultLibraryFile;
    if (result === undefined) {
      result = [];
      if (firstSourceFile !== undefined && !program.isSourceFileDefaultLibrary(firstSourceFile.path)) {
        result.push(firstSourceFile);
      }
      for (const file of program.getSourceFiles()) {
        if (file !== firstSourceFile && !program.isSourceFileDefaultLibrary(file.path)) result.push(file);
      }
      this.allFilesExcludingDefaultLibraryFile = result;
    }
    return result;
  }

  /** Without `incremental`, `tsc -b` only records whether there were errors. */
  canUseIncrementalState(): boolean {
    return isIncremental(this.options) || this.options.build !== true;
  }
}

/**
 * Gives each file of `paths` whose signature in `snapshot` is its version the signature of its text in
 * `last`, the program of the build that made `snapshot`, from its declaration file. A build without build
 * info (a watch without `incremental`) leaves versions as the signatures of the files it computed none for,
 * the first build's among them. A build on `snapshot` then compares a changed file's new signature with the
 * last one, as for files whose signatures were computed, and rechecks the importers only when the
 * declaration file changed. Files that forced declaration emit doesn't write keep their versions.
 */
export function computeLastSignatures(snapshot: Snapshot, last: CheckedProgram, paths: readonly string[]): void {
  if (isIncremental(snapshot.options)) return;
  const options = last.program.options;
  let emitter: ProgramEmitter | undefined = undefined;
  for (const path of paths) {
    const info = snapshot.fileInfos.get(path);
    if (info === undefined || info.signature !== info.version) continue;
    const file = last.program.getSourceFileByPath(path);
    if (file === undefined || file.isDeclarationFile || !sourceFileMayBeEmitted(file, options)) continue;
    emitter ??= new ProgramEmitter(last);
    const signature = declarationSignature(emitter, file, options);
    if (signature !== '') info.signature = signature;
  }
}

/**
 * The shape signature of `file` from its forced declaration emit (`updateShapeSignature`), or `''` where
 * nothing is written, for which the file's version is the signature.
 */
export function declarationSignature(emitter: ProgramEmitter, file: SourceFile, options: CompilerOptions): string {
  const emitted = emitter.forcedDeclaration(file);
  // A file without declarations, such as a script of statements, has an empty declaration file and a signature.
  if (!emitted.written) return '';
  return computeSignatureWithDiagnostics(file, emitted.text, emitted.diagnostics, options);
}

/** The signature of a declaration emit: its text up to the source map comment, and its errors. */
function computeSignatureWithDiagnostics(
  file: SourceFile,
  text: string,
  diagnostics: readonly Diagnostic[],
  options: CompilerOptions,
): string {
  let result = getTextHandlingSourceMapForSignature(text, options);
  for (const d of diagnostics) result += diagnosticToString(d, file);
  return computeHash(result);
}

function getTextHandlingSourceMapForSignature(text: string, options: CompilerOptions): string {
  if (options.declarationMap !== true) return text;
  const pos = text.lastIndexOf('//# sourceMappingURL=');
  return pos < 0 ? text : text.slice(0, pos);
}

function diagnosticToString(d: Diagnostic, file: SourceFile): string {
  let result = '\n';
  const diagnosticFile = d.file;
  if (diagnosticFile !== undefined && diagnosticFile !== file.diagnosticFile()) {
    result += ensurePathIsNonModuleName(
      getRelativePathFromDirectory(getDirectoryPath(file.path), diagnosticFile.fileName, true),
    );
  }
  if (diagnosticFile !== undefined) {
    // UTF-8 offsets, like tsgo's.
    const pos = diagnosticFile.toUtf8Offset(d.pos);
    result += `(${pos},${diagnosticFile.toUtf8Offset(d.end) - pos}): `;
  }
  result += categoryName(d.category) + String(d.code) + ': ' + messageKey(d.message) + '\n';
  for (const arg of d.args) result += arg + '\n';
  for (const chain of d.messageChain) result += diagnosticToString(chain, file);
  for (const related of d.relatedInformation) result += diagnosticToString(related, file);
  return result;
}

// ---- Option comparisons

function optionValuesEqual(a: CompilerOptionValue | undefined, b: CompilerOptionValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
}

function pathsEqual(a: CompilerOptions, b: CompilerOptions): boolean {
  const x = a.paths;
  const y = b.paths;
  if (x === undefined || y === undefined) return x === y;
  if (x.size !== y.size) return false;
  const keysX = [...x.keys()];
  const keysY = [...y.keys()];
  for (let i = 0; i < keysX.length; i++) {
    if (keysX[i] !== keysY[i]) return false;
    const valueX = x.get(keysX[i]);
    const valueY = y.get(keysY[i]);
    if (valueX === undefined || valueY === undefined) {
      if (valueX !== valueY) return false;
    } else if (!optionValuesEqual(valueX, valueY)) return false;
  }
  return true;
}

function optionsHaveChanges(oldOptions: CompilerOptions, newOptions: CompilerOptions, affects: Affects): boolean {
  if (oldOptions === newOptions) return false;
  for (const option of compilerOptionDeclarationsInFieldOrder()) {
    if (((option.affects ?? 0) & affects) === 0) continue;
    if (option.strictFlag === true) {
      const oldValue = compilerOptionValue(oldOptions, option.name);
      const newValue = compilerOptionValue(newOptions, option.name);
      if (
        getStrictOptionValue(oldOptions, typeof oldValue === 'boolean' ? oldValue : undefined) !==
        getStrictOptionValue(newOptions, typeof newValue === 'boolean' ? newValue : undefined)
      ) {
        return true;
      }
      continue;
    }
    if (option.allowJsFlag === true) {
      if (getAllowJS(oldOptions) !== getAllowJS(newOptions)) return true;
      continue;
    }
    if (option.name === 'paths') {
      if (!pathsEqual(oldOptions, newOptions)) return true;
      continue;
    }
    if (
      !optionValuesEqual(compilerOptionValue(oldOptions, option.name), compilerOptionValue(newOptions, option.name))
    ) {
      return true;
    }
  }
  return false;
}

export function compilerOptionsAffectSemanticDiagnostics(a: CompilerOptions, b: CompilerOptions): boolean {
  return optionsHaveChanges(a, b, Affects.SemanticDiagnostics);
}

export function compilerOptionsAffectDeclarationPath(a: CompilerOptions, b: CompilerOptions): boolean {
  return optionsHaveChanges(a, b, Affects.DeclarationPath);
}

export function compilerOptionsAffectEmit(a: CompilerOptions, b: CompilerOptions): boolean {
  return optionsHaveChanges(a, b, Affects.Emit);
}

// ---- Reading build info

/** Reads the build info of a project. */
export abstract class BuildInfoReader {
  abstract readBuildInfo(config: ParsedCommandLine): BuildInfo | undefined;
}

/** Reads build info files from a file system. */
export class FileBuildInfoReader extends BuildInfoReader {
  constructor(private readonly fs: FileSystem) {
    super();
  }

  readBuildInfo(config: ParsedCommandLine): BuildInfo | undefined {
    const fileName = config.buildInfoFileName();
    if (fileName === '') return undefined;
    const text = this.fs.readFile(fileName);
    return text === undefined ? undefined : parseBuildInfo(text);
  }
}

/** The state recorded by the previous build, if it can be used. */
export function readBuildInfoProgram(
  config: ParsedCommandLine,
  reader: BuildInfoReader,
  defaultLibraryPath: string,
  currentDirectory: string,
): Snapshot | undefined {
  const buildInfo = reader.readBuildInfo(config);
  if (buildInfo === undefined || !buildInfo.isValidVersion() || !buildInfo.isIncremental()) return undefined;
  return buildInfoToSnapshot(buildInfo, config, defaultLibraryPath, currentDirectory);
}

function storedDiagnostics(
  diagnostics: readonly BuildInfoDiagnostic[],
  filePaths: readonly string[],
): StoredDiagnostic[] {
  return diagnostics.map(
    (d) =>
      new StoredDiagnostic(
        d.file !== 0 && d.file <= filePaths.length ? filePaths[d.file - 1] : '',
        d,
        storedDiagnostics(d.messageChain, filePaths),
        storedDiagnostics(d.relatedInformation, filePaths),
      ),
  );
}

function buildInfoToSnapshot(
  buildInfo: BuildInfo,
  config: ParsedCommandLine,
  defaultLibraryPath: string,
  currentDirectory: string,
): Snapshot {
  const useCaseSensitiveFileNames = config.useCaseSensitiveFileNames;
  const buildInfoDirectory = getDirectoryPath(getNormalizedAbsolutePath(config.buildInfoFileName(), currentDirectory));
  const filePaths = buildInfo.fileNames.map((fileName) =>
    isBuildInfoFileNameDefaultLibrary(fileName)
      ? toPath(combinePaths(defaultLibraryPath, fileName), currentDirectory, useCaseSensitiveFileNames)
      : toPath(fileName, buildInfoDirectory, useCaseSensitiveFileNames),
  );
  const filePath = (fileId: number): string => (fileId >= 1 && fileId <= filePaths.length ? filePaths[fileId - 1] : '');
  const fileSets = buildInfo.fileIdsList.map((ids) => {
    const set = new Set<string>();
    for (const id of ids) set.add(filePath(id));
    return set;
  });
  const snapshot = new Snapshot(buildInfo.getCompilerOptions(buildInfoDirectory));

  const isComposite = snapshot.options.composite === true;
  for (let i = 0; i < buildInfo.fileInfos.length; i++) {
    const path = filePath(i + 1);
    const info = fileInfoFromBuildInfo(buildInfo.fileInfos[i]);
    snapshot.fileInfos.set(path, info);
    if (info.signature !== '' && isComposite)
      snapshot.emitSignatures.set(path, new EmitSignature(info.signature, undefined));
  }
  for (const value of buildInfo.emitSignatures) {
    const path = filePath(value.fileId);
    if (value.noEmitSignature()) snapshot.emitSignatures.delete(path);
    else if (value.differsOnlyInDtsMap) {
      const existing = snapshot.emitSignatures.get(path);
      snapshot.emitSignatures.set(path, new EmitSignature('', existing === undefined ? '' : existing.signature));
    } else if (value.differsInOptions) snapshot.emitSignatures.set(path, new EmitSignature('', value.signature));
    else snapshot.emitSignatures.set(path, new EmitSignature(value.signature, undefined));
  }
  const fileIdLists = new FileIdLists(
    filePaths,
    buildInfo.fileIdsList,
    fileSets,
    buildInfo.fileIdsListText.length === buildInfo.fileIdsList.length ? buildInfo.fileIdsListText : [],
  );
  for (const entry of buildInfo.referencedMap) {
    const set =
      entry.fileIdListId >= 1 && entry.fileIdListId <= fileSets.length ? fileSets[entry.fileIdListId - 1] : undefined;
    if (set !== undefined) {
      const path = filePath(entry.fileId);
      snapshot.referencedMap.references.set(path, set);
      fileIdLists.listOfFile.set(path, entry.fileIdListId - 1);
    }
  }
  snapshot.fileIdLists = fileIdLists;
  for (const fileId of buildInfo.changeFileSet) snapshot.changedFilesSet.add(filePath(fileId));
  for (const path of snapshot.fileInfos.keys()) {
    if (!snapshot.changedFilesSet.has(path)) snapshot.semanticDiagnosticsPerFile.set(path, FileDiagnostics.of([]));
  }
  for (const diagnostic of buildInfo.semanticDiagnosticsPerFile) {
    const ofFile = diagnostic.diagnostics;
    if (ofFile === undefined) snapshot.semanticDiagnosticsPerFile.delete(filePath(diagnostic.fileId));
    else {
      snapshot.semanticDiagnosticsPerFile.set(
        filePath(ofFile.fileId),
        new FileDiagnostics(undefined, storedDiagnostics(ofFile.diagnostics, filePaths)),
      );
    }
  }
  for (const ofFile of buildInfo.emitDiagnosticsPerFile) {
    snapshot.emitDiagnosticsPerFile.set(
      filePath(ofFile.fileId),
      new FileDiagnostics(undefined, storedDiagnostics(ofFile.diagnostics, filePaths)),
    );
  }
  if (buildInfo.affectedFilesPendingEmit.length > 0) {
    const ownOptionsEmitKind = getFileEmitKind(snapshot.options);
    for (const pending of buildInfo.affectedFilesPendingEmit) {
      snapshot.affectedFilesPendingEmit.set(
        filePath(pending.fileId),
        pending.emitKind === 0 ? ownOptionsEmitKind : pending.emitKind,
      );
    }
  }
  if (buildInfo.latestChangedDtsFile !== '') {
    snapshot.latestChangedDtsFile = getNormalizedAbsolutePath(buildInfo.latestChangedDtsFile, buildInfoDirectory);
  }
  snapshot.hasErrors = buildInfo.errors ? Tristate.True : Tristate.False;
  snapshot.hasSemanticErrors = buildInfo.semanticErrors;
  snapshot.checkPending = buildInfo.checkPending;
  snapshot.packageJsons = buildInfo.packageJsons.map((p) => getNormalizedAbsolutePath(p, buildInfoDirectory));
  snapshot.missingPackageJsons = buildInfo.missingPackageJsons.map((p) =>
    getNormalizedAbsolutePath(p, buildInfoDirectory),
  );
  return snapshot;
}

// ---- The new state from the program and the old state

function fileAffectsGlobalScope(file: SourceFile): boolean {
  for (const augmentation of file.moduleAugmentations) {
    const parent = augmentation.parent;
    if (parent !== undefined && isGlobalScopeAugmentation(parent)) return true;
  }
  if (isExternalOrCommonJSModule(file) || isJsonSourceFile(file)) return false;
  for (const statement of file.statements.nodes) {
    if (!isModuleWithStringLiteralName(statement)) return true;
  }
  return false;
}

function isModuleWithStringLiteralName(node: Node): boolean {
  return node.kind === SyntaxKind.ModuleDeclaration && isAmbientModule(node) && !isGlobalScopeAugmentation(node);
}

function addReferencedFilesFromSymbol(file: SourceFile, referenced: Set<string>, symbol: Symbol | undefined): void {
  if (symbol === undefined) return;
  for (const declaration of getDeclarations(symbol)) {
    const declarationFile = getSourceFileOfNode(declaration);
    if (declarationFile !== file) referenced.add(declarationFile.path);
  }
}

function addReferencedFileFromFileName(
  program: Program,
  fileName: string,
  referenced: Set<string>,
  sourceFileDirectory: string,
): void {
  const redirect = program.getParseFileRedirect(fileName);
  if (redirect !== '') referenced.add(toPath(redirect, program.currentDirectory, program.useCaseSensitiveFileNames));
  else referenced.add(toPath(fileName, sourceFileDirectory, program.useCaseSensitiveFileNames));
}

/**
 * The files `file` depends on: imports, references, type references, augmentations, and the files that
 * declare ambient modules (`getAmbientModuleFiles`).
 */
function getReferencedFiles(
  checked: CheckedProgram,
  file: SourceFile,
  ambientModuleFiles: readonly string[],
): Set<string> | undefined {
  const referenced = new Set<string>();
  addOwnReferencedFiles(checked, file, referenced);
  for (const path of ambientModuleFiles) if (path !== file.path) referenced.add(path);
  return referenced.size > 0 ? referenced : undefined;
}

/** Adds to `referenced` the files `file` depends on (`getReferencedFiles`) other than those that declare ambient modules. */
function addOwnReferencedFiles(checked: CheckedProgram, file: SourceFile, referenced: Set<string>): void {
  const program = checked.program;
  const checker = checked.checker;
  // Every import is resolved. tsgo takes the symbol at each import name, which is undefined for a JavaScript `require`
  // call that does not initialize a variable (`exports.a = require("./a").a`), so its build info leaves out that
  // module and its incremental builds keep outputs that depend on it.
  for (const importName of file.imports) {
    addReferencedFilesFromSymbol(
      file,
      referenced,
      resolveExternalModuleName(
        checker,
        importName,
        importName,
        true,
        getImportAttributesTypeForModuleSpecifier(checker, importName),
      ),
    );
  }
  const sourceFileDirectory = getDirectoryPath(file.fileName);
  for (const reference of file.referencedFiles) {
    addReferencedFileFromFileName(program, reference.fileName, referenced, sourceFileDirectory);
  }
  for (const resolved of program.getResolvedTypeReferenceDirectiveFiles(file.path)) {
    addReferencedFileFromFileName(program, resolved, referenced, sourceFileDirectory);
  }
  // The symbol of an augmentation's name is the symbol the augmentation is merged into (the module, or the
  // target of its `export =`), which has the declarations of every augmentation of the module.
  for (const moduleName of file.moduleAugmentations) {
    if (moduleName.kind !== SyntaxKind.StringLiteral) continue;
    addReferencedFilesFromSymbol(file, referenced, getSymbolAtLocation(checker, moduleName));
  }
}

/**
 * The files that declare the program's ambient modules (`declare module "x"`), as stored in the
 * checker's globals, in the order of their modules and declarations. When a module file augments an
 * ambient module declared in one file, the augmentation is merged into a copy of the symbol, so the
 * augmenting file is not among these declarations. Every file references all of them; listed once
 * here, the files are not found again from each declaration of every file's ambient modules.
 */
function getAmbientModuleFiles(checked: CheckedProgram): string[] {
  const result = new Set<string>();
  for (const [name, symbol] of checked.checker.globals) {
    if (name.length >= 2 && name.charCodeAt(0) === 0x22 && name.charCodeAt(name.length - 1) === 0x22) {
      for (const declaration of getDeclarations(symbol)) result.add(getSourceFileOfNode(declaration).path);
    }
  }
  return [...result];
}

function programToSnapshot(checked: CheckedProgram, oldSnapshot: Snapshot | undefined): Snapshot {
  const program = checked.program;
  const options = program.options;
  const snapshot = new Snapshot(options);
  snapshot.checkPending = options.noCheck === true;
  if (!snapshot.canUseIncrementalState()) return snapshot;

  // Reuse from the old state.
  if (oldSnapshot !== undefined) {
    if (options.composite === true) snapshot.latestChangedDtsFile = oldSnapshot.latestChangedDtsFile;
    snapshot.buildInfoEmitPending = oldSnapshot.buildInfoEmitPending;
    // Changes and pending emit of files no longer in the program are dropped, which changes the build info.
    for (const path of oldSnapshot.changedFilesSet) {
      if (program.getSourceFileByPath(path) !== undefined) snapshot.changedFilesSet.add(path);
      else snapshot.buildInfoEmitPending = true;
    }
    for (const [path, kind] of oldSnapshot.affectedFilesPendingEmit) {
      if (program.getSourceFileByPath(path) !== undefined) snapshot.affectedFilesPendingEmit.set(path, kind);
      else snapshot.buildInfoEmitPending = true;
    }
    snapshot.hasErrorsFromOldState = oldSnapshot.hasErrors;
    snapshot.hasSemanticErrorsFromOldState = oldSnapshot.hasSemanticErrors;
    const oldPackageJsons = oldSnapshot.packageJsons;
    if (oldPackageJsons !== undefined) snapshot.packageJsonsFromOldState = oldPackageJsons;
    snapshot.missingPackageJsonsFromOldState = oldSnapshot.missingPackageJsons;
    snapshot.fileIdLists = oldSnapshot.fileIdLists;
  } else {
    snapshot.buildInfoEmitPending = isIncremental(options);
  }

  // Changes of files.
  const canCopySemanticDiagnostics =
    oldSnapshot !== undefined && !compilerOptionsAffectSemanticDiagnostics(oldSnapshot.options, options);
  const canCopyEmitSignatures =
    options.composite === true &&
    oldSnapshot !== undefined &&
    !compilerOptionsAffectDeclarationPath(oldSnapshot.options, options);
  const copyDeclarationFileDiagnostics =
    canCopySemanticDiagnostics &&
    oldSnapshot !== undefined &&
    (options.skipLibCheck === true) === (oldSnapshot.options.skipLibCheck === true);
  const copyLibFileDiagnostics =
    copyDeclarationFileDiagnostics &&
    oldSnapshot !== undefined &&
    (options.skipDefaultLibCheck === true) === (oldSnapshot.options.skipDefaultLibCheck === true);

  const ambientModuleFiles = getAmbientModuleFiles(checked);
  const lists = oldSnapshot === undefined ? undefined : oldSnapshot.fileIdLists;
  const indexOfPath = lists === undefined ? undefined : lists.indexOfPath();
  const comparer =
    lists === undefined || indexOfPath === undefined
      ? undefined
      : ReferenceListComparer.of(lists, indexOfPath, ambientModuleFiles);
  const verdicts =
    comparer === undefined || lists === undefined || oldSnapshot === undefined
      ? undefined
      : compareReferencesOnThreads(checked, comparer, lists, oldSnapshot);
  // Whether a file of the old state is not in the program: if not, no list has one (`hasMissingFile`).
  let oldFileMissing = false;
  if (comparer !== undefined && oldSnapshot !== undefined) {
    for (const path of oldSnapshot.fileInfos.keys()) {
      if (program.getSourceFileByPath(path) === undefined) {
        oldFileMissing = true;
        break;
      }
    }
  }
  const files = program.getSourceFiles();
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]!;
    const path = file.path;
    const prepared = preparedVersion(file);
    const reused = prepared !== '' ? prepared : (oldSnapshot?.versionsByFile.get(file) ?? '');
    const version = reused !== '' ? reused : computeHash(file.text);
    snapshot.versionsByFile.set(file, version);
    const impliedNodeFormat: number = program.sourceFileMetadata(path).impliedNodeFormat;
    const affectsGlobalScope = fileAffectsGlobalScope(file);
    let signature = '';
    // An unchanged file whose old references are the set of its list of file ids in the build info read
    // is compared with the list, and keeps the set if its references are the list's paths.
    let listIndex = -1;
    let sameAsList: boolean | undefined = undefined;
    if (comparer !== undefined && oldSnapshot !== undefined) {
      const oldInfo = oldSnapshot.fileInfos.get(path);
      if (
        lists !== undefined &&
        oldInfo !== undefined &&
        oldInfo.version === version &&
        oldInfo.affectsGlobalScope === affectsGlobalScope &&
        oldInfo.impliedNodeFormat === impliedNodeFormat
      ) {
        if (verdicts !== undefined) {
          listIndex = verdicts.lists[fileIndex];
          if (listIndex >= 0) sameAsList = verdicts.sameReferences(comparer, checked, file, fileIndex, listIndex);
        } else {
          listIndex = lists.listOf(path, oldSnapshot.referencedMap.references.get(path));
          if (listIndex >= 0) sameAsList = comparer.sameReferences(checked, file, listIndex);
        }
      }
    }
    const newReferences = sameAsList === true ? undefined : getReferencedFiles(checked, file, ambientModuleFiles);
    if (newReferences !== undefined) snapshot.referencedMap.references.set(path, newReferences);
    if (oldSnapshot !== undefined) {
      const oldInfo = oldSnapshot.fileInfos.get(path);
      if (oldInfo !== undefined) {
        signature = oldInfo.signature;
        if (
          oldInfo.version !== version ||
          oldInfo.affectsGlobalScope !== affectsGlobalScope ||
          oldInfo.impliedNodeFormat !== impliedNodeFormat
        ) {
          snapshot.addFileToChangeSet(path);
        } else if (comparer !== undefined && sameAsList === true) {
          const oldReferences = oldSnapshot.referencedMap.references.get(path);
          if (oldReferences !== undefined) snapshot.referencedMap.references.set(path, oldReferences);
          if (oldFileMissing && comparer.hasMissingFile(listIndex, lists!, program, oldSnapshot))
            snapshot.addFileToChangeSet(path);
        } else {
          const oldReferences = oldSnapshot.referencedMap.references.get(path);
          if (sameAsList === false || !sameSet(newReferences, oldReferences)) snapshot.addFileToChangeSet(path);
          else if (newReferences !== undefined && oldReferences !== undefined) {
            // The old set, which can be of a list of file ids the build info writes again (`FileIdLists`).
            snapshot.referencedMap.references.set(path, oldReferences);
            for (const reference of newReferences) {
              if (program.getSourceFileByPath(reference) === undefined && oldSnapshot.fileInfos.has(reference)) {
                snapshot.addFileToChangeSet(path);
                break;
              }
            }
          }
        }
      } else snapshot.addFileToChangeSet(path);
      if (!snapshot.changedFilesSet.has(path)) {
        const emitDiagnostics = oldSnapshot.emitDiagnosticsPerFile.get(path);
        if (emitDiagnostics !== undefined) {
          snapshot.emitDiagnosticsPerFile.set(path, repopulateFileDiagnostics(emitDiagnostics, program, file));
        }
        if (
          canCopySemanticDiagnostics &&
          (!file.isDeclarationFile || copyDeclarationFileDiagnostics) &&
          (!program.isSourceFileDefaultLibrary(path) || copyLibFileDiagnostics)
        ) {
          const diagnostics = oldSnapshot.semanticDiagnosticsPerFile.get(path);
          if (diagnostics !== undefined) {
            snapshot.semanticDiagnosticsPerFile.set(path, repopulateFileDiagnostics(diagnostics, program, file));
          }
        }
      }
      if (canCopyEmitSignatures) {
        const oldEmitSignature = oldSnapshot.emitSignatures.get(path);
        if (oldEmitSignature !== undefined) {
          snapshot.emitSignatures.set(path, oldEmitSignature.getNewEmitSignature(oldSnapshot.options, options));
        }
      }
    } else {
      snapshot.addFileToAffectedFilesPendingEmit(path, getFileEmitKind(options));
      signature = version;
    }
    snapshot.fileInfos.set(path, new FileInfo(version, signature, affectsGlobalScope, impliedNodeFormat));
  }
  verdicts?.done();

  // Deleted files.
  let globalFileRemoved = false;
  if (oldSnapshot !== undefined) {
    for (const [path, oldInfo] of oldSnapshot.fileInfos) {
      if (snapshot.fileInfos.has(path)) continue;
      snapshot.buildInfoEmitPending = true;
      snapshot.changedFilesSet.delete(path);
      snapshot.affectedFilesPendingEmit.delete(path);
      if (oldInfo.affectsGlobalScope) globalFileRemoved = true;
    }
    if (globalFileRemoved) invalidateGlobalScope(checked, snapshot);
  }

  // A file that no longer affects the global scope changes it as its removal would.
  if (oldSnapshot !== undefined && !globalFileRemoved) {
    for (const [path, oldInfo] of oldSnapshot.fileInfos) {
      if (!oldInfo.affectsGlobalScope) continue;
      const info = snapshot.fileInfos.get(path);
      if (info !== undefined && !info.affectsGlobalScope) {
        invalidateGlobalScope(checked, snapshot);
        break;
      }
    }
  }

  // Pending emit from changed options.
  if (oldSnapshot !== undefined && !globalFileRemoved) {
    const pendingEmitKind = compilerOptionsAffectEmit(oldSnapshot.options, options)
      ? getFileEmitKind(options)
      : getPendingEmitKindWithOptions(options, oldSnapshot.options);
    if (pendingEmitKind !== FileEmitKind.None) {
      for (const file of program.getSourceFiles()) {
        if (!snapshot.changedFilesSet.has(file.path))
          snapshot.addFileToAffectedFilesPendingEmit(file.path, pendingEmitKind);
      }
      snapshot.buildInfoEmitPending = true;
    }
  }

  // Pending check.
  if (
    oldSnapshot !== undefined &&
    snapshot.semanticDiagnosticsPerFile.size !== program.getSourceFiles().length &&
    oldSnapshot.checkPending !== snapshot.checkPending
  ) {
    snapshot.buildInfoEmitPending = true;
  }
  return snapshot;
}

/**
 * After a change to the global scope, every file but the default libraries is changed, and the default
 * libraries that are checked are checked again.
 */
function invalidateGlobalScope(checked: CheckedProgram, snapshot: Snapshot): void {
  const program = checked.program;
  snapshot.buildInfoEmitPending = true;
  for (const file of program.getSourceFiles()) {
    if (!program.isSourceFileDefaultLibrary(file.path)) snapshot.addFileToChangeSet(file.path);
    else if (!checked.skipTypeChecking(file, true)) snapshot.semanticDiagnosticsPerFile.delete(file.path);
  }
}

// ---- Affected files

class AffectedFilesHandler {
  private hasAllFilesExcludingDefaultLibraryFile = false;
  private readonly updatedSignatures = new Map<string, string>();
  private readonly dtsMayChange: Map<string, number>[] = [];
  private readonly filesToRemoveDiagnostics = new Set<string>();
  private cleanedDiagnosticsOfLibFiles = false;
  private readonly seenFileAndReferences = new Map<string, boolean>();

  constructor(private readonly incremental: IncrementalProgram) {}

  private get snapshot(): Snapshot {
    return this.incremental.snapshot;
  }

  private get program(): Program {
    return this.incremental.program;
  }

  getDtsMayChange(affectedFilePath: string, emitKind: number): Map<string, number> {
    const result = new Map<string, number>();
    result.set(affectedFilePath, emitKind);
    this.dtsMayChange.push(result);
    return result;
  }

  private isChangedSignature(path: string): boolean {
    const newSignature = this.updatedSignatures.get(path);
    const oldInfo = this.snapshot.fileInfos.get(path);
    return newSignature !== (oldInfo === undefined ? undefined : oldInfo.signature);
  }

  private removeSemanticDiagnosticsOf(path: string): void {
    this.filesToRemoveDiagnostics.add(path);
  }

  private removeDiagnosticsOfLibraryFiles(): void {
    if (this.cleanedDiagnosticsOfLibFiles) return;
    this.cleanedDiagnosticsOfLibFiles = true;
    for (const file of this.program.getSourceFiles()) {
      if (this.program.isSourceFileDefaultLibrary(file.path) && !this.incremental.checked.skipTypeChecking(file)) {
        this.removeSemanticDiagnosticsOf(file.path);
      }
    }
  }

  private computeDtsSignature(file: SourceFile): string {
    const known = this.incremental.signatures.get(file.path);
    if (known !== undefined) return known;
    return declarationSignature(this.incremental.emitter, file, this.snapshot.options);
  }

  updateShapeSignature(file: SourceFile, useFileVersionAsSignature: boolean): boolean {
    if (this.updatedSignatures.has(file.path)) return false;
    const info = this.snapshot.fileInfos.get(file.path);
    if (info === undefined) return false;
    const previous = info.signature;
    let signature = '';
    // A JSON file has no declaration output, so its version is its signature, which invalidates its importers.
    if (!file.isDeclarationFile && !isJsonSourceFile(file) && !useFileVersionAsSignature) {
      signature = this.computeDtsSignature(file);
    }
    if (signature === '') signature = info.version;
    this.updatedSignatures.set(file.path, signature);
    return signature !== previous;
  }

  /**
   * Whether `file`, unchanged, has a signature no build computed. A program without build info (a watch
   * without `incremental`) takes each file's version as its signature in its first build. A signature
   * computed from the file's declaration file differs from the version, so an importer with such a
   * signature is not given one: it keeps its version, as without declaration emit, until a change of the
   * file itself computes its signature (`getFilesAffectedBy`). Files that forced declaration emit doesn't
   * write are excluded: their versions are their signatures.
   */
  private hasUncomputedSignature(file: SourceFile): boolean {
    const options = this.snapshot.options;
    if (isIncremental(options) || this.updatedSignatures.has(file.path)) return false;
    if (!sourceFileMayBeEmitted(file, options)) return false;
    if (this.program.isSourceFileFromExternalLibrary(file)) return false;
    const info = this.snapshot.fileInfos.get(file.path);
    return info !== undefined && info.signature === info.version;
  }

  getFilesAffectedBy(path: string): SourceFile[] {
    const file = this.program.getSourceFileByPath(path);
    if (file === undefined) return [];
    if (!this.updateShapeSignature(file, false)) return [file];
    const info = this.snapshot.fileInfos.get(file.path);
    if (info !== undefined && info.affectsGlobalScope) {
      this.hasAllFilesExcludingDefaultLibraryFile = true;
      return this.snapshot.getAllFilesExcludingDefaultLibraryFile(this.program, file);
    }
    if (this.snapshot.options.isolatedModules === true) return [file];
    const seen = this.forEachFileReferencedBy(file, (currentFile) => {
      if (currentFile === undefined) return 0;
      // As a file whose version is its signature: the changed file's importers are rechecked through
      // `handleDtsMayChangeOfAffectedFile`.
      if (this.hasUncomputedSignature(currentFile)) return 0;
      return this.updateShapeSignature(currentFile, false) ? 1 : 0;
    });
    const result: SourceFile[] = [];
    for (const value of seen.values()) if (value !== undefined) result.push(value);
    return result;
  }

  /** Walks the files referencing `file`; `visit` returns 1 to walk on from a file, 2 to stop. */
  private forEachFileReferencedBy(
    file: SourceFile,
    visit: (currentFile: SourceFile | undefined, currentPath: string) => number,
  ): Map<string, SourceFile | undefined> {
    const seen = new Map<string, SourceFile | undefined>();
    seen.set(file.path, file);
    const queue = this.snapshot.referencedMap.getReferencedBy(file.path);
    while (queue.length > 0) {
      const currentPath = queue.pop();
      if (currentPath === undefined) break;
      if (seen.has(currentPath)) continue;
      const currentFile = this.program.getSourceFileByPath(currentPath);
      seen.set(currentPath, currentFile);
      const result = visit(currentFile, currentPath);
      if (result === 2) return seen;
      if (result === 1 && currentFile !== undefined) {
        for (const reference of this.snapshot.referencedMap.getReferencedBy(currentFile.path)) queue.push(reference);
      }
    }
    return seen;
  }

  handleDtsMayChangeOfAffectedFile(dtsMayChange: Map<string, number>, affectedFile: SourceFile): void {
    this.removeSemanticDiagnosticsOf(affectedFile.path);
    if (this.hasAllFilesExcludingDefaultLibraryFile) {
      this.removeDiagnosticsOfLibraryFiles();
      if (!this.hasUncomputedSignature(affectedFile)) this.updateShapeSignature(affectedFile, false);
      return;
    }
    const options = this.snapshot.options;
    if (options.assumeChangesOnlyAffectDirectDependencies === true) return;
    if (!this.snapshot.changedFilesSet.has(affectedFile.path) || !this.isChangedSignature(affectedFile.path)) return;

    if (options.isolatedModules === true) {
      this.forEachFileReferencedBy(affectedFile, (_currentFile, currentPath) => {
        if (this.handleDtsMayChangeOfGlobalScope(dtsMayChange, currentPath, false)) return 2;
        this.handleDtsMayChangeOf(dtsMayChange, currentPath, false);
        return this.isChangedSignature(currentPath) ? 1 : 0;
      });
    }

    let invalidateJsFiles = false;
    const symbol = affectedFile.symbol;
    const exports = symbol === undefined ? undefined : symbol.exports;
    if (exports !== undefined) {
      const checker = this.incremental.checked.checker;
      for (const exported of exports.values()) {
        if ((exported.flags & SymbolFlags.ConstEnum) !== 0) {
          invalidateJsFiles = true;
          break;
        }
        if ((exported.flags & SymbolFlags.Alias) === 0) continue;
        const aliased = resolveAlias(checker, exported);
        if (aliased === exported) continue;
        if ((aliased.flags & SymbolFlags.ConstEnum) !== 0) {
          if (getDeclarations(aliased).some((d) => getSourceFileOfNode(d) === affectedFile)) {
            invalidateJsFiles = true;
            break;
          }
        }
      }
    }

    for (const fileReferencingChangedFile of this.snapshot.referencedMap.getReferencedBy(affectedFile.path)) {
      if (this.handleDtsMayChangeOfGlobalScope(dtsMayChange, fileReferencingChangedFile, invalidateJsFiles)) return;
      for (const fileReferencingAffectedFile of this.snapshot.referencedMap.getReferencedBy(
        fileReferencingChangedFile,
      )) {
        if (this.handleDtsMayChangeOfFileAndReferences(dtsMayChange, fileReferencingAffectedFile, invalidateJsFiles)) {
          return;
        }
      }
    }
  }

  private handleDtsMayChangeOfFileAndReferences(
    dtsMayChange: Map<string, number>,
    path: string,
    invalidateJsFiles: boolean,
  ): boolean {
    const existing = this.seenFileAndReferences.get(path);
    if (existing !== undefined && (existing || !invalidateJsFiles)) return false;
    this.seenFileAndReferences.set(path, invalidateJsFiles);
    if (this.handleDtsMayChangeOfGlobalScope(dtsMayChange, path, invalidateJsFiles)) return true;
    this.handleDtsMayChangeOf(dtsMayChange, path, invalidateJsFiles);
    for (const referencingFilePath of this.snapshot.referencedMap.getReferencedBy(path)) {
      if (this.handleDtsMayChangeOfFileAndReferences(dtsMayChange, referencingFilePath, invalidateJsFiles)) return true;
    }
    return false;
  }

  private handleDtsMayChangeOfGlobalScope(
    dtsMayChange: Map<string, number>,
    path: string,
    invalidateJsFiles: boolean,
  ): boolean {
    const info = this.snapshot.fileInfos.get(path);
    if (info === undefined || !info.affectsGlobalScope) return false;
    for (const file of this.snapshot.getAllFilesExcludingDefaultLibraryFile(this.program, undefined)) {
      this.handleDtsMayChangeOf(dtsMayChange, file.path, invalidateJsFiles);
    }
    this.removeDiagnosticsOfLibraryFiles();
    return true;
  }

  private handleDtsMayChangeOf(dtsMayChange: Map<string, number>, path: string, invalidateJsFiles: boolean): void {
    if (this.snapshot.changedFilesSet.has(path)) return;
    const file = this.program.getSourceFileByPath(path);
    if (file === undefined) return;
    this.removeSemanticDiagnosticsOf(path);
    this.updateShapeSignature(file, true);
    const options = this.snapshot.options;
    if (invalidateJsFiles) dtsMayChange.set(path, getFileEmitKind(options));
    else if (getEmitDeclarations(options)) {
      dtsMayChange.set(path, options.declarationMap === true ? FileEmitKind.AllDts : FileEmitKind.Dts);
    }
  }

  updateSnapshot(): void {
    const snapshot = this.snapshot;
    for (const [path, signature] of this.updatedSignatures) {
      const info = snapshot.fileInfos.get(path);
      if (info !== undefined) info.signature = signature;
    }
    for (const path of this.filesToRemoveDiagnostics) snapshot.semanticDiagnosticsPerFile.delete(path);
    for (const change of this.dtsMayChange) {
      for (const [path, emitKind] of change) snapshot.addFileToAffectedFilesPendingEmit(path, emitKind);
    }
    snapshot.changedFilesSet = new Set();
    snapshot.buildInfoEmitPending = true;
  }
}

function collectAllAffectedFiles(program: IncrementalProgram): void {
  const snapshot = program.snapshot;
  if (snapshot.changedFilesSet.size === 0) return;
  const handler = new AffectedFilesHandler(program);
  const affected = new Set<SourceFile>();
  for (const path of snapshot.changedFilesSet) {
    for (const file of handler.getFilesAffectedBy(path)) affected.add(file);
  }
  const emitKind = getFileEmitKind(snapshot.options);
  for (const file of affected) {
    handler.handleDtsMayChangeOfAffectedFile(handler.getDtsMayChange(file.path, emitKind), file);
  }
  handler.updateSnapshot();
}

// ---- Emit

/** Writes declaration files, recording their signatures and skipping unchanged ones of composite projects. */
class SignatureRecordingWriter extends OutputWriter {
  file: SourceFile | undefined = undefined;

  constructor(
    private readonly handler: EmitFilesHandler,
    private readonly writer: OutputWriter,
  ) {
    super();
  }

  write(fileName: string, text: string, declarationDiagnostics: readonly Diagnostic[]): string {
    const file = this.file;
    let differsOnlyInMap = false;
    if (
      file !== undefined &&
      isDeclarationFileName(fileName) &&
      this.handler.program.snapshot.canUseIncrementalState()
    ) {
      const snapshot = this.handler.program.snapshot;
      let emitSignature = '';
      const info = snapshot.fileInfos.get(file.path);
      if (info !== undefined && info.signature === info.version) {
        const signature = computeSignatureWithDiagnostics(file, text, declarationDiagnostics, snapshot.options);
        if (declarationDiagnostics.length === 0) emitSignature = signature;
        if (signature !== info.version) this.handler.signatures.set(file.path, signature);
      }
      const skip = this.handler.skipDtsOutputOfComposite(file, fileName, text, emitSignature);
      if (skip === 1) return skippedWrite;
      differsOnlyInMap = skip === 2;
    }
    const mtime = differsOnlyInMap ? this.handler.program.host.getMTime(fileName) : undefined;
    const error = this.writer.write(fileName, text, declarationDiagnostics);
    if (error === '' && mtime !== undefined) this.handler.program.host.setMTime(fileName, mtime);
    return error;
  }
}

/**
 * Writes the outputs a checker thread held for a file of a composite program as `SignatureRecordingWriter` writes
 * them here: `skips` holds `skipDtsOutputOfComposite`'s answer for each of its declaration files, which is left
 * unwritten when unchanged, and keeps its time stamp when only its map changed.
 */
class HeldDeclarationWriter extends OutputWriter {
  constructor(
    private readonly writer: OutputWriter,
    private readonly skips: ReadonlyMap<string, number>,
    private readonly host: TimeStampHost,
  ) {
    super();
  }

  write(fileName: string, text: string, declarationDiagnostics: readonly Diagnostic[]): string {
    const skip = this.skips.get(fileName) ?? 0;
    if (skip === 1) return skippedWrite;
    const mtime = skip === 2 ? this.host.getMTime(fileName) : undefined;
    const error = this.writer.write(fileName, text, declarationDiagnostics);
    if (error === '' && mtime !== undefined) this.host.setMTime(fileName, mtime);
    return error;
  }
}

/**
 * Writes outputs with `writer` and keeps, for each declaration file, its name, its signature and the
 * signature compared for composite projects, as `SignatureRecordingWriter` computes them: for checker
 * threads that emit the files of an incremental program, whose main thread records them
 * (`EmitFilesHandler.recordDeclarationSignatures`).
 */
export class DeclarationSignatureWriter extends OutputWriter {
  /** The file being emitted. */
  file: SourceFile | undefined = undefined;
  private signatures: string[] = [];

  constructor(
    private readonly writer: OutputWriter,
    private readonly options: CompilerOptions,
  ) {
    super();
  }

  write(fileName: string, text: string, declarationDiagnostics: readonly Diagnostic[]): string {
    const file = this.file;
    if (file !== undefined && isDeclarationFileName(fileName)) {
      const signature = computeSignatureWithDiagnostics(file, text, declarationDiagnostics, this.options);
      const compositeSignature =
        declarationDiagnostics.length === 0
          ? signature
          : computeHash(getTextHandlingSourceMapForSignature(text, this.options));
      this.signatures.push(fileName, signature, compositeSignature);
    }
    return this.writer.write(fileName, text, declarationDiagnostics);
  }

  /** The signatures kept since the last call. */
  take(): string[] {
    const signatures = this.signatures;
    this.signatures = [];
    return signatures;
  }
}

/** What emitting a file with the pending emit `pendingKind` (not 0) includes. */
function emitOnlyOfPendingKind(pendingKind: number): EmitOnly {
  const js = (pendingKind & FileEmitKind.AllJs) !== 0;
  const dts = (pendingKind & FileEmitKind.AllDts) !== 0;
  if (js && !dts) return EmitOnly.Js;
  if (dts && !js) return EmitOnly.Dts;
  return EmitOnly.All;
}

class EmitUpdate {
  constructor(
    readonly pendingKind: number,
    readonly result: EmitResult | undefined,
    readonly dtsErrorsFromCache: boolean,
  ) {}
}

class EmitFilesHandler {
  readonly signatures = new Map<string, string>();
  private readonly emitSignatures = new Map<string, EmitSignature>();
  private readonly latestChangedDtsFiles = new Map<string, string>();
  private readonly deletedPendingKinds = new Set<string>();
  private readonly emitUpdates = new Map<string, EmitUpdate>();
  hasEmitDiagnostics = false;

  constructor(
    readonly program: IncrementalProgram,
    private readonly isForDtsErrors: boolean,
  ) {}

  private updateHasEmitDiagnostics(result: EmitResult): void {
    if (result.diagnostics.length !== 0) this.hasEmitDiagnostics = true;
  }

  emitAllAffectedFiles(writer: OutputWriter): EmitResult {
    const program = this.program;
    const snapshot = program.snapshot;
    if (snapshot.canUseIncrementalState()) {
      const results = this.emitFilesIncremental(writer);
      for (const result of results) this.updateHasEmitDiagnostics(result);
      const result = combineEmitResults(results);
      if (!this.isForDtsErrors) this.emitBuildInfo(writer, result);
      return result;
    }
    if (!this.isForDtsErrors) {
      const files = program.program.getSourceFiles();
      const emittedOnCheckers = this.emittedOnCheckers();
      const wrapped = this.wrap(writer);
      const ahead = this.declarationsEmittedAhead();
      const result = program.checked.javaScriptEmittedOnThreads
        ? combineEmitResults(
            files.map((file) =>
              this.emitAfterEmitThreads(
                file,
                EmitOnly.All,
                emittedOnCheckers.get(file),
                ahead.get(file),
                writer,
                wrapped,
              ),
            ),
          )
        : emittedOnCheckers.size === 0
          ? program.emitter.emit(files, EmitOnly.All, wrapped)
          : combineEmitResults(
              files.map((file) => {
                const emitted = emittedOnCheckers.get(file);
                return emitted !== undefined
                  ? writeHeldOutputs(emitted, writer)
                  : program.emitter.emit([file], EmitOnly.All, wrapped);
              }),
            );
      this.updateHasEmitDiagnostics(result);
      this.updateSnapshot();
      this.emitBuildInfo(writer, result);
      return result;
    }
    const result = new EmitResult();
    result.emitSkipped = true;
    for (const d of program.emitDeclarationDiagnostics(program.program.getSourceFiles())) result.diagnostics.push(d);
    if (result.diagnostics.length !== 0) {
      this.updateHasEmitDiagnostics(result);
      snapshot.hasEmitDiagnostics = true;
    }
    return result;
  }

  private emitBuildInfo(writer: OutputWriter, result: EmitResult): void {
    const buildInfoResult = this.program.emitBuildInfo(writer);
    if (buildInfoResult !== undefined) {
      for (const d of buildInfoResult.diagnostics) result.diagnostics.push(d);
      for (const f of buildInfoResult.emittedFiles) result.emittedFiles.push(f);
    }
  }

  /**
   * The emit results of the files checker threads emitted right after checking them (parallel-check.ts),
   * which are not emitted again here. Checker threads emit every file of a program without old build
   * info, with the outputs its options select, as its pending emit asks. Emit threads emit only the
   * JavaScript of the files (`javaScriptEmittedOnThreads`, `emitAfterEmitThreads`).
   */
  private emittedOnCheckers(): Map<SourceFile, EmitResult> {
    return this.byFile(this.program.checked.emittedInParallel);
  }

  /** The declaration emit of the files the declaration thread emitted (parallel-emit.ts). */
  private declarationsEmittedAhead(): Map<SourceFile, EmitResult> {
    return this.byFile(this.program.checked.declarationsEmittedAhead);
  }

  /** The results of `results`, by file index, by file. */
  private byFile(results: readonly (EmitResult | undefined)[] | undefined): Map<SourceFile, EmitResult> {
    const result = new Map<SourceFile, EmitResult>();
    if (results === undefined) return result;
    const files = this.program.program.getSourceFiles();
    for (let i = 0; i < files.length; i++) {
      const fileResult = results[i];
      if (fileResult !== undefined) result.set(files[i]!, fileResult);
    }
    return result;
  }

  /**
   * The emit of `file` with `emitOnly` where emit threads emitted the JavaScript of the program's files
   * while this thread checked it (`javaScriptEmittedOnThreads`, parallel-emit.ts): the outputs an emit thread
   * emitted of its JavaScript (`javaScript`) and the declaration thread of its declarations (`declarations`),
   * and the rest emitted here. A file no thread emitted is emitted here as without the threads.
   */
  private emitAfterEmitThreads(
    file: SourceFile,
    emitOnly: EmitOnly,
    javaScript: EmitResult | undefined,
    declarations: EmitResult | undefined,
    writer: OutputWriter,
    wrapped: OutputWriter,
  ): EmitResult {
    const program = this.program;
    if (wrapped instanceof SignatureRecordingWriter) wrapped.file = file;
    if (javaScript === undefined && declarations === undefined) return program.emitter.emit([file], emitOnly, wrapped);
    const results: EmitResult[] = [];
    if (emitOnly !== EmitOnly.Dts)
      results.push(
        javaScript !== undefined
          ? this.writeThreadOutputs(file, javaScript, writer)
          : program.emitter.emit([file], EmitOnly.Js, writer),
      );
    if (emitOnly !== EmitOnly.Js && getEmitDeclarations(program.snapshot.options))
      results.push(
        declarations !== undefined
          ? this.writeThreadOutputs(file, declarations, writer)
          : program.emitter.emit([file], EmitOnly.Dts, wrapped),
      );
    return combineEmitResults(results);
  }

  /**
   * Writes the outputs a thread emitted for `file` with `writer`, as this thread would have written them:
   * its declaration signatures are recorded (`recordDeclarationSignatures`), and the unchanged declaration
   * files of a composite program are left unwritten.
   */
  private writeThreadOutputs(file: SourceFile, emitted: EmitResult, writer: OutputWriter): EmitResult {
    const skips = this.recordDeclarationSignatures(file, emitted.declarationSignatures);
    return writeHeldOutputs(
      emitted,
      skips === undefined ? writer : new HeldDeclarationWriter(writer, skips, this.program.host),
    );
  }

  /** Records declaration signatures when declarations are emitted. */
  private wrap(writer: OutputWriter): OutputWriter {
    return getEmitDeclarations(this.program.snapshot.options) ? new SignatureRecordingWriter(this, writer) : writer;
  }

  private emitFilesIncremental(writer: OutputWriter): EmitResult[] {
    const program = this.program;
    const snapshot = program.snapshot;
    collectAllAffectedFiles(program);
    const wrapped = this.wrap(writer);
    const emittedOnCheckers = this.emittedOnCheckers();
    const ahead = this.declarationsEmittedAhead();
    for (const [path, emitKind] of snapshot.affectedFilesPendingEmit) {
      const affectedFile = program.program.getSourceFileByPath(path);
      if (affectedFile === undefined || !program.program.sourceFileMayBeEmitted(affectedFile, false)) {
        this.deletedPendingKinds.add(path);
        continue;
      }
      let pendingKind = getPendingEmitKind(emitKind, 0);
      if (this.isForDtsErrors) pendingKind &= FileEmitKind.DtsErrors;
      if (pendingKind === 0) continue;
      let result: EmitResult;
      if (!this.isForDtsErrors) {
        const emitOnly = emitOnlyOfPendingKind(pendingKind);
        const emitted = emittedOnCheckers.get(affectedFile);
        if (program.checked.javaScriptEmittedOnThreads)
          result = this.emitAfterEmitThreads(affectedFile, emitOnly, emitted, ahead.get(affectedFile), writer, wrapped);
        else if (emitted !== undefined) result = this.writeThreadOutputs(affectedFile, emitted, writer);
        else {
          if (wrapped instanceof SignatureRecordingWriter) wrapped.file = affectedFile;
          result = program.emitter.emit([affectedFile], emitOnly, wrapped);
        }
      } else {
        result = new EmitResult();
        result.emitSkipped = true;
        for (const d of program.emitDeclarationDiagnostics([affectedFile])) result.diagnostics.push(d);
      }
      this.updateHasEmitDiagnostics(result);
      this.emitUpdates.set(path, new EmitUpdate(getPendingEmitKind(emitKind, pendingKind), result, false));
    }

    // Errors of files not emitted now, from the cache.
    for (const [path, diagnostics] of snapshot.emitDiagnosticsPerFile) {
      if (this.emitUpdates.has(path)) continue;
      const affectedFile = program.program.getSourceFileByPath(path);
      if (affectedFile === undefined || !program.program.sourceFileMayBeEmitted(affectedFile, false)) {
        this.deletedPendingKinds.add(path);
        continue;
      }
      const result = new EmitResult();
      result.emitSkipped = true;
      for (const d of diagnostics.getDiagnostics(program.program, affectedFile)) result.diagnostics.push(d);
      this.emitUpdates.set(path, new EmitUpdate(snapshot.affectedFilesPendingEmit.get(path) ?? 0, result, true));
    }
    return this.updateSnapshot();
  }

  /** 1 to skip writing an unchanged declaration file, 2 to keep its time stamp, 0 to write it. */
  skipDtsOutputOfComposite(file: SourceFile, outputFileName: string, text: string, newSignature: string): number {
    const snapshot = this.program.snapshot;
    if (snapshot.options.composite !== true) return 0;
    const signature =
      newSignature !== '' ? newSignature : computeHash(getTextHandlingSourceMapForSignature(text, snapshot.options));
    return this.skipDtsOutputWithSignature(file, outputFileName, signature);
  }

  /** `skipDtsOutputOfComposite` with the declaration file's signature computed. */
  private skipDtsOutputWithSignature(file: SourceFile, outputFileName: string, signature: string): number {
    const snapshot = this.program.snapshot;
    let oldSignature = '';
    const oldSignatureFormat = snapshot.emitSignatures.get(file.path);
    if (oldSignatureFormat !== undefined) {
      oldSignature =
        oldSignatureFormat.signature !== ''
          ? oldSignatureFormat.signature
          : (oldSignatureFormat.signatureWithDifferentOptions ?? '');
    }
    let result = 0;
    if (signature === oldSignature) {
      if (oldSignatureFormat !== undefined && oldSignatureFormat.signature === oldSignature) return 1;
      if (snapshot.options.build === true) result = 2;
    } else this.latestChangedDtsFiles.set(file.path, outputFileName);
    this.emitSignatures.set(file.path, new EmitSignature(signature, undefined));
    return result;
  }

  /**
   * Records the declaration files a checker thread emitted for `file` (`EmitResult.declarationSignatures`),
   * as `SignatureRecordingWriter` records the ones written here. For a composite program, returns what
   * `skipDtsOutputOfComposite` answers for each declaration file, by file name: on a rebuild the thread held
   * its outputs (parallel-check.ts) for `HeldDeclarationWriter` to write. A program without old build info
   * has no old emit signatures, so its threads wrote their outputs, none of which was to be skipped.
   */
  private recordDeclarationSignatures(
    file: SourceFile,
    signatures: readonly string[],
  ): Map<string, number> | undefined {
    const snapshot = this.program.snapshot;
    if (!snapshot.canUseIncrementalState()) return undefined;
    let skips: Map<string, number> | undefined = undefined;
    for (let i = 0; i + 2 < signatures.length; i += 3) {
      const info = snapshot.fileInfos.get(file.path);
      if (info !== undefined && info.signature === info.version) {
        const signature = signatures[i + 1]!;
        if (signature !== info.version) this.signatures.set(file.path, signature);
      }
      if (snapshot.options.composite === true) {
        if (skips === undefined) skips = new Map<string, number>();
        skips.set(signatures[i]!, this.skipDtsOutputWithSignature(file, signatures[i]!, signatures[i + 2]!));
      }
    }
    return skips;
  }

  private updateSnapshot(): EmitResult[] {
    const program = this.program;
    const snapshot = program.snapshot;
    const results: EmitResult[] = [];
    if (snapshot.canUseIncrementalState()) {
      for (const [path, signature] of this.signatures) {
        const info = snapshot.fileInfos.get(path);
        if (info !== undefined) info.signature = signature;
        snapshot.buildInfoEmitPending = true;
      }
      for (const [path, signature] of this.emitSignatures) {
        snapshot.emitSignatures.set(path, signature);
        snapshot.buildInfoEmitPending = true;
      }
      for (const path of this.deletedPendingKinds) {
        snapshot.affectedFilesPendingEmit.delete(path);
        snapshot.buildInfoEmitPending = true;
      }
      for (const file of program.program.getSourceFiles()) {
        const latest = this.latestChangedDtsFiles.get(file.path);
        if (latest !== undefined) {
          snapshot.latestChangedDtsFile = latest;
          snapshot.buildInfoEmitPending = true;
          snapshot.hasChangedDtsFile = true;
        }
        const update = this.emitUpdates.get(file.path);
        if (update === undefined) continue;
        if (!update.dtsErrorsFromCache) {
          if (update.pendingKind === 0) snapshot.affectedFilesPendingEmit.delete(file.path);
          else snapshot.affectedFilesPendingEmit.set(file.path, update.pendingKind);
          snapshot.buildInfoEmitPending = true;
        }
        const result = update.result;
        if (result !== undefined) {
          results.push(result);
          if (result.diagnostics.length !== 0) {
            snapshot.emitDiagnosticsPerFile.set(file.path, FileDiagnostics.of(result.diagnostics.slice()));
          }
        }
      }
    } else if (this.hasEmitDiagnostics) snapshot.hasEmitDiagnostics = true;
    return results;
  }
}

// ---- Writing build info

class ToBuildInfo {
  readonly buildInfo = new BuildInfo();
  private readonly buildInfoDirectory: string;
  private readonly fileNameToFileId = new Map<string, number>();
  /** The ids of the lists of file ids so far, by `hashOfIds` of their ids. */
  private readonly fileIdListIdsOfHash = new Map<number, number[]>();
  private readonly roots = new Map<SourceFile, string>();
  /** `relativePath` of the directories of the paths so far. */
  private readonly relativeDirectories = new Map<string, string>();
  /** The path of each file id so far. */
  private readonly fileIdPaths: string[] = [];
  /**
   * How many of the first file ids here are of the same paths as in the snapshot's `fileIdLists`, once
   * computed.
   */
  private sameFileIds = -1;
  /** The id here of each list of the snapshot's `fileIdLists` written so far. */
  private readonly listIdOfOldList = new Map<number, number>();

  constructor(
    private readonly snapshot: Snapshot,
    private readonly program: Program,
    buildInfoFileName: string,
  ) {
    this.buildInfoDirectory = getDirectoryPath(buildInfoFileName);
  }

  private relativeToBuildInfo(path: string): string {
    return ensurePathIsNonModuleName(this.relativePath(path));
  }

  /**
   * The path of `path` relative to the build info's directory: that of its directory and its name,
   * unless the directory is the build info's directory or one above it, where the name could be a
   * component of the build info's directory.
   */
  private relativePath(path: string): string {
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1);
    if (slash > getRootLength(path) && name !== '' && name !== '.' && name !== '..' && !path.includes('\\')) {
      const directory = path.slice(0, slash);
      let relative = this.relativeDirectories.get(directory);
      if (relative === undefined) {
        relative = this.relativePath(directory);
        this.relativeDirectories.set(directory, relative);
      }
      if (relative !== '' && !isParentDirectoryPath(relative)) return relative + '/' + name;
    }
    return getRelativePathFromDirectory(
      this.buildInfoDirectory,
      path,
      this.program.useCaseSensitiveFileNames,
      this.program.currentDirectory,
    );
  }

  /** The path tsgo orders a file by, where bundled libraries have `bundled:///libs/` paths. */
  private orderPath(path: string): string {
    const libFile = this.program.getDefaultLibFile(path);
    return libFile !== undefined && !libFile.replaced ? 'bundled:///libs/' + libFile.name : path;
  }

  /** Orders paths as tsgo does (`orderPath`). */
  private readonly comparePaths = (a: string, b: string): number =>
    compareStrings(this.orderPath(a), this.orderPath(b));

  private toFileId(path: string): number {
    let fileId = this.fileNameToFileId.get(path);
    if (fileId === undefined) {
      const libFile = this.program.getDefaultLibFile(path);
      if (libFile !== undefined && !libFile.replaced) this.buildInfo.fileNames.push(libFile.name);
      else this.buildInfo.fileNames.push(this.relativeToBuildInfo(path));
      this.fileIdPaths.push(path);
      fileId = this.buildInfo.fileNames.length;
      this.fileNameToFileId.set(path, fileId);
    }
    return fileId;
  }

  /** The id of the list of the ids of `set`, the references of the file at `path`. */
  private toFileIdListId(path: string, set: ReadonlySet<string>): number {
    // A set read from the old build info has the ids it was read from, where those are the same here.
    const lists = this.snapshot.fileIdLists;
    let oldIndex = lists?.listOfFile.get(path);
    if (oldIndex !== undefined && lists?.sets[oldIndex] !== set) oldIndex = undefined;
    // The index of the list taken as read, or -1.
    let readIndex = -1;
    if (lists !== undefined && oldIndex !== undefined) {
      const known = this.listIdOfOldList.get(oldIndex);
      if (known !== undefined) return known;
      if (this.hasSameFileIds(oldIndex, lists)) readIndex = oldIndex;
    }
    let fileIds: number[];
    let hash: number;
    if (lists !== undefined && readIndex >= 0) {
      fileIds = lists.ids[readIndex];
      hash = lists.hashes[readIndex];
    } else {
      fileIds = [];
      for (const reference of set) fileIds.push(this.toFileId(reference));
      fileIds.sort((a, b) => a - b);
      hash = hashOfIds(fileIds);
    }
    let listIds = this.fileIdListIdsOfHash.get(hash);
    if (listIds === undefined) {
      listIds = [];
      this.fileIdListIdsOfHash.set(hash, listIds);
    }
    let id = 0;
    for (const listId of listIds) {
      if (sameIds(this.buildInfo.fileIdsList[listId - 1], fileIds)) {
        id = listId;
        break;
      }
    }
    if (id === 0) {
      // A list taken as read has the text it was read from.
      const text =
        lists !== undefined && readIndex >= 0 && readIndex < lists.texts.length
          ? lists.texts[readIndex]
          : fileIds.join(',');
      this.buildInfo.fileIdsList.push(fileIds);
      this.buildInfo.fileIdsListText.push(text);
      id = this.buildInfo.fileIdsList.length;
      listIds.push(id);
    }
    if (readIndex >= 0) this.listIdOfOldList.set(readIndex, id);
    return id;
  }

  /**
   * Whether the list at `index` of `lists` has ascending ids that are of the same paths here, as the ids of
   * the program's files, which come first, are where the program has the same files in the same order.
   */
  private hasSameFileIds(index: number, lists: FileIdLists): boolean {
    if (this.sameFileIds < 0) {
      const paths = this.fileIdPaths;
      const oldPaths = lists.filePaths;
      const length = Math.min(paths.length, oldPaths.length);
      let same = 0;
      while (same < length && paths[same] === oldPaths[same]) same++;
      this.sameFileIds = same;
    }
    const last = lists.lastIds[index];
    return last >= 0 && last <= this.sameFileIds;
  }

  private toBuildInfoDiagnostics(filePath: string, diagnostics: readonly Diagnostic[]): BuildInfoDiagnostic[] {
    return diagnostics.map((d) => {
      const result = new BuildInfoDiagnostic();
      const file = d.file;
      if (file === undefined) result.noFile = true;
      else {
        const path = toPath(file.fileName, this.program.currentDirectory, this.program.useCaseSensitiveFileNames);
        if (path !== filePath) result.file = this.toFileId(path);
      }
      // Build info positions are UTF-8 offsets, like tsgo's.
      result.pos = file === undefined ? d.pos : file.toUtf8Offset(d.pos);
      result.end = file === undefined ? d.end : file.toUtf8Offset(d.end);
      result.code = d.code;
      result.category = d.category;
      result.messageKey = messageKey(d.message);
      result.messageArgs = d.args.slice();
      result.messageChain = this.toBuildInfoDiagnostics(filePath, d.messageChain);
      result.relatedInformation = this.toBuildInfoDiagnostics(filePath, d.relatedInformation);
      result.reportsUnnecessary = d.reportsUnnecessary;
      result.reportsDeprecated = d.reportsDeprecated;
      result.skippedOnNoEmit = d.skippedOnNoEmit;
      result.repopulateInfo = d.repopulateInfo;
      return result;
    });
  }

  private storedToBuildInfoDiagnostics(diagnostics: readonly StoredDiagnostic[]): BuildInfoDiagnostic[] {
    return diagnostics.map((d) => {
      const result = new BuildInfoDiagnostic();
      const stored = d.stored;
      result.file = d.file !== '' ? this.toFileId(d.file) : 0;
      result.noFile = stored.noFile;
      result.pos = stored.pos;
      result.end = stored.end;
      result.code = stored.code;
      result.category = stored.category;
      result.messageKey = stored.messageKey;
      result.messageArgs = stored.messageArgs;
      result.messageChain = this.storedToBuildInfoDiagnostics(d.messageChain);
      result.relatedInformation = this.storedToBuildInfoDiagnostics(d.relatedInformation);
      result.reportsUnnecessary = stored.reportsUnnecessary;
      result.reportsDeprecated = stored.reportsDeprecated;
      result.skippedOnNoEmit = stored.skippedOnNoEmit;
      result.repopulateInfo = stored.repopulateInfo;
      return result;
    });
  }

  private toDiagnosticsOfFile(path: string, diagnostics: FileDiagnostics): BuildInfoDiagnosticsOfFile | undefined {
    const computed = diagnostics.computed;
    if (computed !== undefined && computed.length > 0) {
      return new BuildInfoDiagnosticsOfFile(this.toFileId(path), this.toBuildInfoDiagnostics(path, computed));
    }
    const stored = diagnostics.stored;
    if (computed === undefined && stored !== undefined && stored.length > 0) {
      return new BuildInfoDiagnosticsOfFile(this.toFileId(path), this.storedToBuildInfoDiagnostics(stored));
    }
    return undefined;
  }

  build(): BuildInfo {
    const snapshot = this.snapshot;
    const buildInfo = this.buildInfo;
    const program = this.program;
    buildInfo.version = version;
    if (isIncremental(snapshot.options)) {
      this.collectRootFiles();
      this.setFileInfoAndEmitSignatures();
      this.setRootOfIncrementalProgram();
      this.setCompilerOptions();
      this.setReferencedMap();
      const changed = [...snapshot.changedFilesSet].sort(this.comparePaths);
      buildInfo.changeFileSet = changed.map((path) => this.toFileId(path));
      this.setSemanticDiagnostics();
      const emitDiagnostics = [...snapshot.emitDiagnosticsPerFile.keys()].sort(this.comparePaths);
      for (const path of emitDiagnostics) {
        const diagnostics = snapshot.emitDiagnosticsPerFile.get(path);
        if (diagnostics === undefined) continue;
        const ofFile = this.toDiagnosticsOfFile(path, diagnostics);
        if (ofFile !== undefined) buildInfo.emitDiagnosticsPerFile.push(ofFile);
      }
      this.setAffectedFilesPendingEmit();
      if (snapshot.latestChangedDtsFile !== '') {
        buildInfo.latestChangedDtsFile = this.relativeToBuildInfo(snapshot.latestChangedDtsFile);
      }
    } else {
      for (const fileName of program.commandLine.fileNames) {
        buildInfo.root.push(
          new BuildInfoRoot(
            0,
            0,
            this.relativeToBuildInfo(toPath(fileName, program.currentDirectory, program.useCaseSensitiveFileNames)),
          ),
        );
      }
    }
    buildInfo.errors = snapshot.hasErrors === Tristate.True;
    buildInfo.semanticErrors = snapshot.hasSemanticErrors;
    buildInfo.checkPending = snapshot.checkPending;
    const packageJsons = snapshot.packageJsons;
    if (packageJsons !== undefined) buildInfo.packageJsons = packageJsons.map((p) => this.relativeToBuildInfo(p));
    buildInfo.missingPackageJsons = snapshot.missingPackageJsons.map((p) => this.relativeToBuildInfo(p));
    return buildInfo;
  }

  private collectRootFiles(): void {
    const program = this.program;
    for (const fileName of program.commandLine.fileNames) {
      const path = program.toPath(fileName);
      const redirect = program.getParseFileRedirect(fileName);
      const file = redirect !== '' ? program.getSourceFile(redirect) : program.getSourceFileByPath(path);
      if (file !== undefined) this.roots.set(file, path);
    }
  }

  private setFileInfoAndEmitSignatures(): void {
    const snapshot = this.snapshot;
    const program = this.program;
    for (const file of program.getSourceFiles()) {
      const info = snapshot.fileInfos.get(file.path);
      const fileId = this.toFileId(file.path);
      if (info === undefined) continue;
      if (
        snapshot.options.composite === true &&
        !isJsonSourceFile(file) &&
        program.sourceFileMayBeEmitted(file, false)
      ) {
        const emitSignature = snapshot.emitSignatures.get(file.path);
        if (emitSignature === undefined) {
          this.buildInfo.emitSignatures.push(new BuildInfoEmitSignature(fileId, '', false, false));
        } else if (emitSignature.signature !== info.signature) {
          if (emitSignature.signature !== '') {
            this.buildInfo.emitSignatures.push(
              new BuildInfoEmitSignature(fileId, emitSignature.signature, false, false),
            );
          } else if (emitSignature.signatureWithDifferentOptions === info.signature) {
            this.buildInfo.emitSignatures.push(new BuildInfoEmitSignature(fileId, '', true, false));
          } else {
            this.buildInfo.emitSignatures.push(
              new BuildInfoEmitSignature(fileId, emitSignature.signatureWithDifferentOptions ?? '', false, true),
            );
          }
        }
      }
      this.buildInfo.fileInfos.push(toBuildInfoFileInfo(info));
    }
  }

  private setRootOfIncrementalProgram(): void {
    // The files in the order of their ids, each looked up once.
    const files = [...this.roots.keys()];
    const ids: number[] = [];
    const order: number[] = [];
    for (let i = 0; i < files.length; i++) {
      ids.push(this.toFileId(files[i].path));
      order.push(i);
    }
    order.sort((a, b) => ids[a] - ids[b]);
    const roots = this.buildInfo.root;
    for (const i of order) {
      const file = files[i];
      const rootPath = this.roots.get(file);
      if (rootPath === undefined) continue;
      const root = this.toFileId(rootPath);
      const resolved = ids[i];
      const last = roots.length > 0 ? roots[roots.length - 1] : undefined;
      if (last === undefined) roots.push(new BuildInfoRoot(resolved, 0, ''));
      else if (last.end === resolved - 1) last.end = resolved;
      else if (last.end === 0 && last.start === resolved - 1) last.end = resolved;
      else roots.push(new BuildInfoRoot(resolved, 0, ''));
      if (root !== resolved) this.buildInfo.resolvedRoot.push(new BuildInfoResolvedRoot(resolved, root));
    }
  }

  private setCompilerOptions(): void {
    const options = this.snapshot.options;
    let result: BuildInfoOption[] | undefined = undefined;
    for (const option of compilerOptionDeclarationsInFieldOrder()) {
      if (((option.affects ?? 0) & Affects.BuildInfo) === 0) continue;
      const value = compilerOptionValue(options, option.name);
      if (value === undefined || value === '' || value === 0) continue;
      if (result === undefined) result = [];
      result.push(new BuildInfoOption(option.name, this.relativeOptionValue(option, value)));
    }
    this.buildInfo.options = result;
  }

  private relativeOptionValue(option: OptionDeclaration, value: CompilerOptionValue): CompilerOptionValue {
    if (option.kind === 'list') {
      if (option.element?.isFilePath === true && Array.isArray(value)) {
        return value.map((v) => this.relativeToBuildInfo(v));
      }
    } else if (option.isFilePath === true && typeof value === 'string' && value !== '') {
      return this.relativeToBuildInfo(value);
    }
    return value;
  }

  private setReferencedMap(): void {
    const references = this.snapshot.referencedMap.references;
    const keys = [...references.keys()].sort(this.comparePaths);
    for (const path of keys) {
      const set = references.get(path);
      if (set === undefined) continue;
      this.buildInfo.referencedMap.push(new BuildInfoReference(this.toFileId(path), this.toFileIdListId(path, set)));
    }
  }

  private setSemanticDiagnostics(): void {
    const snapshot = this.snapshot;
    for (const file of this.program.getSourceFiles()) {
      const value = snapshot.semanticDiagnosticsPerFile.get(file.path);
      if (value === undefined) {
        if (!snapshot.changedFilesSet.has(file.path)) {
          this.buildInfo.semanticDiagnosticsPerFile.push(
            new BuildInfoSemanticDiagnostic(this.toFileId(file.path), undefined),
          );
        }
      } else {
        const diagnostics = this.toDiagnosticsOfFile(file.path, value);
        if (diagnostics !== undefined) {
          this.buildInfo.semanticDiagnosticsPerFile.push(new BuildInfoSemanticDiagnostic(0, diagnostics));
        }
      }
    }
  }

  private setAffectedFilesPendingEmit(): void {
    const snapshot = this.snapshot;
    const files = [...snapshot.affectedFilesPendingEmit.keys()].sort(this.comparePaths);
    const fullEmitKind = getFileEmitKind(snapshot.options);
    for (const path of files) {
      const file = this.program.getSourceFileByPath(path);
      if (file === undefined || !this.program.sourceFileMayBeEmitted(file, false)) continue;
      const pending = snapshot.affectedFilesPendingEmit.get(path) ?? 0;
      this.buildInfo.affectedFilesPendingEmit.push(
        new BuildInfoFilePendingEmit(this.toFileId(path), pending === fullEmitKind ? 0 : pending),
      );
    }
  }
}

// ---- The incremental program

/** File time stamps, for `--build`'s up-to-date checks. */
export abstract class TimeStampHost {
  /** Modification time in milliseconds, or `undefined` if the file doesn't exist. */
  abstract getMTime(fileName: string): number | undefined;
  abstract setMTime(fileName: string, time: number): void;
}

export class IncrementalProgram extends CompilerProgram {
  readonly snapshot: Snapshot;

  /**
   * `signatures`: the shape signatures (`declarationSignature`) of files of this program that were
   * computed before it, by path, which the affected files take instead of emitting the files again.
   */
  constructor(
    checked: CheckedProgram,
    times: CompileTimes,
    oldSnapshot: Snapshot | undefined,
    readonly host: TimeStampHost,
    readonly signatures: ReadonlyMap<string, string> = new Map(),
  ) {
    super(checked, times);
    this.snapshot = programToSnapshot(checked, oldSnapshot);
  }

  get hasChangedDtsFile(): boolean {
    return this.snapshot.hasChangedDtsFile;
  }

  /**
   * The global diagnostics found before `filesToCheck` computed the affected files, which the program
   * reports before its semantic diagnostics (`getGlobalDiagnostics(false)`), as when they are computed
   * while checking.
   */
  private globalDiagnosticsBeforeChecking: Diagnostic[] | undefined = undefined;

  getGlobalDiagnostics(withCheckerThreads = true): Diagnostic[] {
    const before = this.globalDiagnosticsBeforeChecking;
    if (!withCheckerThreads && before !== undefined) return before;
    return super.getGlobalDiagnostics(withCheckerThreads);
  }

  /**
   * The files `getSemanticDiagnostics` checks: once the affected files are known
   * (`collectAllAffectedFiles`), those the build info has no semantic diagnostics for. Called before
   * reporting, so that checker threads can check them (tsc-compile.ts).
   */
  filesToCheck(): SourceFile[] {
    const snapshot = this.snapshot;
    if (snapshot.options.noCheck === true) return [];
    this.globalDiagnosticsBeforeChecking = super.getGlobalDiagnostics(false);
    if (snapshot.canUseIncrementalState()) collectAllAffectedFiles(this);
    const result: SourceFile[] = [];
    for (const file of this.program.getSourceFiles())
      if (!snapshot.semanticDiagnosticsPerFile.has(file.path) && !this.checked.skipTypeChecking(file))
        result.push(file);
    return result;
  }

  /**
   * The files checker threads take in a rebuild: those `filesToCheck` returns, then the files whose
   * semantic diagnostics the build info holds but whose outputs are pending (after a change of the
   * options that select outputs, or where an earlier build did not write them). Emitting a file asks
   * the checker about it, so threads that check and emit it spare this thread that work; the
   * diagnostics reported for it are still those of the build info. Where no file needs checking
   * (`checksOnCheckers` false), the threads only emit, and emit checks what it needs.
   */
  filesForCheckers(): SourceFile[] {
    const result = this.filesToCheck();
    this.checksOnCheckers = result.length > 0;
    const snapshot = this.snapshot;
    if (snapshot.options.noEmit === true || snapshot.affectedFilesPendingEmit.size === 0) return result;
    const program = this.program;
    const taken = new Set(result);
    for (const [path, emitKind] of snapshot.affectedFilesPendingEmit) {
      if (getPendingEmitKind(emitKind, 0) === 0) continue;
      const file = program.getSourceFileByPath(path);
      if (
        file === undefined ||
        taken.has(file) ||
        this.checked.skipTypeChecking(file) ||
        !program.sourceFileMayBeEmitted(file, false)
      )
        continue;
      taken.add(file);
      result.push(file);
    }
    return result;
  }

  /** Whether the files `filesForCheckers` returned last include files to check, not only files to emit. */
  checksOnCheckers = true;

  /**
   * For checker threads that check `files` (from `filesForCheckers`) and emit them, what the emit of each
   * file includes, by file index: its pending emit (`EmitFilesHandler.emitFilesIncremental`), or -1.
   * The incremental program's emit then takes what the threads emitted.
   */
  emitKindsOnCheckers(files: readonly SourceFile[]): number[] {
    const program = this.program;
    const all = program.getSourceFiles();
    const index = new Map<SourceFile, number>();
    for (let i = 0; i < all.length; i++) index.set(all[i]!, i);
    const result: number[] = [];
    for (let i = 0; i < all.length; i++) result.push(-1);
    const checking = new Set(files);
    for (const [path, emitKind] of this.snapshot.affectedFilesPendingEmit) {
      const file = program.getSourceFileByPath(path);
      if (file === undefined || !checking.has(file) || !program.sourceFileMayBeEmitted(file, false)) continue;
      const pendingKind = getPendingEmitKind(emitKind, 0);
      if (pendingKind !== 0) result[index.get(file)!] = emitOnlyOfPendingKind(pendingKind);
    }
    return result;
  }

  getSemanticDiagnostics(): Diagnostic[] {
    const options = this.snapshot.options;
    if (options.noCheck === true) return [];
    this.collectSemanticDiagnosticsOfAffectedFiles();
    const result: Diagnostic[] = [];
    for (const file of this.program.getSourceFiles()) {
      for (const d of this.getSemanticDiagnosticsOfFile(file)) result.push(d);
    }
    return result;
  }

  private getSemanticDiagnosticsOfFile(file: SourceFile): Diagnostic[] {
    const cached = this.snapshot.semanticDiagnosticsPerFile.get(file.path);
    const result: Diagnostic[] = [];
    if (cached !== undefined) {
      const noEmit = this.snapshot.options.noEmit === true;
      for (const d of cached.getDiagnostics(this.program, file)) if (!noEmit || !d.skippedOnNoEmit) result.push(d);
    }
    for (const d of this.checked.getIncludeProcessorDiagnostics(file)) result.push(d);
    return result;
  }

  getDeclarationDiagnostics(): Diagnostic[] {
    return new EmitFilesHandler(this, true).emitAllAffectedFiles(new DiscardWriter()).diagnostics;
  }

  /**
   * Declaration emit errors of `files`, without writing. Declaration emit is per file: those checker
   * threads computed under `noEmit` (`declarationsInParallel`), the others here, in order.
   */
  emitDeclarationDiagnostics(files: readonly SourceFile[]): Diagnostic[] {
    const checked = this.checked;
    if (checked.declarationsInParallel === undefined)
      return this.emitter.emit(files, EmitOnly.ForcedDts, new DiscardWriter()).diagnostics;
    const result: Diagnostic[] = [];
    for (const file of files) {
      const diagnostics =
        checked.declarationDiagnosticsInParallel(file) ?? declarationDiagnosticsOfFile(this.emitter, file);
      for (const d of diagnostics) result.push(d);
    }
    return result;
  }

  emit(writer: OutputWriter): EmitResult {
    const options = this.snapshot.options;
    let result: EmitResult | undefined;
    // A `noEmit` program emits only its build info, and its emit is not skipped (tsgo's `HandleNoEmitOptions`).
    if (options.noEmit === true) result = new EmitResult();
    else result = handleNoEmitOnError(this);
    if (result !== undefined) {
      const buildInfoResult = this.emitBuildInfo(writer);
      if (buildInfoResult !== undefined) {
        for (const d of buildInfoResult.diagnostics) result.diagnostics.push(d);
        for (const f of buildInfoResult.emittedFiles) result.emittedFiles.push(f);
      }
      return result;
    }
    return new EmitFilesHandler(this, false).emitAllAffectedFiles(writer);
  }

  private collectSemanticDiagnosticsOfAffectedFiles(): void {
    const snapshot = this.snapshot;
    const files = this.program.getSourceFiles();
    if (snapshot.canUseIncrementalState()) {
      collectAllAffectedFiles(this);
      if (snapshot.semanticDiagnosticsPerFile.size === files.length) return;
    }
    for (const file of files) {
      if (snapshot.semanticDiagnosticsPerFile.has(file.path)) continue;
      snapshot.semanticDiagnosticsPerFile.set(
        file.path,
        FileDiagnostics.of(this.checked.getSemanticDiagnosticsWithoutNoEmitFiltering(file)),
      );
    }
    if (
      snapshot.semanticDiagnosticsPerFile.size === files.length &&
      snapshot.checkPending &&
      snapshot.options.noCheck !== true
    ) {
      snapshot.checkPending = false;
    }
    snapshot.buildInfoEmitPending = true;
  }

  /** Writes the build info if it changed; `undefined` if nothing was written. */
  emitBuildInfo(writer: OutputWriter): EmitResult | undefined {
    const snapshot = this.snapshot;
    const program = this.program;
    const buildInfoFileName = program.commandLine.buildInfoFileName();
    if (buildInfoFileName === '' || program.isEmitBlocked(buildInfoFileName)) return undefined;
    if (snapshot.hasErrors === Tristate.Unknown) {
      this.ensureHasErrorsForState();
      if (
        snapshot.hasErrors !== snapshot.hasErrorsFromOldState ||
        snapshot.hasSemanticErrors !== snapshot.hasSemanticErrorsFromOldState
      ) {
        snapshot.buildInfoEmitPending = true;
      }
    }
    if (snapshot.packageJsons === undefined) {
      this.ensurePackageJsonsForState();
      if (
        !sameList(snapshot.packageJsons ?? noStrings, snapshot.packageJsonsFromOldState) ||
        !sameList(snapshot.missingPackageJsons, snapshot.missingPackageJsonsFromOldState)
      ) {
        snapshot.buildInfoEmitPending = true;
      }
    }
    if (!snapshot.buildInfoEmitPending) return undefined;
    const absolute = getNormalizedAbsolutePath(buildInfoFileName, program.currentDirectory);
    const buildInfo = new ToBuildInfo(snapshot, program, absolute).build();
    const text = buildInfoToJson(buildInfo);
    const error = writer.write(buildInfoFileName, text, []);
    const result = new EmitResult();
    if (error !== '' && error !== skippedWrite) {
      result.emitSkipped = true;
      result.diagnostics.push(
        createCompilerDiagnostic(Diagnostics.Could_not_write_file_0_Colon_1, buildInfoFileName, error),
      );
      return result;
    }
    this.lastBuildInfo = buildInfo;
    snapshot.buildInfoEmitPending = false;
    result.emittedFiles.push(buildInfoFileName);
    return result;
  }

  /** The build info written last, for `--build`. */
  lastBuildInfo: BuildInfo | undefined = undefined;

  private ensureHasErrorsForState(): void {
    const snapshot = this.snapshot;
    const program = this.program;
    const checked = this.checked;
    const files = program.getSourceFiles();
    let hasEmitDiagnostics = false;
    // Without the files whose checking is skipped, and filtered by comment directives, as when reported.
    let hasIncludeProcessingDiagnostics = false;
    if (snapshot.canUseIncrementalState()) {
      for (const file of files) {
        if (snapshot.emitDiagnosticsPerFile.has(file.path)) {
          hasEmitDiagnostics = true;
          break;
        }
        if (!hasIncludeProcessingDiagnostics && checked.getIncludeProcessorDiagnostics(file).length > 0) {
          hasIncludeProcessingDiagnostics = true;
        }
      }
    } else {
      hasEmitDiagnostics = snapshot.hasEmitDiagnostics;
      hasIncludeProcessingDiagnostics = files.some((file) => checked.getIncludeProcessorDiagnostics(file).length > 0);
    }
    if (hasEmitDiagnostics) {
      snapshot.hasErrors = isIncremental(snapshot.options) ? Tristate.False : Tristate.True;
      snapshot.hasSemanticErrors = false;
      return;
    }
    if (
      hasIncludeProcessingDiagnostics ||
      program.getConfigFileParsingDiagnostics().length > 0 ||
      program.getSyntacticDiagnostics().length > 0 ||
      program.getProgramDiagnostics().length > 0 ||
      this.checked.getGlobalDiagnostics().length > 0
    ) {
      snapshot.hasErrors = Tristate.True;
      snapshot.hasSemanticErrors = false;
      return;
    }
    snapshot.hasErrors = Tristate.False;
    const incremental = isIncremental(snapshot.options);
    for (const file of files) {
      const diagnostics = snapshot.semanticDiagnosticsPerFile.get(file.path);
      if (diagnostics === undefined ? incremental : !diagnostics.isEmpty()) {
        snapshot.hasSemanticErrors = !incremental;
        break;
      }
    }
  }

  private ensurePackageJsonsForState(): void {
    const snapshot = this.snapshot;
    const program = this.program;
    const packageJsons: string[] = [];
    const missing: string[] = [];
    if (program.commandLine.configName !== '') {
      for (const info of program.packageJsonLookups()) {
        let packageJson = combinePaths(info.packageDirectory, 'package.json');
        const exists = info.exists;
        if (exists || info.directoryExists) packageJson = program.host.fs.realpath(packageJson);
        if (exists) packageJsons.push(packageJson);
        else if (packageJson.includes('/node_modules/')) missing.push(packageJson);
      }
    }
    snapshot.packageJsons = normalizePackageJsons(packageJsons);
    snapshot.missingPackageJsons = normalizePackageJsons(missing);
  }

  /** The `package.json` files module resolution looked up, for watching. */
  packageJsonLookupPaths(): string[] {
    const program = this.program;
    if (program.commandLine.configName === '') return [];
    const result: string[] = [];
    for (const info of program.packageJsonLookups()) {
      let packageJson = combinePaths(info.packageDirectory, 'package.json');
      if (info.exists || info.directoryExists) packageJson = program.host.fs.realpath(packageJson);
      result.push(packageJson);
    }
    return normalizePackageJsons(result);
  }
}

class DiscardWriter extends OutputWriter {
  write(_fileName: string, _text: string, _declarationDiagnostics: readonly Diagnostic[]): string {
    return skippedWrite;
  }
}

const noStrings: string[] = [];

function normalizePackageJsons(packageJsons: string[]): string[] {
  packageJsons.sort(compareStrings);
  const result: string[] = [];
  for (const p of packageJsons) if (result.length === 0 || result[result.length - 1] !== p) result.push(p);
  return result;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
