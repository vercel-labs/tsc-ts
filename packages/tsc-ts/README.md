# tsc-ts

The TypeScript 7.0.2 compiler (tsgo), ported to TypeScript and compiled to a native executable with [scriptc](https://scriptc.dev). Experimental.

## Installation

```sh
npm install -D tsc-ts
```

npm installs the executable for your platform from an optional dependency:

| Platform                         | Package                    |
| -------------------------------- | -------------------------- |
| macOS, Apple silicon             | `@tsc-ts/darwin-arm64`     |
| macOS, Intel                     | `@tsc-ts/darwin-x64`       |
| Linux arm64, glibc 2.34 or later | `@tsc-ts/linux-arm64-gnu`  |
| Linux arm64, musl                | `@tsc-ts/linux-arm64-musl` |
| Linux x64, glibc 2.34 or later   | `@tsc-ts/linux-x64-gnu`    |
| Linux x64, musl                  | `@tsc-ts/linux-x64-musl`   |
| Windows x64                      | `@tsc-ts/win32-x64-msvc`   |

Don't install with `--omit=optional` or `--no-optional`.

## Usage

`tsc-ts` takes the same arguments as `tsc`:

```sh
npx tsc-ts -p tsconfig.json
npx tsc-ts --noEmit src/index.ts
```

`tsc-ts --api` serves the TypeScript API over stdin and stdout, like `tsc --api`.

`--checkers N` checks the program with N checkers, each on its own thread. Files go to checkers as in tsgo: file i of the program to checker i % N, and each checker checks its files in program order. What a checker has computed for the files it checked before can change the errors it reports for the next one, so the output is the same on every run with the same number of checkers, and matches tsgo's with as many checkers. Pass `--checkers 4` for output identical to tsgo's default.

Unless `--checkers` or `--singleThreaded` is given, the native executable uses one checker per CPU it may run on (up to 16), and at least four. It uses fewer than the CPUs, but never fewer than four, when the estimated peak memory of more checkers would not fit 85% of the machine's memory (`TSC_TS_CHECKERS=fixed` uses four). Its output is then the same on every run on the same machine. Programs with less than 20,000 characters to check are checked on one thread. The native executable shares one program between its threads and also parses and binds the program's files on them. Under Node.js, where every thread builds its own copy of the program, tsc-ts checks on one thread unless `--checkers` is given.

The native executable never frees syntax trees, types, signatures or symbols: it keeps them until it exits, which saves the cost of tracking them during a build. A one-shot build is unaffected, but a long-running process grows with each rebuild or project update. Native `--watch` (also with `--build`) runs in a child process, and when a change arrives while that process holds more than 2.5 times the memory it held after its first build, a new process replaces it and builds the change, reporting what the old process would have. `TSC_TS_WATCH_MEMORY` sets that limit in megabytes, and `TSC_TS_WATCH_MEMORY=0` turns the replacement off. A `--api` process grows with each project update; restart it to reclaim the memory.

The default lib files (`lib.*.d.ts`) ship next to the executable. Set `TSC_TS_LIB_DIR` to use another directory.
