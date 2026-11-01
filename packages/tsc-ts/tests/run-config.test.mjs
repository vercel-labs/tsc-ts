// The run configuration: the pins of the checker count, sharing and parse threads, the decisions made
// once the program is bound, and the `--extendedDiagnostics` section that prints them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  beatsBy,
  checkTimes,
  checkersBand,
  decideCheck,
  defaultParseThreads,
  fastRevert,
  isLibraryBound,
  libraryBoundCount,
  marginOf,
  medianOf,
  minSharingCheckers,
  noiseOf,
  pinsOf,
  preParseConfig,
  reportRunConfig,
  sharePin,
  shareWindow,
  shareWindowOf,
  sharingBand,
  sharingCandidate,
  sharingFileShare,
  sharingPeakShare,
  tsgoCheckers,
  usableSamples,
} = await load('compiler/run-config.js');
const { sharingFitNeeded, sharingNumbers, signalsNeeded, stopLevel } = await load('compiler/parallel-check.js');
const { recordsAllowed } = await load('compiler/run-record-read.js');
const { nextRecord } = await load('compiler/run-records.js');
const { shareStatColumns, shareStatExport, shareStatSaved, shareStatTranslation, shareStatUnpack } =
  await load('compiler/shared-results.js');

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
  assert.equal(pinsOf({ TSC_TS_AUTO: 'explore' }).automaticity, Automaticity.Explore);
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

/** T3 Code's web project's signals at `count` checkers: 66% of its files are in node_modules. */
function t3web(count = 16) {
  const s = signals(count, 12_145_000, 889_000);
  s.declarationShare = 0.62;
  s.nodeModulesShare = 0.66;
  return s;
}

/** T3 Code's server project: 48% of its files are in node_modules. */
function t3server(count = 16) {
  const s = signals(count, 8_727_000, 1_134_000);
  s.declarationShare = 0.41;
  s.nodeModulesShare = 0.48;
  return s;
}

test('decideCheck never overrides a pinned count, and keeps sharing off where it does not pay', () => {
  const config = preParseConfig({ checkers: 16 }, 16, {});
  config.checkers = 16;
  // The count is the pin's; sharing stays off where the memory fit does not allow it.
  assert.equal(decideCheck(config, t3web(), { possible: true, fit: { sharing: 15 } }), 16);
  assert.equal(config.checkersSource, Source.Pinned);
  assert.equal(config.share, false);
  // A pinned count with the fit and the signals shares: the pin fixes the count, not sharing.
  assert.equal(decideCheck(config, t3web(), { possible: true, fit: { sharing: 16 } }), 16);
  assert.equal(config.share, true);
  assert.equal(config.shareSource, Source.Static);
  assert.equal(config.checkersSource, Source.Pinned);
  // What TSC_TS_SHARE says wins over the rule, and a sharing pin does not keep the count from being
  // cut: the pin decides sharing, the count rule decides the count.
  const off = preParseConfig({ checkers: 16 }, 16, { TSC_TS_SHARE: '0' });
  off.checkers = 16;
  assert.equal(decideCheck(off, t3web(), { possible: true, fit: { sharing: 16 } }), 16);
  assert.equal(off.share, false);
  assert.equal(off.shareSource, Source.Pinned);
  const pinned = preParseConfig({}, 16, { TSC_TS_SHARE: '1' });
  pinned.checkers = 16;
  assert.equal(decideCheck(pinned, signals(16, 12_145_000, 889_000)), 12);
  assert.equal(pinned.checkers, 12);
  assert.equal(pinned.share, true);
});

test('decideCheck turns sharing on for a count whose checkers mostly resolve libraries', () => {
  for (const [name, make] of [
    ['T3 Code web', t3web],
    ['T3 Code server', t3server],
  ]) {
    const config = preParseConfig({}, 16, {});
    config.checkers = 16;
    assert.equal(decideCheck(config, make(), { possible: true, fit: { sharing: 16 } }), 12, name);
    assert.equal(config.share, true, name);
    assert.equal(config.shareSource, Source.Static, name);
    // The cut stays on: 16 checkers with sharing are within noise of the cut count with it (Q2), and
    // the cut uses less memory, so sharing does not raise the count.
    assert.equal(config.checkers, 12, name);
    assert.equal(config.checkersSource, Source.Default, name);
    assert.deepEqual(config.checkersReasons, [], name);
  }
  const config = new RunConfig();
  config.checkers = 16;
  decideCheck(config, t3web(), { possible: true, fit: { sharing: 16 } });
  assert.deepEqual(config.shareReasons, [
    '66% of files in node_modules; ranges reach 12.1M library characters for 0.9M checked',
  ]);
  const server = new RunConfig();
  server.checkers = 16;
  decideCheck(server, t3server(), { possible: true, fit: { sharing: 16 } });
  assert.deepEqual(server.shareReasons, [
    '48% of files in node_modules; ranges reach 8.7M library characters for 1.1M checked',
  ]);
  // Sharing is on only when it can be: the emit threads and Node builds have no shared program.
  const alone = preParseConfig({}, 16, {});
  assert.equal(decideCheck(alone, t3web()), 12);
  assert.equal(alone.share, false);
});

test('the sharing rule needs 12 checkers, 40% of the files, library-bound ranges and the memory fit', () => {
  const at = (signals, fit = { sharing: 16 }, possible = true) => {
    const config = preParseConfig({}, signals.count, {});
    decideCheck(config, signals, { possible, fit });
    return config;
  };
  assert.equal(sharingCandidate(t3web()), true);
  assert.equal(sharingCandidate(t3server()), true);
  // c4 is neutral to slightly worse, and c8 and c12 are unmeasured: the rule starts at 12.
  assert.equal(minSharingCheckers, 12);
  assert.equal(sharingCandidate(t3web(11)), false);
  assert.equal(at(t3web(11)).share, false);
  // F = max(declaration, node_modules share) of 0.40: TypeORM and VS Code are at 0.08, Sentry at 0.26.
  assert.equal(sharingFileShare, 0.4);
  const typeorm = signals(16, 12_145_000, 889_000);
  typeorm.declarationShare = 0.08;
  typeorm.nodeModulesShare = 0.05;
  assert.equal(sharingCandidate(typeorm), false);
  assert.equal(at(typeorm).share, false);
  const sentry = signals(16, 5_704_000, 3_037_000);
  sentry.declarationShare = 0.21;
  sentry.nodeModulesShare = 0.26;
  assert.equal(sharingCandidate(sentry), false);
  assert.equal(at(sentry).share, false);
  // The ranges must mostly resolve the same large libraries: Excalidraw reaches 1.4M.
  const excalidraw = signals(16, 1_400_000, 150_000);
  excalidraw.declarationShare = 0.5;
  excalidraw.nodeModulesShare = 0.6;
  assert.equal(isLibraryBound(1_400_000, 150_000), false);
  assert.equal(sharingCandidate(excalidraw), false);
  // The count it leaves must fit memory with the peak sharing adds (1.12 of the estimate): the cut
  // count, which is 12 here, not the plan's 16.
  assert.equal(sharingPeakShare, 1.12);
  assert.equal(at(t3web(), { sharing: 11 }).share, false);
  assert.equal(at(t3web(), { sharing: 12 }).share, true);
  // A cut below the count sharing was measured at does not share: 13 checkers leave 10.
  assert.equal(libraryBoundCount(13, 12_145_000, 889_000), 10);
  assert.equal(at(t3web(13), { sharing: 16 }).share, false);
  // TSC_TS_AUTO=0 keeps the decisions of a run before the rule.
  const off = preParseConfig({}, 16, { TSC_TS_AUTO: '0' });
  assert.equal(decideCheck(off, t3web(), { possible: true, fit: { sharing: 16 } }), 12);
  assert.equal(off.share, false);
  // TSC_TS_AUTO=static keeps the rule: it is what a run without records uses.
  const staticRun = preParseConfig({}, 16, { TSC_TS_AUTO: 'static' });
  assert.equal(decideCheck(staticRun, t3web(), { possible: true, fit: { sharing: 16 } }), 12);
  assert.equal(staticRun.share, true);
});

test('TSC_TS_AUTO=0 still collects the signals the library-bound cut reads', () => {
  // With selection off the sharing rule is not consulted, but the cut is: an unpinned count at more
  // than tsgo's four is still cut to three quarters where the ranges mostly resolve large libraries,
  // and the cut reads the ranges' characters. Dropping the signals with the rule would leave the cut
  // with zeros and run every checker.
  const off = preParseConfig({}, 16, { TSC_TS_AUTO: '0' });
  assert.equal(off.checkersSource, Source.Default);
  assert.equal(signalsNeeded(off, 16), true);
  assert.equal(signalsNeeded(off, 4), false);
  assert.equal(decideCheck(off, signals(16, 12_145_000, 889_000)), 12);
  // A pinned count is never cut, and reads nothing.
  const pinned = preParseConfig({ checkers: 16 }, 16, { TSC_TS_AUTO: '0' });
  assert.equal(signalsNeeded(pinned, 16), false);
  // With selection on, the sharing rule reads them at 12 checkers or more, where the count is not
  // pinned either; the cut reads them above tsgo's four.
  const on = preParseConfig({}, 16, {});
  assert.equal(signalsNeeded(on, 16), true);
  const countPinned = preParseConfig({ checkers: 12 }, 12, {});
  assert.equal(countPinned.checkersSource, Source.Pinned);
  assert.equal(countPinned.shareSource, Source.Default);
  assert.equal(signalsNeeded(countPinned, 12), true);
  assert.equal(signalsNeeded(preParseConfig({ checkers: 11 }, 11, {}), 11), false);
  // A count and sharing both pinned: no rule reads them, and the pass over the ranges is not made.
  const both = preParseConfig({ checkers: 16 }, 16, { TSC_TS_SHARE: '1' });
  assert.equal(signalsNeeded(both, 16), false);
});

test('the sharing window counts unpacking inside translating, not on both sides', () => {
  // Two checkers that each exported 50 ms and translated 50 ms of records, 75 ms of that unpacking
  // them, and each saved 150 ms of computation by translating instead. Unpacking is timed inside the
  // translation that reads the records (`ThreadSharing.translatePosted`), so what posting cost is 200
  // ms over the two: 300 saved for 200 spent is past the 1.5-times threshold, and sharing keeps
  // running. Counted on both sides it would be 350 spent, and the window would stop what pays.
  const stats = new Float64Array(shareStatColumns * 2);
  for (let i = 0; i < 2; i++) {
    const row = i * shareStatColumns;
    stats[row + shareStatExport] = 50;
    stats[row + shareStatTranslation] = 50;
    stats[row + shareStatUnpack] = 75;
    stats[row + shareStatSaved] = 150;
  }
  const numbers = sharingNumbers(stats, 2);
  assert.equal(numbers.saved, 300);
  assert.equal(numbers.spent, 200);
  assert.equal(stopLevel(numbers), 0);
  // Without the saving, what posting costs is what stops it.
  stats[shareStatSaved] = 0;
  stats[shareStatColumns + shareStatSaved] = 0;
  assert.equal(stopLevel(sharingNumbers(stats, 2)), 2);
});

test('CheckSignals.fileShare is the larger of the declaration and node_modules shares', () => {
  const s = new CheckSignals(16, 16);
  s.declarationShare = 0.23;
  s.nodeModulesShare = 0.26;
  assert.equal(s.fileShare, 0.26);
  s.nodeModulesShare = 0.08;
  assert.equal(s.fileShare, 0.23);
});

// Learning (DESIGN 3-5): the record's samples decide a run's configuration where the static rules are
// uncertain, within the margins the record's own noise allows.

const now = Math.floor(Date.now() / 1000);

/** A program's shape, as a record keeps it: 800 files, ranges that reach 1M library characters. */
function recordShape(extra = {}) {
  return {
    files: 800,
    chars: 5_000_000,
    declarationChars: 1_000_000,
    checkChars: 4_000_000,
    library: 1_000_000,
    own: 5_000_000,
    redundancy: 0.05,
    fileShare: 0.05,
    ...extra,
  };
}

function recordChoice(extra = {}) {
  return { checkers: 16, share: false, parseThreads: defaultParseThreads(16), source: 'default', since: 0, ...extra };
}

/** The samples of `list`, numbered from run 1; each entry gives its own fields. */
function samplesOf(list, extra = {}) {
  return list.map((sample, index) => ({
    run: index + 1,
    at: now - 60 * (list.length - index),
    role: 'chosen',
    checkers: 16,
    share: false,
    parseThreads: defaultParseThreads(16),
    parseMs: 100,
    checkMs: 100,
    totalMs: 1000,
    cpuMs: 900,
    peakMB: 500,
    load: 0.1,
    ...extra,
    ...sample,
  }));
}

/** A record of these samples; `extra` overrides its other fields. */
function recordOf(samples, extra = {}) {
  return {
    format: 1,
    shape: recordShape(),
    runs: samples.length,
    lastExplore: 0,
    lastControl: 0,
    chosen: recordChoice(),
    samples,
    ...extra,
  };
}

/** Signals that leave the static rules with 16 checkers and no sharing. */
function quietSignals(extra = {}) {
  const s = signals(16, 1_000_000, 5_000_000);
  return Object.assign(s, extra);
}

/** What a run's bound program gives `decideCheck`: no sharing, 16 CPUs, 32 GB. */
function quietDecision(extra = {}) {
  return { possible: false, fit: undefined, cpus: 16, memoryBytes: 32 * 2 ** 30, now, ...extra };
}

/**
 * The configuration a run of `signals` makes when it read `record` before parsing; `explore` is the run's
 * `TSC_TS_AUTO=explore`, off by default like every run that does not set it.
 */
function recordRun(record, signals = quietSignals(), decision = quietDecision(), explore = false) {
  const config = new RunConfig();
  config.explore = explore;
  config.checkers = 16;
  config.record = record;
  decideCheck(config, signals, decision);
  return config;
}

/** The sample a run of `config` writes, as `nextRecord` takes it (the run number is added there). */
function sampleOfRun(config, extra = {}) {
  return {
    at: now,
    role: config.role,
    checkers: config.checkers,
    share: config.share,
    parseThreads: config.parseThreads,
    parseMs: 100,
    checkMs: 100,
    totalMs: 1000,
    cpuMs: 900,
    peakMB: 500,
    load: 0.1,
    ...extra,
  };
}

test('a comparison needs the margin its own noise allows', () => {
  assert.equal(medianOf([]), undefined);
  assert.equal(medianOf([1, 2, 3]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(noiseOf([100, 100, 100]), 0);
  assert.ok(Math.abs(noiseOf([80, 100, 120]) - 0.29652) < 1e-4);
  assert.equal(marginOf([100, 100, 100], [100, 100, 100]), 0.03);
  assert.ok(Math.abs(marginOf([80, 100, 120], [100, 100, 100]) - 0.59304) < 1e-4);
  // Faster by the margin, and only then: 40% is a win, 2% is inside the floor.
  assert.equal(beatsBy([60, 60, 60], [100, 100, 100]), 0.4);
  assert.equal(beatsBy([98, 98, 98], [100, 100, 100]), undefined);
  assert.equal(beatsBy([60, 60], [100, 100, 100]), undefined);
  assert.equal(beatsBy([100, 100, 100], [60, 60, 60]), undefined);
  // Samples the machine was busy for are kept but decide nothing.
  const busy = recordOf(samplesOf([{ checkMs: 100, load: 0.9 }, { checkMs: 100 }]));
  assert.equal(usableSamples(busy).length, 1);
});

test('the sharing window is a tenth of the recorded check, at least 200 ms', () => {
  assert.equal(shareWindow, 300);
  assert.equal(shareWindowOf(undefined, 16, false), 300);
  assert.equal(shareWindowOf(recordOf([]), 16, false), 300);
  assert.equal(shareWindowOf(recordOf(samplesOf([{ checkMs: 1000 }])), 16, false), 200);
  assert.equal(shareWindowOf(recordOf(samplesOf([{ checkMs: 3000 }])), 16, false), 300);
  assert.equal(shareWindowOf(recordOf(samplesOf([{ checkers: 8, checkMs: 5000 }])), 16, false), 300);
  assert.equal(shareWindowOf(recordOf(samplesOf([{ checkers: 8, checkMs: 5000 }])), 8, false), 500);
});

test('a configuration the record shows faster is adopted, with the margin it won by', () => {
  const samples = samplesOf([
    { checkers: 16, checkMs: 100 },
    { checkers: 16, checkMs: 100 },
    { checkers: 16, checkMs: 100 },
    { checkers: 12, checkMs: 60 },
    { checkers: 12, checkMs: 60 },
    { checkers: 12, checkMs: 60 },
  ]);
  const config = recordRun(recordOf(samples));
  assert.equal(config.checkers, 12);
  assert.equal(config.checkersSource, Source.Learned);
  assert.deepEqual(config.checkersReasons, ['check 40% faster over 3 runs']);
  // The record keeps the configuration for the next run.
  assert.deepEqual(config.chosen, {
    checkers: 12,
    share: false,
    parseThreads: defaultParseThreads(16),
    source: 'learned',
    since: 0,
  });

  // Sharing is adopted the same way, where the run can share.
  const sharing = recordRun(
    recordOf(
      samplesOf([
        { checkers: 16, share: false, checkMs: 100 },
        { checkers: 16, share: false, checkMs: 100 },
        { checkers: 16, share: false, checkMs: 100 },
        { checkers: 16, share: true, checkMs: 60 },
        { checkers: 16, share: true, checkMs: 60 },
        { checkers: 16, share: true, checkMs: 60 },
      ]),
    ),
    quietSignals(),
    quietDecision({ possible: true, fit: { sharing: 16 } }),
  );
  assert.equal(sharing.share, true);
  assert.equal(sharing.shareSource, Source.Learned);
  assert.deepEqual(sharing.shareReasons, ['check 40% faster over 3 runs']);

  // A configuration whose samples reached the memory limit is not chosen (DESIGN 5.5).
  const peaked = samples.map((s) => (s.checkers === 12 ? { ...s, peakMB: 30_000 } : s));
  const limited = recordRun(recordOf(peaked), quietSignals(), quietDecision({ memoryBytes: 16 * 2 ** 30 }));
  assert.equal(limited.checkers, 16);
  assert.equal(limited.chosen.checkers, 16);
});

test("samples a doctor run measured are evidence for adoption like any other run's", () => {
  // The alternative's samples come from `tsc-ts doctor` and from a run pinned to that count; the static
  // choice's from an ordinary run and a control run. Every one of them counts, with no exploration.
  const record = recordOf(
    samplesOf([
      { checkers: 16, checkMs: 100, role: 'chosen' },
      { checkers: 16, checkMs: 100, role: 'control' },
      { checkers: 16, checkMs: 100, role: 'chosen' },
      { checkers: 12, checkMs: 60, role: 'doctor' },
      { checkers: 12, checkMs: 60, role: 'doctor' },
      { checkers: 12, checkMs: 60, role: 'chosen' },
    ]),
  );
  const config = recordRun(record);
  assert.equal(config.checkers, 12);
  assert.equal(config.checkersSource, Source.Learned);
  assert.deepEqual(config.checkersReasons, ['check 40% faster over 3 runs']);
  assert.equal(config.role, 'chosen');
});

test('learning reads the sharing fit where the static rule turns sharing off', () => {
  // Half the files are declarations, but the ranges are not library-bound: the static rule is off.
  const band = quietSignals({ declarationShare: 0.5 });
  assert.equal(sharingCandidate(band), false);
  const learning = new RunConfig();
  learning.record = recordOf([]);
  assert.equal(sharingFitNeeded(learning, band), true);
  // With nothing to learn from, or with the learning rules off, no rule reads the estimate.
  learning.record = undefined;
  assert.equal(sharingFitNeeded(learning, band), false);
  learning.record = recordOf([]);
  learning.automaticity = Automaticity.Static;
  assert.equal(sharingFitNeeded(learning, band), false);
  learning.automaticity = Automaticity.Off;
  assert.equal(sharingFitNeeded(learning, band), false);
  learning.automaticity = Automaticity.On;
  learning.shareSource = Source.Pinned;
  assert.equal(sharingFitNeeded(learning, band), false);
  // The static rule's own signals read it, with or without a record.
  const candidate = quietSignals({ declarationShare: 0.5, library: 8_000_000, own: 1_000_000 });
  assert.equal(sharingCandidate(candidate), true);
  assert.equal(sharingFitNeeded(new RunConfig(), candidate), true);
});

test('samples that show sharing faster adopt it where the static rule leaves it off', () => {
  const band = quietSignals({ declarationShare: 0.5 });
  assert.equal(sharingCandidate(band), false);
  const record = recordOf(
    samplesOf([
      { checkers: 16, share: true, checkMs: 60 },
      { checkers: 16, share: true, checkMs: 60 },
      { checkers: 16, share: true, checkMs: 60 },
      { checkers: 16, share: false, checkMs: 100 },
      { checkers: 16, share: false, checkMs: 100 },
      { checkers: 16, share: false, checkMs: 100 },
    ]),
  );
  const config = recordRun(record, band, quietDecision({ possible: true, fit: { sharing: 16 } }));
  assert.equal(config.share, true);
  assert.equal(config.shareSource, Source.Learned);
  assert.deepEqual(config.shareReasons, ['check 40% faster over 3 runs']);
  assert.equal(config.chosen.share, true);
  // The same samples adopt nothing where the program may not share: the fit is what decides it.
  const alone = recordRun(record, band);
  assert.equal(alone.share, false);
  assert.equal(alone.shareSource, Source.Default);
});

test('an adopted configuration stays until the static one beats it, and reverts when it does', () => {
  const adopted = recordChoice({ checkers: 12, source: 'learned', since: 1 });
  const kept = recordRun(
    recordOf(
      samplesOf([
        { checkers: 12, checkMs: 99 },
        { checkers: 12, checkMs: 99 },
        { checkers: 12, checkMs: 99 },
        { checkers: 16, checkMs: 100 },
        { checkers: 16, checkMs: 100 },
        { checkers: 16, checkMs: 100 },
      ]),
      { chosen: adopted },
    ),
  );
  // 1% is inside the margin: the adopted count stays.
  assert.equal(kept.checkers, 12);
  assert.equal(kept.checkersSource, Source.Learned);
  assert.deepEqual(kept.checkersReasons, ['check measured over 3 runs']);
  assert.equal(kept.chosen.checkers, 12);

  // The static choice 25% faster is past the margin, in both directions.
  const reverted = recordRun(
    recordOf(
      samplesOf([
        { checkers: 12, checkMs: 125 },
        { checkers: 12, checkMs: 125 },
        { checkers: 12, checkMs: 125 },
        { checkers: 16, checkMs: 100 },
        { checkers: 16, checkMs: 100 },
        { checkers: 16, checkMs: 100 },
      ]),
      { chosen: adopted },
    ),
  );
  assert.equal(reverted.checkers, 16);
  assert.equal(reverted.checkersSource, Source.Default);
  assert.equal(reverted.chosen.checkers, 16);
});

test('an adopted configuration whose last samples are slower than control reverts at once', () => {
  const samples = samplesOf([
    { checkers: 12, checkMs: 200 },
    { checkers: 12, checkMs: 200 },
    { checkers: 12, checkMs: 200 },
    { checkers: 16, role: 'control', checkMs: 100 },
    { checkers: 16, role: 'control', checkMs: 100 },
  ]);
  // Two control samples are one short of a comparison, so the margin rule cannot revert it.
  assert.equal(beatsBy(checkTimes(samples, 16, false), checkTimes(samples, 12, false)), undefined);
  assert.equal(fastRevert(usableSamples(recordOf(samples)), 12, false), true);
  // One adopted sample inside the margin is enough to keep it.
  assert.equal(
    fastRevert(usableSamples(recordOf(samples.map((s, i) => (i === 2 ? { ...s, checkMs: 101 } : s)))), 12, false),
    false,
  );
  const config = recordRun(recordOf(samples, { chosen: recordChoice({ checkers: 12, source: 'learned', since: 1 }) }));
  assert.equal(config.checkers, 16);
  assert.equal(config.chosen.checkers, 16);
});

test('a configuration fastRevert rejects is not adopted again from its older samples', () => {
  // Six samples from when the learned count was faster still dominate its median, while its last three
  // runs fell behind the control samples: the medians alone would adopt it again in the same run.
  const samples = samplesOf([
    ...Array.from({ length: 6 }, () => ({ checkers: 12, checkMs: 60 })),
    ...Array.from({ length: 3 }, () => ({ checkers: 12, checkMs: 200 })),
    ...Array.from({ length: 3 }, () => ({ checkers: 16, role: 'control', checkMs: 100 })),
    ...Array.from({ length: 3 }, () => ({ checkers: 16, checkMs: 100 })),
  ]);
  assert.equal(beatsBy(checkTimes(samples, 12, false), checkTimes(samples, 16, false)), 0.4);
  assert.equal(fastRevert(usableSamples(recordOf(samples)), 12, false), true);
  const config = recordRun(recordOf(samples, { chosen: recordChoice({ checkers: 12, source: 'learned', since: 1 }) }));
  assert.equal(config.checkers, 16);
  assert.equal(config.checkersSource, Source.Default);
  assert.equal(config.chosen.checkers, 16);
});

test('a fast revert is kept in the record, so the next run does not re-adopt what it gave up', () => {
  const learned = recordChoice({ checkers: 12, source: 'learned', since: 1 });
  const samples = samplesOf([
    ...Array.from({ length: 6 }, () => ({ checkers: 12, checkMs: 60 })),
    ...Array.from({ length: 3 }, () => ({ checkers: 12, checkMs: 200 })),
    ...Array.from({ length: 3 }, () => ({ checkers: 16, role: 'control', checkMs: 100 })),
  ]);
  const record = recordOf(samples, { chosen: learned });
  const reverted = recordRun(record);
  assert.equal(reverted.checkers, 16);
  assert.deepEqual(reverted.rejected, { checkers: 12, share: false, run: record.runs });
  // The run writes its record, and the next run reads it: the count the revert gave up is not adopted
  // again from the six samples it won on back when it was faster.
  const written = nextRecord(record, sampleOfRun(reverted), recordShape(), reverted.chosen, reverted.rejected);
  assert.deepEqual(written.rejected, { checkers: 12, share: false, run: record.runs });
  const next = recordRun(written);
  assert.equal(next.checkers, 16);
  assert.equal(next.checkersSource, Source.Default);
  // Without the rejection, the same samples adopt it again: that is what the record keeps it for.
  const forgetful = recordRun(recordOf(written.samples, { chosen: reverted.chosen }));
  assert.equal(forgetful.checkers, 12);
});

test('a pinned sharing on learns the checker count its samples show faster', () => {
  // TSC_TS_SHARE=1 pins sharing on; the samples show twelve checkers faster than sixteen with it.
  const samples = samplesOf([
    ...Array.from({ length: 3 }, () => ({ checkers: 16, share: true, checkMs: 100 })),
    ...Array.from({ length: 3 }, () => ({ checkers: 12, share: true, checkMs: 60 })),
  ]);
  const record = recordOf(samples);
  const pinned = preParseConfig({}, 16, { TSC_TS_SHARE: '1' }, record);
  assert.equal(pinned.share, true);
  assert.equal(pinned.shareSource, Source.Pinned);
  // The count the run may adopt with that sharing reads how many checkers fit memory with it.
  assert.equal(sharingFitNeeded(pinned, quietSignals()), true);
  decideCheck(pinned, quietSignals(), quietDecision({ possible: true, fit: { sharing: 16 } }));
  assert.equal(pinned.share, true);
  assert.equal(pinned.checkers, 12);
  assert.equal(pinned.checkersSource, Source.Learned);
  // A pinned count no rule may change, and a sharing pinned off, read no fit.
  const both = preParseConfig({ checkers: 16 }, 16, { TSC_TS_SHARE: '1' }, record);
  assert.equal(sharingFitNeeded(both, quietSignals()), false);
  const off = preParseConfig({}, 16, { TSC_TS_SHARE: '0' }, record);
  assert.equal(sharingFitNeeded(off, quietSignals()), false);
});

test('a count a pinned first run stored is not learned when the pin is removed', () => {
  const parseDefault = defaultParseThreads(16);
  const pinned = Math.max(1, Math.ceil(parseDefault / 3));
  if (pinned >= parseDefault) return;
  // The first run has no record to read, so it writes the parse threads its pin made it use, and the
  // samples of that one run hold that count alone: no comparison makes it learned.
  const first = preParseConfig({}, 16, { TSC_TS_PARSE_THREADS: String(pinned) });
  assert.equal(first.parseThreads, pinned);
  decideCheck(first, quietSignals(), quietDecision());
  const written = nextRecord(undefined, sampleOfRun(first), recordShape(), {
    checkers: first.checkers,
    share: first.share,
    parseThreads: first.parseThreads,
    source: 'pinned',
    since: 0,
  });
  assert.equal(written.chosen.parseThreads, pinned);
  // With the pin gone, the run parses with the default, and the record it keeps says so.
  const second = preParseConfig({}, 16, {}, written);
  assert.equal(second.parseThreads, parseDefault);
  assert.equal(second.parseSource, Source.Default);
  const after = recordRun(written);
  assert.equal(after.chosen.parseThreads, parseDefault);
  assert.equal(after.chosen.source, 'default');
});

test('one run in 16 re-measures the static choice, as does the first after two weeks', () => {
  const learned = recordChoice({ checkers: 12, source: 'learned', since: 1 });
  const samples = samplesOf([
    { checkers: 12, checkMs: 99 },
    { checkers: 12, checkMs: 99 },
    { checkers: 12, checkMs: 99 },
  ]);
  // The 16th run after the last control at run 0 is a control run, and it parses with the default threads.
  const due = preParseConfig({}, 16, {}, recordOf(samples, { runs: 16, chosen: learned }));
  assert.equal(due.role, 'control');
  assert.equal(due.parseSource, Source.Control);
  assert.equal(due.parseThreads, defaultParseThreads(16));
  decideCheck(due, quietSignals(), quietDecision());
  // It uses the static choice, and keeps the learned one for the next run.
  assert.equal(due.checkers, 16);
  assert.equal(due.checkersSource, Source.Control);
  assert.equal(due.chosen.checkers, 12);
  // The run before is not due yet.
  const early = preParseConfig({}, 16, {}, recordOf(samples, { runs: 15, chosen: learned }));
  assert.equal(early.role, 'chosen');
  // The first run after 14 days is due, whatever the run count.
  const stale = recordOf(
    samples.map((s) => ({ ...s, at: now - 15 * 86400 })),
    { runs: 5, chosen: learned },
  );
  assert.equal(preParseConfig({}, 16, {}, stale).role, 'control');
  // TSC_TS_AUTO=static keeps no record, and no control run.
  assert.equal(preParseConfig({}, 16, { TSC_TS_AUTO: 'static' }, stale).role, 'chosen');
});

test('the record chooses the parse threads it adopted, and why', () => {
  const parseDefault = defaultParseThreads(16);
  const half = Math.ceil(parseDefault / 2);
  const samples = samplesOf([
    { parseThreads: half, parseMs: 80 },
    { parseThreads: half, parseMs: 80 },
    { parseThreads: half, parseMs: 80 },
    { parseThreads: parseDefault, parseMs: 100 },
    { parseThreads: parseDefault, parseMs: 100 },
    { parseThreads: parseDefault, parseMs: 100 },
  ]);
  const record = recordOf(samples, { chosen: recordChoice({ parseThreads: half, source: 'learned', since: 1 }) });
  const config = preParseConfig({}, 16, {}, record);
  assert.equal(config.parseThreads, half);
  assert.equal(config.parseSource, Source.Learned);
  assert.deepEqual(config.parseReasons, ['parse 20% faster over 3 runs']);
  assert.equal(config.role, 'chosen');
  // A pin wins over the record.
  const pinned = preParseConfig({}, 16, { TSC_TS_PARSE_THREADS: '3' }, record);
  assert.equal(pinned.parseThreads, 3);
  assert.equal(pinned.parseSource, Source.Pinned);
  // Three explored samples of half the default adopt them for the next run.
  const explored = recordOf(
    samplesOf([
      { parseThreads: half, parseMs: 80 },
      { parseThreads: half, parseMs: 80 },
      { parseThreads: half, parseMs: 80 },
      { parseThreads: parseDefault, parseMs: 100 },
      { parseThreads: parseDefault, parseMs: 100 },
      { parseThreads: parseDefault, parseMs: 100 },
    ]),
  );
  const adopted = recordRun(explored);
  assert.equal(adopted.chosen.parseThreads, half);
  assert.equal(adopted.chosen.source, 'learned');
  // A learned choice the default beats by the margin goes back to the default.
  const worse = recordOf(
    samplesOf([
      { parseThreads: half, parseMs: 125 },
      { parseThreads: half, parseMs: 125 },
      { parseThreads: half, parseMs: 125 },
      { parseThreads: parseDefault, parseMs: 100 },
      { parseThreads: parseDefault, parseMs: 100 },
      { parseThreads: parseDefault, parseMs: 100 },
    ]),
    { chosen: recordChoice({ parseThreads: half, source: 'learned', since: 1 }) },
  );
  assert.equal(recordRun(worse).chosen.parseThreads, parseDefault);
});

test('a count a pin left in the record is not learned without the comparison', () => {
  const parseDefault = defaultParseThreads(16);
  const pinned = Math.ceil(parseDefault / 2);
  if (pinned >= parseDefault) return;
  // The first run had no record, so it recorded the parse threads its pin made it use, as the default
  // source, and only that run's sample. Removing the pin does not make the count learned: the samples
  // of one arm are no comparison.
  const record = recordOf(samplesOf([{ parseThreads: pinned, parseMs: 80 }]), {
    chosen: recordChoice({ parseThreads: pinned, source: 'default' }),
  });
  const config = preParseConfig({}, 16, {}, record);
  assert.equal(config.parseThreads, parseDefault);
  assert.equal(config.parseSource, Source.Default);
  assert.deepEqual(config.parseReasons, []);
  assert.equal(config.role, 'chosen');
  // The comparison the samples do hold adopts it.
  const compared = recordOf(
    samplesOf([
      { parseThreads: pinned, parseMs: 80 },
      { parseThreads: pinned, parseMs: 80 },
      { parseThreads: pinned, parseMs: 80 },
      { parseThreads: parseDefault, parseMs: 100 },
      { parseThreads: parseDefault, parseMs: 100 },
      { parseThreads: parseDefault, parseMs: 100 },
    ]),
    { chosen: recordChoice({ parseThreads: pinned, source: 'default' }) },
  );
  assert.equal(preParseConfig({}, 16, {}, compared).parseThreads, pinned);
});

test('a record that leaves the parse threads open tries half of them, once in eight runs', () => {
  const parseDefault = defaultParseThreads(16);
  if (parseDefault < 2) return;
  const half = Math.ceil(parseDefault / 2);
  const exploring = { TSC_TS_AUTO: 'explore' };
  const samples = samplesOf(Array.from({ length: 8 }, () => ({ parseThreads: parseDefault, checkMs: 2500 })));
  const config = preParseConfig({}, 16, exploring, recordOf(samples));
  assert.equal(config.parseThreads, half);
  assert.equal(config.parseSource, Source.Explore);
  assert.equal(config.role, 'explore');
  // The run measures the parse threads alone: the checker count stays the static choice.
  decideCheck(config, quietSignals(), quietDecision());
  assert.equal(config.checkers, 16);
  assert.equal(config.checkersSource, Source.Default);
  // The same record without `TSC_TS_AUTO=explore` tries nothing: exploration is experimental.
  const off = preParseConfig({}, 16, {}, recordOf(samples));
  assert.equal(off.parseThreads, parseDefault);
  assert.equal(off.parseSource, Source.Default);
  assert.equal(off.role, 'chosen');
  // A check too short for the parse to show, or too few runs since the last exploration, tries nothing.
  const short = preParseConfig({}, 16, exploring, recordOf(samples.map((s) => ({ ...s, checkMs: 300 }))));
  assert.equal(short.parseThreads, parseDefault);
  assert.equal(short.parseSource, Source.Default);
  const young = preParseConfig({}, 16, exploring, recordOf(samples, { runs: 7 }));
  assert.equal(young.parseThreads, parseDefault);
  // CI and a concurrent build never explore, even with the mode on.
  assert.equal(preParseConfig({}, 16, { ...exploring, CI: 'true' }, recordOf(samples)).parseThreads, parseDefault);
  assert.equal(preParseConfig({}, 16, exploring, recordOf(samples), false).parseThreads, parseDefault);
  // A record whose checker count is still uncertain has that candidate measured first.
  const band = { shape: recordShape({ library: 4_000_000, own: 1_000_000 }) };
  assert.equal(preParseConfig({}, 16, exploring, recordOf(samples, band)).parseThreads, parseDefault);
  // Once every count candidate has its three samples, the parse threads have their turn. The candidates
  // are three quarters of the count and the machine's CPUs, which machines count differently.
  const counts = [...new Set([Math.ceil((16 * 3) / 4), Math.min(availableParallelism(), 16)])].filter(
    (checkers) => checkers !== 16,
  );
  const closed = samplesOf([
    ...Array.from({ length: 8 }, () => ({ checkMs: 2500 })),
    ...counts.flatMap((checkers) => Array.from({ length: 3 }, () => ({ checkers, checkMs: 2500 }))),
  ]);
  const open = preParseConfig({}, 16, exploring, recordOf(closed, band));
  assert.equal(open.parseThreads, half);
  assert.equal(open.parseSource, Source.Explore);
});

test('a run adopts what the record measured, and explores only with TSC_TS_AUTO=explore', () => {
  // Twelve checkers measured faster than sixteen, and signals whose band would be explored.
  const band = quietSignals({ library: 4_000_000, own: 1_000_000 });
  const record = recordOf(
    samplesOf([
      ...Array.from({ length: 3 }, () => ({ checkers: 12, checkMs: 2000 })),
      ...Array.from({ length: 3 }, () => ({ checkers: 16, checkMs: 2500 })),
    ]),
  );
  // By default a run reads the record and tries nothing: the measured count is adopted, and the run is
  // the configuration it would have used without the record.
  assert.equal(preParseConfig({}, 16, {}, record).explore, false);
  const adopted = recordRun(record, band);
  assert.equal(adopted.checkers, 12);
  assert.equal(adopted.checkersSource, Source.Learned);
  assert.equal(adopted.role, 'chosen');
  // TSC_TS_AUTO=explore turns the exploration on, and the measured count still wins over it.
  assert.equal(preParseConfig({}, 16, { TSC_TS_AUTO: 'explore' }, record).explore, true);
  const exploring = recordRun(record, band, quietDecision(), true);
  assert.equal(exploring.checkers, 12);
  assert.equal(exploring.checkersSource, Source.Learned);
  assert.equal(exploring.role, 'chosen');
  // The mode keeps the records: it learns from them.
  assert.equal(recordsAllowed({}), true);
  assert.equal(recordsAllowed({ TSC_TS_AUTO: 'explore' }), true);
  assert.equal(recordsAllowed({ TSC_TS_AUTO: 'static' }), false);
  assert.equal(recordsAllowed({ TSC_TS_AUTO: '0' }), false);
  assert.equal(recordsAllowed({ TSC_TS_AUTO: 'explore', TSC_TS_CACHE: '0' }), false);
});

test('signals that leave the checker count uncertain explore three quarters of it', () => {
  const band = quietSignals({ library: 4_000_000, own: 1_000_000 });
  assert.equal(checkersBand(band), true);
  const samples = samplesOf(Array.from({ length: 8 }, () => ({ checkMs: 2500 })));
  const config = recordRun(recordOf(samples), band, quietDecision(), true);
  assert.equal(config.checkers, 12);
  assert.equal(config.checkersSource, Source.Explore);
  assert.equal(config.role, 'explore');
  assert.deepEqual(config.checkersReasons, []);
  // A candidate that lost twice is not tried again.
  const lost = samplesOf([
    { checkers: 16, checkMs: 2500 },
    { checkers: 16, checkMs: 2500 },
    { checkers: 16, checkMs: 2500 },
    { checkers: 12, checkMs: 3000 },
    { checkers: 12, checkMs: 3000 },
  ]);
  const closed = recordRun(recordOf(lost, { runs: 8 }), band, quietDecision(), true);
  assert.equal(closed.checkers, 16);
  assert.equal(closed.role, 'chosen');
});

test('signals that leave sharing uncertain explore it, when sharing is possible', () => {
  // 50% of the files are declarations, but the ranges are not library-bound: one of the two tests holds.
  const band = quietSignals({ declarationShare: 0.5 });
  assert.equal(sharingBand(band), true);
  assert.equal(sharingCandidate(band), false);
  const samples = samplesOf(Array.from({ length: 8 }, () => ({ checkMs: 2500 })));
  const config = recordRun(recordOf(samples), band, quietDecision({ possible: true, fit: { sharing: 16 } }), true);
  assert.equal(config.share, true);
  assert.equal(config.shareSource, Source.Explore);
  assert.equal(config.role, 'explore');
  // No shared program, no exploration of it.
  const alone = recordRun(recordOf(samples), band, quietDecision(), true);
  assert.equal(alone.share, false);
  assert.equal(alone.role, 'chosen');
});

test('a pin keeps the checker count the count band would try', () => {
  // The band would try three quarters of the count, and a pin keeps the count it fixed.
  const band = quietSignals({ library: 4_000_000, own: 1_000_000 });
  const samples = samplesOf(Array.from({ length: 8 }, () => ({ checkMs: 2500 })));
  const pinned = new RunConfig();
  pinned.explore = true;
  pinned.checkers = 16;
  pinned.checkersSource = Source.Pinned;
  pinned.checkersPin = '--checkers';
  pinned.record = recordOf(samples);
  decideCheck(pinned, band, quietDecision());
  assert.equal(pinned.checkers, 16);
  assert.equal(pinned.checkersSource, Source.Pinned);
  assert.equal(pinned.role, 'chosen');
  // A pin on sharing does not keep the count from the exploration its own band allows.
  const countOpen = new RunConfig();
  countOpen.explore = true;
  countOpen.checkers = 16;
  countOpen.share = false;
  countOpen.shareSource = Source.Pinned;
  countOpen.sharePin = 'TSC_TS_SHARE';
  countOpen.record = recordOf(samples);
  decideCheck(countOpen, band, quietDecision());
  assert.equal(countOpen.checkers, 12);
  assert.equal(countOpen.checkersSource, Source.Explore);
  assert.equal(countOpen.role, 'explore');
});

test('a pin keeps the sharing the sharing band would try', () => {
  // One of the static rule's two tests holds, and the band would turn sharing on at 16 checkers.
  const band = quietSignals({ declarationShare: 0.5 });
  assert.equal(sharingBand(band), true);
  const samples = recordOf(samplesOf(Array.from({ length: 8 }, () => ({ checkMs: 2500 }))));
  const pinned = new RunConfig();
  pinned.explore = true;
  pinned.checkers = 16;
  pinned.share = false;
  pinned.shareSource = Source.Pinned;
  pinned.sharePin = 'TSC_TS_SHARE';
  pinned.record = samples;
  decideCheck(pinned, band, quietDecision({ possible: true, fit: { sharing: 16 } }));
  assert.equal(pinned.share, false);
  assert.equal(pinned.shareSource, Source.Pinned);
  assert.equal(pinned.role, 'chosen');
  // A pin on the count does not keep sharing from the exploration its own band allows.
  const shareOpen = new RunConfig();
  shareOpen.explore = true;
  shareOpen.checkers = 16;
  shareOpen.checkersSource = Source.Pinned;
  shareOpen.checkersPin = '--checkers';
  shareOpen.record = samples;
  decideCheck(shareOpen, band, quietDecision({ possible: true, fit: { sharing: 16 } }));
  assert.equal(shareOpen.share, true);
  assert.equal(shareOpen.shareSource, Source.Explore);
  assert.equal(shareOpen.role, 'explore');
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

test('the section names the record, or says why the run kept none', () => {
  const config = new RunConfig();
  const named = output();
  reportRunConfig(named, config, { path: '~/.cache/tsc-ts/runs-v1/3f9a.json' });
  assert.match(named.text, /^ {2}Records: ~\/\.cache\/tsc-ts\/runs-v1\/3f9a\.json$/m);

  const off = output();
  reportRunConfig(off, config, { off: 'watch mode' });
  assert.match(off.text, /^ {2}Records: off \(watch mode\)$/m);

  const unavailable = output();
  reportRunConfig(unavailable, config, { unavailable: 'EACCES: permission denied' });
  assert.match(unavailable.text, /^ {2}Records: unavailable \(EACCES: permission denied\)$/m);

  const none = output();
  reportRunConfig(none, config);
  assert.doesNotMatch(none.text, /Records:/);
});

// ---- the command line

const skip = tscTsMissing;

/** Runs tsc-ts in `dir` with `args`, and the lib files of the TypeScript the harness compares against. */
function run(dir, args, env = {}) {
  const result = spawnSync(tscTs[0], [...tscTs.slice(1), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: typescriptLib, NO_COLOR: '1', TSC_TS_CACHE: '0', ...env },
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

/** A composite project of one file, for `tsc -b`. */
function compositeProject() {
  const dir = tempDir('tsc-ts-run-config-composite-');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    '{"compilerOptions":{"composite":true,"outDir":"out","declaration":true,"types":[]},"files":["a.ts"]}\n',
  );
  writeFileSync(join(dir, 'a.ts'), 'export const a: number = 1;\n');
  return dir;
}

/** The records written under `cache`. */
function writtenRecords(cache) {
  const dir = join(cache, 'runs-v1');
  return existsSync(dir) ? readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))) : [];
}

/** Runs tsc-ts in `dir` until `pattern` matches its output, then stops it; resolves with the output. */
function runUntil(dir, args, pattern, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tscTs[0], [...tscTs.slice(1), ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: typescriptLib, NO_COLOR: '1', TSC_TS_CACHE: '0', ...env },
    });
    let output = '';
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      child.kill();
      if (error === undefined) resolve(output);
      else reject(error);
    };
    const deadline = Date.now() + 60_000;
    const poll = () => {
      if (done) return;
      if (pattern.test(output)) finish();
      else if (Date.now() > deadline) finish(new Error(`timed out; output so far:\n${output}`));
      else setTimeout(poll, 10);
    };
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('exit', () => finish());
    poll();
  });
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
  assert.equal(lines[at + 4], '  Records: off (TSC_TS_CACHE=0)');
  // Nothing after the four lines.
  assert.deepEqual(lines.slice(at + 5), ['']);
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

// The stop switch: TSC_TS_SHARE_STOP_AT_MS stops a sharing run at that many milliseconds, and the
// section says what the window saw instead of the source that turned sharing on.
test(
  'the sharing window stops sharing, and the section says what it saw',
  { skip: tscTs.length !== 1 && 'needs a native build (TSC_TS_BIN)' },
  () => {
    const dir = project();
    for (const level of ['2', '1']) {
      const stopped = run(dir, ['-p', '.', '--checkers', '4', '--extendedDiagnostics'], {
        TSC_TS_SHARE: '1',
        TSC_TS_SHARE_STOP_AT_MS: '0:' + level,
      });
      assert.equal(stopped.status, 0);
      assert.match(
        stopped.output,
        /^ {2}Sharing: on \(measured: stopped after 0 ms: \d+ ms saved for \d+ ms spent\)(; pin with TSC_TS_SHARE=1)?$/m,
      );
      // The switch keeps the diagnostics: the project checks clean.
      assert.doesNotMatch(stopped.output, /error TS/);
    }
    // A run that finishes before the window keeps the source that chose sharing, and the timer goes with it.
    const long = run(dir, ['-p', '.', '--checkers', '4', '--extendedDiagnostics'], {
      TSC_TS_SHARE: '1',
      TSC_TS_SHARE_STOP_AT_MS: '60000',
    });
    assert.equal(long.status, 0);
    assert.match(long.output, /^ {2}Sharing: on \(pinned: TSC_TS_SHARE\)$/m);
  },
);

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
  // A build of several projects at once keeps no record, and each project's section says so.
  const records = rebuilt.output.split('\n').filter((line) => line.startsWith('  Records: '));
  assert.deepEqual(records, ['  Records: off (concurrent projects)', '  Records: off (concurrent projects)']);
});

// A native run writes its record; the Node build keeps none (`sharesPublishedGraphs`).
const native = tscTs.length === 1;

test(
  '--build with one builder writes a record without --diagnostics',
  { skip: !native && 'needs a native build (TSC_TS_BIN)' },
  () => {
    const dir = compositeProject();
    const cache = tempDir('tsc-ts-run-config-cache-');
    const { output, status } = run(dir, ['-b', '--builders', '1'], {
      TSC_TS_CACHE: '1',
      TSC_TS_CACHE_DIR: cache,
    });
    assert.equal(status, 0, output);
    const records = writtenRecords(cache);
    assert.equal(records.length, 1, `expected one record:\n${output}`);
    assert.equal(records[0].runs, 1);
    assert.equal(records[0].samples.length, 1);
    assert.equal(records[0].samples[0].role, 'chosen');
    assert.ok(records[0].samples[0].checkMs > 0, `no check time: ${JSON.stringify(records[0].samples[0])}`);
  },
);

test(
  '--build keeps no record of an incremental recheck',
  { skip: !native && 'needs a native build (TSC_TS_BIN)' },
  () => {
    const dir = compositeProject();
    const cache = tempDir('tsc-ts-run-config-cache-');
    const env = { TSC_TS_CACHE: '1', TSC_TS_CACHE_DIR: cache };
    assert.equal(run(dir, ['-b', '--builders', '1'], env).status, 0);
    assert.equal(writtenRecords(cache).length, 1);
    writeFileSync(join(dir, 'a.ts'), 'export const a: number = 2;\n');
    const { output, status } = run(dir, ['-b', '--builders', '1', '--extendedDiagnostics'], env);
    assert.equal(status, 0, output);
    assert.match(output, /^ {2}Records: off \(incremental recheck\)$/m);
    const records = writtenRecords(cache);
    assert.equal(records.length, 1);
    assert.equal(records[0].runs, 1, `a recheck wrote a sample:\n${JSON.stringify(records[0])}`);
  },
);

test('--build --watch keeps no record', { skip: !native && 'needs a native build (TSC_TS_BIN)' }, async () => {
  const dir = compositeProject();
  const cache = tempDir('tsc-ts-run-config-cache-');
  const output = await runUntil(
    dir,
    ['-b', '--watch', '--builders', '1', '--extendedDiagnostics'],
    /Watching for file changes/,
    {
      TSC_TS_CACHE: '1',
      TSC_TS_CACHE_DIR: cache,
    },
  );
  assert.match(output, /^ {2}Records: off \(watch mode\)$/m);
  assert.deepEqual(writtenRecords(cache), []);
});

test(
  'an incremental recheck with one checker keeps no record',
  { skip: !native && 'needs a native build (TSC_TS_BIN)' },
  () => {
    const dir = project();
    const cache = tempDir('tsc-ts-run-config-cache-');
    const env = { TSC_TS_CACHE: '1', TSC_TS_CACHE_DIR: cache };
    const first = run(dir, ['-p', '.', '--incremental', '--checkers', '1'], env);
    assert.equal(first.status, 0, first.output);
    assert.equal(writtenRecords(cache).length, 1);
    writeFileSync(join(dir, 'a.ts'), 'export const a: number = 2;\n');
    const { output, status } = run(dir, ['-p', '.', '--incremental', '--checkers', '1', '--extendedDiagnostics'], env);
    assert.equal(status, 0, output);
    assert.match(output, /^ {2}Records: off \(incremental recheck\)$/m);
    assert.equal(writtenRecords(cache)[0].runs, 1, `a recheck wrote a sample:\n${output}`);
  },
);

test(
  '--noCheck keeps no record, and the section says nothing was checked',
  { skip: !native && 'needs a native build (TSC_TS_BIN)' },
  () => {
    const dir = project();
    const cache = tempDir('tsc-ts-run-config-cache-');
    const { output, status } = run(dir, ['-p', '.', '--noCheck', '--extendedDiagnostics'], {
      TSC_TS_CACHE: '1',
      TSC_TS_CACHE_DIR: cache,
    });
    assert.equal(status, 0, output);
    assert.match(output, /^ {2}Records: off \(nothing checked\)$/m);
    assert.deepEqual(writtenRecords(cache), []);
  },
);

test('a run stopped by syntax errors keeps no record', { skip: !native && 'needs a native build (TSC_TS_BIN)' }, () => {
  const dir = project();
  writeFileSync(join(dir, 'a.ts'), 'export const a: number = ;\n');
  const cache = tempDir('tsc-ts-run-config-cache-');
  const { output, status } = run(dir, ['-p', '.', '--checkers', '1', '--extendedDiagnostics'], {
    TSC_TS_CACHE: '1',
    TSC_TS_CACHE_DIR: cache,
  });
  assert.notEqual(status, 0);
  assert.match(output, /error TS/);
  assert.match(output, /^ {2}Records: off \(nothing checked\)$/m);
  assert.deepEqual(writtenRecords(cache), []);
});

test(
  '--singleThreaded keeps no record, and the section says why',
  { skip: !native && 'needs a native build (TSC_TS_BIN)' },
  () => {
    const dir = project();
    const cache = tempDir('tsc-ts-run-config-cache-');
    const { output, status } = run(dir, ['-p', '.', '--extendedDiagnostics', '--singleThreaded'], {
      TSC_TS_CACHE: '1',
      TSC_TS_CACHE_DIR: cache,
    });
    assert.equal(status, 0);
    assert.match(output, /^ {2}Records: off \(--singleThreaded\)$/m);
    assert.equal(existsSync(cache) ? readdirSync(cache).length : 0, 0, `a record was written:\n${output}`);
  },
);

test(
  'a native run writes its record and the section names it',
  { skip: !native && 'needs a native build (TSC_TS_BIN)' },
  () => {
    const dir = project();
    const cache = tempDir('tsc-ts-run-config-cache-');
    const { output, status } = run(dir, ['-p', '.', '--extendedDiagnostics'], {
      TSC_TS_CACHE: '1',
      TSC_TS_CACHE_DIR: cache,
    });
    assert.equal(status, 0);
    const line = output.split('\n').find((text) => text.startsWith('  Records: '));
    assert.ok(line !== undefined, `no Records line in:\n${output}`);
    const path = line.slice('  Records: '.length);
    assert.ok(!path.startsWith('~'), `the section abbreviated a path outside the home directory: ${path}`);
    assert.ok(existsSync(path), `no record at ${path}`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(record.format, 1);
    assert.equal(record.runs, 1);
    assert.equal(record.samples.length, 1);
    assert.equal(record.samples[0].run, 1);
    assert.equal(record.samples[0].role, 'chosen');
    assert.equal(record.samples[0].checkers, record.chosen.checkers);
    assert.equal(record.chosen.since, 1);
    assert.ok(record.samples[0].totalMs > 0);
    assert.ok(record.samples[0].peakMB > 0);
    // The program's files: the project's, and the default libraries it loads.
    assert.ok(record.shape.files > 1);
    assert.ok(record.shape.chars > 0);
    assert.ok(record.shape.declarationChars > 0);
  },
);
