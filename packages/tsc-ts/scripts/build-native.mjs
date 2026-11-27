// Builds the native tsc-ts (`npm run build:native`; `--dev` for `npm run build:native:dev`): the API server
// executable `dist/tsc-api`, which serves `--api` with program regions, and the command line executable `dist/tsc`,
// which leaves the regions out so a plain check pays nothing for them. A build that names its output, profiles, or
// logs share prices builds the command line alone (the profile describes it). On Windows it
// first compiles native/pipe-win32.c, the named pipe server of `tsc-ts --api --pipe`, with zig (the linker scriptc
// uses there) and links it through native/pipe-win32.ffi.json. On Linux and macOS it first compiles
// native/listen-posix.c, the Unix socket server of `tsc-ts --api --listen`, with clang, or with zig for the
// SCRIPTC_TARGET that scriptc links for, and links it through native/listen-posix.ffi.json. Then it checks that the
// number fields of Node, Type and Symbol are 32-bit integers in the build (scripts/check-int32-fields.mjs).
//
// Optimized Linux builds compile with `scriptc build --exceptions=rare` (a scriptc with a second profile phase knows
// the option): the check's recursive functions propagate an exception by native unwinding instead of testing a flag
// after each of their calls, and the exceptions tsc-ts throws, in the configuration, record and watch drivers, travel
// a few frames. A profile describes the code of a build with a given setting, so the committed profiles are collected
// from builds with the same option (refresh-profile.mjs passes it to every instrumented build).
//
// Optimized builds use a committed profile (profile-phases.mjs): profiles/tsc-ts.cs.profdata, collected in two phases,
// when the scriptc accepts a second profile phase, and profiles/tsc-ts.profdata, collected in one phase, otherwise.
// They check how well the profile matches the code they compile (profile-match.mjs): below 95% of the functions the
// profile describes they warn, and below 90% a build in CI (the CI environment variable is set) fails. Windows builds
// print the match without checking it. Other arguments go to `scriptc build`, except:
//   --output <path>          builds the command line there, alone, instead of dist/tsc
//   --profile-generate=<p>   builds the instrumented tsc-ts refresh-profile.mjs runs, without the profile
//   --profile-use=<p>        optimizes with <p> instead of a committed profile; with --profile-generate, builds the
//                            second instrumented tsc-ts refresh-profile.mjs runs, which is optimized by <p> and counts
//                            the code again after inlining
//   --record-profile         writes the number of functions the profile describes beside it (tsc-ts.json or
//                            tsc-ts.cs.json)
//   --with-share-price       builds with the price log compiled in, from a copy of src/ that
//                            scripts/share-price-sources.patch edits (share-price-sources.mjs); a build without it
//                            compiles the sources as they are, which carry none of the log
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { judgeProfileMatch, parseProfileReport } from './profile-match.mjs';
import { writeSharePriceSources } from './share-price-sources.mjs';
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
    'with-share-price': { type: 'boolean', default: false },
  },
  strict: false,
  tokens: true,
});
const ours = new Set(['dev', 'output', 'profile-generate', 'profile-use', 'record-profile', 'with-share-price']);
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
// A price build writes dist/tsc-price unless --output names a file, so it does not replace the release binary.
const sharePrice = values['with-share-price'];
// Two executables ship together: `tsc-ts`, which serves the API with program regions, and `tsc-ts-cli`, which runs
// tsc with the compiler objects exactly as they were before the regions existed. A price build, a pattern build, or
// one that names its output builds the command line alone (the profile describes it); the shipped build builds both,
// in parallel, so CI's wall time barely moves.
const outputGiven = tokens.some((token) => token.kind === 'option' && token.name === 'output');
const single = sharePrice || outputGiven || values['profile-generate'] !== undefined || values['profile-use'] !== undefined;

// SCRIPTC selects another scriptc executable than the installed one.
const require = createRequire(join(root, 'package.json'));
const scriptcPackage = require.resolve('scriptc/package.json');
const scriptc =
  process.env.SCRIPTC ?? join(dirname(scriptcPackage), JSON.parse(readFileSync(scriptcPackage, 'utf8')).bin.scriptc);

const generate = values['profile-generate'];
const useProfile = !values.dev && generate === undefined;
// scriptc gained --exceptions=rare with the second profile phase; an older scriptc does not know the option. The
// probe builds a one-line program, so it runs once.
let secondPhase;
const profile = values['profile-use'] ?? (useProfile ? committedProfile() : undefined);
const info = profile === undefined ? undefined : profileInfoPath(profile);
const profileInfo = info === undefined ? undefined : join(root, info);

const singleOutput = outputGiven ? values.output : sharePrice ? 'dist/tsc-price' : 'dist/tsc';
const builds = single
  ? [
      {
        // --with-share-price builds the sources writeSharePriceSources writes: a copy of src/ with the price log.
        entry: sharePrice ? writeSharePriceSources(root, join(root, 'dist/share-price')) : 'src/cli-main.ts',
        output: singleOutput,
        profile: 'check',
      },
    ]
  : [
      { entry: 'src/main.ts', output: 'dist/tsc-api', profile: 'note', api: true },
      { entry: 'src/cli-main.ts', output: 'dist/tsc', profile: 'check' },
    ];

// Only the API executable links the server its flags need: the named pipe on Windows, the Unix socket elsewhere.
// Building the command line alone needs neither.
let ffiArgs = [];
mkdirSync(join(root, 'dist'), { recursive: true });
if (builds.some((build) => build.api)) {
  if (windows) {
    run('zig', ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-c', 'native/pipe-win32.c', '-o', 'dist/pipe-win32.o']);
    ffiArgs = ['--ffi', 'native/pipe-win32.ffi.json'];
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
    ffiArgs = ['--ffi', 'native/listen-posix.ffi.json'];
  }
}

const running = [];
let results;
try {
  results = await Promise.all(
    builds.map((build) => {
      const args = buildArgs(build.entry, build.output, build.api === true);
      return useProfile ? runCollectingStderr(scriptc, args) : (run(scriptc, args), { status: 0, stderr: '' });
    }),
  );
} catch (error) {
  for (const child of running) child.kill();
  throw error;
}
for (const result of results) if (result.status !== 0) {
  // A failed build ends its sibling too, rather than leaving it compiling into the same directory.
  for (const child of running) if (child.exitCode === null) child.kill();
  process.exit(result.status ?? 1);
}
if (useProfile) {
  for (const [i, result] of results.entries()) {
    const report = parseProfileReport(result.stderr);
    if (values['record-profile']) recordProfile(report);
    // The command line's build is the one the profile gates; the API executable's regions change the functions the
    // profile describes, and its match is reported, not checked.
    else if (builds[i].profile === 'check') checkProfile(report);
    else noteProfile(report);
  }
}
// The checker's hot classes keep 32-bit number fields (scripts/check-int32-fields.mjs), in the IR scriptc keeps
// beside each executable.
if (!passed.includes('--no-keep-llvm'))
  for (const build of builds)
    run(process.execPath, [
      'scripts/check-int32-fields.mjs',
      join(dirname(build.output), basename(build.entry).replace(/\.ts$/, '.ll')),
    ]);

/** The scriptc arguments of one build. */
function buildArgs(entry, output, api) {
  const args = ['build', entry];
  if (values.dev) args.push('--optimization=dev');
  else {
    args.push('--optimization=speed', '--detached-exit');
    if (process.platform === 'linux' && hasSecondProfilePhase()) args.push('--exceptions=rare');
    if (generate === undefined) {
      if (profile !== undefined) args.push(`--profile-use=${profile}`);
    } else args.push(...(profile === undefined ? [] : [`--profile-use=${profile}`]), `--profile-generate=${generate}`);
  }
  args.push(...(api ? ffiArgs : []), ...passed, '-o', output);
  return args;
}

// The committed profile for this scriptc: the two-phase one when scriptc accepts a second profile phase.
function committedProfile() {
  const twoPhase = existsSync(join(root, TWO_PHASE_PROFILE));
  return twoPhase && hasSecondProfilePhase() ? TWO_PHASE_PROFILE : SINGLE_PHASE_PROFILE;
}

// The installed scriptc has a second profile phase when it is the one that collected the two-phase profile, as
// profiles/tsc-ts.cs.json records. The probe needs --profile-generate, which scriptc supports only for Linux
// executables, so on macOS and Windows it always fails; it decides only for another scriptc (SCRIPTC).
function hasSecondProfilePhase() {
  return (secondPhase ??=
    collectedTwoPhaseProfile() || supportsSecondProfilePhase(scriptc, join(root, SINGLE_PHASE_PROFILE)));
}

function collectedTwoPhaseProfile() {
  if (process.env.SCRIPTC !== undefined) return false;
  const recorded = join(root, profileInfoPath(TWO_PHASE_PROFILE));
  if (!existsSync(recorded)) return false;
  const { scriptc: collectedWith, secondProfilePhase } = JSON.parse(readFileSync(recorded, 'utf8'));
  return secondProfilePhase === true && collectedWith === JSON.parse(readFileSync(scriptcPackage, 'utf8')).version;
}

function checkProfile(report) {
  const info = profileInfo === undefined ? {} : JSON.parse(readFileSync(profileInfo, 'utf8'));
  const verdict = judgeProfileMatch(report, info.functions ?? undefined, {
    ci: Boolean(process.env.CI),
    checked: process.platform === 'linux',
    profile,
  });
  const prefix = { ok: 'tsc-ts:', note: 'tsc-ts: note:', warn: 'tsc-ts: warning:', fail: 'tsc-ts: error:' }[
    verdict.level
  ];
  console.error(`${prefix} ${verdict.message}`);
  if (verdict.level === 'fail') process.exit(1);
}

// A build right after the profile was collected annotates every function the profile describes.
// The API executable's match, which is reported and not checked: its program regions change the IR of the retain
// and release helpers of the lifetime classes, so the committed profile describes fewer of its functions.
function noteProfile(report) {
  const info = profileInfo === undefined ? {} : JSON.parse(readFileSync(profileInfo, 'utf8'));
  const verdict = judgeProfileMatch(report, info.functions ?? undefined, {
    ci: false,
    checked: process.platform === 'linux',
    profile,
  });
  console.error(`tsc-ts: note: the API executable's profile match: ${verdict.message}`);
}

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
    running.push(child);
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
