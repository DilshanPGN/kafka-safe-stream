const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

const POOL_SIZE = Math.min(8, Math.max(1, os.cpus().length));
const WORKER_PATH = path.join(__dirname, '../workers/kafkaBatchWorker.js');

let jobSeq = 0;
/** @type {Worker[]} */
const workers = [];
/** @type {Map<number, { resolve: Function, reject: Function }>} */
const pendingJobs = new Map();
/** @type {Array<{ jobId: number, payload: object }>} */
const jobQueue = [];
/** @type {Set<Worker>} */
const busyWorkers = new Set();
let initialized = false;

function initPool() {
    if (initialized) return;
    initialized = true;
    for (let i = 0; i < POOL_SIZE; i += 1) {
        spawnWorker();
    }
}

function tryDispatch() {
    if (jobQueue.length === 0) return;
    for (const worker of workers) {
        if (busyWorkers.has(worker)) continue;
        const job = jobQueue.shift();
        if (!job) return;
        busyWorkers.add(worker);
        worker.postMessage(job.payload);
        return;
    }
}

function spawnWorker() {
    const worker = new Worker(WORKER_PATH);
    worker.on('message', (msg) => {
        busyWorkers.delete(worker);
        if (!msg || msg.jobId == null) {
            tryDispatch();
            return;
        }
        const pending = pendingJobs.get(msg.jobId);
        if (pending) {
            pendingJobs.delete(msg.jobId);
            if (msg.type === 'error') {
                pending.reject(new Error(msg.error || 'Worker error'));
            } else {
                pending.resolve(msg);
            }
        }
        tryDispatch();
    });
    worker.on('error', (err) => {
        busyWorkers.delete(worker);
        console.error('[kss-worker] error', err);
        tryDispatch();
    });
    workers.push(worker);
}

function runWorkerJob(payload) {
    initPool();
    const jobId = ++jobSeq;
    const fullPayload = { ...payload, jobId };
    return new Promise((resolve, reject) => {
        pendingJobs.set(jobId, { resolve, reject });
        jobQueue.push({ jobId, payload: fullPayload });
        tryDispatch();
    });
}

/**
 * @param {Array<{ name: string, offsets?: object[], offsetError?: string|null }>} entries
 */
async function computeTopicMessagesBatch(entries) {
    if (!entries || entries.length === 0) return [];
    const msg = await runWorkerJob({ type: 'computeTopicMessages', entries });
    return msg.results || [];
}

/**
 * @param {object[]} groups
 */
async function mergeLagPartitionsBatch(groups) {
    if (!groups || groups.length === 0) return [];
    const msg = await runWorkerJob({ type: 'mergeLagPartitions', groups });
    return msg.groups || [];
}

function shutdownWorkerPool() {
    for (const w of workers) {
        w.terminate().catch(() => {});
    }
    workers.length = 0;
    jobQueue.length = 0;
    pendingJobs.clear();
    busyWorkers.clear();
    initialized = false;
}

module.exports = {
    computeTopicMessagesBatch,
    mergeLagPartitionsBatch,
    shutdownWorkerPool,
    POOL_SIZE,
};
