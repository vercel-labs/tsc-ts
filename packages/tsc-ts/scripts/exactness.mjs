// Shared pieces of the exactness checks: the project-file format, TypeScript's test cases in batches, the runner
// that starts a compiler in a project directory, and the helpers that describe and save its output.
//
// A project is `{ name, dir, config }`: a name, a directory and the tsconfig file relative to it.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join, normalize, resolve } from 'node:path';

export const timeout = 900_000;
const time = existsSync('/usr/bin/time') ? '/usr/bin/time' : undefined;

/** The value of `--name` in `args`, or `fallback`. */
export function option(args, name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
}

/** The projects of a file with one project per line. */
export function loadProjects(file) {
  const projects = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === '' || fields[0].startsWith('#')) continue;
    projects.push({ name: fields[0], dir: resolve(fields[1]), config: fields[2] ?? 'tsconfig.json' });
  }
  return projects;
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

/**
 * TypeScript's compiler and conformance test cases as projects of `batch` cases each, written into `work`.
 *
 * A batch is a program whose cases share global declarations, so the output of a case can depend on which files a
 * checker checks with it (the error of a JSX attributes interface with more than one property, at the first class
 * element a checker checks, or a body too large for control flow analysis turning it off for the checker's other
 * files). The cases that print differently between the counts in `counts` without sharing are left out, found by
 * running the batch at each count five times: which files a checker checks together varies from run to run, and a
 * case can differ in a few runs in ten. `run(project, checkers, share)` returns `{ output }`.
 */
export function corpusProjects({ ts, work, batch, options, counts, only, run }) {
  const cases = join(resolve(import.meta.dirname, '../../..'), 'upstream/TypeScript/tsc/testdata/tests/cases');
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
  for (const name of options) compilerOptions[name] = true;
  const projects = [];
  for (let start = 0; start < files.length; start += batch) {
    const name = 'corpus-' + String(start / batch).padStart(3, '0');
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
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
    // Two kinds of case are left out of a batch, counted in left: the cases that make the program report syntax
    // errors only (tsc-ts finds ones the TypeScript package doesn't, in JSON files say), and the cases whose output
    // differs between checker counts or at a body too large for control flow analysis, which no configuration can be
    // held to.
    let left = 0;
    for (let round = 0; round < 8; round++) {
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: checked }));
      if (only !== undefined && !name.includes(only)) break;
      const output = run(project, 1, false).output;
      const errors = output.split('\n').filter((line) => / error TS\d+:/.test(line));
      const syntax =
        errors.length > 0 && errors.every((line) => / error TS(1\d\d\d|2880|8\d\d\d|17\d\d\d):/.test(line));
      const differing = new Set();
      for (const line of errors) if (syntax || / error TS2563:/.test(line)) differing.add(line.split('/')[0]);
      if (differing.size === 0) {
        const lines = new Set(output.split('\n'));
        for (const n of [...counts, ...counts, ...counts, ...counts, ...counts]) {
          const other = run(project, n, false).output.split('\n');
          const otherLines = new Set(other);
          for (const line of other) if (!lines.has(line) && line.includes('/')) differing.add(line.split('/')[0]);
          for (const line of lines) if (!otherLines.has(line) && line.includes('/')) differing.add(line.split('/')[0]);
        }
      }
      if (differing.size === 0) break;
      left += differing.size;
      checked = checked.filter((file) => !differing.has(file.split('/')[0]));
    }
    project.left = left;
    // Batches take a while to prepare; the report of each project follows once every batch is written.
    if (only === undefined || name.includes(only))
      process.stderr.write(name + ': ' + files.slice(start, start + batch).length + ' cases, ' + left + ' left out\n');
    projects.push(project);
  }
  return projects;
}

/**
 * Runs `binary` in a project's directory with `args` and returns the combined output it prints, its exit status,
 * its wall time and its peak RSS. `env` replaces variables of the environment: a value of undefined removes one.
 */
export function runBinary({ binary, project, args, env = {}, work }) {
  const childEnv = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[name];
    else childEnv[name] = value;
  }
  const timeFile = join(work, 'time.txt');
  const command = [binary, ...args];
  const timed = time !== undefined ? [time, '-f', '%e %M', '-o', timeFile, ...command] : command;
  const start = performance.now();
  // Deeply nested programs need more than the default stack.
  const result = spawnSync('/bin/sh', ['-c', 'ulimit -s unlimited 2>/dev/null; exec "$0" "$@"', ...timed], {
    cwd: project.dir,
    env: childEnv,
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

export const describe = (r) =>
  r.seconds.toFixed(2) + ' s' + (r.rss !== undefined ? ' ' + r.rss.toFixed(2) + ' GB' : '');

export const lineCount = (text) => text.split('\n').length - 1;

/** The number of lines in one output and not the other. */
export function changedLines(a, b) {
  const left = new Set(a.split('\n'));
  const right = new Set(b.split('\n'));
  let changed = 0;
  for (const line of left) if (!right.has(line)) changed++;
  for (const line of right) if (!left.has(line)) changed++;
  return changed;
}

/** The lines of one output that the other does not have. */
export function differingLines(a, b) {
  const left = new Set(a.split('\n'));
  const right = new Set(b.split('\n'));
  const lines = [];
  for (const line of left) if (!right.has(line)) lines.push(line);
  for (const line of right) if (!left.has(line)) lines.push(line);
  return lines.filter((line) => line !== '');
}

export function saveOutput(dir, name, output) {
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name + '.txt'), output);
}

/** Every file a run wrote under `dir`, as `{ path, hash }` with the SHA-256 of its contents, sorted by path. */
export function treeFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else files.push({ path: normalize(join('.', child.slice(dir.length))), hash: hashFile(child) });
    }
  };
  visit(dir);
  return files;
}

function hashFile(path) {
  // The tree comparison reads every emitted file; the compiler's own hash is over source text, not files.
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The number of files in one tree and not the other, with the same contents. */
export function changedFiles(a, b) {
  const left = new Map(a.map((f) => [f.path, f.hash]));
  const right = new Map(b.map((f) => [f.path, f.hash]));
  let changed = 0;
  for (const [path, hash] of left) if (right.get(path) !== hash) changed++;
  for (const path of right.keys()) if (!left.has(path)) changed++;
  return changed;
}

export function differingPaths(a, b) {
  const left = new Map(a.map((f) => [f.path, f.hash]));
  const right = new Map(b.map((f) => [f.path, f.hash]));
  const paths = [];
  for (const [path, hash] of left) if (right.get(path) !== hash) paths.push(path);
  for (const path of right.keys()) if (!left.has(path)) paths.push(path);
  return paths;
}
