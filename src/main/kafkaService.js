const {
    createKafkaClient,
    brokerListFromInput,
    probeClusterConnection,
    produceMessage,
    disconnectProducer,
    consumeMessages,
    stopConsuming,
    getTopicsAndPartitions,
    loadTopicsMessageCounts,
    getTopicOffsets,
    getConsumerLagOverview,
    resetConsumerGroupOffsetsToLatest,
    deleteConsumerGroups,
    appendOffsetResetAudit,
    getClusterMetadata,
    createOperationCancelledError,
} = require('../backend/kafka');
const { normalizeConnection, connectionFingerprint, isKafkaAuthError } = require('../backend/kafkaConnection');
const { withRetry } = require('../backend/concurrency');
const { computeTopicMessagesBatch, mergeLagPartitionsBatch } = require('./kafkaWorkerPool');

/** @type {import('electron').BrowserWindow|null} */
let progressWindow = null;

/** @type {Map<string, { client: import('kafkajs').Kafka, key: string }>} */
const clientCache = new Map();

/** @type {Map<string, { admin: import('kafkajs').Admin, connected: boolean, connectPromise: Promise<void>|null }>} */
const adminPool = new Map();

/** @type {Map<string, AbortController>} */
const activeOps = new Map();

/** @type {string|null} */
let activeConsumeOpId = null;

function setProgressWindow(win) {
    progressWindow = win;
}

function sendProgress(opId, payload) {
    if (!progressWindow || progressWindow.isDestroyed()) return;
    progressWindow.webContents.send('kafka:progress', { opId, ...payload });
}

function sendPartial(opId, payload) {
    if (!progressWindow || progressWindow.isDestroyed()) return;
    progressWindow.webContents.send('kafka:partial', { opId, ...payload });
}

function sendConsumeMessage(opId, msg) {
    if (!progressWindow || progressWindow.isDestroyed()) return;
    progressWindow.webContents.send('kafka:message', { opId, msg });
}

function sendConsumeDone(opId) {
    if (!progressWindow || progressWindow.isDestroyed()) return;
    progressWindow.webContents.send('kafka:consume-done', { opId });
}

function hasAnyKafkaSecret(secrets) {
    if (!secrets || typeof secrets !== 'object') return false;
    return Boolean(
        secrets.password
        || secrets.oauthAccessToken
        || secrets.awsSecretAccessKey
        || secrets.sslKeyPassphrase,
    );
}

function buildClientKey(ctx) {
    const connection = normalizeConnection(ctx.connection);
    const hasSecret = hasAnyKafkaSecret(ctx.secrets);
    const epoch = ctx.secretEpoch || 0;
    return `${ctx.envId || 'probe'}|${epoch}|${connectionFingerprint(connection, ctx.brokers, hasSecret)}`;
}

function getOrCreateClient(ctx) {
    const key = buildClientKey(ctx);
    const cached = clientCache.get(key);
    if (cached && cached.client) {
        return { client: cached.client, key };
    }
    const connection = normalizeConnection(ctx.connection);
    const client = createKafkaClient(ctx.brokers, { connection, secrets: ctx.secrets || {} });
    clientCache.set(key, { client, key });
    return { client, key };
}

async function getPooledAdmin(clientKey, client) {
    let entry = adminPool.get(clientKey);
    if (!entry) {
        entry = { admin: client.admin(), connected: false, connectPromise: null };
        adminPool.set(clientKey, entry);
    }
    if (entry.connected) return entry.admin;
    if (entry.connectPromise) {
        await entry.connectPromise;
        return entry.admin;
    }
    entry.connectPromise = entry.admin.connect()
        .then(() => {
            entry.connected = true;
        })
        .finally(() => {
            entry.connectPromise = null;
        });
    await entry.connectPromise;
    return entry.admin;
}

async function disconnectAdminEntry(clientKey) {
    const entry = adminPool.get(clientKey);
    if (!entry) return;
    adminPool.delete(clientKey);
    try {
        await entry.admin.disconnect();
    } catch (err) {
        console.debug('[kss-kafkaService] admin.disconnect', err);
    }
}

function invalidateClientCache(envId) {
    if (envId) {
        for (const [key, entry] of clientCache.entries()) {
            if (key.startsWith(`${envId}|`)) {
                const client = entry.client;
                clientCache.delete(key);
                disconnectProducer(client).catch(() => {});
                disconnectAdminEntry(key).catch(() => {});
            }
        }
        return;
    }
    for (const [key, entry] of clientCache.entries()) {
        disconnectProducer(entry.client).catch(() => {});
        disconnectAdminEntry(key).catch(() => {});
    }
    clientCache.clear();
}

function registerOp(opId) {
    const controller = new AbortController();
    activeOps.set(opId, controller);
    return controller;
}

async function cancelOp(opId) {
    const controller = activeOps.get(opId);
    if (controller) {
        controller.abort();
        activeOps.delete(opId);
        return true;
    }
    if (activeConsumeOpId === opId) {
        activeConsumeOpId = null;
        await stopConsuming();
        return true;
    }
    return false;
}

function finishOp(opId) {
    activeOps.delete(opId);
}

function makeAbortSignal(opId) {
    const controller = activeOps.get(opId);
    return controller ? controller.signal : undefined;
}

async function runWithRetry(opId, fn) {
    return withRetry(fn, {
        maxAttempts: 3,
        onRetry: (attempt, err) => {
            sendProgress(opId, {
                phase: 'retry',
                current: attempt + 1,
                total: 3,
                message: `Retrying after error: ${err.message || err}`,
            });
        },
    });
}

async function handleProbe(ctx, opId) {
    const controller = registerOp(opId);
    try {
        return await runWithRetry(opId, () => probeClusterConnection(ctx.brokersText || ctx.brokers, {
            connection: normalizeConnection(ctx.connection),
            secrets: ctx.secrets || {},
            onProgress: (p) => sendProgress(opId, p),
        }));
    } finally {
        finishOp(opId);
        if (controller.signal.aborted) {
            throw createOperationCancelledError();
        }
    }
}

async function handleGetTopics(ctx, opId, metadataOnly) {
    const controller = registerOp(opId);
    try {
        const { client, key } = getOrCreateClient(ctx);
        return await runWithRetry(opId, async () => {
            const admin = await getPooledAdmin(key, client);
            return getTopicsAndPartitions(client, {
                admin,
                signal: controller.signal,
                metadataOnly: Boolean(metadataOnly),
                concurrency: 10,
                computeTopicMessagesBatch,
                onProgress: (p) => sendProgress(opId, p),
                onPartial: (topics) => sendPartial(opId, { topics }),
            });
        });
    } finally {
        finishOp(opId);
    }
}

async function handleLoadTopicMessageCounts(ctx, opId, topics) {
    const controller = registerOp(opId);
    try {
        const { client, key } = getOrCreateClient(ctx);
        return await runWithRetry(opId, async () => {
            const admin = await getPooledAdmin(key, client);
            return loadTopicsMessageCounts(client, topics, {
                admin,
                signal: controller.signal,
                concurrency: 10,
                computeTopicMessagesBatch,
                onProgress: (p) => sendProgress(opId, p),
                onPartial: (partialTopics) => sendPartial(opId, { topics: partialTopics }),
            });
        });
    } finally {
        finishOp(opId);
    }
}

async function handleGetTopicOffsets(ctx, opId, topic) {
    registerOp(opId);
    try {
        const { client, key } = getOrCreateClient(ctx);
        return await runWithRetry(opId, async () => {
            const admin = await getPooledAdmin(key, client);
            sendProgress(opId, { phase: 'offsets', current: 0, total: 1, message: 'Loading partitions…' });
            const offsets = await admin.fetchTopicOffsets(topic);
            sendProgress(opId, { phase: 'done', current: 1, total: 1, message: 'Partitions loaded' });
            return offsets;
        });
    } finally {
        finishOp(opId);
    }
}

async function handleGetClusterMetadata(ctx, opId) {
    registerOp(opId);
    try {
        const { client } = getOrCreateClient(ctx);
        return await runWithRetry(opId, () => getClusterMetadata(client, ctx.brokers, {
            onProgress: (p) => sendProgress(opId, p),
        }));
    } finally {
        finishOp(opId);
    }
}

async function handleGetConsumerLag(ctx, opId, topicName) {
    registerOp(opId);
    try {
        const { client } = getOrCreateClient(ctx);
        return await runWithRetry(opId, () => getConsumerLagOverview(client, topicName, {
            concurrency: 10,
            mergeLagPartitionsBatch,
            onProgress: (p) => sendProgress(opId, p),
        }));
    } finally {
        finishOp(opId);
    }
}

async function handleProduce(ctx, opId, topic, message) {
    registerOp(opId);
    try {
        const { client } = getOrCreateClient(ctx);
        sendProgress(opId, { phase: 'produce', current: 0, total: 1, message: 'Sending message…' });
        await runWithRetry(opId, () => produceMessage(client, topic, message));
        sendProgress(opId, { phase: 'done', current: 1, total: 1, message: 'Message sent' });
        return { ok: true };
    } finally {
        finishOp(opId);
    }
}

async function handlePingAuth(ctx, opId) {
    registerOp(opId);
    try {
        const { client, key } = getOrCreateClient(ctx);
        await runWithRetry(opId, async () => {
            sendProgress(opId, { phase: 'connect', current: 0, total: 1, message: 'Verifying connection…' });
            await getPooledAdmin(key, client);
            sendProgress(opId, { phase: 'done', current: 1, total: 1, message: 'Connected' });
        });
        return { ok: true };
    } finally {
        finishOp(opId);
    }
}

async function handleConsumeStart(ctx, opId, options) {
    if (activeConsumeOpId) {
        await stopConsuming().catch(() => {});
    }
    activeConsumeOpId = opId;
    const { client } = getOrCreateClient(ctx);
    sendProgress(opId, { phase: 'consume', current: 0, total: 1, message: 'Starting consumer…' });
    consumeMessages(client, options, (msg) => {
        sendConsumeMessage(opId, msg);
    }, () => {
        activeConsumeOpId = null;
        sendConsumeDone(opId);
    }).catch((err) => {
        activeConsumeOpId = null;
        sendConsumeDone(opId);
        if (progressWindow && !progressWindow.isDestroyed()) {
            progressWindow.webContents.send('kafka:consume-error', { opId, error: err.message || String(err) });
        }
    });
    return { ok: true, opId };
}

async function handleConsumeStop() {
    activeConsumeOpId = null;
    await stopConsuming();
    return { ok: true };
}

async function handleResetOffsets(ctx, opId, options) {
    registerOp(opId);
    try {
        const { client } = getOrCreateClient(ctx);
        sendProgress(opId, { phase: 'reset', current: 0, total: 1, message: 'Resetting offsets…' });
        const result = await runWithRetry(opId, () => resetConsumerGroupOffsetsToLatest(client, options));
        sendProgress(opId, { phase: 'done', current: 1, total: 1, message: 'Offsets reset' });
        return result;
    } finally {
        finishOp(opId);
    }
}

async function handleDeleteGroups(ctx, opId, options) {
    registerOp(opId);
    try {
        const { client } = getOrCreateClient(ctx);
        sendProgress(opId, { phase: 'delete', current: 0, total: 1, message: 'Deleting groups…' });
        const result = await runWithRetry(opId, () => deleteConsumerGroups(client, options));
        sendProgress(opId, { phase: 'done', current: 1, total: 1, message: 'Groups deleted' });
        return result;
    } finally {
        finishOp(opId);
    }
}

function handleAppendAudit(event) {
    appendOffsetResetAudit(event);
    return { ok: true };
}

module.exports = {
    setProgressWindow,
    invalidateClientCache,
    cancelOp,
    handleProbe,
    handleGetTopics,
    handleLoadTopicMessageCounts,
    handleGetTopicOffsets,
    handleGetClusterMetadata,
    handleGetConsumerLag,
    handleProduce,
    handlePingAuth,
    handleConsumeStart,
    handleConsumeStop,
    handleResetOffsets,
    handleDeleteGroups,
    handleAppendAudit,
    isKafkaAuthError,
    brokerListFromInput,
};
