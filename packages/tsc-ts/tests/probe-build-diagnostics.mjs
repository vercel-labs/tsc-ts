// Builds a program with scriptc and reports on the build: the runner's CPUs, memory, swap, transparent huge pages and
// TMPDIR, the scriptc version, and the build's SCRIPTC_TIMING phases. A build that has not finished after `stallMs`
// is reported while it is stuck: ps state, CPU time and wait channel of the scriptc processes, their threads, kernel
// stacks and gdb backtraces where the runner allows them. Then the build is killed.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readdirSync } from 'node:fs';

function sh(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error !== undefined) return `(${command}: ${result.error.message})`;
  return (result.stdout + result.stderr).trimEnd();
}

function read(path) {
  try {
    return readFileSync(path, 'utf8').trimEnd();
  } catch (e) {
    return `(${e.code})`;
  }
}

/** The runner's CPUs, memory, swap, huge page settings, TMPDIR and the scriptc version. */
export function environmentReport(scriptc) {
  return [
    `nproc: ${sh('nproc', [])} (online ${sh('getconf', ['_NPROCESSORS_ONLN'])})`,
    `uname: ${sh('uname', ['-a'])}`,
    `transparent_hugepage/enabled: ${read('/sys/kernel/mm/transparent_hugepage/enabled')}`,
    `transparent_hugepage/defrag: ${read('/sys/kernel/mm/transparent_hugepage/defrag')}`,
    `free -m:\n${sh('free', ['-m'])}`,
    `/proc/swaps:\n${read('/proc/swaps')}`,
    `TMPDIR: ${process.env.TMPDIR ?? '(unset)'}`,
    `df -h /tmp:\n${sh('df', ['-h', process.env.TMPDIR ?? '/tmp'])}`,
    `ptrace_scope: ${read('/proc/sys/kernel/yama/ptrace_scope')}`,
    `scriptc --version: ${sh(scriptc, ['--version'])}`,
    `SCRIPTC_EMIT_WORKERS: ${process.env.SCRIPTC_EMIT_WORKERS ?? '(unset)'}`,
  ].join('\n');
}

// The processes below `pid`, with `pid`.
function descendants(pid) {
  const lines = sh('ps', ['-eo', 'pid=,ppid=']).split('\n');
  const parents = lines.map((l) => l.trim().split(/\s+/).map(Number));
  const found = [pid];
  for (let grew = true; grew;) {
    grew = false;
    for (const [child, parent] of parents) {
      if (found.includes(parent) && !found.includes(child)) {
        found.push(child);
        grew = true;
      }
    }
  }
  return found;
}

/** The state of the processes of a stuck build. */
function stuckReport(pid) {
  const pids = descendants(pid);
  const out = [`ps:\n${sh('ps', ['-o', 'pid,ppid,stat,time,etime,wchan:32,nlwp,rss,args', '-p', pids.join(',')])}`];
  out.push(`threads:\n${sh('ps', ['-L', '-o', 'pid,lwp,stat,time,wchan:32,comm', '-p', pids.join(',')])}`);
  for (const p of pids) {
    out.push(`--- ${p}: ${read(`/proc/${p}/cmdline`).replaceAll('\0', ' ')}`);
    out.push(`status:\n${read(`/proc/${p}/status`)}`);
    out.push(`wchan: ${read(`/proc/${p}/wchan`)}`);
    let tasks = [];
    try {
      tasks = readdirSync(`/proc/${p}/task`);
    } catch {}
    for (const t of tasks) {
      out.push(`task ${t} wchan ${read(`/proc/${p}/task/${t}/wchan`)} stat ${read(`/proc/${p}/task/${t}/stat`)}`);
      const stack = read(`/proc/${p}/task/${t}/stack`);
      out.push(
        `task ${t} stack:\n${stack.startsWith('(') ? sh('sudo', ['-n', 'cat', `/proc/${p}/task/${t}/stack`]) : stack}`,
      );
    }
    out.push(`fds:\n${sh('ls', ['-l', `/proc/${p}/fd`])}`);
    out.push(
      `gdb:\n${sh('sudo', ['-n', 'gdb', '-batch', '-ex', 'info threads', '-ex', 'thread apply all bt', '-p', String(p)])}`,
    );
    out.push(`eu-stack:\n${sh('sudo', ['-n', 'eu-stack', '-p', String(p)])}`);
  }
  return out.join('\n');
}

/**
 * Runs `scriptc build` with `args` in `cwd`, its output in `log`, and resolves to `{ status, report }`. The report has
 * the environment, the build's timing phases, and, for a build stuck after `stallMs`, its processes' state.
 */
export async function buildWithDiagnostics(scriptc, args, cwd, env, log, stallMs) {
  const fd = openSync(log, 'w');
  const start = Date.now();
  const child = spawn(scriptc, ['build', ...args], {
    cwd,
    env: { ...env, SCRIPTC_TIMING: '1' },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  let stuck = '';
  const timer = setTimeout(() => {
    stuck = `stuck after ${Math.round((Date.now() - start) / 1000)} s:\n${stuckReport(child.pid)}`;
    for (const p of descendants(child.pid).reverse()) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {}
    }
  }, stallMs);
  const status = await new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? signal)));
  clearTimeout(timer);
  const output = read(log);
  const timing = output
    .split('\n')
    .filter((line) => line.startsWith('scriptc timing') || line.startsWith('scriptc lowering'))
    .join('\n');
  const report = [
    `build ${args.join(' ')}: status ${status} in ${Math.round((Date.now() - start) / 1000)} s`,
    timing,
    stuck,
  ].join('\n');
  return { status, output, report };
}
