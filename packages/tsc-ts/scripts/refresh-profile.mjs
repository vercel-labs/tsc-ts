// Collects the profile that `npm run build:native` optimizes with (profiles/tsc-ts.profdata).
// Usage: node scripts/refresh-profile.mjs [--project <dir>[:<tsconfig>]]...
//
// Builds an instrumented tsc-ts (Linux only, like --profile-generate), checks the tsc-ts sources and each --project
// with it at --checkers 1, and merges the raw profiles into the committed one, keeping only the functions that ran
// (merge-profiles --sparse). The committed profile was collected with the tsc-ts sources plus the benchmark apps'
// tRPC (packages/server), TypeORM (packages/typeorm, tsconfig.bench.json), Playwright, Excalidraw
// (tsconfig.bench.json), Sentry, VS Code (src, tsconfig.bench.json), T3 Code server and T3 Code web (apps/server and
// apps/web, tsconfig.bench.json) checks. A profile from older sources still applies to the functions that did not
// change, so refreshing it is a matter of gain, not of correctness. SCRIPTC selects the scriptc executable.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const scriptc = process.env.SCRIPTC ?? join(repo, 'node_modules/.bin/scriptc');
const output = join(root, 'profiles/tsc-ts.profdata');
const versionFile = join(root, 'profiles/scriptc-version');

const { values } = parseArgs({ options: { project: { type: 'string', multiple: true, default: [] } } });
const projects = [
  { dir: root, config: 'tsconfig.json' },
  ...values.project.map((spec) => {
    const [dir, config = 'tsconfig.json'] = spec.split(':');
    return { dir: resolve(dir), config };
  }),
];
for (const { dir, config } of projects) if (!existsSync(join(dir, config))) throw new Error(`no ${config} in ${dir}`);

const work = mkdtempSync(join(tmpdir(), 'tsc-ts-profile-'));
try {
  const raw = join(work, 'raw');
  const instrumented = join(work, 'tsc');
  run(
    scriptc,
    [
      'build',
      'src/main.ts',
      '--optimization=speed',
      '--detached-exit',
      `--profile-generate=${join(raw, '%p.profraw')}`,
      '-o',
      instrumented,
    ],
    { cwd: root },
  );
  for (const { dir, config } of projects) {
    // Projects with type errors exit with 1 or 2; any other status is a failed run.
    const result = spawnSync(instrumented, ['-p', config, '--noEmit', '--incremental', 'false', '--checkers', '1'], {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, TSC_TS_LIB_DIR: typescriptLib() },
    });
    if (result.status === null || result.status > 2)
      throw new Error(`the instrumented tsc-ts failed on ${join(dir, config)} (${result.signal ?? result.status})`);
    console.log(`profiled ${join(dir, config)}`);
  }
  const profiles = readdirSync(raw).map((name) => join(raw, name));
  if (profiles.length !== projects.length)
    throw new Error(`expected ${projects.length} raw profiles in ${raw}, found ${profiles.length}`);
  mkdirSync(dirname(output), { recursive: true });
  run(scriptc, ['merge-profiles', '-o', output, '--sparse', ...profiles], { cwd: root });
  // The scriptc that generated the profiled code. tests/profile.test.mjs compares it with the pinned scriptc.
  writeFileSync(versionFile, `${scriptcVersion()}\n`);
  console.log(`wrote ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// The version the scriptc executable reports.
function scriptcVersion() {
  const result = spawnSync(scriptc, ['--version'], { encoding: 'utf8' });
  const version = /\d+\.\d+\.\d+\S*/.exec(result.stdout ?? '')?.[0];
  if (result.status !== 0 || version === undefined) throw new Error(`${scriptc} --version did not report a version`);
  return version;
}

// TypeScript 7.0.2's lib files, from the tsc bundled with the installed scriptc.
function typescriptLib() {
  const require = createRequire(join(root, 'package.json'));
  const scriptcPackage = JSON.parse(readFileSync(require.resolve('scriptc/package.json'), 'utf8'));
  for (const name of Object.keys(scriptcPackage.optionalDependencies ?? {})) {
    let path;
    try {
      path = require.resolve(`${name}/package.json`);
    } catch {
      continue;
    }
    const lib = join(dirname(path), 'dist/lib/typescript/lib');
    if (existsSync(join(lib, 'lib.d.ts'))) return lib;
  }
  throw new Error('no scriptc platform package with TypeScript lib files is installed');
}

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}
