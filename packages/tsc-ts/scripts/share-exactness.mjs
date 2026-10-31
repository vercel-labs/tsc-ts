// Checks that sharing results between checker threads (TSC_TS_SHARE=1) leaves the output of tsc-ts unchanged.
// Each project, and the compiler and conformance test cases in batches, is checked with --checkers 1 without
// sharing, then at each checker count without and with sharing; every run must print what the first run printed.
// A shared run that prints what the unshared run at its count printed is counted apart: the checkers differ from
// one checker there without sharing (a diagnostic in one file that only checking another reports, say).
// Reports the wall time and peak RSS of each run.
//
// Usage: node scripts/share-exactness.mjs --native BINARY [--projects FILE] [--corpus] [--checkers 4,16]
//                                         [--repeat N] [--batch N] [--options A,B] [--only NAME] [--save DIR]
//                                         [--work DIR]
//
// --projects names a file with one project per line: a name, a directory and its tsconfig file (relative to the
// directory), separated by spaces; lines starting with # are skipped. --corpus adds TypeScript's test cases,
// written --batch at a time (default 400) into projects of their own: each case in a directory, split into its
// files at its @filename directives, each TypeScript file a module. Cases with syntax errors are left out, since a
// program with one reports only syntax errors. Their test directives are not applied. --options sets
// boolean compiler options for those projects. --repeat runs each shared configuration N times (default 1),
// since what a checker translates depends on the timing of the threads. --only checks the projects whose name
// contains NAME. --save keeps the outputs that differ in DIR; --work writes the batches into DIR, which is kept.
// Exits with 1 if a shared run differs from both. Other TSC_TS_SHARE_* variables in the environment apply to the
// shared runs.
//
// scripts/config-exactness.mjs checks the same projects against tsgo and at more counts; this script stays for
// the runs that compare the two arms only.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { tempDir } from '../tests/temp.mjs';
import {
  changedLines,
  corpusProjects,
  describe,
  lineCount,
  loadProjects,
  option,
  runBinary,
  saveOutput,
} from './exactness.mjs';

const args = process.argv.slice(2);
const native = option(args, '--native', undefined);
if (native === undefined) {
  console.error('usage: node scripts/share-exactness.mjs --native BINARY [--projects FILE] [--corpus] ...');
  process.exit(2);
}
const binary = resolve(native);
const projectsFile = option(args, '--projects', undefined);
const corpus = args.includes('--corpus');
const counts = option(args, '--checkers', '4,16').split(',').map(Number);
const repeat = Number(option(args, '--repeat', '1'));
const batch = Number(option(args, '--batch', '400'));
const extraOptions = option(args, '--options', '')
  .split(',')
  .filter((name) => name !== '');
const only = option(args, '--only', undefined);
const saveDir = option(args, '--save', undefined);
const work = option(args, '--work', undefined) ?? tempDir('tsc-ts-share-exactness-');

const projects = projectsFile === undefined ? [] : loadProjects(projectsFile);

/** A run at one checker count, with `share` choosing whether the sharing variables stay in the environment. */
function run(project, checkers, share) {
  const env = {};
  if (share) env.TSC_TS_SHARE = '1';
  else for (const name of Object.keys(process.env)) if (name.startsWith('TSC_TS_SHARE')) env[name] = undefined;
  return runBinary({
    binary,
    project,
    args: ['-p', project.config, '--noEmit', '--incremental', 'false', '--checkers', String(checkers)],
    env,
    work,
  });
}

if (corpus) {
  const ts = createRequire(import.meta.url)('typescript');
  projects.push(
    ...corpusProjects({
      ts,
      work,
      batch,
      options: extraOptions,
      counts,
      only,
      run: (project, n) => run(project, n, false),
    }),
  );
}

let differences = 0;
let unsharedDifferences = 0;
let asUnshared = 0;
let runs = 0;
for (const project of projects) {
  if (only !== undefined && !project.name.includes(only)) continue;
  const base = run(project, 1, false);
  const left = project.left ? ', ' + project.left + ' cases left out' : '';
  const parts = [project.name + ': c1 ' + describe(base) + ' (' + lineCount(base.output) + ' lines' + left + ')'];
  for (const n of counts) {
    const plain = run(project, n, false);
    let verdict = 'same';
    if (plain.output !== base.output) {
      unsharedDifferences++;
      verdict = 'DIFF ' + changedLines(base.output, plain.output) + ' lines';
      saveOutput(saveDir, project.name + '-c1', base.output);
      saveOutput(saveDir, project.name + '-c' + n + '-unshared', plain.output);
    }
    parts.push('c' + n + ' unshared ' + verdict + ' ' + describe(plain));
    for (let i = 0; i < repeat; i++) {
      const shared = run(project, n, true);
      runs++;
      verdict = 'same';
      if (shared.output !== base.output) {
        if (shared.output === plain.output) {
          asUnshared++;
          verdict = 'as unshared';
        } else {
          differences++;
          verdict = 'DIFF ' + changedLines(base.output, shared.output) + ' lines';
          saveOutput(saveDir, project.name + '-c1', base.output);
          saveOutput(saveDir, project.name + '-c' + n + '-' + i, shared.output);
        }
      }
      parts.push('c' + n + ' shared ' + verdict + ' ' + describe(shared));
    }
  }
  console.log(parts.join(', '));
}
const summary = [
  differences === 0 ? 'all ' + runs + ' shared runs match' : differences + ' of ' + runs + ' shared runs differ',
];
if (asUnshared > 0) summary.push(asUnshared + ' print what the unshared run at their count printed');
if (unsharedDifferences > 0) summary.push(unsharedDifferences + ' unshared runs differ from --checkers 1');
console.log(summary.join('; '));
process.exit(differences === 0 ? 0 : 1);
