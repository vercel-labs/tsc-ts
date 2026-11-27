// tsc-ts: `--api` serves the TypeScript API; anything else runs tsc.
import { Worker } from 'node:worker_threads';
import { runServer } from './api/server.js';
import { runEntry } from './entry.js';

runEntry((data) => new Worker(new URL('./main.js', import.meta.url), { workerData: data }), runServer);
