/**
 * Opening a project's run record before its files are parsed: the directory the records live in, the key
 * that names this project's, and the record itself. `preParseConfig` needs the record before the first
 * file (its chosen parse threads apply there), and `saveRunRecord` writes the same file afterwards.
 *
 * The key covers the executable (`process.execPath`), so a run reads only records a run of the same build
 * wrote, and it needs the root files only where no config file names the project. Best effort throughout:
 * a record that cannot be read is absent, and a run without a cache directory reads nothing.
 */
import { version } from './help.js';
import type { CompilerOptions } from './options.js';
import { memoryLimit } from './parallel-check.js';
import { availableCpus } from './cgroup.js';
import { learns, pinsOf } from './run-config.js';
import {
  readRecord,
  recordEnvironment,
  recordFile,
  recordKey,
  recordsDirectory,
  type RecordEnvironment,
  type RecordOptions,
  type RunRecord,
} from './run-records.js';

/** Where a run's record lives, and what it held before this run: `record` is `undefined` where there is none. */
export interface OpenedRecord {
  readonly directory: string;
  readonly key: string;
  readonly file: string;
  readonly record: RunRecord | undefined;
}

/** The project a record is kept for: its config file, or the root files where there is none. */
export interface RecordProject {
  readonly configFile: string | undefined;
  readonly rootNames: readonly string[];
  readonly options: CompilerOptions;
}

/** Whether a run may keep and read a record: `TSC_TS_CACHE=0` and `TSC_TS_AUTO=0|static` turn them off. */
export function recordsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.TSC_TS_CACHE !== '0' && learns(pinsOf(env).automaticity);
}

/**
 * The record `project`'s runs share, read now, or `undefined` where the run keeps no records
 * (`recordsAllowed`) or the cache directory is off. Reading is one small file: a missing or malformed
 * record is absent, not an error.
 */
export function openRecord(
  project: RecordProject,
  env: Record<string, string | undefined> = process.env,
  recordEnv: RecordEnvironment = recordEnvironment(),
): OpenedRecord | undefined {
  if (!recordsAllowed(env)) return undefined;
  const directory = recordsDirectory(recordEnv);
  if (directory === undefined) return undefined;
  const key = recordKey({
    version,
    executable: process.execPath,
    configFile: project.configFile,
    rootNames: project.rootNames,
    options: recordOptionsOf(project.options),
    cpus: Math.max(1, availableCpus()),
    memoryBytes: memoryLimit(),
  });
  const file = recordFile(directory, key);
  return { directory, key, file, record: readRecord(file) };
}

/** The options the record's key covers (`run-records.ts`: those that change the work a run does). */
export function recordOptionsOf(options: CompilerOptions): RecordOptions {
  return {
    noEmit: options.noEmit,
    emitDeclarationOnly: options.emitDeclarationOnly,
    declaration: options.declaration,
    composite: options.composite,
    incremental: options.incremental,
    outFile: options.outFile,
    noEmitOnError: options.noEmitOnError,
    skipLibCheck: options.skipLibCheck,
    checkJs: options.checkJs,
    isolatedDeclarations: options.isolatedDeclarations,
    configFilePath: options.configFilePath,
  };
}
