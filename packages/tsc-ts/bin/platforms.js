// The platform packages that carry the native tsc-ts executable.
import { existsSync } from 'node:fs';

export const platforms = [
  { name: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { name: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { name: 'linux-arm64-gnu', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { name: 'linux-arm64-musl', os: 'linux', cpu: 'arm64', libc: 'musl' },
  { name: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { name: 'linux-x64-musl', os: 'linux', cpu: 'x64', libc: 'musl' },
  { name: 'win32-x64-msvc', os: 'win32', cpu: 'x64' },
];

export function packageName(platform) {
  return `@tsc-ts/${platform.name}`;
}

export function executableName(os = process.platform) {
  return os === 'win32' ? 'tsc-ts.exe' : 'tsc-ts';
}

/** The command line executable, which runs tsc without the API server. */
export function cliExecutableName(os = process.platform) {
  return os === 'win32' ? 'tsc-ts-cli.exe' : 'tsc-ts-cli';
}

// The platform of this process, or undefined if tsc-ts has no build for it.
export function hostPlatform() {
  const libc = hostLibc();
  return platforms.find(
    (p) => p.os === process.platform && p.cpu === process.arch && (p.libc === undefined || p.libc === libc),
  );
}

export function hostDescription() {
  const libc = hostLibc();
  return `${process.platform}-${process.arch}${libc ? `-${libc}` : ''}`;
}

function hostLibc() {
  if (process.platform !== 'linux') return undefined;
  const report = process.report.getReport();
  if (report.header.glibcVersionRuntime) return 'glibc';
  if (report.sharedObjects.some((path) => /(?:^|\/)ld-musl-|libc\.musl-/.test(path))) return 'musl';
  // A statically linked Node loads no libc; look for the musl loader.
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return existsSync(`/lib/ld-musl-${arch}.so.1`) ? 'musl' : undefined;
}
