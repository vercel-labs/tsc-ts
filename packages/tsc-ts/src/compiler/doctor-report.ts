/**
 * The report a `tsc-ts doctor` child writes: `TSC_TS_DOCTOR_REPORT` names a file, and `main.ts` writes
 * what the child's compile measured to it before the process exits. The doctor process reads the file
 * after the child exits; its own runs are unaffected, since nothing here is set for them.
 *
 * The parent times the child and compares its diagnostic output itself, so the report carries what only
 * the child knows: the phase times, the program's shape, the signals, the run's configuration and the
 * key the run's record would have.
 */
import { writeFileSync } from 'node:fs';
import { residentMB } from './parallel-check.js';

/** The report path, or `undefined` when this process is not a doctor child. */
export function doctorReportPath(): string | undefined {
  const path = process.env.TSC_TS_DOCTOR_REPORT;
  return path === undefined || path === '' ? undefined : path;
}

/** What a bound program showed about the cost of checking it (`CheckSignals`), as the report keeps it. */
export interface DoctorSignals {
  count: number;
  ranges: number;
  library: number;
  own: number;
  redundancy: number;
  declarationShare: number;
  nodeModulesShare: number;
  fileShare: number;
}

/** The program's size, as a run record keeps it. */
export interface DoctorShape {
  files: number;
  chars: number;
  declarationChars: number;
  checkChars: number;
}

/** The phase times of a compile, in milliseconds (`CompileTimes`). */
export interface DoctorTimes {
  parseMs: number;
  checkMs: number;
  totalMs: number;
}

/** What this child's compile measured. */
export interface DoctorCompile {
  /** The version the executable reports (`help.ts`). */
  version: string;
  /** The project's config file, or `undefined` for root files on the command line. */
  configFile: string | undefined;
  /** The key a record of this run would have (`run-records.ts`). */
  key: string;
  checkers: number;
  share: boolean;
  parseThreads: number;
  times: DoctorTimes;
  shape: DoctorShape;
  signals: DoctorSignals | undefined;
}

/**
 * What the file holds: the compile the child measured, where it measured one, plus the exit status,
 * the CPU time and the peak memory. A child that never compiled writes only the last three.
 */
export interface DoctorReport {
  version?: string;
  configFile?: string;
  key?: string;
  checkers?: number;
  share?: boolean;
  parseThreads?: number;
  times?: DoctorTimes;
  shape?: DoctorShape;
  signals?: DoctorSignals;
  status: number;
  cpuMs: number;
  peakMB: number;
}

/** The report the process writes, once its compile measured something. */
let pending: DoctorCompile | undefined;

/** Records what this child's compile measured; `main.ts` writes it before the process exits. */
export function setDoctorCompile(compile: DoctorCompile): void {
  pending = compile;
}

/**
 * Exits with `status`, writing the doctor report first where `TSC_TS_DOCTOR_REPORT` names a file. The
 * compile's exits go through here: the thread drivers in `node-system.ts` exit from their callbacks,
 * without returning to `main.ts`.
 */
export function exitWithDoctorReport(status: number): never {
  if (doctorReportPath() !== undefined) {
    const cpu = process.cpuUsage();
    writeDoctorReport(status, (cpu.user + cpu.system) / 1000);
  }
  return process.exit(status);
}

/**
 * Writes the report to the file `TSC_TS_DOCTOR_REPORT` names, with the exit status, the CPU time and the
 * peak memory read at exit. Never throws: a report that cannot be written leaves the parent to time the
 * child without one.
 */
export function writeDoctorReport(status: number, cpuMs: number): void {
  const path = doctorReportPath();
  if (path === undefined) return;
  const compile = pending;
  const report: DoctorReport =
    compile === undefined
      ? { status, cpuMs, peakMB: residentMB()[1] }
      : {
          version: compile.version,
          configFile: compile.configFile,
          key: compile.key,
          checkers: compile.checkers,
          share: compile.share,
          parseThreads: compile.parseThreads,
          times: compile.times,
          shape: compile.shape,
          signals: compile.signals,
          status,
          cpuMs,
          peakMB: residentMB()[1],
        };
  try {
    writeFileSync(path, JSON.stringify(report) + '\n');
  } catch {
    // The parent reports the run without a report file.
  }
}
