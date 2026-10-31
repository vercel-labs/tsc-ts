// Checks that the run configurations the automatic selection can choose print what tsgo prints and what one
// checker with sharing off prints, and write the same files. Each project, and the compiler and conformance test
// cases in batches, is checked with one checker (the reference), then at each checker count without and with
// sharing; every run must print what the reference printed. Two kinds of difference are counted apart, because
// they do not depend on the selection and a project can have them at one checker:
//
// - the checkers differ from one checker without sharing (a diagnostic in one file that only checking another
//   reports, say); a run that prints what the unshared run at its count printed is counted as such;
// - tsgo prints something other than one-checker tsc-ts. Each is reported with the lines that differ, and --json
//   and --baseline make the set comparable between runs: it has to stay the same, and a line that is new fails.
//   The corpus has such differences (the library a suggestion names, say); the projects should have none, so for
//   the corpus pass the --json file of an earlier run as --baseline, and a differing line that it does not have fails.
//
// Any other difference fails. Reports the wall time and peak RSS of each run.
//
// Usage: node scripts/config-exactness.mjs --native BINARY [--tsgo PATH] [--projects FILE] [--corpus]
//                                         [--checkers 4,8,12,16] [--repeat 5] [--batch N] [--options A,B]
//                                         [--only NAME] [--emit] [--save DIR] [--work DIR] [--json FILE]
//                                         [--baseline FILE]
//
// --projects names a file with one project per line: a name, a directory and its tsconfig file (relative to the
// directory), separated by spaces; lines starting with # are skipped. --corpus adds TypeScript's test cases,
// written --batch at a time (default 400) into projects of their own: each case in a directory, split into its
// files at its @filename directives, each TypeScript file a module. Cases with syntax errors are left out, since a
// program with one reports only syntax errors. Their test directives are not applied. --options sets boolean
// compiler options for those projects. --checkers sets the checker counts, one checker being the reference.
// --repeat runs each shared configuration N times (default 5), since what a checker translates depends on the
// timing of the threads. --emit writes the program to a temporary directory with declarations and compares the
// trees, instead of --noEmit: pass a projects file of the emit configs, since a check config can give an option
// error once emit is on (TS5096 without rewriteRelativeImportExtensions). --only checks the projects whose name
// contains NAME. --save keeps the outputs that
// differ in DIR; --work writes the batches and the emitted trees into DIR, which is kept. --json writes the result
// of every run to FILE; --baseline compares the differing lines and files with those of an earlier --json file and
// fails when one appears that it does not have. --tsgo defaults to packages/tsgo/dist/tsgo.
//
// Exits with 1 if a run differs from the reference and from the unshared run at its count, if the one-checker run
// differs from tsgo and no --baseline is given, or if a differing line is new against --baseline. TSC_TS_SHARE_*
// variables in the environment are removed; sharing runs set TSC_TS_SHARE=1.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tempDir } from '../tests/temp.mjs';
import {
  changedFiles,
  changedLines,
  corpusProjects,
  describe,
  differingLines,
  differingPaths,
  lineCount,
  loadProjects,
  option,
  runBinary,
  saveOutput,
  treeFiles,
} from './exactness.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const native = option(args, '--native', undefined);
if (native === undefined) {
  console.error('usage: node scripts/config-exactness.mjs --native BINARY [--projects FILE] [--corpus] ...');
  process.exit(2);
}
const binary = resolve(native);
const tsgo = resolve(option(args, '--tsgo', join(root, '../tsgo/dist/tsgo')));
const projectsFile = option(args, '--projects', undefined);
const corpus = args.includes('--corpus');
const counts = [...new Set(option(args, '--checkers', '4,8,12,16').split(',').map(Number))].filter((n) => n !== 1);
const repeat = Number(option(args, '--repeat', '5'));
const batch = Number(option(args, '--batch', '400'));
const extraOptions = option(args, '--options', '')
  .split(',')
  .filter((name) => name !== '');
const only = option(args, '--only', undefined);
const emit = args.includes('--emit');
const saveDir = option(args, '--save', undefined);
const jsonFile = option(args, '--json', undefined);
const baselineFile = option(args, '--baseline', undefined);
const work = option(args, '--work', undefined) ?? tempDir('tsc-ts-config-exactness-');
mkdirSync(work, { recursive: true });

/** The arguments of a run: the program, then where an emit run writes. */
function argumentsOf(project, checkers, outDir) {
  const out = ['-p', project.config, '--incremental', 'false'];
  // A project's check config can set noEmit; an emit run writes anyway.
  if (emit) out.push('--noEmit', 'false', '--outDir', outDir, '--declaration');
  else out.push('--noEmit');
  if (checkers !== undefined) out.push('--checkers', String(checkers));
  return out;
}

let emits = 0;

/** A run with its combined output, and the files it wrote when emitting. `checkers` is undefined for tsgo. */
function runAt(path, project, checkers, share) {
  let outDir;
  const env = {};
  if (emit) {
    outDir = join(work, 'emit-' + String(emits++).padStart(5, '0'));
    mkdirSync(outDir);
  }
  // The caller's other TSC_TS_SHARE_* variables apply to the shared runs, as they do in share-exactness.mjs.
  if (share) env.TSC_TS_SHARE = '1';
  else for (const name of Object.keys(process.env)) if (name.startsWith('TSC_TS_SHARE')) env[name] = undefined;
  const result = runBinary({ binary: path, project, args: argumentsOf(project, checkers, outDir), env, work });
  if (!emit) return { ...result, signature: result.output };
  const tree = treeFiles(outDir);
  rmSync(outDir, { recursive: true, force: true });
  return { ...result, tree, signature: result.output + '\0' + JSON.stringify(tree) };
}

const check = (project, n, share = false) => runAt(binary, project, n, share);
const shareOff = (project, n) => runAt(binary, project, n, false);
const reference = (project) => runAt(tsgo, project, undefined, false);

const projects = [];
if (projectsFile !== undefined) projects.push(...loadProjects(projectsFile));

// A run without --projects or --corpus checks the tsc-ts sources themselves.
if (projects.length === 0 && !corpus) projects.push({ name: 'tscts', dir: root, config: 'tsconfig.json' });

if (corpus) {
  const ts = createRequire(import.meta.url)('typescript');
  projects.push(...corpusProjects({ ts, work, batch, options: extraOptions, counts, only, run: shareOff }));
}

for (const project of projects) {
  if (!existsSync(project.dir) || !existsSync(join(project.dir, project.config))) {
    console.error('no project ' + project.name + ' at ' + project.dir + ' (' + project.config + ')');
    process.exit(2);
  }
}

const differences = [];
const asUnshared = [];
const countDifferences = [];
const referenceDifferences = [];
const records = [];
let runs = 0;

const changed = (a, b) => (emit ? changedFiles(a.tree, b.tree) : changedLines(a.output, b.output));
// An emit run prints diagnostics as well as writing files; both differ or neither does.
const quantity = (a, b) =>
  emit
    ? changedFiles(a.tree, b.tree) + ' files and ' + changedLines(a.output, b.output) + ' lines'
    : changedLines(a.output, b.output) + ' lines';
const difference = (a, b) => (emit ? differingPaths(a.tree, b.tree) : differingLines(a.output, b.output));
// A difference in an emit run can be in the files, in the diagnostics, or in both; --baseline compares both.
const outputDifference = (a, b) => (emit ? differingLines(a.output, b.output) : []);
const units = (r) => (emit ? r.tree.length + ' files' : lineCount(r.output) + ' lines');

for (const project of projects) {
  if (only !== undefined && !project.name.includes(only)) continue;
  const tsgoRun = reference(project);
  const base = check(project, 1);
  runs += 2;
  const left = project.left ? ', ' + project.left + ' cases left out' : '';
  const referenceClean = base.signature === tsgoRun.signature;
  const record = {
    name: project.name,
    reference: referenceClean ? 'same' : 'differs',
    referenceLines: referenceClean ? [] : difference(base, tsgoRun),
    referenceOutput: referenceClean ? [] : outputDifference(base, tsgoRun),
    runs: [],
  };
  records.push(record);
  record.runs.push({
    checkers: 1,
    share: false,
    verdict: 'reference',
    changed: 0,
    seconds: base.seconds,
    rss: base.rss,
    lines: [],
  });
  if (!referenceClean)
    referenceDifferences.push({
      project: project.name,
      lines: record.referenceLines,
      output: record.referenceOutput,
    });
  console.log(
    project.name +
      ': c1 ' +
      describe(base) +
      ' (' +
      units(base) +
      left +
      ') vs tsgo ' +
      (referenceClean ? 'same' : 'DIFF ' + quantity(base, tsgoRun)),
  );
  const unshared = new Map([[1, base]]);
  for (const n of counts) {
    const plain = shareOff(project, n);
    runs++;
    unshared.set(n, plain);
    const same = plain.signature === base.signature;
    const verdict = same ? 'same' : 'count differs ' + quantity(base, plain);
    record.runs.push({
      checkers: n,
      share: false,
      verdict,
      changed: changed(base, plain),
      seconds: plain.seconds,
      rss: plain.rss,
      lines: same ? [] : difference(base, plain).slice(0, 20),
    });
    if (!same)
      countDifferences.push({
        project: project.name,
        checkers: n,
        lines: difference(base, plain),
        output: outputDifference(base, plain),
      });
    console.log('  c' + n + ' off ' + verdict + ' ' + describe(plain));
  }
  for (const n of [1, ...counts]) {
    const plain = unshared.get(n);
    const verdicts = [];
    for (let i = 0; i < repeat; i++) {
      const shared = check(project, n, true);
      runs++;
      const same = shared.signature === base.signature;
      const asPlain = shared.signature === plain.signature;
      const verdict = same ? 'same' : asPlain ? 'as unshared' : 'DIFF ' + quantity(base, shared);
      verdicts.push(verdict);
      record.runs.push({
        checkers: n,
        share: true,
        verdict,
        changed: changed(base, shared),
        seconds: shared.seconds,
        rss: shared.rss,
        lines: verdict.startsWith('DIFF') ? difference(base, shared).slice(0, 20) : [],
      });
      if (!same && asPlain) {
        asUnshared.push({
          project: project.name,
          checkers: n,
          lines: difference(base, shared),
          output: outputDifference(base, shared),
        });
      } else if (!same) {
        differences.push({
          project: project.name,
          checkers: n,
          share: true,
          lines: difference(base, shared),
          output: outputDifference(base, shared),
        });
        saveOutput(saveDir, project.name + '-c1', base.output);
        saveOutput(saveDir, project.name + '-c' + n + '-shared-' + i, shared.output);
      }
    }
    const differing = verdicts.filter((v) => v.startsWith('DIFF')).length;
    const times = record.runs
      .filter((r) => r.share && r.checkers === n)
      .map((r) => r.seconds)
      .sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const shown = differing > 0 ? differing + ' of ' + repeat + ' DIFF' : verdicts[0];
    console.log('  c' + n + ' on  ' + shown + ' ×' + repeat + ' ' + median.toFixed(2) + ' s');
  }
}

const summary = {
  binary,
  tsgo,
  emit,
  checkers: counts,
  repeat,
  projects: records,
  differences,
  asUnshared,
  countDifferences,
  referenceDifferences,
  counts: { runs, differences: differences.length, asUnshared: asUnshared.length },
};
if (jsonFile !== undefined) writeFileSync(jsonFile, JSON.stringify(summary, null, 1) + '\n');

const reported = [
  runs + ' runs',
  differences.length === 0 ? 'all match the reference' : differences.length + ' differ',
];
if (asUnshared.length > 0) reported.push(asUnshared.length + ' print what the unshared run at their count printed');
if (countDifferences.length > 0)
  reported.push(countDifferences.length + ' counts differ from one checker without sharing');
if (referenceDifferences.length > 0)
  reported.push(
    referenceDifferences.length +
      ' projects where one checker differs from tsgo' +
      (baselineFile === undefined ? ' (a failure without --baseline)' : ''),
  );

let grew = 0;
if (baselineFile !== undefined) {
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const all = [...differences, ...asUnshared, ...countDifferences, ...referenceDifferences];
  const known = new Set(
    [
      ...(baseline.differences ?? []),
      ...(baseline.asUnshared ?? []),
      ...(baseline.countDifferences ?? []),
      ...(baseline.referenceDifferences ?? []),
    ].flatMap((d) => [...(d.lines ?? []), ...(d.output ?? [])].map((line) => d.project + '\0' + line)),
  );
  const fresh = all.flatMap((d) =>
    [...(d.lines ?? []), ...(d.output ?? [])]
      .map((line) => ({ project: d.project, line }))
      .filter((item) => !known.has(item.project + '\0' + item.line)),
  );
  grew = fresh.length;
  if (grew > 0) {
    for (const item of fresh.slice(0, 20)) console.log('new difference ' + item.project + ': ' + item.line);
    reported.push(grew + ' differing lines are new against ' + baselineFile);
  } else {
    reported.push('no differing line is new against ' + baselineFile);
  }
}

// Without --baseline, a difference from tsgo is a difference: the projects must print what it prints. The corpus
// has a few (the report lists them), so its runs pass the --json file of an earlier run as --baseline.
const failed = differences.length > 0 || grew > 0 || (baselineFile === undefined && referenceDifferences.length > 0);
console.log(reported.join('; '));
process.exit(failed ? 1 : 0);
