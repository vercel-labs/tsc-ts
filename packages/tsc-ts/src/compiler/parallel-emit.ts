/**
 * Emitting a program's JavaScript on threads while the main thread checks it (`--checkers 1` in
 * scriptc builds).
 *
 * JavaScript emit needs nothing of a checker but how decorator metadata serializes a type: import
 * elision, export names and const enum values come from syntax, the binder's symbols and the other
 * files of the program (`SyntacticEmitResolver`, `ReferenceResolver`). So emit threads create no
 * checker. They receive the published program, emit with a `JavaScriptEmitter` the files the main
 * thread hands out through a shared counter, write the outputs and send back their emit results.
 * The main thread checks meanwhile. Then it records how its checker serializes the types of the
 * decorator metadata of the files that have it (`recordMetadataKinds`), which a second wave of emit
 * threads emits with those answers as plain data (`startMetadataEmit`), and emits the declarations
 * of every file while they do. Which thread emits a file doesn't change its output.
 */
import type { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { publish } from '@scriptc/threads';
import { lastNodeIdValue, type SourceFile } from './ast.js';
import { JavaScriptEmitter, type OutputWriter } from './compile-program.js';
import type { Diagnostic, DiagnosticFile } from './diagnostics.js';
import { EmitResult, sourceFileMayBeEmitted } from './emitter.js';
import { CheckerResult, packResult, packsResults, type PackedResult, unpackResult } from './parallel-check.js';
import type { CheckedProgram } from './program-checker.js';
import type { Program } from './program.js';
import { lastSymbolIdValue } from './symbol.js';
import { mark } from './timeline.js';
import { SubtreeFacts, SyntaxFacts } from './transformers/syntax-facts.js';

/**
 * Starts emit thread `index` (main.ts owns the worker entry point) on the shared, published
 * `program`: it emits the files of `files` at the positions it takes from `counter`, with the decorator
 * metadata `kinds` the main thread recorded (`startMetadataEmit`); ids continue above `nodeIds` and
 * `symbolIds`.
 */
export type EmitSpawn = (
  program: Program,
  index: number,
  counter: SharedArrayBuffer,
  files: number[],
  kinds: number[],
  nodeIds: number,
  symbolIds: number,
) => Worker;

export class ParallelEmit {
  /** Set where emit threads can be started. */
  spawn: EmitSpawn | undefined = undefined;
}

export const parallelEmit = new ParallelEmit();

/** The most emit threads: four emitted VS Code's JavaScript as fast as 15 did while one thread checked it. */
const maxEmitThreads = 4;

/**
 * The least text of the files to emit, in characters, for emit threads: starting them and sharing
 * the program takes about as long as emitting this much.
 */
const littleEmitText = 50_000;

/**
 * The number of threads to emit the JavaScript of `program` on, or 0 to emit it on this thread:
 * where threads can start and the program emits enough, one fewer than the CPUs, at most
 * `maxEmitThreads`.
 */
export function emitThreads(program: Program, singleThreaded: boolean | undefined): number {
  if (parallelEmit.spawn === undefined || singleThreaded === true) return 0;
  const cpus = availableParallelism();
  if (cpus < 2) return 0;
  const options = program.options;
  let text = 0;
  for (const file of program.getSourceFiles())
    if (sourceFileMayBeEmitted(file, options)) {
      text += file.end;
      if (text >= littleEmitText) return Math.min(cpus - 1, maxEmitThreads);
    }
  return 0;
}

/**
 * Whether the JavaScript of `file` needs decorator metadata kinds from the checker (`emitDecoratorMetadata`
 * asks it how the types of decorated declarations serialize): a file with decorators is emitted by the second
 * wave of emit threads, with the kinds the main thread's checker recorded after checking (`startMetadataEmit`).
 */
function needsMetadataKinds(file: SourceFile, program: Program): boolean {
  return program.options.emitDecoratorMetadata === true && new SyntaxFacts().has(file, SubtreeFacts.ContainsDecorators);
}

/**
 * Emits the JavaScript of the files of `checked` on `threads` threads and calls `done` once they are
 * emitted; the program must be shared (`shareWithCheckers`). The emit results go to
 * `checked.emittedInParallel`, which `PlainProgram.emit` completes on this thread. Returns at once, with the
 * indexes of the files left for `startMetadataEmit`: the results arrive on this thread's event loop.
 */
export function startParallelEmit(checked: CheckedProgram, threads: number, done: () => void): number[] {
  const program = checked.program;
  const options = program.options;
  const files = program.getSourceFiles();
  const order: number[] = [];
  const metadata: number[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (!sourceFileMayBeEmitted(file, options)) continue;
    if (needsMetadataKinds(file, program)) metadata.push(i);
    else order.push(i);
  }
  const perFileEmits: (EmitResult | undefined)[] = [];
  for (let i = 0; i < files.length; i++) perFileEmits.push(undefined);
  checked.emittedInParallel = perFileEmits;
  checked.javaScriptEmittedOnThreads = true;
  spawnEmitThreads(checked, threads, order, [], done);
  return metadata;
}

/**
 * Emits the JavaScript of `files` (indexes, from `startParallelEmit`), whose decorator metadata asks the
 * checker, on `threads` threads with the kinds that this thread's checker gave (`recordMetadataKinds`), and
 * calls `done` once they are emitted. Called once this thread has checked the program, so that asking for the
 * kinds doesn't change what checking finds.
 */
export function startMetadataEmit(
  checked: CheckedProgram,
  threads: number,
  files: number[],
  kinds: number[],
  done: () => void,
): void {
  spawnEmitThreads(checked, Math.min(threads, files.length), files, kinds, done);
}

function spawnEmitThreads(
  checked: CheckedProgram,
  threads: number,
  files: number[],
  kinds: number[],
  done: () => void,
): void {
  const program = checked.program;
  const sourceFiles = program.getSourceFiles();
  const perFileEmits = checked.emittedInParallel!;
  const order = files.slice();
  // The longest files first, so that the threads finish together.
  order.sort((a, b) => sourceFiles[b]!.end - sourceFiles[a]!.end || a - b);
  publish(order);
  publish(kinds);
  mark(`planned ${order.length} files to emit`);
  const trace = process.env.TSC_TS_CHECKERS_TRACE !== undefined;
  const start = performance.now();
  const counter = new SharedArrayBuffer(4);
  const diagnosticFiles = new Map<string, DiagnosticFile>();
  let remaining = threads;
  if (remaining === 0) done();
  for (let i = 0; i < threads; i++) {
    const worker = parallelEmit.spawn!(program, i, counter, order, kinds, lastNodeIdValue(), lastSymbolIdValue());
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      remaining--;
      if (remaining === 0) done();
    };
    worker.on('message', (message: unknown) => {
      mark(`result from e${i}`);
      const result = packsResults
        ? unpackResult(message as PackedResult, program, diagnosticFiles)
        : publish((message as { result: CheckerResult }).result);
      for (let k = 0; k < result.files.length; k++) perFileEmits[result.files[k]!] = result.emits[k]!;
      if (trace)
        process.stderr.write(
          `emit threads: thread ${i} emitted ${result.files.length} files${kinds.length > 0 ? ` with metadata kinds (${result.stats[0] ?? 0} missed a kind)` : ''} in ${result.checkTime.toFixed(1)}ms, done at ${(performance.now() - start).toFixed(1)}ms\n`,
        );
      end();
    });
    // The files a failed thread took and did not send back are emitted on this thread (`PlainProgram.emit`).
    worker.on('error', (error: unknown) => {
      if (trace) process.stderr.write(`emit threads: thread ${i} failed: ${String(error)}\n`);
      end();
    });
  }
  mark('emit threads spawned');
}

/**
 * On emit thread `index`: emits the JavaScript of the files of `order` at the positions it takes
 * from `counter` until none are left, writing it with `writer`; `kinds` are the decorator metadata kinds
 * the main thread recorded for them (`recordMetadataKinds`), if any. `stats` has the number of files that
 * missed a kind.
 */
export function emitFromQueue(
  program: Program,
  index: number,
  counter: Int32Array,
  order: readonly number[],
  kinds: readonly number[],
  writer: OutputWriter,
): CheckerResult {
  const start = performance.now();
  const files = program.getSourceFiles();
  const emitter = new JavaScriptEmitter(program, kinds);
  mark('emitter ready');
  const done: number[] = [];
  const diagnostics: Diagnostic[][] = [];
  const emits: EmitResult[] = [];
  let missed = 0;
  for (;;) {
    const position = Atomics.add(counter, 0, 1);
    if (position >= order.length) break;
    const i = order[position]!;
    const result = emitter.emit(files[i]!, writer);
    // A file whose emit missed a kind isn't sent back: the main thread emits it again, with its checker.
    if (result === undefined) {
      missed++;
      continue;
    }
    done.push(i);
    diagnostics.push([]);
    emits.push(result);
  }
  mark(`emitted ${done.length} files`);
  return new CheckerResult(index, done, diagnostics, [], [], performance.now() - start, [missed], false, [], emits);
}

/** What an emit thread posts back: `result`, packed for `postMessage` where results are packed. */
export function postedEmitResult(result: CheckerResult, program: Program): PackedResult | { result: CheckerResult } {
  return packsResults ? packResult(result, program) : { result: publish(result) };
}
