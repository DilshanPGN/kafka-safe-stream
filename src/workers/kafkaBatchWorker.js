const { parentPort } = require('worker_threads');

function computeTotalMessages(offsets) {
    if (!Array.isArray(offsets)) return null;
    return offsets.reduce((sum, o) => {
        const high = Number(o.high || 0);
        const low = Number(o.low || 0);
        return sum + Math.max(0, high - low);
    }, 0);
}

function handleComputeTopicMessages(msg) {
    const { jobId, entries } = msg;
    const results = (entries || []).map((entry) => ({
        name: entry.name,
        totalMessages: entry.offsetError ? null : computeTotalMessages(entry.offsets),
        offsets: entry.offsets || [],
        offsetError: entry.offsetError || null,
    }));
    parentPort.postMessage({ jobId, type: 'result', results });
}

function handleMergeLagPartitions(msg) {
    const { jobId, groups } = msg;
    const merged = (groups || []).map((g) => {
        let totalLag = 0;
        for (const pr of g.partitionRows || []) {
            if (typeof pr.lag === 'number') totalLag += pr.lag;
        }
        return { ...g, totalLag };
    });
    parentPort.postMessage({ jobId, type: 'result', groups: merged });
}

parentPort.on('message', (msg) => {
    if (!msg || !msg.type) return;
    try {
        if (msg.type === 'computeTopicMessages') {
            handleComputeTopicMessages(msg);
        } else if (msg.type === 'mergeLagPartitions') {
            handleMergeLagPartitions(msg);
        } else {
            parentPort.postMessage({ jobId: msg.jobId, type: 'error', error: `Unknown job type: ${msg.type}` });
        }
    } catch (err) {
        parentPort.postMessage({
            jobId: msg.jobId,
            type: 'error',
            error: err.message || String(err),
        });
    }
});
