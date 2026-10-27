// Collects the profile that `npm run build:native` optimizes with (profiles/tsc-ts.profdata).
// Usage: npm run refresh-profile -w tsc-ts [-- --projects-dir <dir>] [--jobs <n>] [--project <dir>[:<tsconfig>]]...
//
// Linux only, like --profile-generate. The profile is collected in two phases, each an instrumented tsc-ts
// (build-native.mjs, with the shipped build's options) that checks the tsc-ts sources and the projects in
// profiles/projects.json at --checkers 1:
//   1. The first build is instrumented before inlining; its raw profiles merge into the first-phase profile.
//   2. The second build is optimized by the first-phase profile and instrumented after inlining, so it counts each
//      inlined copy of a function separately (context-sensitive counts).
// Both phases merge into profiles/tsc-ts.profdata, keeping only the functions that ran (merge-profiles --sparse).
// scriptc lays out a build that uses a profile with context-sensitive counts by them: it orders each function's
// blocks and moves the blocks the checks never reached into separate sections. Then the script builds the native
// tsc-ts with the new profile and records in profiles/tsc-ts.json the scriptc that collected it and the number of
// functions it describes, which build:native compares its profile match with.
//
// The projects are cloned at their pinned commits into --projects-dir (default ~/.cache/tsc-ts/profile-projects) and
// installed with their lockfiles and without install scripts, once; later runs reuse them. --project adds a project
// to the checks. --jobs sets how many checks run at once (default: half the CPUs, at most the number of projects).
// SCRIPTC selects the scriptc executable that builds and merges the profiles.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const scriptc = process.env.SCRIPTC ?? join(repo, 'node_modules/.bin/scriptc');
const output = join(root, 'profiles/tsc-ts.profdata');
const profileInfo = join(root, 'profiles/tsc-ts.json');

const { values } = parseArgs({
  options: {
    'projects-dir': { type: 'string', default: join(homedir(), '.cache/tsc-ts/profile-projects') },
    jobs: { type: 'string' },
    project: { type: 'string', multiple: true, default: [] },
  },
});
const projectsDir = resolve(values['projects-dir']);
// corepack installs the pnpm and yarn versions the projects pin without asking.
process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ??= '0';
const pinned = JSON.parse(readFileSync(join(root, 'profiles/projects.json'), 'utf8')).projects;

const projects = [
  { name: 'tsc-ts', dir: root, config: 'tsconfig.json' },
  ...pinned.map((project) => ({ name: project.name, dir: prepare(project), config: project.config })),
  ...values.project.map((spec) => {
    const [dir, config = 'tsconfig.json'] = spec.split(':');
    return { name: dir, dir: resolve(dir), config };
  }),
];
for (const { dir, config } of projects) if (!existsSync(join(dir, config))) throw new Error(`no ${config} in ${dir}`);
const jobs = Number(values.jobs ?? Math.max(1, Math.min(projects.length, Math.floor(availableParallelism() / 2))));
if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs must be a positive integer, got ${values.jobs}`);

const work = mkdtempSync(join(tmpdir(), 'tsc-ts-profile-'));
try {
  const env = { ...process.env, TSC_TS_LIB_DIR: typescriptLib() };
  const first = join(work, 'first.profdata');
  run(scriptc, ['merge-profiles', '-o', first, '--sparse', ...(await collect('first', [], env))]);
  const second = await collect('second', [`--profile-use=${first}`], env);
  mkdirSync(dirname(output), { recursive: true });
  run(scriptc, ['merge-profiles', '-o', output, '--sparse', first, ...second]);
  // The scriptc that generated the profiled code. tests/profile.test.mjs compares it with the pinned scriptc.
  writeFileSync(profileInfo, `${JSON.stringify({ scriptc: scriptcVersion(), functions: null }, null, 2)}\n`);
  console.log(`wrote ${output}`);
  run(process.execPath, ['scripts/build-native.mjs', '--record-profile', '--output', join(work, 'tsc-check')]);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Builds an instrumented tsc-ts with the extra build-native.mjs arguments, checks every project with it, and returns
// the paths of the raw profiles it wrote, one per project.
async function collect(phase, buildArgs, env) {
  const raw = join(work, `${phase}-raw`);
  const instrumented = join(work, `tsc-${phase}`);
  run(process.execPath, [
    'scripts/build-native.mjs',
    ...buildArgs,
    `--profile-generate=${join(raw, '%p.profraw')}`,
    '--output',
    instrumented,
  ]);
  await pool(
    projects.map(({ name, dir, config }) => async () => {
      // Projects with type errors exit with 1 or 2; any other status is a failed run.
      const status = await check(instrumented, dir, config, env);
      if (status === null || status > 2) throw new Error(`the instrumented tsc-ts failed on ${join(dir, config)}`);
      console.log(`profiled ${name} (${phase} phase)`);
    }),
    jobs,
  );
  const profiles = readdirSync(raw).map((name) => join(raw, name));
  if (profiles.length !== projects.length)
    throw new Error(`expected ${projects.length} raw profiles in ${raw}, found ${profiles.length}`);
  return profiles;
}

// The checkout of a pinned project, cloned and installed when it is missing; returns the project directory.
function prepare(project) {
  const name = `${project.repository.split('/').pop()}-${project.commit.slice(0, 12)}`;
  const checkout = join(projectsDir, name);
  const ready = join(checkout, '.tsc-ts-profile-ready');
  if (!existsSync(ready)) {
    console.log(`preparing ${name} in ${checkout}`);
    rmSync(checkout, { recursive: true, force: true });
    mkdirSync(checkout, { recursive: true });
    run('git', ['init', '-q'], checkout);
    run('git', ['fetch', '-q', '--depth', '1', project.repository, project.commit], checkout);
    run('git', ['checkout', '-q', '--detach', 'FETCH_HEAD'], checkout);
    run(project.install[0], project.install.slice(1), checkout);
    for (const [command, ...args] of project.after ?? []) run(command, args, checkout);
    writeFileSync(ready, `${project.commit}\n`);
  }
  const dir = join(checkout, project.directory);
  const config = join(dir, project.config);
  if (project.writeConfig) writeFileSync(config, `${JSON.stringify(project.writeConfig, null, 2)}\n`);
  if (project.copyConfig) {
    const copy = JSON.parse(readFileSync(join(dir, project.copyConfig.from), 'utf8'));
    for (const option of project.copyConfig.removeCompilerOptions ?? []) delete copy.compilerOptions?.[option];
    writeFileSync(config, `${JSON.stringify(copy, null, 2)}\n`);
  }
  return dir;
}

// Checks one project with the instrumented tsc-ts; resolves with its exit status (null when a signal ended it).
function check(tsc, dir, config, env) {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(tsc, ['-p', config, '--noEmit', '--incremental', 'false', '--checkers', '1'], {
      cwd: dir,
      stdio: 'ignore',
      env,
    });
    child.on('error', reject);
    child.on('exit', (status) => resolveStatus(status));
  });
}

// Runs the tasks, at most `limit` at a time.
async function pool(tasks, limit) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
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

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}
