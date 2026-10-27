import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { FAIL_BELOW, WARN_BELOW, judgeProfileMatch, parseProfileReport } from '../scripts/profile-match.mjs';
import { SINGLE_PHASE_PROFILE, TWO_PHASE_PROFILE, profileInfoPath } from '../scripts/profile-phases.mjs';

// build:native optimizes with profiles/tsc-ts.profdata. Functions whose generated code differs between scriptc
// versions lose their profile data, so the profile is collected again when the pinned scriptc changes
// (npm run refresh-profile, which records its scriptc in profiles/tsc-ts.json).
test('the committed profile was collected with the pinned scriptc', () => {
  const pinned = JSON.parse(readFileSync('../../package.json', 'utf8')).devDependencies.scriptc;
  const collected = JSON.parse(readFileSync('profiles/tsc-ts.json', 'utf8')).scriptc;
  assert.equal(
    collected,
    pinned,
    `profiles/tsc-ts.profdata was collected with scriptc ${collected}, but package.json pins ${pinned}: run npm run refresh-profile`,
  );
});

test('the pinned profile projects name a commit, an install command and a config', () => {
  const { projects } = JSON.parse(readFileSync('profiles/projects.json', 'utf8'));
  assert.equal(projects.length, 8);
  for (const project of projects) {
    assert.match(project.commit, /^[0-9a-f]{40}$/, project.name);
    assert.ok(project.install.length > 0, project.name);
    assert.equal(typeof project.config, 'string', project.name);
  }
});

const line = (annotated, mismatched, missing, suffix = '') =>
  `scriptc: profile profiles/tsc-ts.profdata: ${annotated} functions annotated, ${mismatched} mismatched, ${missing} without a record${suffix}\n`;

test("the profile report is read from scriptc's output", () => {
  assert.deepEqual(parseProfileReport(`warning: x\n${line(8914, 230, 14194)}`), {
    annotated: 8914,
    mismatched: 230,
    missing: 14194,
    withoutCounts: 0,
  });
  assert.equal(parseProfileReport(line(10, 0, 5, ', 3 partitions without counts')).withoutCounts, 3);
  assert.equal(parseProfileReport(line(10, 0, 5, ', 1 partition without counts')).withoutCounts, 1);
  assert.equal(parseProfileReport('Compiled dist/tsc\n'), undefined);
});

test('the profile match passes, warns or fails by the share of described functions the build annotates', () => {
  const report = (annotated) => ({ annotated, mismatched: 0, missing: 0, withoutCounts: 0 });
  assert.equal(judgeProfileMatch(report(1000), 1000, { ci: true }).level, 'ok');
  assert.equal(judgeProfileMatch(report(1000 * WARN_BELOW), 1000, { ci: true }).level, 'ok');
  assert.equal(judgeProfileMatch(report(1000 * WARN_BELOW - 1), 1000, { ci: true }).level, 'warn');
  assert.equal(judgeProfileMatch(report(1000 * FAIL_BELOW), 1000, { ci: true }).level, 'warn');
  const stale = judgeProfileMatch(report(1000 * FAIL_BELOW - 1), 1000, { ci: true });
  assert.equal(stale.level, 'fail');
  assert.match(stale.message, /899 of the 1000 functions .* \(89\.9%\).*npm run refresh-profile/);
  assert.equal(judgeProfileMatch(report(1000 * FAIL_BELOW - 1), 1000, { ci: false }).level, 'warn');
});

test('the profile match of a build that is not checked is a note', () => {
  const verdict = judgeProfileMatch({ annotated: 320, mismatched: 680, missing: 0, withoutCounts: 0 }, 1000, {
    ci: true,
    checked: false,
  });
  assert.equal(verdict.level, 'note');
  assert.match(verdict.message, /320 of the 1000 functions .* \(32\.0%\)/);
});

test('the profile match is not checked without a report, a function count or every partition', () => {
  const report = { annotated: 10, mismatched: 0, missing: 0, withoutCounts: 0 };
  assert.equal(judgeProfileMatch(undefined, 1000, { ci: true }).level, 'note');
  assert.equal(judgeProfileMatch(report, undefined, { ci: true }).level, 'note');
  assert.equal(judgeProfileMatch({ ...report, withoutCounts: 2 }, 1000, { ci: true }).level, 'note');
});

test('each committed profile records the scriptc that collected it beside it', () => {
  for (const profile of [SINGLE_PHASE_PROFILE, TWO_PHASE_PROFILE]) {
    if (!existsSync(profile)) continue;
    const info = JSON.parse(readFileSync(profileInfoPath(profile), 'utf8'));
    assert.match(info.scriptc, /^\d+\.\d+\.\d+/, profile);
  }
  assert.equal(profileInfoPath('elsewhere.profdata'), undefined);
});
