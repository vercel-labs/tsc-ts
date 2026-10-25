# CI scripts

`.github/workflows/ci.yml` runs in two lanes:

- **Pull requests** run lint and format, the build (which type-checks every source file), a smoke set of short
  tests, and the tests the change selects. Selection reads the diff from the merge base; see the rules at the top of
  `select-tests.mjs`. Changes to CI configuration, build scripts, manifests, the lockfile, `upstream.json`, the
  oracles or a path no rule covers run every test.
- **Pushes to main** (and manual runs) run every test.

Both lanes build once (`build` job) and share the build through an artifact. The tests run in shards packed from
measured durations; the `CI result` job fails when any other job failed, and is the check to require.

The **native lane** runs when a pull request changes runtime code of tsc-ts (`packages/tsc-ts/src` beyond types and
comments), and on every full run, which includes scriptc upgrades (the lockfile changes). The `native build` job
compiles the shipped native tsc-ts (`npm run build:native`, `packages/tsc-ts/dist/tsc`) and a native command line
driver (`src/drivers/cli.ts`, `dist/cli`) next to the `build` job, with scriptc's runtime cache kept per scriptc
version. The `native test` shards then run the native twins (`native:<unit>`) of the selected units of the test files
that take a native build: `TSC_TS_BIN` for api, api-libraries-from-disk, api-listen, api-pipe, build, library-checking, parallel-emit, projects, scriptc
and tsc-project, `TSC_TS_CLI` for program and command-line. With the native lane, the `API server (windows)` job builds
the native tsc-ts on Windows, with the named pipe server `--api --pipe` serves on (`native/pipe-win32.c`, compiled
with zig), and runs `api-pipe.test.mjs` with it, over the pipe and over standard input and output, and `native/pipe-win32.test.c`, which checks that the pipe's DACL grants access to the current user only. Locally:

```sh
(cd packages/tsc-ts && npm run build:native && npx scriptc build src/drivers/cli.ts --optimization=speed -o dist/cli)
node scripts/ci/run-tests.mjs --set native
```

`release.yml` checks for an unreleased package version on every push to main. To prepare a release, update
`packages/tsc-ts/package.json` and its entry in `package-lock.json`, and put that version's notes between the
`release:start` and `release:end` markers in the root `CHANGELOG.md`. Keep previous entries below the markers.
CI checks that the marked entry matches the package version with `node scripts/release-notes.mjs`.

Merge the version bump to main to start the release. The workflow waits for that commit's full CI run to succeed,
builds the packages, and waits for approval in the `Release` environment before publishing to npm. It then creates
the version tag and GitHub release automatically, uses the marked changelog entry as its body, and attaches the
eight published npm tarballs. No manual tag or workflow dispatch is needed. The release stays a draft until all
assets are uploaded; later main pushes skip versions with a completed GitHub release.

If the GitHub release job fails, rerun failed jobs to finish it without publishing to npm again. A manual workflow
dispatch from main can start a release for main's current version; the optional `release_tag` input selects an
existing tag for a retry. Runs use a fixed source commit, and retries of an existing tag keep that tag's commit.

| Script              | What it does                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `units.mjs`         | The test units (test files and parts of the split test files) and shard packing.                                |
| `select-tests.mjs`  | Chooses the units for a change. `node scripts/ci/select-tests.mjs --base origin/main` shows what a branch runs. |
| `run-tests.mjs`     | Runs units (`--set node`, the default, or `native`), retries a failed unit once, reports flaky and quarantined. |
| `quarantine.txt`    | Tests that are known to flake: they run, but their failures do not fail the job.                                |
| `coverage-map.mjs`  | Regenerates `coverage-map.json`, which source files and functions each tsc-ts test file runs.                   |
| `durations.json`    | Seconds per unit on a GitHub-hosted runner. `update-durations.mjs` refreshes it from test reports.              |
| `compile-tests.mjs` | Compiles all tsc-ts sources once for the tests (`TSC_TS_TEST_BUILD`).                                           |
| `ci-status.mjs`     | `latest-green` prints the latest main commit with a green CI run; `require-green <sha>` is the release gate.    |

Running a shard locally, after `npm ci`, `npm run fetch:upstream` and
`npx turbo run build build:oracle --filter='!@tsc-ts/web'`:

```sh
node scripts/ci/select-tests.mjs --base origin/main --out plan.json
node scripts/ci/run-tests.mjs --plan plan.json --shard 1/3
```

Regenerate `coverage-map.json` after adding test files or moving code between source files
(`node scripts/ci/coverage-map.mjs`, about 15 minutes on 16 cores). A stale map can leave a test out of a pull
request's selection; the full run on main still runs it.
