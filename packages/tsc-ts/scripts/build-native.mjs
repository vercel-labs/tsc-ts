// Builds the native tsc-ts, dist/tsc (`npm run build:native`; `--dev` for `npm run build:native:dev`). On Windows it
// first compiles native/pipe-win32.c, the named pipe server of `tsc-ts --api --pipe`, with zig (the linker scriptc
// uses there) and links it through native/pipe-win32.ffi.json. On Linux and macOS it first compiles
// native/listen-posix.c, the Unix socket server of `tsc-ts --api --listen`, with clang, or with zig for the
// SCRIPTC_TARGET that scriptc links for, and links it through native/listen-posix.ffi.json. Then it checks that the
// number fields of Node, Type and Symbol are 32-bit integers in the build (scripts/check-int32-fields.mjs).
//
// Optimized builds use a committed profile (profile-phases.mjs): profiles/tsc-ts.cs.profdata, collected in two phases,
// when the scriptc accepts a second profile phase, and profiles/tsc-ts.profdata, collected in one phase, otherwise.
// They check how well the profile matches the code they compile (profile-match.mjs): below 95% of the functions the
// profile describes they warn, and below 90% a build in CI (the CI environment variable is set) fails. Windows builds
// print the match without checking it. Other arguments go to `scriptc build`, except:
//   --output <path>          writes the executable there instead of dist/tsc
//   --profile-generate=<p>   builds the instrumented tsc-ts refresh-profile.mjs runs, without the profile
//   --profile-use=<p>        optimizes with <p> instead of a committed profile; with --profile-generate, builds the
//                            second instrumented tsc-ts refresh-profile.mjs runs, which is optimized by <p> and counts
//                            the code again after inlining
//   --record-profile         writes the number of functions the profile describes beside it (tsc-ts.json or
//                            tsc-ts.cs.json)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { judgeProfileMatch, parseProfileReport } from './profile-match.mjs';
import {
  SINGLE_PHASE_PROFILE,
  TWO_PHASE_PROFILE,
  profileInfoPath,
  supportsSecondProfilePhase,
} from './profile-phases.mjs';

const root = resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';

const { values, tokens } = parseArgs({
  options: {
    dev: { type: 'boolean', default: false },
    output: { type: 'string', default: 'dist/tsc' },
    'profile-generate': { type: 'string' },
    'profile-use': { type: 'string' },
    'record-profile': { type: 'boolean', default: false },
  },
  strict: false,
  tokens: true,
});
const ours = new Set(['dev', 'output', 'profile-generate', 'profile-use', 'record-profile']);
// The arguments for scriptc, in their order: every option this script does not handle, with its value.
const passed = [];
for (const token of tokens) {
  if (token.kind === 'positional') passed.push(token.value);
  else if (token.kind === 'option' && !ours.has(token.name)) {
    if (token.value === undefined) passed.push(token.rawName);
    else if (token.inlineValue) passed.push(`${token.rawName}=${token.value}`);
    else passed.push(token.rawName, token.value);
  }
}

// SCRIPTC selects another scriptc executable than the installed one.
const require = createRequire(join(root, 'package.json'));
const scriptcPackage = require.resolve('scriptc/package.json');
const scriptc =
  process.env.SCRIPTC ?? join(dirname(scriptcPackage), JSON.parse(readFileSync(scriptcPackage, 'utf8')).bin.scriptc);

const generate = values['profile-generate'];
const useProfile = !values.dev && generate === undefined;
const profile = values['profile-use'] ?? (useProfile ? committedProfile() : undefined);
const info = profile === undefined ? undefined : profileInfoPath(profile);
const profileInfo = info === undefined ? undefined : join(root, info);
const args = ['build', 'src/main.ts'];
if (values.dev) args.push('--optimization=dev');
else {
  args.push('--optimization=speed', '--detached-exit');
  if (generate === undefined) args.push(`--profile-use=${profile}`);
  else args.push(...(profile === undefined ? [] : [`--profile-use=${profile}`]), `--profile-generate=${generate}`);
}
mkdirSync(join(root, 'dist'), { recursive: true });
if (windows) {
  run('zig', ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-c', 'native/pipe-win32.c', '-o', 'dist/pipe-win32.o']);
  args.push('--ffi', 'native/pipe-win32.ffi.json');
} else {
  const target = process.env.SCRIPTC_TARGET;
  const flags = [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-c',
    'native/listen-posix.c',
    '-o',
    'dist/listen-posix.o',
  ];
  if (target) run('zig', ['cc', '-target', target, ...flags]);
  else run('clang', flags);
  args.push('--ffi', 'native/listen-posix.ffi.json');
}
args.push(...passed, '-o', values.output);
if (!useProfile) run(scriptc, args);
else {
  const { status, stderr } = await runCollectingStderr(scriptc, args);
  if (status !== 0) process.exit(status ?? 1);
  const report = parseProfileReport(stderr);
  if (values['record-profile']) recordProfile(report);
  else checkProfile(report);
}
// The checker's hot classes keep 32-bit number fields (scripts/check-int32-fields.mjs), in the IR scriptc keeps
// beside the executable.
if (!passed.includes('--no-keep-llvm'))
  run(process.execPath, ['scripts/check-int32-fields.mjs', join(dirname(values.output), 'main.ll')]);

// The committed profile for this scriptc: the two-phase one when scriptc accepts a second profile phase.
function committedProfile() {
  const twoPhase = existsSync(join(root, TWO_PHASE_PROFILE));
  return twoPhase && supportsSecondProfilePhase(scriptc, join(root, SINGLE_PHASE_PROFILE))
    ? TWO_PHASE_PROFILE
    : SINGLE_PHASE_PROFILE;
}

function checkProfile(report) {
  const info = profileInfo === undefined ? {} : JSON.parse(readFileSync(profileInfo, 'utf8'));
  const verdict = judgeProfileMatch(report, info.functions ?? undefined, {
    ci: Boolean(process.env.CI),
    checked: !windows,
    profile,
  });
  const prefix = { ok: 'tsc-ts:', note: 'tsc-ts: note:', warn: 'tsc-ts: warning:', fail: 'tsc-ts: error:' }[
    verdict.level
  ];
  console.error(`${prefix} ${verdict.message}`);
  if (verdict.level === 'fail') process.exit(1);
}

// A build right after the profile was collected annotates every function the profile describes.
function recordProfile(report) {
  if (profileInfo === undefined) throw new Error(`--record-profile needs a committed profile, not ${profile}`);
  const info = JSON.parse(readFileSync(profileInfo, 'utf8'));
  if (report !== undefined && report.mismatched > 0)
    throw new Error(`${report.mismatched} functions changed since the profile was collected; collect it again`);
  info.functions = report === undefined || report.withoutCounts > 0 ? null : report.annotated;
  writeFileSync(profileInfo, `${JSON.stringify(info, null, 2)}\n`);
  console.error(
    info.functions === null
      ? `tsc-ts: note: scriptc printed no profile report, so ${profileInfoPath(profile)} records no function count`
      : `tsc-ts: ${profile} describes ${info.functions} functions`,
  );
}

// Runs scriptc with its stderr shown as it arrives and collected, since its profile report is printed there.
function runCollectingStderr(command, commandArgs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: ['inherit', 'inherit', 'pipe'] });
    const chunks = [];
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (status) => resolveRun({ status, stderr: Buffer.concat(chunks).toString('utf8') }));
  });
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
