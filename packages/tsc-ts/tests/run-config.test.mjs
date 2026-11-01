// The run configuration: the pins of the checker count, sharing and parse threads, the decisions made
// once the program is bound, and the `--extendedDiagnostics` section that prints them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';
import { tscTs, tscTsMissing, typescriptLib } from './toolchain.mjs';

const out = compileSources('tsc-ts-run-config-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const {
  Automaticity,
  CheckSignals,
  RunConfig,
  Source,
  decideCheck,
  defaultParseThreads,
  libraryBoundCount,
  pinsOf,
  preParseConfig,
  reportRunConfig,
  sharePin,
  tsgoCheckers,
} = await load('compiler/run-config.js');

/** A `RunConfigOutput` collecting what the section writes. */
function output() {
  return {
    text: '',
    write(text) {
      this.text += text;
    },
  };
}

test('TSC_TS_SHARE pins sharing on with 1 and off with 0', () => {
  assert.equal(sharePin({ TSC_TS_SHARE: '1' }), true);
  assert.equal(sharePin({ TSC_TS_SHARE: '0' }), false);
  assert.equal(sharePin({}), undefined);
  // Any other value pins nothing, which the rules read as "no pin" rather than as off.
  assert.equal(sharePin({ TSC_TS_SHARE: 'yes' }), undefined);
  assert.equal(sharePin({ TSC_TS_SHARE: '' }), undefined);
});

test('the pins parse TSC_TS_AUTO and TSC_TS_PARSE_THREADS', () => {
  assert.equal(pinsOf({}).automaticity, Automaticity.On);
  assert.equal(pinsOf({ TSC_TS_AUTO: '0' }).automaticity, Automaticity.Off);
  assert.equal(pinsOf({ TSC_TS_AUTO: 'static' }).automaticity, Automaticity.Static);
  // A value the variable does not define leaves automatic selection on; it is not a silent off switch.
  assert.equal(pinsOf({ TSC_TS_AUTO: '1' }).automaticity, Automaticity.On);

  assert.equal(pinsOf({ TSC_TS_PARSE_THREADS: '3' }).parseThreads, 3);
  assert.equal(pinsOf({ TSC_TS_PARSE_THREADS: '1' }).parseThreads, 1);
  for (const bad of ['0', '-2', '1.5', 'abc', ''])
    assert.equal(pinsOf({ TSC_TS_PARSE_THREADS: bad }).parseThreads, undefined);
  assert.equal(pinsOf({}).parseThreads, undefined);
});

test('the default parse threads use every CPU but one, up to the checker cap', () => {
  const cpus = availableParallelism();
  const cap = Math.min(cpus, 16);
  assert.equal(defaultParseThreads(1), Math.max(1, Math.min(cpus - 1, cap)));
  assert.equal(defaultParseThreads(4), Math.max(1, Math.min(cpus - 1, Math.max(4, cap))));
  // More checkers than CPUs never gives more parse threads than there are CPUs but one.
  assert.equal(defaultParseThreads(64), Math.max(1, cpus - 1));
});

test('preParseConfig takes the pins, and the defaults where there are none', () => {
  const plain = preParseConfig({}, 4, {});
  assert.equal(plain.checkers, 4);
  assert.equal(plain.checkersSource, Source.Default);
  assert.equal(plain.checkersPin, undefined);
  assert.equal(plain.share, false);
  assert.equal(plain.shareSource, Source.Default);
  assert.equal(plain.parseThreads, defaultParseThreads(4));
  assert.equal(plain.parseSource, Source.Default);
  assert.deepEqual(plain.checkersReasons, []);

  const checkers = preParseConfig({ checkers: 2 }, 2, {});
  assert.equal(checkers.checkersSource, Source.Pinned);
  assert.equal(checkers.checkersPin, '--checkers');

  const fixed = preParseConfig({}, 4, { TSC_TS_CHECKERS: 'fixed' });
  assert.equal(fixed.checkersSource, Source.Pinned);
  assert.equal(fixed.checkersPin, 'TSC_TS_CHECKERS');

  const threads = preParseConfig({}, 4, { TSC_TS_PARSE_THREADS: '3' });
  assert.equal(threads.parseThreads, 3);
  assert.equal(threads.parseSource, Source.Pinned);
  assert.equal(threads.parsePin, 'TSC_TS_PARSE_THREADS');

  const on = preParseConfig({}, 4, { TSC_TS_SHARE: '1' });
  assert.equal(on.share, true);
  assert.equal(on.shareSource, Source.Pinned);
  assert.equal(on.sharePin, 'TSC_TS_SHARE');
  const off = preParseConfig({}, 4, { TSC_TS_SHARE: '0' });
  assert.equal(off.share, false);
  assert.equal(off.shareSource, Source.Pinned);
});

/** The signals of a plan over `count` checkers whose ranges reach `library` and check `own` characters. */
function signals(count, library, own, ranges = count) {
  const s = new CheckSignals(count, ranges);
  s.library = library;
  s.own = own;
  return s;
}

test('decideCheck cuts an automatic count that mostly resolves the same libraries', () => {
  // The measurements of tests/parallel-schedule.test.mjs, which libraryBoundCount encodes.
  const config = new RunConfig();
  config.checkers = 16;
  assert.equal(decideCheck(config, signals(16, 12_145_000, 889_000)), 12); // T3 Code web
  config.checkers = 16;
  assert.equal(decideCheck(config, signals(16, 8_727_000, 1_134_000)), 12); // T3 Code server
  config.checkers = 16;
  assert.equal(decideCheck(config, signals(16, 5_704_000, 3_037_000)), 16); // Sentry
  config.checkers = 16;
  assert.equal(decideCheck(config, signals(16, 2_403_000, 232_000)), 16); // Playwright
  // A count of tsgo's four or fewer is never cut, and never raised to four.
  config.checkers = 2;
  assert.equal(decideCheck(config, signals(2, 12_145_000, 889_000)), 2);
  config.checkers = 4;
  assert.equal(decideCheck(config, signals(4, 12_145_000, 889_000)), 4);
  // Signals computed nowhere (a pinned run) leave the count alone.
  config.checkers = 16;
  assert.equal(decideCheck(config, signals(16, 0, 0)), 16);
  // The cut is the one libraryBoundCount makes, and never goes below it.
  assert.equal(libraryBoundCount(16, 12_145_000, 889_000), 12);
  assert.ok(decideCheck(new RunConfig(), signals(16, 12_145_000, 889_000)) >= tsgoCheckers);
});

test('decideCheck never overrides a pinned count, nor shares on its own', () => {
  const config = preParseConfig({ checkers: 16 }, 16, {});
  config.checkers = 16;
  assert.equal(decideCheck(config, signals(16, 12_145_000, 889_000)), 16);
  assert.equal(config.checkersSource, Source.Pinned);
  // No rule turns sharing on yet: what the pin says is what the run keeps.
  assert.equal(config.share, false);
  const pinned = preParseConfig({}, 16, { TSC_TS_SHARE: '1' });
  pinned.checkers = 16;
  decideCheck(pinned, signals(16, 12_145_000, 889_000));
  assert.equal(pinned.share, true);
});

test('CheckSignals.fileShare is the larger of the declaration and node_modules shares', () => {
  const s = new CheckSignals(16, 16);
  s.declarationShare = 0.23;
  s.nodeModulesShare = 0.26;
  assert.equal(s.fileShare, 0.26);
  s.nodeModulesShare = 0.08;
  assert.equal(s.fileShare, 0.23);
});

test('the section prints the value, its source, and how to pin it', () => {
  const plain = preParseConfig({}, 4, { TSC_TS_PARSE_THREADS: '3' });
  const out = output();
  reportRunConfig(out, plain);
  assert.equal(
    out.text,
    '\nSuggestions:\n' +
      `  Checkers: 4 (default); pin with --checkers 4\n` +
      '  Sharing: off (default); pin with TSC_TS_SHARE=0\n' +
      '  Parse threads: 3 (pinned: TSC_TS_PARSE_THREADS)\n',
  );

  const pinned = preParseConfig({ checkers: 2 }, 2, { TSC_TS_SHARE: '1' });
  const out2 = output();
  reportRunConfig(out2, pinned);
  assert.equal(
    out2.text,
    '\nSuggestions:\n' +
      '  Checkers: 2 (pinned: --checkers)\n' +
      '  Sharing: on (pinned: TSC_TS_SHARE)\n' +
      `  Parse threads: ${pinned.parseThreads} (default); pin with TSC_TS_PARSE_THREADS=${pinned.parseThreads}\n`,
  );
});

test('the section prints a source that chose a value with its reason', () => {
  const config = new RunConfig();
  config.checkers = 12;
  config.checkersSource = Source.Static;
  config.checkersReasons.push('16 CPUs', 'library-bound');
  const out = output();
  reportRunConfig(out, config);
  assert.match(out.text, /^ {2}Checkers: 12 \(automatic: 16 CPUs; library-bound\); pin with --checkers 12$/m);

  const learned = new RunConfig();
  learned.share = true;
  learned.shareSource = Source.Learned;
  learned.shareReasons.push('check 27% faster over 5 runs');
  const out2 = output();
  reportRunConfig(out2, learned);
  assert.match(out2.text, /^ {2}Sharing: on \(learned: check 27% faster over 5 runs\); pin with TSC_TS_SHARE=1$/m);

  const exploring = new RunConfig();
  exploring.parseThreads = 8;
  exploring.parseSource = Source.Explore;
  const out3 = output();
  reportRunConfig(out3, exploring);
  assert.match(out3.text, /^ {2}Parse threads: 8 \(exploring\); pin with TSC_TS_PARSE_THREADS=8$/m);
});

// ---- the command line

const skip = tscTsMissing;

/** Runs tsc-ts in `dir` with `args`, and the lib files of the TypeScript the harness compares against. */
function run(dir, args, env = {}) {
  const result = spawnSync(tscTs[0], [...tscTs.slice(1), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: typescriptLib, NO_COLOR: '1', ...env },
    encoding: 'utf8',
  });
  return { output: result.stdout + result.stderr, status: result.status };
}

/** A project of one file that checks without emitting. */
function project() {
  const dir = tempDir('tsc-ts-run-config-project-');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    '{"compilerOptions":{"strict":true,"noEmit":true,"types":[]},"files":["a.ts"]}\n',
  );
  writeFileSync(join(dir, 'a.ts'), 'export const a: number = 1;\n');
  return dir;
}

test('--extendedDiagnostics prints the section, after the statistics', { skip }, () => {
  const dir = project();
  const { output, status } = run(dir, ['-p', '.', '--extendedDiagnostics', '--checkers', '2']);
  assert.equal(status, 0);
  const lines = output.split('\n');
  const at = lines.indexOf('Suggestions:');
  assert.ok(at > 0, `no section in:\n${output}`);
  // A blank line before the heading, and the statistics table before that.
  assert.equal(lines[at - 1], '');
  assert.match(lines[at - 2], /^Total time:/);
  assert.equal(lines[at + 1], '  Checkers: 2 (pinned: --checkers)');
  assert.equal(lines[at + 2], '  Sharing: off (default); pin with TSC_TS_SHARE=0');
  assert.match(lines[at + 3], /^ {2}Parse threads: \d+ \(default\); pin with TSC_TS_PARSE_THREADS=\d+$/);
  // Nothing after the three lines.
  assert.deepEqual(lines.slice(at + 4), ['']);
});

test('--extendedDiagnostics reports the pins of sharing and the parse threads', { skip }, () => {
  const dir = project();
  const { output } = run(dir, ['-p', '.', '--extendedDiagnostics'], {
    TSC_TS_SHARE: '1',
    TSC_TS_PARSE_THREADS: '2',
  });
  assert.match(output, /^ {2}Sharing: on \(pinned: TSC_TS_SHARE\)$/m);
  assert.match(output, /^ {2}Parse threads: 2 \(pinned: TSC_TS_PARSE_THREADS\)$/m);
});

test('--diagnostics and the default print no section', { skip }, () => {
  const dir = project();
  for (const args of [
    ['-p', '.'],
    ['-p', '.', '--diagnostics'],
  ]) {
    const { output, status } = run(dir, args);
    assert.equal(status, 0);
    assert.doesNotMatch(output, /Suggestions:/);
  }
});

test('--build prints one section per project it builds', { skip }, () => {
  const dir = tempDir('tsc-ts-run-config-build-');
  writeFileSync(join(dir, 'tsconfig.json'), '{"files":[],"references":[{"path":"./p1"},{"path":"./p2"}]}\n');
  for (const [name, source] of [
    ['p1', 'export const a = 1;\n'],
    ['p2', 'export const b = 2;\n'],
  ]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, 'tsconfig.json'),
      '{"compilerOptions":{"composite":true,"outDir":"out","declaration":true,"types":[]},"files":["a.ts"]}\n',
    );
    writeFileSync(join(dir, name, 'a.ts'), source);
  }
  const { status } = run(dir, ['-b', '--extendedDiagnostics']);
  assert.equal(status, 0);
  const rebuilt = run(dir, ['-b', '--extendedDiagnostics', '--force']);
  const sections = rebuilt.output.split('Suggestions:').length - 1;
  assert.equal(sections, 2, `expected one section per project in:\n${rebuilt.output}`);
});
