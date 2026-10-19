// tsc-ts: `--api` serves the TypeScript API; anything else runs tsc.
import { dirname } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { publish, sharesPublishedGraphs } from '@scriptc/threads';
import { runServer } from './api/server.js';
import { reserveNodeIds, shareNodeIds } from './compiler/ast.js';
import {
  CheckerResult,
  checkFromQueue,
  packResult,
  packsResults,
  parallelCheck,
  recycleFiles,
} from './compiler/parallel-check.js';
import { type LoadMessage, parallelParse } from './compiler/parallel-parse.js';
import { useThreadTextCaches } from './compiler/diagnostics.js';
import { compareReferencesOfThread, type ReferenceJob, referenceThreads } from './compiler/incremental.js';
import { useLazyJSDocTable } from './compiler/parser.js';
import { CheckedProgram } from './compiler/program-checker.js';
import type { Program } from './compiler/program.js';
import { mark, markMemory, setTimelineThread, timeline } from './compiler/timeline.js';
import { assignSymbolIdsAtCreation, reserveSymbolIds, shareSymbolIds } from './compiler/symbol.js';
import {
  outputWriterOfThread,
  parseThreadOfCommandLine,
  programOfCommandLine,
  runTsc,
  watching,
} from './drivers/node-system.js';
import './drivers/lowering.js';

// Lib files come from TSC_TS_LIB_DIR, or the executable's directory as in tsc.
const defaultLibraryPath =
  process.env.TSC_TS_LIB_DIR ?? dirname(isNode() ? (process.argv[1] ?? '.') : process.execPath);

const args = process.argv.slice(2);
if (!isMainThread) runThread();
else {
  if (timeline) {
    // The monotonic clock at the same moment, to line the timeline up with profiles.
    const hr = process.hrtime();
    mark(`main clock ${hr[0]} ${hr[1]}`);
  }
  if (args[0] !== '--api') startThreads();
  const status = args[0] === '--api' ? runServer(args.slice(1), defaultLibraryPath) : runTsc(args, defaultLibraryPath);
  // Watch mode and `--checkers` keep running until their callbacks exit.
  if (status !== watching) {
    markMemory();
    mark('exit');
    process.exit(status);
  }
}

/**
 * Lets `--checkers N` start checker threads that write the files they emit, and parse threads where
 * threads share objects.
 */
function startThreads(): void {
  parallelCheck.writer = outputWriterOfThread(defaultLibraryPath);
  parallelCheck.spawn = (program, index, counter, order, nodeIds, symbolIds, emits, emitKinds, checking) =>
    new Worker(new URL(import.meta.url), {
      workerData: {
        kind: 'check',
        program,
        args,
        index,
        counter,
        order,
        nodeIds,
        symbolIds,
        emits,
        emitKinds,
        checking,
      },
    });
  if (sharesPublishedGraphs) {
    parallelParse.spawn = (configFileName, counter, index) =>
      new Worker(new URL(import.meta.url), {
        workerData: { kind: 'parse', configFileName, args, counter, index },
      });
    // The main thread compares the files a reference thread that failed did not.
    referenceThreads.spawn = (job) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'references', job } });
      worker.on('error', () => {});
    };
  }
}

function runThread(): void {
  const kind = (workerData as { kind: string }).kind;
  if (kind === 'parse') runParseThread();
  else if (kind === 'references') runReferenceThread();
  else runCheckerThread();
}

/** A reference thread (incremental.ts): compares the references of the program's files with its old state. */
function runReferenceThread(): void {
  const job = (workerData as { job: ReferenceJob }).job;
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

/** A checker thread (parallel-check.ts). */
function runCheckerThread(): void {
  const startedAt = Date.now();
  setTimelineThread('c' + String((workerData as { index: number }).index));
  mark('thread start');
  parallelCheck.writer = outputWriterOfThread(defaultLibraryPath);
  const job = workerData as {
    kind: string;
    program: Program | undefined;
    args: string[];
    index: number;
    counter: SharedArrayBuffer;
    order: number[];
    nodeIds: number;
    symbolIds: number;
    emits: boolean;
    emitKinds: number[] | undefined;
    checking: boolean;
  };
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
  } else program = programOfCommandLine(job.args, defaultLibraryPath);
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
          job.emits,
          job.emitKinds,
          job.checking,
        );
  // Packed results are copied: nothing this thread allocated stays reachable after it ends.
  if (packsResults) parentPort!.postMessage(packResult(result, program!));
  else parentPort!.postMessage({ result: sharesPublishedGraphs ? publish(result) : result });
  mark('result posted');
}

/** A parse thread (parallel-parse.ts): loads the chunks the main thread posts until it posts `stop`. */
function runParseThread(): void {
  const job = workerData as {
    kind: string;
    configFileName: string;
    args: string[];
    counter: SharedArrayBuffer;
    index: number;
  };
  setTimelineThread('p' + String(job.index));
  mark('thread start');
  // Ids, also of the nodes of the config, come in chunks from the counter shared with the other threads.
  shareNodeIds(new Int32Array(job.counter, 0, 1));
  shareSymbolIds(new Int32Array(job.counter, 4, 1));
  assignSymbolIdsAtCreation();
  // The command line comes from the main thread: native worker threads don't inherit process.argv.
  const thread = parseThreadOfCommandLine(job.args, job.configFileName, defaultLibraryPath);
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

function isNode(): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(process.execPath);
}
