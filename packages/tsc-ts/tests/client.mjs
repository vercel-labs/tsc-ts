// A minimal synchronous-protocol API client for tests. It answers the
// server's file system callbacks from the disk.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';

const Request = 1;
const CallResponse = 2;
const Response = 4;
const Error_ = 5;
const Call = 6;

export const callbacks = ['readFile', 'fileExists', 'directoryExists', 'realpath', 'getAccessibleEntries'];

export class Client {
  // command: [executable, ...args] that starts `tsc --api`; `args` are more server flags. With `pipe` (Windows), the
  // server serves on the named pipe it creates, as scriptc's Node host starts it, and the client connects to it once
  // it exists.
  constructor(command, cwd, env = {}, { pipe, args: extra = [] } = {}) {
    const args = [...command.slice(1), '--api', '--cwd', cwd, `--callbacks=${callbacks.join(',')}`, ...extra];
    this.child = spawn(command[0], pipe === undefined ? args : [...args, '--pipe', pipe], {
      stdio: pipe === undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.init();
    const receive = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    };
    if (pipe === undefined) {
      this.output = this.child.stdin;
      this.child.stdout.on('data', receive);
    } else {
      this.pending = [];
      this.connectPipe(pipe, receive, Date.now() + 30_000);
    }
    this.child.stderr.on('data', (chunk) => (this.stderr += chunk));
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)));
    this.child.on('exit', () => {
      for (const w of this.waiters.splice(0)) w.reject(new Error(`server exited: ${this.stderr}`));
    });
  }

  // A client of the server listening on the Unix socket `path` (`tsc-ts --api --listen`). `close()` resolves once
  // the server has closed the connection.
  static connect(path) {
    const client = Object.create(Client.prototype);
    client.init();
    client.socket = connect(path);
    client.socket.on('data', (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      client.drain();
    });
    client.output = client.socket;
    // Resolves to 0, or to 1 after a connection error.
    client.exited = new Promise((resolve) => client.socket.once('close', (error) => resolve(error ? 1 : 0)));
    client.socket.on('error', (error) => (client.stderr += `${error.message}\n`));
    client.socket.once('close', () => {
      for (const w of client.waiters.splice(0)) w.reject(new Error(`connection closed: ${client.stderr}`));
    });
    return client;
  }

  init() {
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.stderr = '';
    this.calls = [];
  }

  // Sends a request and returns { type: 'response' | 'error', payload: Buffer }.
  request(method, params) {
    const payload = Buffer.from(params === undefined ? 'null' : JSON.stringify(params));
    this.write(Request, method, payload);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  // Sends a request whose payload is \`bytes\` as they are.
  requestBytes(method, bytes) {
    this.write(Request, method, Buffer.from(bytes));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async json(method, params) {
    const reply = await this.request(method, params);
    if (reply.type === 'error') throw new Error(`${method}: ${reply.payload}`);
    return JSON.parse(reply.payload.toString());
  }

  async close() {
    if (this.output !== undefined) this.output.end();
    else this.closing = true;
    return this.exited;
  }

  write(type, method, payload) {
    const name = Buffer.from(method);
    const frame = Buffer.concat([Buffer.from([0x93, type]), bin(name), bin(payload)]);
    if (this.output !== undefined) this.output.write(frame);
    else this.pending.push(frame);
  }

  // Connects to the server's pipe, retrying until the server has created it, then sends what was written meanwhile.
  connectPipe(pipe, receive, deadline) {
    const socket = connect(pipe);
    socket.once('error', (error) => {
      if (this.output === undefined && Date.now() < deadline && this.child.exitCode === null)
        setTimeout(() => this.connectPipe(pipe, receive, deadline), 20);
      else for (const w of this.waiters.splice(0)) w.reject(error);
    });
    socket.once('connect', () => {
      socket.on('data', receive);
      this.output = socket;
      for (const frame of this.pending.splice(0)) socket.write(frame);
      if (this.closing) socket.end();
    });
  }

  drain() {
    for (;;) {
      const frame = readFrame(this.buffer);
      if (frame === undefined) return;
      this.buffer = this.buffer.subarray(frame.size);
      if (frame.type === Call) {
        const arg = JSON.parse(frame.payload.toString());
        this.calls.push([frame.method, arg]);
        this.write(CallResponse, frame.method, Buffer.from(JSON.stringify(answer(frame.method, arg))));
      } else if (frame.type === Response || frame.type === Error_) {
        this.waiters.shift().resolve({ type: frame.type === Response ? 'response' : 'error', payload: frame.payload });
      }
    }
  }
}

function answer(method, path) {
  switch (method) {
    case 'readFile':
      return existsSync(path) && statSync(path).isFile() ? { content: readFileSync(path, 'utf8') } : null;
    case 'fileExists':
      return existsSync(path) && statSync(path).isFile();
    case 'directoryExists':
      return existsSync(path) && statSync(path).isDirectory();
    case 'realpath':
      return existsSync(path) ? realpathSync(path) : path;
    case 'getAccessibleEntries': {
      if (!existsSync(path)) return null;
      const files = [];
      const directories = [];
      for (const name of readdirSync(path).sort()) {
        try {
          (statSync(`${path}/${name}`).isDirectory() ? directories : files).push(name);
        } catch {}
      }
      return { files, directories };
    }
  }
  return null;
}

function bin(data) {
  const n = data.length;
  if (n < 0x100) return Buffer.concat([Buffer.from([0xc4, n]), data]);
  if (n < 0x10000) return Buffer.concat([Buffer.from([0xc5, n >> 8, n & 0xff]), data]);
  const head = Buffer.alloc(5);
  head[0] = 0xc6;
  head.writeUInt32BE(n, 1);
  return Buffer.concat([head, data]);
}

function readFrame(b) {
  let i = 0;
  const need = (n) => i + n <= b.length;
  if (!need(2)) return undefined;
  i++;
  let type = b[i++];
  if (type === 0xcc) {
    if (!need(1)) return undefined;
    type = b[i++];
  }
  const readBin = () => {
    if (!need(1)) return undefined;
    const t = b[i++];
    let n;
    if (t === 0xc4) {
      if (!need(1)) return undefined;
      n = b[i++];
    } else if (t === 0xc5) {
      if (!need(2)) return undefined;
      n = b.readUInt16BE(i);
      i += 2;
    } else {
      if (!need(4)) return undefined;
      n = b.readUInt32BE(i);
      i += 4;
    }
    if (!need(n)) return undefined;
    const out = b.subarray(i, i + n);
    i += n;
    return out;
  };
  const method = readBin();
  if (method === undefined) return undefined;
  const payload = readBin();
  if (payload === undefined) return undefined;
  return { type, method: method.toString(), payload: Buffer.from(payload), size: i };
}
