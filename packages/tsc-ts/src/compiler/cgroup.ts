// The limits the process's cgroup puts on the machine a run sees: the whole CPUs its CPU quota allows
// and the smallest memory limit of its cgroup and that cgroup's ancestors. `os.availableParallelism()`
// already lowers its count to a quota of one CPU or more; the native runtime's count ignores a quota
// below one, which truncates to no CPUs there and falls back to the affinity mask, so the quota is read
// here too. The memory limit only sometimes reaches `process.constrainedMemory()` (libuv reads the
// process's own cgroup, and scriptc's runtime only the root of the cgroup mount, which is the process's
// own cgroup only inside a cgroup namespace).
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

/**
 * The CPUs this process may run on: `os.availableParallelism()`, lowered to the whole CPUs its cgroup
 * quota allows (`cgroupCpuQuota`). Where the runtime already applies the quota this returns the same
 * count; a quota below one CPU, which the native runtime's count ignores, lowers it to one. The text and
 * root parameters are for the tests.
 */
export function availableCpus(membershipText: string = readMembership(), root: string = '/sys/fs/cgroup'): number {
  const cpus = Math.max(1, availableParallelism());
  const quota = cgroupCpuQuota(membershipText, root);
  return quota > 0 && quota < cpus ? quota : cpus;
}

/**
 * The whole CPUs this process's cgroup and its ancestors allow, or 0 where there is none or it is
 * unknown: `cpu.max` under cgroup v2, `cpu.cfs_quota_us` and `cpu.cfs_period_us` under v1. A quota
 * below one CPU counts as one, the least a run can use. The text and root parameters are for the tests.
 */
export function cgroupCpuQuota(membershipText: string = readMembership(), root: string = '/sys/fs/cgroup'): number {
  let quota = 0;
  const lower = (value: number): void => {
    if (value > 0 && (quota === 0 || value < quota)) quota = value;
  };
  forEachCgroupDirectory(membershipText, root, '', (directory) => {
    lower(cpuMaxValue(directory + '/cpu.max'));
  });
  forEachCgroupDirectory(membershipText, root, 'cpu', (directory) => {
    // The kernel's default period, for a mount that lost the file but kept its quota.
    const period = numberIn(directory + '/cpu.cfs_period_us') || 100_000;
    lower(wholeCpus(numberIn(directory + '/cpu.cfs_quota_us'), period));
  });
  return quota;
}

/**
 * The smallest memory limit of this process's cgroup and its ancestors (Linux), or 0 where there is
 * none or it is unknown: `memory.max` and `memory.high` under cgroup v2, `memory.limit_in_bytes` under
 * v1. The text and root parameters are for the tests.
 */
export function cgroupMemoryLimit(membershipText: string = readMembership(), root: string = '/sys/fs/cgroup'): number {
  let limit = 0;
  const lower = (value: number): void => {
    if (value > 0 && (limit === 0 || value < limit)) limit = value;
  };
  forEachCgroupDirectory(membershipText, root, '', (directory) => {
    lower(memoryLimitValue(directory + '/memory.max'));
    lower(memoryLimitValue(directory + '/memory.high'));
  });
  forEachCgroupDirectory(membershipText, root, 'memory', (directory) => {
    lower(memoryLimitValue(directory + '/memory.limit_in_bytes'));
  });
  return limit;
}

/**
 * Calls `visit` with the directory of this process's cgroup for `controller` and of each of its
 * ancestors, deepest first: the unified hierarchy for `''` (cgroup v2, whose line lists no
 * controllers), or the controller's own mount for a v1 line that lists it.
 */
function forEachCgroupDirectory(
  membershipText: string,
  root: string,
  controller: string,
  visit: (directory: string) => void,
): void {
  for (const line of membershipText.split('\n')) {
    // "0::/path" (v2), "N:cpu:/path" or "N:cpu,cpuacct:/path" (v1).
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (first < 0 || second < 0) continue;
    const controllers = line.substring(first + 1, second);
    const path = line.substring(second + 1);
    if (controller === '') {
      if (controllers !== '') continue;
      forEachAncestor(path, (directory) => visit(root + directory));
    } else if (controllers.split(',').indexOf(controller) >= 0) {
      forEachAncestor(path, (directory) => visit(root + '/' + controller + directory));
    }
  }
}

/**
 * Calls `visit` with `path` and each of its ancestors, deepest first ("/a/b/c", "/a/b", "/a", ""): a
 * cgroup's limits apply to every process below it, in cgroup v1 as in v2.
 */
function forEachAncestor(path: string, visit: (directory: string) => void): void {
  for (let directory = path; ; directory = directory.substring(0, directory.lastIndexOf('/'))) {
    visit(directory === '/' ? '' : directory);
    if (directory === '' || directory.lastIndexOf('/') < 0) break;
  }
}

/** `/proc/self/cgroup`, or an empty text where it cannot be read (no cgroup limits). */
function readMembership(): string {
  try {
    return readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return '';
  }
}

/**
 * The whole CPUs a cgroup v2 quota file allows, or 0 for `max`, an unreadable file or no number:
 * `cpu.max` holds "MAX PERIOD" in microseconds.
 */
function cpuMaxValue(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return 0;
  }
  if (text === '' || text === 'max') return 0;
  const parts = text.split(/\s+/).map(Number);
  return wholeCpus(parts[0]!, parts[1] ?? 100_000);
}

/** A cgroup memory limit file's value in bytes, or 0 for `max`, an unreadable file or no number. */
function memoryLimitValue(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return 0;
  }
  if (text === '' || text === 'max') return 0;
  const value = Number(text);
  // cgroup v1 reports no limit as a page-aligned value near 2^63.
  return Number.isFinite(value) && value > 0 && value < 2 ** 62 ? value : 0;
}

/** A file's number, or 0 where it cannot be read or holds none (a v1 quota of -1 is no quota). */
function numberIn(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return 0;
  }
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The whole CPUs `quota` microseconds per `period` microseconds allow, at least one where there is one. */
function wholeCpus(quota: number, period: number): number {
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return 0;
  return Math.max(1, Math.floor(quota / period));
}
