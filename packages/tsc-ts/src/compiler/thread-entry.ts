// The threads of tsc-ts: starting them from the main thread, and what a thread runs. The entry module of the
// executable (main.ts) creates the workers, on itself, and hands each one's `workerData` to `runThread`; the
// command line supplies what depends on it (`ThreadDrivers`).
import type { Worker } from 'node:worker_threads';
import { parentPort } from 'node:worker_threads';
import { publish, sharesPublishedGraphs } from '@scriptc/threads';
import { reserveNodeIds, shareNodeIds } from './ast.js';
import type { OutputWriter } from './compile-program.js';
import { type DiagnosticFormatOptions, formattedReports, useThreadTextCaches } from './diagnostics.js';
import { compareReferencesOfThread, type ReferenceJob, referenceThreads } from './incremental.js';
import {
  CheckerResult,
  checkFromQueue,
  packResult,
  packsResults,
  parallelCheck,
  recycleFiles,
} from './parallel-check.js';
import { emitFromQueue, parallelEmit, postedEmitResult } from './parallel-emit.js';
import { type LoadMessage, parallelParse } from './parallel-parse.js';
import type { ParseThread } from './parse-thread.js';
import { useLazyJSDocTable } from './parser.js';
import { CheckedProgram } from './program-checker.js';
import type { Program } from './program.js';
import { assignSymbolIdsAtCreation, reserveSymbolIds, shareSymbolIds } from './symbol.js';
import { mark, setTimelineThread } from './timeline.js';

/** What threads need from the command line that starts them. */
export interface ThreadDrivers {
  /** Where checker threads write the files they emit. */
  outputWriter(): OutputWriter;
  /** The program of a command line, for a checker thread that builds its own (under Node.js). */
  programOfCommandLine(args: readonly string[]): Program | undefined;
  /** A parse thread for the project of a command line and config file, or undefined if it can't be read. */
  parseThreadOfCommandLine(args: readonly string[], configFileName: string): ParseThread | undefined;
}

/** Starts a worker that runs `runThread(data)`. */
export type ThreadSpawn = (data: ThreadData) => Worker;

/** The `workerData` of a thread of tsc-ts. */
export type ThreadData = CheckerThreadData | EmitThreadData | ParseThreadData | ReferenceThreadData;

export interface CheckerThreadData {
  readonly kind: 'check';
  /** The shared, published program in scriptc builds; undefined under Node.js, where the thread builds its own. */
  readonly program: Program | undefined;
  readonly args: readonly string[];
  readonly index: number;
  readonly counter: SharedArrayBuffer;
  readonly order: number[];
  readonly nodeIds: number;
  readonly symbolIds: number;
  readonly reserved: number[];
  readonly emits: boolean;
  readonly emitKinds: number[] | undefined;
  readonly checking: boolean;
  readonly units: number[];
  /** The main thread's report format (`formattedReports`), which the thread formats its diagnostics in. */
  readonly reportFormat: DiagnosticFormatOptions | undefined;
}

export interface EmitThreadData {
  readonly kind: 'emit';
  /** The shared, published program. */
  readonly program: Program;
  readonly index: number;
  readonly counter: SharedArrayBuffer;
  readonly files: number[];
  readonly kinds: number[];
  readonly nodeIds: number;
  readonly symbolIds: number;
}

export interface ParseThreadData {
  readonly kind: 'parse';
  readonly configFileName: string;
  readonly args: readonly string[];
  readonly counter: SharedArrayBuffer;
  readonly index: number;
}

export interface ReferenceThreadData {
  readonly kind: 'references';
  readonly job: ReferenceJob;
}

/**
 * Lets `--checkers N` start checker threads that write the files they emit, and parse threads where
 * threads share objects; `args` is the command line the threads read.
 */
export function startThreads(spawn: ThreadSpawn, drivers: ThreadDrivers, args: readonly string[]): void {
  parallelCheck.writer = drivers.outputWriter();
  parallelCheck.spawn = (
    program,
    index,
    counter,
    order,
    nodeIds,
    symbolIds,
    reserved,
    emits,
    emitKinds,
    checking,
    units,
  ) =>
    spawn({
      kind: 'check',
      program,
      args,
      index,
      counter,
      order,
      nodeIds,
      symbolIds,
      reserved,
      emits,
      emitKinds,
      checking,
      units,
      reportFormat: formattedReports.format,
    });
  if (sharesPublishedGraphs) {
    parallelEmit.spawn = (program, index, counter, files, kinds, nodeIds, symbolIds) =>
      spawn({ kind: 'emit', program, index, counter, files, kinds, nodeIds, symbolIds });
    parallelParse.spawn = (configFileName, counter, index) =>
      spawn({ kind: 'parse', configFileName, args, counter, index });
    // The main thread compares the files a reference thread that failed did not.
    referenceThreads.spawn = (job) => {
      const worker = spawn({ kind: 'references', job });
      worker.on('error', () => {});
    };
  }
}

/**
 * Runs the thread that `data`, its `workerData` (a `ThreadData`), describes. The data is read as the type of its
 * kind: a native build checks `workerData` against the type it is read as.
 */
export function runThread(data: unknown, drivers: ThreadDrivers): void {
  const kind = (data as { kind: string }).kind;
  if (kind === 'parse') runParseThread(data as ParseThreadData, drivers);
  else if (kind === 'references') runReferenceThread(data as ReferenceThreadData);
  else if (kind === 'emit') runEmitThread(data as EmitThreadData, drivers);
  else runCheckerThread(data as CheckerThreadData, drivers);
}

/** A reference thread (incremental.ts): compares the references of the program's files with its old state. */
function runReferenceThread(data: ReferenceThreadData): void {
  const job = data.job;
  setTimelineThread('r' + String(job.index));
  mark('thread start');
  // As on a checker thread, the shared program is never written.
  reserveNodeIds(job.nodeIds);
  reserveSymbolIds(job.symbolIds);
  assignSymbolIdsAtCreation();
  useLazyJSDocTable();
  useThreadTextCaches();
  compareReferencesOfThread(publish(job.program), job);
  mark('references compared');
}

/** An emit thread (parallel-emit.ts): emits JavaScript, without a checker. */
function runEmitThread(job: EmitThreadData, drivers: ThreadDrivers): void {
  setTimelineThread('e' + String(job.index));
  mark('thread start');
  // As on a checker thread, the shared program is never written.
  reserveNodeIds(job.nodeIds);
  reserveSymbolIds(job.symbolIds);
  assignSymbolIdsAtCreation();
  useLazyJSDocTable();
  useThreadTextCaches();
  const program = publish(job.program);
  const result = emitFromQueue(
    program,
    job.index,
    new Int32Array(job.counter),
    job.files,
    job.kinds,
    drivers.outputWriter(),
  );
  parentPort!.postMessage(postedEmitResult(result, program));
  mark('result posted');
}

/** A checker thread (parallel-check.ts). */
function runCheckerThread(job: CheckerThreadData, drivers: ThreadDrivers): void {
  const startedAt = Date.now();
  setTimelineThread('c' + String(job.index));
  mark('thread start');
  parallelCheck.writer = drivers.outputWriter();
  formattedReports.format = job.reportFormat;
  let program: Program | undefined = undefined;
  if (job.program !== undefined) {
    // The shared program is never written: new ids continue above its own, and lazily parsed JSDoc
    // goes to a table of this thread.
    reserveNodeIds(job.nodeIds);
    reserveSymbolIds(job.symbolIds);
    assignSymbolIdsAtCreation();
    useLazyJSDocTable();
    useThreadTextCaches();
    program = publish(job.program);
    mark('program received');
  } else program = drivers.programOfCommandLine(job.args);
  // Without a program this thread checks nothing; the main thread checks the files it would have.
  const result =
    program === undefined
      ? new CheckerResult(job.index, [], [], [], [], 0, [])
      : checkFromQueue(
          new CheckedProgram(program),
          job.index,
          new Int32Array(job.counter),
          job.order,
          startedAt,
          false,
          recycleFiles,
          job.reserved,
          job.emits,
          job.emitKinds,
          job.checking,
          job.units,
        );
  // Packed results are copied: nothing this thread allocated stays reachable after it ends.
  if (packsResults) parentPort!.postMessage(packResult(result, program!));
  else parentPort!.postMessage({ result: sharesPublishedGraphs ? publish(result) : result });
  mark('result posted');
}

/** A parse thread (parallel-parse.ts): loads the chunks the main thread posts until it posts `stop`. */
function runParseThread(job: ParseThreadData, drivers: ThreadDrivers): void {
  setTimelineThread('p' + String(job.index));
  mark('thread start');
  // Ids, also of the nodes of the config, come in chunks from the counter shared with the other threads.
  shareNodeIds(new Int32Array(job.counter, 0, 1));
  shareSymbolIds(new Int32Array(job.counter, 4, 1));
  assignSymbolIdsAtCreation();
  // The command line comes from the main thread: native worker threads don't inherit process.argv.
  const thread = drivers.parseThreadOfCommandLine(job.args, job.configFileName);
  mark('project read');
  const port = parentPort!;
  port.on('message', (message: unknown) => {
    const chunk = message as LoadMessage;
    if (chunk.stop) port.close();
    // The main thread read the project, so this one can too; if not, the program's FileLoader
    // parses the files of the chunk (the main thread sees this thread fail).
    else if (thread === undefined) throw new Error('A parse thread could not read the project');
    else port.postMessage({ batch: thread.load(chunk) });
  });
}
