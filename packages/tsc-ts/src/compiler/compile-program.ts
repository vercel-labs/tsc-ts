/**
 * What `tsc` compiles: a checked program, plain or incremental, with the diagnostics it reports and
 * the emit it does, like tsgo's `ProgramLike`.
 */
import type { Node, SourceFile } from './ast.js';
import type { Diagnostic } from './diagnostics.js';
import { EmitHost, EmitOnly, EmitResult, emitFiles, skippedWrite, sourceFileMayBeEmitted } from './emitter.js';
import { Resolver } from './module-resolution.js';
import { getEmitDeclarations, type CompilerOptions, type ModuleKind } from './options.js';
import type { Program } from './program.js';
import { CheckedProgram } from './program-checker.js';
import { CheckerDeclarationEmitResolver, CheckerEmitResolver } from './checker-emit-resolver.js';
import { getEmitModuleFormatOfFile } from './program-utilities.js';
import { DeclarationGlobals, SyntacticDeclarationEmitResolver } from './transformers/declarations-syntactic.js';
import { mark } from './timeline.js';
import { DecoratorMetadata } from './transformers/decorator-metadata.js';
import { SyntaxFacts } from './transformers/syntax-facts.js';
import type { TypeReferenceSerializationKind } from './transformers/type-serialization.js';
import { EmitContext } from './printer/emit-context.js';
import { type EmitResolver, SyntacticEmitResolver } from './transformers/emit-resolver.js';
import { ModuleFormatHost } from './transformers/module.js';
import { type MergedGlobals, ModuleLookup, ReferenceResolver } from './transformers/reference-resolver.js';

/** Where emit writes files. */
export abstract class OutputWriter {
  /**
   * Writes `text` to `fileName`; returns an error message, `''`, or `skippedWrite` for a file left
   * alone. `declarationDiagnostics` are the errors of a forced declaration emit.
   */
  abstract write(fileName: string, text: string, declarationDiagnostics: readonly Diagnostic[]): string;
}

/** Keeps the outputs written to it, as file name and text alternately, instead of writing them. */
export class HoldingWriter extends OutputWriter {
  private outputs: string[] = [];

  write(fileName: string, text: string, _declarationDiagnostics: readonly Diagnostic[]): string {
    this.outputs.push(fileName, text);
    return '';
  }

  /** The outputs kept since the last call. */
  take(): string[] {
    const outputs = this.outputs;
    this.outputs = [];
    return outputs;
  }
}

/**
 * Writes the outputs a checker thread held (`EmitResult.heldOutputs`) with `writer`; returns the emit
 * result as if the thread had written them: an output that fails to be written is an error instead of
 * an emitted file, and one the writer leaves unwritten (`skippedWrite`) isn't an emitted file.
 */
export function writeHeldOutputs(result: EmitResult, writer: OutputWriter): EmitResult {
  const held = result.heldOutputs;
  let failed: Map<string, string> | undefined = undefined;
  let skipped: Set<string> | undefined = undefined;
  for (let i = 0; i < held.length; i += 2) {
    const error = writer.write(held[i]!, held[i + 1]!, []);
    if (error === skippedWrite) {
      if (skipped === undefined) skipped = new Set<string>();
      skipped.add(held[i]!);
    } else if (error !== '') {
      if (failed === undefined) failed = new Map<string, string>();
      failed.set(held[i]!, error);
    }
  }
  if (failed === undefined && skipped === undefined) return result;
  const copy = new EmitResult();
  copy.emitSkipped = result.emitSkipped;
  for (const f of result.emittedFiles)
    if (failed?.has(f) !== true && skipped?.has(f) !== true) copy.emittedFiles.push(f);
  for (const e of result.errors) copy.errors.push(e);
  if (failed !== undefined) for (const e of failed.values()) copy.errors.push(e);
  for (const u of result.unsupported) copy.unsupported.push(u);
  for (const d of result.diagnostics) copy.diagnostics.push(d);
  for (const s of result.declarationSignatures) copy.declarationSignatures.push(s);
  return copy;
}

/** Collects what a forced declaration emit produces instead of writing it. */
export class CapturingWriter extends OutputWriter {
  /** Whether a file was written; its text can be empty. */
  written = false;
  text = '';
  diagnostics: readonly Diagnostic[] = [];

  write(_fileName: string, text: string, declarationDiagnostics: readonly Diagnostic[]): string {
    this.written = true;
    this.text = text;
    this.diagnostics = declarationDiagnostics;
    return skippedWrite;
  }
}

/** Phase timings in milliseconds, for `--diagnostics`. */
export class CompileTimes {
  configTime = 0;
  buildInfoReadTime = 0;
  parseTime = 0;
  bindTime = 0;
  checkTime = 0;
  emitTime = 0;
  changesComputeTime = 0;
  totalTime = 0;
}

/** Module formats from the program's file metadata. */
class ProgramFormats extends ModuleFormatHost {
  constructor(private readonly program: Program) {
    super();
  }

  getEmitModuleFormat(fileName: string): ModuleKind {
    const program = this.program;
    return getEmitModuleFormatOfFile(fileName, program.options, program.sourceFileMetadata(program.toPath(fileName)));
  }
}

/** Module specifiers resolved to files of the program. */
class ProgramModules extends ModuleLookup {
  private readonly resolver: Resolver;

  constructor(private readonly program: Program) {
    super();
    this.resolver = new Resolver(program.host, program.options);
  }

  resolveModule(location: Node, file: SourceFile, specifier: string): SourceFile | undefined {
    const mode = this.program.getModeForUsageLocation(file, location);
    // The program resolved the module names its files import; others, such as names emit
    // synthesizes, are resolved here.
    const recorded = this.program.getResolvedModule(file, specifier, mode);
    const resolved =
      recorded !== undefined
        ? recorded.resolvedFileName
        : this.resolver.resolveModuleName(specifier, file.fileName, mode).resolvedFileName;
    return resolved === '' ? undefined : this.program.getSourceFile(resolved);
  }
}

class ProgramEmitHost extends EmitHost {
  writer: OutputWriter | undefined = undefined;

  constructor(
    private readonly program: Program,
    resolver: EmitResolver,
  ) {
    super(
      program.options,
      resolver,
      new ProgramFormats(program),
      program.commonSourceDirectory(),
      program.currentDirectory,
      program.useCaseSensitiveFileNames,
    );
  }

  isEmitBlocked(fileName: string): boolean {
    return this.program.isEmitBlocked(fileName);
  }

  isSourceFileFromExternalLibrary(file: SourceFile): boolean {
    return this.program.isSourceFileFromExternalLibrary(file);
  }

  writeFile(fileName: string, text: string, declarationDiagnostics?: readonly Diagnostic[]): string {
    const writer = this.writer;
    if (writer === undefined) return skippedWrite;
    return writer.write(fileName, text, declarationDiagnostics ?? []);
  }
}

/** Whether a program's emit resolves declarations, which incremental builds need for their shape signatures. */
function resolvesDeclarations(options: CompilerOptions): boolean {
  return getEmitDeclarations(options) || options.incremental === true || options.composite === true;
}

/**
 * What the emit resolvers of a program index for all its files: the globals of emit's name
 * resolution and, where declarations are resolved, those of declaration emit and the files by path.
 * The thread that shares a program with checker threads builds them before publishing it
 * (`shareWithCheckers`), so that the checkers' resolvers use one copy instead of each building its own.
 */
export class EmitIndexes {
  readonly globals: MergedGlobals;
  readonly declarations: DeclarationGlobals | undefined;

  constructor(program: Program) {
    const options = program.options;
    const files = program.getSourceFiles();
    this.globals = new ReferenceResolver(options, files, new ProgramModules(program)).merged;
    this.declarations = resolvesDeclarations(options)
      ? new DeclarationGlobals(files, program.currentDirectory)
      : undefined;
  }
}

/**
 * The JavaScript emit of a program's files without a checker, for emit threads (parallel-emit.ts).
 * JavaScript emit asks the checker only how decorator metadata serializes a type
 * (`CheckerEmitResolver`): with `kinds`, the answers the main thread's checker gave
 * (`recordMetadataKinds`), else files with decorator metadata are emitted by a `ProgramEmitter`.
 */
export class JavaScriptEmitter {
  private readonly host: ProgramEmitHost;
  private readonly recorded: RecordedKindsEmitResolver | undefined;

  constructor(program: Program, kinds: readonly number[] = []) {
    const options = program.options;
    const indexes = program.emitIndexes;
    const references = new ReferenceResolver(
      options,
      program.getSourceFiles(),
      new ProgramModules(program),
      indexes !== undefined ? indexes.globals : undefined,
    );
    this.recorded = kinds.length > 0 ? new RecordedKindsEmitResolver(options, references, kinds) : undefined;
    this.host = new ProgramEmitHost(program, this.recorded ?? new SyntacticEmitResolver(options, references));
  }

  /**
   * Emits `file`, or returns undefined if its decorator metadata asked for a kind that wasn't recorded: what
   * was written is then not the file's emit, and it must be emitted with the checker.
   */
  emit(file: SourceFile, writer: OutputWriter): EmitResult | undefined {
    const host = this.host;
    const recorded = this.recorded;
    if (recorded !== undefined) recorded.missed = false;
    host.writer = writer;
    const result = emitFiles(host, [file], EmitOnly.Js);
    host.writer = undefined;
    return recorded !== undefined && recorded.missed ? undefined : result;
  }
}

/**
 * The serialization kinds of decorator metadata that the checker of `checked` gives the type references of
 * `files`, in the order JavaScript emit asks for them: the type name's node id, the location's node id (-1 for
 * none) and the kind, for each. Only the decorator metadata transform runs, as the first transform of emit.
 */
export function recordMetadataKinds(checked: CheckedProgram, files: readonly SourceFile[]): number[] {
  const program = checked.program;
  const options = program.options;
  const indexes = program.emitIndexes;
  const references = new ReferenceResolver(
    options,
    program.getSourceFiles(),
    new ProgramModules(program),
    indexes !== undefined ? indexes.globals : undefined,
  );
  const resolver = new RecordingEmitResolver(options, references, checked.checker);
  for (const file of files)
    new DecoratorMetadata(new EmitContext(), options, resolver, new SyntaxFacts()).transformSourceFile(file);
  return resolver.kinds;
}

/** A `CheckerEmitResolver` that records the serialization kinds it gives (`recordMetadataKinds`). */
class RecordingEmitResolver extends CheckerEmitResolver {
  readonly kinds: number[] = [];

  getTypeReferenceSerializationKind(typeName: Node, location: Node | undefined): TypeReferenceSerializationKind {
    const kind = super.getTypeReferenceSerializationKind(typeName, location);
    this.kinds.push(typeName.id, location === undefined ? -1 : location.id, kind);
    return kind;
  }
}

/** Answers serialization kinds from those recorded on the main thread; `missed` once one wasn't. */
class RecordedKindsEmitResolver extends SyntacticEmitResolver {
  /** The kind and location of each type name, by the type name's node id. */
  private readonly byName = new Map<number, number>();
  missed = false;

  constructor(
    options: CompilerOptions,
    referenceResolver: ReferenceResolver,
    private readonly kinds: readonly number[],
  ) {
    super(options, referenceResolver);
    for (let i = 0; i < kinds.length; i += 3) if (!this.byName.has(kinds[i]!)) this.byName.set(kinds[i]!, i);
  }

  getTypeReferenceSerializationKind(typeName: Node, location: Node | undefined): TypeReferenceSerializationKind {
    const at = this.byName.get(typeName.id);
    if (at !== undefined && this.kinds[at + 1] === (location === undefined ? -1 : location.id))
      return this.kinds[at + 2]! as TypeReferenceSerializationKind;
    this.missed = true;
    return super.getTypeReferenceSerializationKind(typeName, location);
  }
}

/** A checked program and the emit of its files. */
export class ProgramEmitter {
  private host: ProgramEmitHost | undefined = undefined;

  readonly program: Program;

  constructor(readonly checked: CheckedProgram) {
    this.program = checked.program;
  }

  /**
   * The emit host, whose resolver resolves declarations where the options emit them or keep build info,
   * or once `declarations` asks for it: a watch without build info computes the shape signatures of its
   * rebuilds from forced declaration emit (`forcedDeclaration`).
   */
  private getHost(declarations: boolean): ProgramEmitHost {
    let host = this.host;
    if (host === undefined || (declarations && !(host.resolver instanceof CheckerDeclarationEmitResolver))) {
      const program = this.program;
      const options = program.options;
      const files = program.getSourceFiles();
      const indexes = program.emitIndexes;
      const references = new ReferenceResolver(
        options,
        files,
        new ProgramModules(program),
        indexes !== undefined ? indexes.globals : undefined,
      );
      const emitResolver = new CheckerEmitResolver(options, references, this.checked.checker);
      // Declaration emit is also needed for the shape signatures of incremental builds.
      let resolver: EmitResolver = emitResolver;
      if (declarations || resolvesDeclarations(options)) {
        const syntactic = new SyntacticDeclarationEmitResolver(
          options,
          files,
          program.currentDirectory,
          emitResolver,
          indexes !== undefined ? indexes.declarations : undefined,
        );
        resolver = new CheckerDeclarationEmitResolver(this.checked.checker, syntactic);
      }
      host = new ProgramEmitHost(program, resolver);
      this.host = host;
    }
    return host;
  }

  emit(files: readonly SourceFile[], emitOnly: EmitOnly, writer: OutputWriter): EmitResult {
    // Where `emitFiles` would emit nothing, it is not given a host, whose resolvers index every file.
    const options = this.program.options;
    if (
      (options.noEmit === true && emitOnly !== EmitOnly.ForcedDts) ||
      !files.some((file) => sourceFileMayBeEmitted(file, options))
    ) {
      const result = new EmitResult();
      result.emitSkipped = options.noEmit === true && emitOnly !== EmitOnly.ForcedDts;
      return result;
    }
    const host = this.getHost(emitOnly === EmitOnly.ForcedDts);
    host.writer = writer;
    const result = emitFiles(host, files, emitOnly);
    host.writer = undefined;
    return result;
  }

  /** The declaration text and errors of `file`, emitted even without `declaration`. */
  forcedDeclaration(file: SourceFile): CapturingWriter {
    const writer = new CapturingWriter();
    this.emit([file], EmitOnly.ForcedDts, writer);
    return writer;
  }
}

/** A program as `tsc` compiles it. */
export abstract class CompilerProgram {
  readonly emitter: ProgramEmitter;

  constructor(
    readonly checked: CheckedProgram,
    readonly times: CompileTimes,
  ) {
    this.emitter = new ProgramEmitter(checked);
  }

  /**
   * The time spent in declaration emit while checking, to count as emit time rather than check time, since
   * the last call. Only an incremental program emits while checking, to compute signatures.
   */
  takeNestedEmitTime(): number {
    return 0;
  }

  get program(): Program {
    return this.checked.program;
  }

  get options(): CompilerOptions {
    return this.checked.program.options;
  }

  getConfigFileParsingDiagnostics(): readonly Diagnostic[] {
    return this.program.getConfigFileParsingDiagnostics();
  }

  getSyntacticDiagnostics(): Diagnostic[] {
    return this.program.getSyntacticDiagnostics();
  }

  getProgramDiagnostics(): Diagnostic[] {
    return this.program.getProgramDiagnostics();
  }

  /** See `CheckedProgram.getGlobalDiagnostics`. */
  getGlobalDiagnostics(withCheckerThreads = true): Diagnostic[] {
    return this.checked.getGlobalDiagnostics(withCheckerThreads);
  }

  /**
   * Whether the global diagnostics found by checking are reported after the semantic diagnostics. An
   * incremental program has them in the semantic diagnostics of the files they were found in
   * (`CheckedProgram.globalsInFileDiagnostics`).
   */
  reportsGlobalDiagnosticsOfChecking(): boolean {
    return !this.checked.globalsInFileDiagnostics;
  }

  /** Semantic diagnostics of every file. */
  abstract getSemanticDiagnostics(): Diagnostic[];

  /** Declaration emit errors of every file. */
  abstract getDeclarationDiagnostics(): Diagnostic[];

  /** Emits the program (or what changed) with `writer`. */
  abstract emit(writer: OutputWriter): EmitResult;
}

/** Collects declaration emit errors without writing anything. */
class DiscardingWriter extends OutputWriter {
  write(_fileName: string, _text: string, _declarationDiagnostics: readonly Diagnostic[]): string {
    return skippedWrite;
  }
}

export const discardingWriter: OutputWriter = new DiscardingWriter();

/** The declaration emit errors of `file` (none if it is not emitted). */
export function declarationDiagnosticsOfFile(emitter: ProgramEmitter, file: SourceFile): Diagnostic[] {
  return emitter.emit([file], EmitOnly.ForcedDts, discardingWriter).diagnostics;
}

/** A program compiled from scratch. */
export class PlainProgram extends CompilerProgram {
  getSemanticDiagnostics(): Diagnostic[] {
    return this.checked.getSemanticDiagnostics(undefined);
  }

  getDeclarationDiagnostics(): Diagnostic[] {
    const files = this.program.getSourceFiles();
    const parallel = this.checked.declarationsInParallel;
    if (parallel === undefined) return this.emitter.emit(files, EmitOnly.ForcedDts, discardingWriter).diagnostics;
    // Declaration emit is per file: the files checker threads emitted, the others here, in order.
    const result: Diagnostic[] = [];
    for (let i = 0; i < files.length; i++) {
      const diagnostics = parallel[i] ?? declarationDiagnosticsOfFile(this.emitter, files[i]!);
      for (const d of diagnostics) result.push(d);
    }
    return result;
  }

  emit(writer: OutputWriter): EmitResult {
    const options = this.options;
    // A `noEmit` program emits nothing, and its emit is not skipped (tsgo's `HandleNoEmitOptions`): its
    // declaration errors come with its other diagnostics (`getDiagnosticsOfProgram`).
    if (options.noEmit === true) return new EmitResult();
    const skipped = handleNoEmitOnError(this);
    if (skipped !== undefined) return skipped;
    const program = this.program;
    const files = program.getSourceFiles();
    const parallel = this.checked.emittedInParallel;
    // Checker threads emitted the files they checked (parallel-check.ts), or emit threads their JavaScript
    // (parallel-emit.ts); the rest is emitted here, in order.
    const result =
      parallel === undefined
        ? this.emitter.emit(files, EmitOnly.All, writer)
        : combineEmitResults(
            files.map((file, i) => {
              const emitted = parallel[i];
              // The declaration thread emitted the declarations of the files it could (parallel-emit.ts).
              const ahead = this.checked.declarationsEmittedAhead;
              const declarations = (): EmitResult => ahead?.[i] ?? this.emitter.emit([file], EmitOnly.Dts, writer);
              if (emitted === undefined)
                return ahead !== undefined
                  ? combineEmitResults([this.emitter.emit([file], EmitOnly.Js, writer), declarations()])
                  : this.emitter.emit([file], EmitOnly.All, writer);
              const written = writeHeldOutputs(emitted, writer);
              // Emit threads emit JavaScript only.
              if (!this.checked.javaScriptEmittedOnThreads || !getEmitDeclarations(options)) return written;
              return combineEmitResults([written, declarations()]);
            }),
          );
    return result;
  }
}

/** Under `noEmitOnError`, a skipped emit with the errors that prevent it; otherwise `undefined`. */
export function handleNoEmitOnError(program: CompilerProgram): EmitResult | undefined {
  if (program.options.noEmitOnError !== true) return undefined;
  const diagnostics = getDiagnosticsOfProgram(program, true);
  if (diagnostics.length === 0) return undefined;
  const result = new EmitResult();
  for (const d of diagnostics) result.diagnostics.push(d);
  result.emitSkipped = true;
  return result;
}

/**
 * Config and syntax errors; without syntax errors, program, global and semantic errors too, and, when
 * there are none of these, declaration errors under `noEmit` (or `withDeclarationDiagnostics`). With
 * `declarationsLater`, the declaration errors are left to the caller (`declarationDiagnosticsDue`).
 */
export function getDiagnosticsOfProgram(
  program: CompilerProgram,
  withDeclarationDiagnostics: boolean,
  declarationsLater: boolean = false,
): Diagnostic[] {
  const result: Diagnostic[] = [...program.getConfigFileParsingDiagnostics()];
  const configCount = result.length;
  for (const d of program.getSyntacticDiagnostics()) result.push(d);
  mark('syntactic diagnostics');
  if (result.length !== configCount) return result;
  for (const d of program.getProgramDiagnostics()) result.push(d);
  mark('program diagnostics');
  const options = program.options;
  if (options.listFilesOnly === true) return result;
  // Those found by checking come after the semantic diagnostics, as with a single checker.
  for (const d of program.getGlobalDiagnostics(false)) result.push(d);
  if (result.length === configCount) {
    const checkStart = performance.now();
    const semantic = program.getSemanticDiagnostics();
    // Declaration emit that computed signatures while checking counts as emit time, as in TypeScript 7.1.
    const nestedEmitTime = program.takeNestedEmitTime();
    program.times.checkTime = Math.max(0, performance.now() - checkStart - nestedEmitTime);
    program.times.emitTime += nestedEmitTime;
    for (const d of semantic) result.push(d);
    // Checking may have found more, such as missing global types.
    if (program.reportsGlobalDiagnosticsOfChecking()) for (const d of program.getGlobalDiagnostics()) result.push(d);
    mark('semantic diagnostics');
  }
  if (!declarationsLater && declarationDiagnosticsDue(program, result, withDeclarationDiagnostics))
    for (const d of program.getDeclarationDiagnostics()) result.push(d);
  return result;
}

/**
 * Whether `getDiagnosticsOfProgram` adds the declaration errors to `diagnostics`: under `noEmit` (or
 * `withDeclarationDiagnostics`) with declarations, when only config errors were found.
 */
export function declarationDiagnosticsDue(
  program: CompilerProgram,
  diagnostics: readonly Diagnostic[],
  withDeclarationDiagnostics: boolean,
): boolean {
  const options = program.options;
  return (
    (withDeclarationDiagnostics || options.noEmit === true) &&
    getEmitDeclarations(options) &&
    diagnostics.length === program.getConfigFileParsingDiagnostics().length
  );
}

/** Combines emit results in order. */
export function combineEmitResults(results: readonly EmitResult[]): EmitResult {
  const result = new EmitResult();
  for (const r of results) {
    if (r.emitSkipped) result.emitSkipped = true;
    for (const d of r.diagnostics) result.diagnostics.push(d);
    for (const f of r.emittedFiles) result.emittedFiles.push(f);
    for (const e of r.errors) result.errors.push(e);
    for (const u of r.unsupported) result.unsupported.push(u);
  }
  return result;
}

export { CheckedProgram };
