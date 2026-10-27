// The two profiles in profiles/: tsc-ts.profdata, collected in one phase, and tsc-ts.cs.profdata, collected in two
// phases, whose second phase counts code after inlining (context-sensitive counts). A scriptc that accepts a second
// profile phase, --profile-use together with --profile-generate, lays out the code it compiles by those counts; an
// older scriptc refuses the combination and matches only part of a profile that another scriptc collected. Each
// profile's function count and the scriptc that collected it are recorded beside it (tsc-ts.json, tsc-ts.cs.json).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SINGLE_PHASE_PROFILE = 'profiles/tsc-ts.profdata';
export const TWO_PHASE_PROFILE = 'profiles/tsc-ts.cs.profdata';

// The file that records a committed profile's scriptc and function count, or undefined for another profile.
export function profileInfoPath(profile) {
  if (profile === SINGLE_PHASE_PROFILE) return 'profiles/tsc-ts.json';
  if (profile === TWO_PHASE_PROFILE) return 'profiles/tsc-ts.cs.json';
  return undefined;
}

// Whether `scriptc` accepts a second profile phase: builds a one-line program with --profile-use of `profile` and
// --profile-generate, and reports whether the build succeeded.
export function supportsSecondProfilePhase(scriptc, profile) {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-profile-probe-'));
  try {
    const entry = join(dir, 'probe.ts');
    writeFileSync(entry, 'console.log("probe");\n');
    const result = spawnSync(
      scriptc,
      [
        'build',
        entry,
        '--optimization=speed',
        `--profile-use=${profile}`,
        `--profile-generate=${join(dir, '%p.profraw')}`,
        '-o',
        join(dir, 'probe'),
      ],
      { stdio: 'ignore' },
    );
    return result.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
