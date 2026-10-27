// How well a committed profile (profile-phases.mjs) matches the code a `scriptc build --profile-use` compiles, from the
// report scriptc prints on stderr:
//   scriptc: profile <path>: <a> functions annotated, <m> mismatched, <n> without a record[, <p> partitions without counts]
// A build right after the profile was collected annotates every function the profile describes; refresh-profile.mjs
// records that number beside the profile (tsc-ts.json, tsc-ts.cs.json). Functions whose code changed since then are mismatched, and functions
// that were renamed or removed are no longer annotated, so the share of the recorded functions a build annotates
// measures how stale the profile is.

// build:native warns below WARN_BELOW of the recorded functions, and fails in CI below FAIL_BELOW.
export const WARN_BELOW = 0.95;
export const FAIL_BELOW = 0.9;

const reportLine =
  /^scriptc: profile .*: (\d+) functions annotated, (\d+) mismatched, (\d+) without a record(?:, (\d+) partitions? without counts)?$/m;

// The counts of scriptc's profile report, or undefined when the output has none (a scriptc that predates it).
export function parseProfileReport(stderr) {
  const match = reportLine.exec(stderr);
  if (match === null) return undefined;
  return {
    annotated: Number(match[1]),
    mismatched: Number(match[2]),
    missing: Number(match[3]),
    withoutCounts: Number(match[4] ?? 0),
  };
}

// The verdict on a build's profile match: { level: 'ok' | 'note' | 'warn' | 'fail', message }. `functions` is the
// number recorded beside `profile`. A partition that scriptc reused from its cache without the match counts
// leaves the share undefined, as does a missing report or count; those builds get a note.
// `checked: false` reports the share as a note: refresh-profile.mjs collects the profile on Linux, and Windows builds
// generate different control flow for most functions, so they annotate fewer of them however fresh the profile is.
export function judgeProfileMatch(report, functions, { ci, checked = true, profile = 'profiles/tsc-ts.profdata' }) {
  if (report === undefined)
    return { level: 'note', message: 'scriptc printed no profile report, so the profile match is not checked' };
  if (functions === undefined)
    return {
      level: 'note',
      message: `${profile.replace(/\.profdata$/, '.json')} records no function count, so the profile match is not checked`,
    };
  if (report.withoutCounts > 0)
    return {
      level: 'note',
      message: `${report.withoutCounts} partition${report.withoutCounts === 1 ? ' was' : 's were'} compiled without profile counts, so the profile match is not checked`,
    };
  const share = report.annotated / functions;
  const percent = (Math.floor(share * 1000) / 10).toFixed(1);
  const summary = `the build annotates ${report.annotated} of the ${functions} functions ${profile} describes (${percent}%)`;
  if (!checked) return { level: 'note', message: `${summary}; the match is checked on Linux and macOS builds` };
  if (share >= WARN_BELOW) return { level: 'ok', message: summary };
  const advice = 'run `npm run refresh-profile -w tsc-ts` to collect it again';
  if (share >= FAIL_BELOW) return { level: 'warn', message: `${summary}; ${advice}` };
  const below = `${summary}, below ${FAIL_BELOW * 100}%`;
  if (!ci) return { level: 'warn', message: `${below}, which fails in CI; ${advice}` };
  return { level: 'fail', message: `${below}; ${advice}` };
}
