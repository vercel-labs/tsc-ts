// The command line the two executables share: `tsc-ts`, which also serves the API (`--api`), and `tsc-ts-cli`,
// which runs tsc only. The CLI build leaves the API server and its program regions out, so its compiler objects
// keep the layout and the reference counting-free life they have without them.
import { dirname } from 'node:path';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { exitWithDoctorReport } from './compiler/doctor-report.js';
import { runThread, startThreads, type ThreadData, type ThreadDrivers } from './compiler/thread-entry.js';
import { runDoctor } from './drivers/doctor.js';
import { mark, markMemory, timeline } from './compiler/timeline.js';
import {
  outputWriterOfThread,
  parseThreadOfCommandLine,
  programOfCommandLine,
  runTsc,
  watching,
} from './drivers/node-system.js';
import './drivers/lowering.js';

/** An executable's API server, or undefined for the CLI-only executable. */
export type ApiServer = (args: string[], defaultLibraryPath: string) => number;

/** Runs the command line in `args`; `spawnThread` starts a worker that runs this executable's entry again. */
export function runEntry(spawnThread: (data: ThreadData) => Worker, apiServer: ApiServer | undefined): void {
  // Lib files come from TSC_TS_LIB_DIR, or the executable's directory as in tsc.
  const defaultLibraryPath =
    process.env.TSC_TS_LIB_DIR ?? dirname(isNode() ? (process.argv[1] ?? '.') : process.execPath);
  const args = process.argv.slice(2);

  /** What the threads read from this command line. */
  const drivers: ThreadDrivers = {
    outputWriter: () => outputWriterOfThread(defaultLibraryPath),
    programOfCommandLine: (threadArgs) => programOfCommandLine(threadArgs, defaultLibraryPath),
    parseThreadOfCommandLine: (threadArgs, configFileName) =>
      parseThreadOfCommandLine(threadArgs, configFileName, defaultLibraryPath),
  };

  if (!isMainThread) {
    runThread(workerData, drivers);
    return;
  }
  if (apiServer === undefined && args[0] === '--api') {
    process.stderr.write('this executable runs tsc only; the tsc-ts executable serves the API\n');
    exitWithDoctorReport(2);
  }
  if (timeline) {
    // The monotonic clock at the same moment, to line the timeline up with profiles.
    const hr = process.hrtime();
    mark(`main clock ${hr[0]} ${hr[1]}`);
  }
  const doctor = args[0] === 'doctor';
  const serves = apiServer !== undefined && args[0] === '--api';
  if (!doctor && !serves) startThreads(spawnThread, drivers, args);
  const status = doctor
    ? runDoctor(args.slice(1))
    : serves
      ? apiServer(args.slice(1), defaultLibraryPath)
      : runTsc(args, defaultLibraryPath);
  // Watch mode and `--checkers` keep running until their callbacks exit.
  if (status !== watching) {
    markMemory();
    mark('exit');
    // A doctor child's report, written only for the runs doctor starts (`doctor-report.ts`).
    exitWithDoctorReport(status);
  }
}

function isNode(): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(process.execPath);
}
