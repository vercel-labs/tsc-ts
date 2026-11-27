// tsc-ts-cli: the command line, without the API server. The `tsc-ts` executable serves `--api`, and its program
// regions keep every project's objects region-aware; this executable leaves them out so a plain check pays nothing
// for them.
import { Worker } from 'node:worker_threads';
import { runEntry } from './entry.js';

runEntry((data) => new Worker(new URL('./cli-main.js', import.meta.url), { workerData: data }), undefined);
