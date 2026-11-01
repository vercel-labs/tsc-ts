// Replays the logs TSC_TS_SHARE_PRICE=<prefix> writes, one file per checker thread (`<prefix>-c<index>-<n>.log`),
// and prices what result sharing costs and could save on that run.
//
// It measures, from the run itself, what a record costs to translate (`c`, split into unpacking and building) and
// the ratio of a consumer's translation to the computation the producer it names made of that key (`ρ`); it
// classifies every computation of another checker's file by why it was not taken (nothing posted, the producer was
// still computing, a refused take, or a post the producer did not make); it counts the evaluations of the type
// operators a shared evaluation cache would cover and how many of them another checker had already done; and it
// walks candidate takes under a posting rule and reports the checker time each rule would save and the wall time
// that implies.
//
// A take, under a rule, replays like this: for every computation of a key in another checker's file, the rule
// finds the earliest finish of the same key on another checker. A finish before this computation's start is a
// candidate take. The rule posts a result only if it clears the posting threshold, the demand of another checker
// for its key, and the export budget (`p0 + R·e ≤ κ·T`); the consumer takes it only if the records it would build
// fit its budget (`c·B_new + w·B_seen ≤ λ·T`). A take saves the computation it replaces, which is the computation
// and its nested computations, counted once, less the records it builds at the consumer: a take inside a take saves
// nothing more. The wall estimate is the longest of the checkers' busy intervals with each rule's takes, their
// translations and its posts priced in.
//
// Times in the logs are `performance.now()` of the build, offset by the epoch each log records (`origin`), so
// records of different threads can be compared.
//
// Usage: node scripts/share-price.mjs --logs DIR_OR_PREFIX [--wall MS] [--summary FILE]
//                                     [--type-bytes N] [--symbol-bytes N] [--json FILE]
//
// --logs is a directory of logs, or the prefix they were written with. --wall is the run's wall time, which the
// percentages are against; --summary is the stderr of a run with TSC_TS_SHARE_SUMMARY, whose per-kind build
// times are reported with the ones this script measures. --type-bytes and --symbol-bytes are the census sizes of
// an instantiated type and a symbol, which turn the objects a take avoids into MB.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const logsOption = option('--logs', undefined);
if (logsOption === undefined) {
  console.error('usage: node scripts/share-price.mjs --logs DIR_OR_PREFIX [--wall MS] [--summary FILE] ...');
  process.exit(2);
}
const wallMs = option('--wall', undefined) === undefined ? undefined : Number(option('--wall'));
const summaryFile = option('--summary', undefined);
const typeBytes = Number(option('--type-bytes', '0'));
const symbolBytes = Number(option('--symbol-bytes', '0'));
const jsonFile = option('--json', undefined);

// The rule's costs. The defaults are today's measured means for a record's translation and a post's fixed cost
// (share-kind-costs.md): 6.3 µs per record built on T3 web, 1.2 µs per record exported, 0.3 µs per post.
const p0Us = Number(option('--p0', '0.3'));
const eUs = Number(option('--e', '1.2'));
const cUs = Number(option('--c', '6.3'));
const wNs = Number(option('--w', '40'));
const kappa = Number(option('--kappa', '0.25'));
const lambdaOption = option('--lambda', undefined);
const minMsOption = Number(option('--min-ms', '2'));

/** The outcome field of a computation: how its checker reached the result. */
const Owned = 0;
const Computed = 1;
const Taken = 2;
const Local = 3;

function logFiles(target) {
  // The prefix of the logs never exists as a file itself: only a directory is a directory.
  if (existsSync(target) && statSync(target).isDirectory()) {
    return readdirSync(target)
      .filter((file) => file.endsWith('.log'))
      .sort()
      .map((file) => join(target, file));
  }
  {
    // A prefix: the logs beside it.
    const dir = target.slice(0, target.lastIndexOf('/') + 1) || './';
    const name = target.slice(target.lastIndexOf('/') + 1);
    return readdirSync(dir)
      .filter((file) => file.startsWith(name + '-c') && file.endsWith('.log'))
      .sort()
      .map((file) => join(dir, file));
  }
}

function parseLog(file) {
  const log = {
    file,
    index: -1,
    count: 0,
    origin: 0,
    names: [],
    computations: [],
    translations: [],
    evaluations: [],
    intervals: [],
  };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    const kind = line[0];
    if (kind === '#') {
      const found = /checker (\d+) of (\d+)/.exec(line);
      if (found !== null) {
        log.index = Number(found[1]);
        log.count = Number(found[2]);
      }
      continue;
    }
    if (kind === 'n') {
      const at = line.indexOf(' ', 2);
      log.names[Number(line.slice(2, at))] = line.slice(at + 1);
      continue;
    }
    if (line.startsWith('origin ')) {
      log.origin = Number(line.slice(7));
      continue;
    }
    const f = line.slice(2).split(' ');
    if (kind === 'c') {
      log.computations.push({
        log,
        checker: log.index,
        fileName: log.names[Number(f[3])] ?? '',
        key: Number(f[0]),
        kind: Number(f[1]),
        outcome: Number(f[2]),
        file: Number(f[3]),
        taker: Number(f[4]),
        start: log.origin + Number(f[5]),
        end: log.origin + Number(f[6]),
        depth: Number(f[7]),
        shareable: Number(f[8]),
        annotated: Number(f[9]),
        diagnosticFiles: Number(f[10]),
        reason: f[11] === '-' ? '' : f[11],
        slot: Number(f[12]),
        exportRecords: Number(f[13]),
        exportWords: Number(f[14]),
        exportUnits: Number(f[15]),
        exportMs: Number(f[16]),
        types: Number(f[17]),
        symbols: Number(f[18]),
        self: 0,
        child: 0,
      });
      continue;
    }
    if (kind === 't') {
      log.translations.push({
        log,
        key: Number(f[0]),
        kind: Number(f[1]),
        producer: Number(f[2]),
        start: log.origin + Number(f[3]),
        end: log.origin + Number(f[4]),
        walked: Number(f[5]),
        built: Number(f[6]),
        unpackMs: Number(f[7]),
        buildMs: Number(f[8]),
        types: Number(f[9]),
        symbols: Number(f[10]),
        taken: Number(f[11]) === 1,
      });
      continue;
    }
    if (kind === 'e') {
      log.evaluations.push({
        log,
        operator: Number(f[0]),
        node: Number(f[1]),
        key: Number.parseInt(f[2], 16),
        flags: Number(f[3]),
        start: log.origin + Number(f[4]),
        end: log.origin + Number(f[5]),
      });
      continue;
    }
    if (kind === 'w')
      log.intervals.push({ index: Number(f[0]), start: log.origin + Number(f[1]), end: log.origin + Number(f[2]) });
  }
  // The computations are in the order they started: a nested one started after the one it is in.
  const stack = [];
  const close = (r) => {
    r.self = Math.max(0, r.end - r.start - r.child);
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.child += r.end - r.start;
  };
  for (const r of log.computations) {
    while (stack.length > 0 && stack[stack.length - 1].end <= r.start) close(stack.pop());
    if (stack.length > 0 && stack[stack.length - 1].end < r.end) {
      // Not nested: the outer one ends first, which a record of the same stack does only with shared state.
      while (stack.length > 0) close(stack.pop());
    }
    stack.push(r);
  }
  while (stack.length > 0) close(stack.pop());
  return log;
}

const files = logFiles(logsOption);
if (files.length === 0) {
  console.error(`no logs under ${logsOption}`);
  process.exit(2);
}
const logs = files.map(parseLog);
const computations = [];
const translations = [];
const evaluations = [];
for (const log of logs) {
  for (const c of log.computations) computations.push(c);
  for (const t of log.translations) translations.push(t);
  for (const e of log.evaluations) evaluations.push(e);
}

/** Translations by `kind:key`: what consumers that took a result measured. */
const translationsByKey = new Map();
for (const t of translations) {
  const key = t.kind + ':' + t.key;
  let list = translationsByKey.get(key);
  if (list === undefined) translationsByKey.set(key, (list = []));
  list.push(t);
}

const us = (ms) => ms * 1000;
const pct = (part, whole) => (whole === 0 ? '0.0%' : ((100 * part) / whole).toFixed(1) + '%');
const pctOfWall = (ms) => (wallMs === undefined ? '' : ` (${pct(ms, wallMs)})`);
const fixed = (value, digits = 1) => value.toFixed(digits);

function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[at];
}

// ---- What the run measured: busy time, records, `c` and `ρ`

const lines = [];
const say = (text = '') => {
  lines.push(text);
  console.log(text);
};

const busyByLog = logs.map((log) => {
  let busy = 0;
  for (const interval of log.intervals) busy += interval.end - interval.start;
  return busy;
});
const totalBusy = busyByLog.reduce((a, b) => a + b, 0);
const threads = logs.length;
const checkers = new Set(logs.map((log) => log.index)).size;

say(`# share price replay`);
say();
say(
  `${threads} logs, ${checkers} checkers, ${computations.length.toLocaleString()} computations, ` +
    `${translations.length.toLocaleString()} translations, ${evaluations.length.toLocaleString()} evaluations`,
);
say(`busy time ${fixed(totalBusy, 0)} ms over ${threads} threads, longest ${fixed(Math.max(...busyByLog), 0)} ms`);
let otherMs = 0;
let ownedMs = 0;
let takenMs = 0;
for (const c of computations) {
  if (c.outcome === Taken) takenMs += c.end - c.start;
  else if (c.file >= 0 && c.taker === c.checker + 1) ownedMs += c.end - c.start;
  else if (c.outcome === Computed || c.outcome === Local) otherMs += c.end - c.start;
}
say(
  `own-file computations ${fixed(ownedMs, 0)} ms, other-file ${fixed(otherMs, 0)} ms ` +
    `(${pct(otherMs, ownedMs + otherMs)}), taken ${fixed(takenMs, 0)} ms`,
);
say();

// `c`: what a record costs to translate, and how many records a translation walks and builds.
let builtRecords = 0;
let unpackMs = 0;
let buildMs = 0;
let walkedRecords = 0;
let newTypes = 0;
let newSymbols = 0;
for (const t of translations) {
  builtRecords += t.built;
  walkedRecords += t.walked;
  unpackMs += t.unpackMs;
  buildMs += t.buildMs;
  newTypes += t.types;
  newSymbols += t.symbols;
}
say(`## translating`);
if (translations.length > 0) {
  const total = unpackMs + buildMs;
  say(
    `c ${fixed(us(total) / Math.max(1, builtRecords), 2)} µs per record built ` +
      `(${fixed(us(unpackMs) / Math.max(1, builtRecords), 2)} unpacking, ${fixed(us(buildMs) / Math.max(1, builtRecords), 2)} building)`,
  );
  say(
    `walked ${walkedRecords.toLocaleString()} records, built ${builtRecords.toLocaleString()} ` +
      `(${pct(builtRecords, walkedRecords)}), ${fixed(builtRecords / translations.length, 1)} per translation`,
  );
  say(
    `per translation that built records: ${fixed(us(total) / translations.length, 1)} µs, ` +
      `${fixed(newTypes / translations.length, 0)} types and ${fixed(newSymbols / translations.length, 0)} symbols`,
  );
} else say('no translations: sharing made no takes (TSC_TS_SHARE_VERIFY off or nothing posted in time)');

if (summaryFile !== undefined) {
  // The summary's per-kind build times are the only place building is split by kind: the log has the totals.
  const kinds = new Map();
  for (const line of readFileSync(summaryFile, 'utf8').split('\n')) {
    const found = /by kind (.*)$/.exec(line);
    if (found === null) continue;
    for (const part of found[1].split(', ')) {
      const item = /^(\S+) (\d+) \((\d+) ms\)$/.exec(part);
      if (item === null) continue;
      const entry = kinds.get(item[1]) ?? { records: 0, ms: 0 };
      entry.records += Number(item[2]);
      entry.ms += Number(item[3]);
      kinds.set(item[1], entry);
    }
  }
  const ranked = [...kinds.entries()].filter(([, entry]) => entry.records > 0).sort((a, b) => b[1].ms - a[1].ms);
  const total = ranked.reduce((sum, [, entry]) => sum + entry.ms, 0);
  if (ranked.length > 0) {
    say(`by record kind (TSC_TS_SHARE_SUMMARY):`);
    for (const [kind, entry] of ranked.slice(0, 12))
      say(
        `  ${kind} ${entry.records.toLocaleString()} records, ${entry.ms.toLocaleString()} ms ` +
          `(${pct(entry.ms, total)} of building, ${fixed(us(entry.ms) / Math.max(1, entry.records), 2)} µs per record)`,
      );
  }
}

// `ρ`: the consumer's translation against the producer's computation of the same key. The producer is the checker
// the translation names, and its computation is one it made itself, of its own file or of another checker's: a
// computation another checker made of the same key is not the result that was posted, and a result the producer
// took is one it did not compute.
const producerOf = new Map();
for (const c of computations) {
  if (c.outcome === Taken || c.outcome === Local) continue;
  const key = `${c.checker}:${c.kind}:${c.key}`;
  const list = producerOf.get(key);
  if (list === undefined) producerOf.set(key, [c]);
  else list.push(c);
}
for (const list of producerOf.values()) list.sort((a, b) => a.end - b.end);
/** The producer's computation the translation was made from: its last one that ended before the translation. */
function producedBefore(list, at) {
  let found;
  for (const c of list) {
    if (c.end > at) break;
    found = c;
  }
  return found ?? list[0];
}
const rhoSmall = [];
const rhoAll = [];
for (const t of translations) {
  const list = producerOf.get(`${t.producer}:${t.kind}:${t.key}`);
  if (list === undefined) continue;
  const producer = producedBefore(list, t.start);
  const compute = producer.end - producer.start;
  if (compute <= 0) continue;
  const rho = (t.unpackMs + t.buildMs) / compute;
  rhoAll.push(rho);
  if (compute < 2) rhoSmall.push(rho);
}
say();
say(`## ρ (translation ÷ producer computation)`);
if (rhoAll.length > 0) {
  say(
    `all results: ${rhoAll.length.toLocaleString()} pairs, p10 ${fixed(percentile(rhoAll, 10), 2)}, ` +
      `p50 ${fixed(percentile(rhoAll, 50), 2)}`,
  );
  say(
    `under 2 ms: ${rhoSmall.length.toLocaleString()} pairs, p10 ${fixed(percentile(rhoSmall, 10), 2)}, ` +
      `p50 ${fixed(percentile(rhoSmall, 50), 2)}`,
  );
} else say('no pair of a translation and the computation it was translated from');

// ---- The not-taken classification

/** Computations by `kind:key`, to find the checker that computed a result first. */
const byKey = new Map();
for (const c of computations) {
  const key = c.kind + ':' + c.key;
  let list = byKey.get(key);
  if (list === undefined) byKey.set(key, (list = []));
  list.push(c);
}

const buckets = [
  [2, 3],
  [4, 6],
  [7, 9],
  [10, 12],
  [13, 15],
  [16, Infinity],
];
function bucketOf(count) {
  for (const [low, high] of buckets) if (count >= low && count <= high) return low === 16 ? '16+' : `${low}-${high}`;
  return '1';
}

/** The threads that compute results in each declaration file, which the demand rule reads. */
const logsInFile = new Map();
for (const c of computations) {
  if (c.fileName === '') continue;
  let set = logsInFile.get(c.fileName);
  if (set === undefined) logsInFile.set(c.fileName, (set = new Set()));
  set.add(c.log);
}

const classes = new Map();
const addClass = (bucket, name, ms) => {
  const key = bucket + ' ' + name;
  classes.set(key, (classes.get(key) ?? 0) + ms);
};
let overlapMs = 0;
for (const c of computations) {
  if (c.outcome === Taken) {
    addClass(bucketOf(byKey.get(c.kind + ':' + c.key).length), 'taken', c.self);
    continue;
  }
  if (c.outcome === Local || c.outcome === Owned) continue;
  if (c.file >= 0 && c.taker === c.checker + 1) continue;
  const siblings = byKey.get(c.kind + ':' + c.key);
  const bucket = bucketOf(siblings.length);
  // The earliest finish of the same key on another checker: what a rule could have taken.
  let earliest;
  let inFlight = false;
  for (const s of siblings) {
    if (s.log === c.log) continue;
    if (earliest === undefined || s.end < earliest.end) earliest = s;
    if (s.start < c.start && s.end > c.start) inFlight = true;
  }
  if (earliest !== undefined && earliest.end < c.end && earliest.start < c.end) {
    overlapMs += Math.max(0, Math.min(c.end, earliest.end) - Math.max(c.start, earliest.start));
  }
  let name;
  if (c.reason === 'not-posted' || c.reason === '') {
    // The lookup found no post: another checker was computing it, the checker that computed it first did not post
    // it, or nobody had.
    if (inFlight) name = 'timing';
    else if (earliest !== undefined && earliest.reason !== '' && earliest.reason !== 'verify')
      name = 'not-posted:' + earliest.reason.split(':')[0];
    else if (earliest !== undefined && earliest.end < c.start) name = 'posted-late';
    else name = 'nothing';
  } else if (c.reason.startsWith('refused-')) name = 'refused:' + c.reason.slice('refused-'.length);
  else if (c.reason === 'verify') name = 'verify';
  else name = 'not-posted:' + c.reason.split(':')[0];
  addClass(bucket, name, c.self);
}

say();
say(`## why results in another checker's file were computed here (self time, ms)`);
const classBuckets = [...new Set([...classes.keys()].map((key) => key.split(' ')[0]))];
classBuckets.sort((a, b) => Number(a.split('-')[0].replace('+', '')) - Number(b.split('-')[0].replace('+', '')));
const classNames = [...new Set([...classes.keys()].map((key) => key.split(' ').slice(1).join(' ')))].sort();
say(['bucket', ...classNames, 'total'].join(' | '));
for (const bucket of classBuckets) {
  const cells = classNames.map((name) => {
    const value = classes.get(bucket + ' ' + name);
    return value === undefined ? '' : fixed(value, 1);
  });
  const total = classNames.reduce((sum, name) => sum + (classes.get(bucket + ' ' + name) ?? 0), 0);
  say([bucket, ...cells, fixed(total, 1)].join(' | '));
}
const classTotals = classNames.map((name) =>
  classBuckets.reduce((sum, bucket) => sum + (classes.get(bucket + ' ' + name) ?? 0), 0),
);
say(
  [
    'all',
    ...classTotals.map((value) => fixed(value, 1)),
    fixed(
      classTotals.reduce((a, b) => a + b, 0),
      1,
    ),
  ].join(' | '),
);
// Duplicates of a result seven or more checkers compute, started while another checker was already computing it,
// and the self time of those duplicates.
const sevenPlusTiming = ['7-9', '10-12', '13-15', '16+'].reduce(
  (sum, bucket) => sum + (classes.get(bucket + ' timing') ?? 0),
  0,
);
say(
  `started while another checker was computing it, seven or more checkers: ` +
    `${fixed(sevenPlusTiming, 1)} ms${pctOfWall(sevenPlusTiming)}`,
);
say();
say(
  `overlap share: ${pct(overlapMs, otherMs)} of other-file time (${fixed(overlapMs, 0)} ms of ${fixed(otherMs, 0)} ms)`,
);

// ---- Repeated structures

const repeated = new Map();
for (const c of computations) {
  if (c.outcome === Taken || c.file < 0 || c.taker === c.checker + 1) continue;
  const key = c.kind + ':' + c.key;
  const entry = repeated.get(key) ?? { checkers: new Set(), types: 0, symbols: 0, self: 0 };
  entry.checkers.add(c.checker);
  entry.types += c.types;
  entry.symbols += c.symbols;
  entry.self += c.self;
  repeated.set(key, entry);
}
let repeatedKeys = 0;
let repeatedTypes = 0;
let repeatedSymbols = 0;
let repeatedSelf = 0;
for (const entry of repeated.values()) {
  if (entry.checkers.size < 2) continue;
  repeatedKeys++;
  repeatedTypes += entry.types;
  repeatedSymbols += entry.symbols;
  repeatedSelf += entry.self;
}
const mb = (objects, bytes) => (bytes === 0 ? '' : `${fixed((objects * bytes) / (1024 * 1024), 1)} MB`);
say();
say(`## repeated structures`);
say(
  `${repeatedKeys.toLocaleString()} keys computed in another checker's file by 2 or more checkers: ` +
    `${repeatedTypes.toLocaleString()} types, ${repeatedSymbols.toLocaleString()} symbols, ${fixed(repeatedSelf, 0)} ms of self time`,
);
if (typeBytes > 0 || symbolBytes > 0)
  say(`at the census sizes: ${mb(repeatedTypes, typeBytes)} of types, ${mb(repeatedSymbols, symbolBytes)} of symbols`);

// ---- The evaluations a shared evaluation cache would cover

/** The operators of an `e` record, in the order of the compiler's `EvaluationKind`. */
const operatorNames = ['conditional', 'distributed', 'indexed-access', 'keyof-mapped', 'template', 'map-over-union'];
if (evaluations.length > 0) {
  say();
  say(`## evaluations (uncached)`);
  say(
    [
      'operator',
      'count',
      'time ms',
      'keys',
      'key in 2+ checkers',
      'time in 2+ checkers ms',
      'limited',
      'diagnostic',
    ].join(' | '),
  );
  for (let operator = 0; operator < operatorNames.length; operator++) {
    const list = evaluations.filter((e) => e.operator === operator);
    if (list.length === 0) continue;
    const owners = new Map();
    let time = 0;
    let limited = 0;
    let diagnostic = 0;
    for (const e of list) {
      time += e.end - e.start;
      if ((e.flags & 1) !== 0) limited++;
      if ((e.flags & 8) !== 0) diagnostic++;
      const key = e.node + ':' + e.key;
      let set = owners.get(key);
      if (set === undefined) owners.set(key, (set = new Set()));
      set.add(e.log);
    }
    let repeatedTime = 0;
    let repeatedCount = 0;
    for (const e of list) {
      const set = owners.get(e.node + ':' + e.key);
      if (set.size > 1) {
        repeatedCount++;
        repeatedTime += e.end - e.start;
      }
    }
    say(
      [
        operatorNames[operator] ?? `operator ${operator}`,
        list.length.toLocaleString(),
        fixed(time, 1),
        owners.size.toLocaleString(),
        repeatedCount.toLocaleString(),
        fixed(repeatedTime, 1),
        limited.toLocaleString(),
        diagnostic.toLocaleString(),
      ].join(' | '),
    );
  }
}

// ---- The rules

/** For a key: the records a consumer would build (`B_new`), the ones it would walk built (`B_seen`), the
 * producer's new records (`R`) and the producer's computation time in ms, as the run shows them. */
function shapeOf(key, producer) {
  const seen = repeated.get(key);
  const measured = translationsByKey.get(key) ?? [];
  let built = 0;
  let walked = 0;
  for (const t of measured) {
    built += t.built;
    walked += t.walked - t.built;
  }
  const bNew = measured.length > 0 ? built / measured.length : producer.exportRecords >= 0 ? producer.exportRecords : 0;
  const bSeen = measured.length > 0 ? walked / measured.length : 0;
  return {
    bNew,
    bSeen,
    records: producer.exportRecords,
    types: seen === undefined ? 0 : seen.types,
    symbols: seen === undefined ? 0 : seen.symbols,
  };
}

function replay({ name, cPerRecordUs, lambda, minMs, kappaValue, demand }) {
  // The earliest finisher of each key on another thread, and the key's post.
  const earliest = new Map();
  for (const c of computations) {
    const key = c.kind + ':' + c.key;
    const known = earliest.get(key);
    if (known === undefined || c.end < known.end) earliest.set(key, c);
  }
  const posts = new Map();
  const takes = new Map(logs.map((log) => [log, []]));
  let postCost = 0;
  let postCount = 0;
  const byChecker = new Map();
  const addSaved = (log, ms) => byChecker.set(log, (byChecker.get(log) ?? 0) + ms);
  const addCost = (log, ms) => byChecker.set(log, (byChecker.get(log) ?? 0) - ms);
  for (const c of computations) {
    if (c.outcome === Taken) continue;
    if (c.file >= 0 && c.taker === c.checker + 1) continue;
    const key = c.kind + ':' + c.key;
    const producer = earliest.get(key);
    if (producer === undefined || producer.log === c.log || producer.end >= c.start) continue;
    if (producer.end - producer.start < minMs) continue;
    const shared = producer.end - producer.start;
    // The producer posts, once per key.
    let post = posts.get(key);
    if (post === undefined) {
      const shape = shapeOf(key, producer);
      // `records` is `-1` when the run measured no export of this result: the export failed, or the result was
      // neither posted nor dry-run. Such a post cannot be replayed, so the rule leaves the result unposted.
      const measured = shape.records >= 0;
      const records = Math.max(0, shape.records);
      const cost = p0Us + records * eUs;
      const overBudget = kappaValue > 0 && us(shared) * kappaValue < cost;
      let wanted = true;
      if (demand) {
        // Demand: another checker computes a result in the same declaration file, which is what a post is for.
        wanted = (logsInFile.get(producer.fileName)?.size ?? 0) > 1;
      }
      post = { ok: !overBudget && wanted && measured, records, shape };
      posts.set(key, post);
      if (post.ok) {
        // `cost` is microseconds, like the per-record costs it is built from; the saved time is milliseconds.
        postCost += cost / 1000;
        postCount++;
        addCost(producer.log, cost / 1000);
      }
    }
    if (!post.ok) continue;
    const shape = post.shape;
    // What the consumer would pay to translate the result: records built at `c` each, the others walked at `w`.
    const translationUs = cPerRecordUs * shape.bNew + (wNs / 1000) * shape.bSeen;
    const lookup = p0Us + translationUs;
    // The consumer's budget: the records it would build must fit under λ of the producer's time. Both sides are
    // microseconds: `lookup` is built from the per-microsecond costs, and the producer's time is in milliseconds.
    if (lambda > 0 && lookup > lambda * us(shared)) continue;
    takes.get(c.log).push({ computation: c, bucket: bucketOf(byKey.get(key).length), bNew: shape.bNew, translationUs });
  }
  // A take saves the computation and what was computed inside it, once, less the records it builds at the
  // consumer: a take inside a take saves nothing more.
  let saved = 0;
  let takeCost = 0;
  // The net saved time by checker-count bucket, and of it the takes that build no new record at the consumer.
  const savedByBucket = new Map();
  let savedNoNew = 0;
  let takesNoNew = 0;
  for (const [log, list] of takes) {
    const set = new Set(list.map((take) => take.computation));
    for (const take of list) {
      const c = take.computation;
      let inside = false;
      for (let p = c.parent; p !== undefined; p = p.parent) {
        if (set.has(p)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      const self = c.end - c.start;
      // The consumer pays for the records it builds instead of the computation it skips.
      const translation = take.translationUs / 1000;
      saved += self;
      takeCost += translation;
      addSaved(log, self);
      addCost(log, translation);
      savedByBucket.set(take.bucket, (savedByBucket.get(take.bucket) ?? 0) + self - translation);
      if (take.bNew < 0.5) {
        savedNoNew += self - translation;
        takesNoNew++;
      }
    }
  }
  const busy = logs.map((log) => busyByLog[logs.indexOf(log)] - (byChecker.get(log) ?? 0));
  const wall = Math.max(...busy);
  return {
    name,
    saved,
    takeCost,
    postCost,
    postCount,
    takes: [...takes.values()].reduce((a, b) => a + b.length, 0),
    takesNoNew,
    savedNoNew,
    savedByBucket,
    wall,
    byChecker,
  };
}

for (const log of logs) for (const c of log.computations) c.parent = undefined;
for (const log of logs) {
  const stack = [];
  for (const c of log.computations) {
    while (stack.length > 0 && stack[stack.length - 1].end <= c.start) stack.pop();
    if (stack.length > 0 && stack[stack.length - 1].end < c.end) stack.length = 0;
    c.parent = stack[stack.length - 1];
    stack.push(c);
  }
}

say();
say(`## rules`);
say(
  `costs: p0 ${p0Us} µs, e ${eUs} µs per record, c ${cUs} µs per record built, w ${wNs} ns per record walked, κ ${kappa}`,
);
// No pair of a translation and the computation it came from leaves ρ undecided: the budget rule then takes the
// cap, so the replay answers for a consumer that can afford all of a small result's translation.
const lambda10 = percentile(rhoSmall.length > 0 ? rhoSmall : rhoAll, 10);
const lambdaBase = Number.isNaN(lambda10) ? 0.6 : lambda10 - 0.1;
const lambda = lambdaOption === undefined ? Math.min(0.5, Math.max(0, lambdaBase)) : Number(lambdaOption);
say(
  `λ = ${fixed(lambda, 2)} (` +
    (Number.isNaN(lambda10)
      ? 'no ρ measured, so the cap'
      : 'the 10th percentile of ρ under 2 ms, minus 0.1, capped at 0.5') +
    ') unless given',
);
say();
say(
  [
    'rule',
    'posts',
    'takes',
    'saved ms',
    'take ms',
    'post ms',
    'net ms',
    'net of wall ms',
    'net % wall',
    'wall estimate ms',
  ].join(' | '),
);
const rules = [
  { name: 'today', cPerRecordUs: cUs, lambda: 0, minMs: minMsOption, kappaValue: kappa, demand: true },
  { name: 'today, no demand', cPerRecordUs: cUs, lambda: 0, minMs: minMsOption, kappaValue: kappa, demand: false },
  { name: 'with λ budget', cPerRecordUs: cUs, lambda, minMs: minMsOption, kappaValue: kappa, demand: true },
  {
    name: 'after translation work, 0.5 ms floor',
    cPerRecordUs: 4.8,
    lambda,
    minMs: 0.5,
    kappaValue: kappa,
    demand: true,
  },
  {
    name: 'after translation work, small results',
    cPerRecordUs: 4.8,
    lambda,
    minMs: 0,
    kappaValue: kappa,
    demand: true,
  },
];
const results = [];
for (const rule of rules) {
  const result = replay(rule);
  results.push(result);
  const net = result.saved - result.takeCost - result.postCost;
  // Checker time saved is shared by the checkers: at c16 a millisecond of checker time is 1/16 ms of wall, the same
  // conversion the design's ceilings use.
  const ofWall = net / threads;
  // A rule's wall time is the longest busy interval once its takes, translations and posts are priced in, which is
  // `result.wall`: each checker's busy time already holds the time the rule saves it and the time it costs it.
  const wall = wallMs === undefined ? '' : fixed(result.wall, 0);
  say(
    [
      rule.name,
      result.postCount.toLocaleString(),
      result.takes.toLocaleString(),
      fixed(result.saved, 0),
      fixed(result.takeCost, 0),
      fixed(result.postCost, 0),
      fixed(net, 0),
      fixed(ofWall, 0),
      wallMs === undefined ? '' : pct(ofWall, wallMs),
      wall,
    ].join(' | '),
  );
}
if (wallMs !== undefined) say(`(wall time of the run: ${fixed(wallMs, 0)} ms)`);

// The best rule by net checker time, and where its takes are.
const best = results.reduce((a, b) => (b.saved - b.takeCost - b.postCost > a.saved - a.takeCost - a.postCost ? b : a));
// The best rule's saving, after the records its takes build at the consumer: the bucket figures are net of them.
const bestNet = best.saved - best.takeCost;
say();
say(`## takes of the best rule (${best.name}), by how many checkers compute the key`);
const bucketOrder = ['1', ...buckets.map(([low, high]) => (low === 16 ? '16+' : `${low}-${high}`))];
say(['bucket', 'net ms', 'share'].join(' | '));
for (const bucket of bucketOrder) {
  const value = best.savedByBucket.get(bucket);
  if (value === undefined) continue;
  say([bucket, fixed(value, 0), pct(value, bestNet)].join(' | '));
}
const sevenPlus = bucketOrder
  .filter((bucket) => bucket === '16+' || Number(bucket.split('-')[0]) >= 7)
  .reduce((sum, bucket) => sum + (best.savedByBucket.get(bucket) ?? 0), 0);
say(
  `seven or more checkers: ${fixed(sevenPlus, 0)} ms saved, ` +
    `${pct(sevenPlus, bestNet)} of the rule's saving, ` +
    `${fixed(sevenPlus / threads, 0)} ms of wall${pctOfWall(sevenPlus / threads)}`,
);
say(
  `takes that build no new record at the consumer: ${best.takesNoNew.toLocaleString()} takes, ` +
    `${fixed(best.savedNoNew, 0)} ms saved, ${pct(best.savedNoNew, bestNet)} of the rule's saving, ` +
    `${fixed(best.savedNoNew / threads, 0)} ms of wall${pctOfWall(best.savedNoNew / threads)}`,
);

if (jsonFile !== undefined) {
  writeFileSync(
    jsonFile,
    JSON.stringify(
      {
        logs: threads,
        checkers,
        computations: computations.length,
        translations: translations.length,
        evaluations: evaluations.length,
        busyMs: totalBusy,
        otherMs,
        takenMs,
        builtRecords,
        recordsPerTranslation: builtRecords / Math.max(1, translations.length),
        cPerRecordUs: us(unpackMs + buildMs) / Math.max(1, builtRecords),
        unpackPerRecordUs: us(unpackMs) / Math.max(1, builtRecords),
        buildPerRecordUs: us(buildMs) / Math.max(1, builtRecords),
        rhoP10: percentile(rhoAll, 10),
        rhoSmallP10: percentile(rhoSmall, 10),
        rhoSmallCount: rhoSmall.length,
        overlapShare: otherMs === 0 ? 0 : overlapMs / otherMs,
        timingSevenPlusMs: sevenPlusTiming,
        timingSevenPlusOfWallMs: sevenPlusTiming / threads,
        timingSevenPlusShareOfWall: wallMs === undefined ? null : sevenPlusTiming / threads / wallMs,
        repeatedKeys,
        repeatedTypes,
        repeatedSymbols,
        classes: Object.fromEntries(classes),
        rules: results.map((r) => ({
          name: r.name,
          posts: r.postCount,
          takes: r.takes,
          savedMs: r.saved,
          takeMs: r.takeCost,
          postMs: r.postCost,
          netMs: r.saved - r.takeCost - r.postCost,
          netOfWallMs: (r.saved - r.takeCost - r.postCost) / threads,
          netShareOfWall: wallMs === undefined ? null : (r.saved - r.takeCost - r.postCost) / threads / wallMs,
          wallMs: r.wall,
        })),
        best: {
          name: best.name,
          netMs: bestNet,
          savedByBucket: Object.fromEntries(best.savedByBucket),
          sevenCheckersOrMoreSavedMs: sevenPlus,
          sevenCheckersOrMoreShareOfSaving: bestNet === 0 ? 0 : sevenPlus / bestNet,
          sevenCheckersOrMoreOfWallMs: sevenPlus / threads,
          sevenCheckersOrMoreShareOfWall: wallMs === undefined ? null : sevenPlus / threads / wallMs,
          takesThatBuildNoNewRecord: best.takesNoNew,
          savedByThoseMs: best.savedNoNew,
          savedByThoseShareOfSaving: bestNet === 0 ? 0 : best.savedNoNew / bestNet,
          savedByThoseShareOfWall: wallMs === undefined ? null : best.savedNoNew / threads / wallMs,
        },
      },
      undefined,
      2,
    ) + '\n',
  );
}
