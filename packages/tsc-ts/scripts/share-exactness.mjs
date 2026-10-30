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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { tempDir } from '../tests/temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const native = option('--native', undefined);
if (native === undefined) {
  console.error('usage: node scripts/share-exactness.mjs --native BINARY [--projects FILE] [--corpus] ...');
  process.exit(2);
}
const binary = resolve(native);
const projectsFile = option('--projects', undefined);
const corpus = args.includes('--corpus');
const counts = option('--checkers', '4,16').split(',').map(Number);
const repeat = Number(option('--repeat', '1'));
const batch = Number(option('--batch', '400'));
const extraOptions = option('--options', '')
  .split(',')
  .filter((name) => name !== '');
const only = option('--only', undefined);
const saveDir = option('--save', undefined);
const timeout = 900_000;
const time = existsSync('/usr/bin/time') ? '/usr/bin/time' : undefined;
const work = option('--work', undefined) ?? tempDir('tsc-ts-share-exactness-');

const projects = [];
if (projectsFile !== undefined) {
  for (const line of readFileSync(projectsFile, 'utf8').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === '' || fields[0].startsWith('#')) continue;
    projects.push({ name: fields[0], dir: resolve(fields[1]), config: fields[2] ?? 'tsconfig.json' });
  }
}

function caseFiles(path) {
  if (!statSync(path).isDirectory()) return [path];
  const out = [];
  for (const name of readdirSync(path).sort()) out.push(...caseFiles(join(path, name)));
  return out.filter((f) => /\.tsx?$/.test(f));
}

/** The files of the test case at `path`, split at its @filename directives; undefined if one has syntax errors. */
function caseUnits(ts, path) {
  const text = readFileSync(path, 'utf8');
  const units = [];
  let name = basename(path).endsWith('.tsx') ? 'input.tsx' : 'input.ts';
  let lines = [];
  const flush = () => {
    if (lines.some((line) => line.trim() !== '' && !/^\s*\/\/\s*@\w+\s*:/.test(line)))
      units.push({ name, text: lines.join('\n') });
    lines = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const directive = /^\s*\/\/\s*@filename\s*:\s*(.+?)\s*$/i.exec(line);
    if (directive === null) {
      lines.push(line);
      continue;
    }
    flush();
    name = normalize(directive[1].replace(/^([a-z]:)?[\\/]+/i, '')).replace(/^(\.\.[\\/])+/, '');
  }
  flush();
  const typescript = units.filter((unit) => /\.(ts|tsx|mts|cts)$/.test(unit.name));
  if (typescript.length === 0) return undefined;
  for (const unit of typescript) {
    let file;
    try {
      file = ts.createSourceFile(unit.name, unit.text, ts.ScriptTarget.Latest, false);
    } catch {
      // Cases nested past the parser's stack.
      return undefined;
    }
    if (file.parseDiagnostics.length > 0) return undefined;
    if (!/^\s*(import|export)\b/m.test(unit.text)) unit.text += '\nexport {};\n';
    unit.checked = true;
  }
  return units;
}

if (corpus) {
  const ts = createRequire(import.meta.url)('typescript');
  const cases = join(repo, 'upstream/TypeScript/tsc/testdata/tests/cases');
  const all = [...caseFiles(join(cases, 'compiler')), ...caseFiles(join(cases, 'conformance'))];
  const files = [];
  for (const path of all) {
    const units = caseUnits(ts, path);
    if (units !== undefined) files.push(units);
  }
  const compilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: 'es2024',
    module: 'esnext',
    moduleResolution: 'bundler',
    jsx: 'preserve',
  };
  for (const name of extraOptions) compilerOptions[name] = true;
  for (let start = 0; start < files.length; start += batch) {
    const name = 'corpus-' + String(start / batch).padStart(3, '0');
    const dir = join(work, name);
    mkdirSync(dir);
    const include = [];
    files.slice(start, start + batch).forEach((units, i) => {
      // Each case has a directory and each of its files is a module, so the cases of a batch keep their own names.
      const caseDir = String(i).padStart(3, '0');
      for (const unit of units) {
        const fileName = join(caseDir, unit.name);
        mkdirSync(join(dir, dirname(fileName)), { recursive: true });
        writeFileSync(join(dir, fileName), unit.text);
        if (unit.checked) include.push(fileName);
      }
    });
    const project = { name, dir, config: 'tsconfig.json' };
    let checked = include;
    // tsc-ts finds syntax errors the TypeScript package doesn't (in JSON files, say); while every error is one,
    // the cases they are in are left out. So are the cases whose output depends on which files a checker checks
    // with them, as the unshared runs at each count find them: the cases of a batch share global declarations,
    // and a diagnostic in one file can come from checking another (the error of a JSX attributes interface with
    // more than one property, at the first class element a checker checks), or a body too large for control flow
    // analysis turns it off for the rest of the checker's files.
    let left = 0;
    for (let round = 0; round < 8; round++) {
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: checked }));
      if (only !== undefined && !name.includes(only)) break;
      const output = run(project, 1, false).output;
      const errors = output.split('\n').filter((line) => / error TS\d+:/.test(line));
      const syntax =
        errors.length > 0 && errors.every((line) => / error TS(1\d\d\d|2880|8\d\d\d|17\d\d\d):/.test(line));
      const cases = new Set();
      for (const line of errors) if (syntax || / error TS2563:/.test(line)) cases.add(line.split('/')[0]);
      if (cases.size === 0) {
        const lines = new Set(output.split('\n'));
        // Five runs at each count: which files a checker checks together varies from run to run, and a case can
        // differ in a few runs in ten.
        for (const n of [...counts, ...counts, ...counts, ...counts, ...counts]) {
          const other = run(project, n, false).output.split('\n');
          const otherLines = new Set(other);
          for (const line of other) if (!lines.has(line) && line.includes('/')) cases.add(line.split('/')[0]);
          for (const line of lines) if (!otherLines.has(line) && line.includes('/')) cases.add(line.split('/')[0]);
        }
      }
      if (cases.size === 0) break;
      if (!syntax) left += cases.size;
      checked = checked.filter((file) => !cases.has(file.split('/')[0]));
    }
    project.left = left;
    projects.push(project);
  }
}

function run(project, checkers, share) {
  const env = { ...process.env };
  if (share) env.TSC_TS_SHARE = '1';
  else for (const name of Object.keys(env)) if (name.startsWith('TSC_TS_SHARE')) delete env[name];
  const timeFile = join(work, 'time.txt');
  const command = [binary, '-p', project.config, '--noEmit', '--incremental', 'false', '--checkers', String(checkers)];
  const timed = time !== undefined ? [time, '-f', '%e %M', '-o', timeFile, ...command] : command;
  const start = performance.now();
  // Deeply nested programs need more than the default stack.
  const result = spawnSync('/bin/sh', ['-c', 'ulimit -s unlimited 2>/dev/null; exec "$0" "$@"', ...timed], {
    cwd: project.dir,
    env,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    timeout,
  });
  let seconds = (performance.now() - start) / 1000;
  let rss = undefined;
  if (time !== undefined && existsSync(timeFile)) {
    const fields = readFileSync(timeFile, 'utf8').trim().split('\n').pop().split(' ');
    if (fields.length === 2) {
      seconds = Number(fields[0]);
      rss = Number(fields[1]) / 1024 / 1024;
    }
  }
  const output =
    result.error !== undefined
      ? 'error: ' + result.error.message
      : result.stdout + result.stderr + 'status ' + result.status;
  return { output, seconds, rss };
}

const describe = (r) => r.seconds.toFixed(2) + ' s' + (r.rss !== undefined ? ' ' + r.rss.toFixed(2) + ' GB' : '');
const lineCount = (text) => text.split('\n').length - 1;

/** The number of lines in one output and not the other. */
function changedLines(a, b) {
  const left = new Set(a.split('\n'));
  const right = new Set(b.split('\n'));
  let changed = 0;
  for (const line of left) if (!right.has(line)) changed++;
  for (const line of right) if (!left.has(line)) changed++;
  return changed;
}

function save(name, output) {
  if (saveDir === undefined) return;
  mkdirSync(saveDir, { recursive: true });
  writeFileSync(join(saveDir, name + '.txt'), output);
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
      save(project.name + '-c1', base.output);
      save(project.name + '-c' + n + '-unshared', plain.output);
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
          save(project.name + '-c1', base.output);
          save(project.name + '-c' + n + '-' + i, shared.output);
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
