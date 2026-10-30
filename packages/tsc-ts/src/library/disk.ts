// The disk, as tsc-ts's public API and `tsc-ts --api` read it where a host doesn't answer.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isNetworkPath } from '../compiler/path.js';

// Network paths are never accessed (`isNetworkPath`).

export interface DirectoryEntries {
  files: string[];
  directories: string[];
}

export interface FileStat {
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

// Reads a text file, decoding UTF-16 byte order marks and dropping a UTF-8 one.
export function diskReadFile(path: string): string | undefined {
  if (isNetworkPath(path)) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    return undefined;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  return new TextDecoder().decode(bytes);
}

function utf16be(bytes: Uint8Array): string {
  const swapped = new Uint8Array(bytes.length & ~1);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return new TextDecoder('utf-16le').decode(swapped);
}

export function diskStat(path: string): FileStat | undefined {
  if (isNetworkPath(path)) return undefined;
  try {
    const s = statSync(path);
    return { isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

// Lists a directory, following symbolic links and skipping broken ones.
export function diskEntries(path: string): DirectoryEntries {
  const files: string[] = [];
  const directories: string[] = [];
  let names: string[];
  if (isNetworkPath(path)) return { files, directories };
  try {
    names = readdirSync(path);
  } catch {
    return { files, directories };
  }
  for (const name of names.sort()) {
    const stat = diskStat(path + '/' + name);
    if (stat === undefined) continue;
    if (stat.isDirectory) directories.push(name);
    else files.push(name);
  }
  return { files, directories };
}

export function diskRealpath(path: string): string {
  if (isNetworkPath(path)) return path;
  try {
    // A local path may resolve to a network location (a mapped network drive): keep the original.
    const real = realpathSync(path);
    return isNetworkPath(real) ? path : real;
  } catch {
    return path;
  }
}
