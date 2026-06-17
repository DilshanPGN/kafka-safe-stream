const { ipcRenderer } = require('electron');
const { brokerListFromInput } = require('../backend/kafka');
const { isKafkaAuthError } = require('../backend/kafkaConnection');

let seq = 0;
/** @type {Map<string, { onPartial?: Function, onProgress?: Function }>} */
const opHandlers = new Map();
let ipcListenersBound = false;

function ensureIpcListeners() {
    if (ipcListenersBound || !ipcRenderer) return;
    ipcListenersBound = true;

    ipcRenderer.on('kafka:progress', (_event, payload) => {
        if (!payload || !payload.opId) return;
        const handlers = opHandlers.get(payload.opId);
        if (handlers && typeof handlers.onProgress === 'function') {
            handlers.onProgress(payload);
        }
    });

    ipcRenderer.on('kafka:partial', (_event, payload) => {
        if (!payload || !payload.opId) return;
        const handlers = opHandlers.get(payload.opId);
        if (handlers && typeof handlers.onPartial === 'function') {
            handlers.onPartial(payload.topics);
        }
    });

    ipcRenderer.on('kafka:message', (_event, payload) => {
        if (!payload || payload.opId !== consumeOpId) return;
        if (typeof consumeMessageHandler === 'function') {
            consumeMessageHandler(payload.msg);
        }
    });

    ipcRenderer.on('kafka:consume-done', (_event, payload) => {
        if (!payload || payload.opId !== consumeOpId) return;
        const done = consumeDoneHandler;
        consumeOpId = null;
        consumeMessageHandler = null;
        consumeDoneHandler = null;
        consumeErrorHandler = null;
        consumeLogHandler = null;
        if (typeof done === 'function') done();
    });

    ipcRenderer.on('kafka:consume-error', (_event, payload) => {
        if (!payload || payload.opId !== consumeOpId) return;
        const errHandler = consumeErrorHandler;
        consumeOpId = null;
        consumeMessageHandler = null;
        consumeDoneHandler = null;
        consumeErrorHandler = null;
        consumeLogHandler = null;
        if (typeof errHandler === 'function') {
            errHandler(new Error(payload.error || 'Consumer error'));
        }
    });

    ipcRenderer.on('kafka:consume-log', (_event, payload) => {
        if (!payload || payload.opId !== consumeOpId) return;
        if (typeof consumeLogHandler === 'function') {
            consumeLogHandler(payload.entry);
        }
    });
}

function nextOpId() {
    seq += 1;
    return `op-${Date.now()}-${seq}`;
}

function buildCtx(envId, brokers, connection, secrets, secretEpoch) {
    return {
        envId: envId || 'probe',
        brokers: Array.isArray(brokers) ? brokers : [],
        connection: connection || {},
        secrets: secrets || {},
        secretEpoch: secretEpoch || 0,
    };
}

async function invokeKafka(channel, payload) {
    ensureIpcListeners();
    const response = await ipcRenderer.invoke(channel, payload);
    if (!response || response.ok === false) {
        const err = new Error((response && response.error) || 'Kafka operation failed');
        if (response && response.authError) {
            err.name = 'KafkaJSSASLAuthenticationError';
        }
        throw err;
    }
    return response.result !== undefined ? response.result : response;
}

function registerOpHandlers(opId, handlers) {
    if (handlers) opHandlers.set(opId, handlers);
}

function clearOpHandlers(opId) {
    opHandlers.delete(opId);
}

function invalidateCache(envId) {
    return ipcRenderer.invoke('kafka:invalidate-cache', { envId: envId || null });
}

function cancelOp(opId) {
    return ipcRenderer.invoke('kafka:cancel', { opId });
}

async function probeClusterConnection(brokersInput, authOptions, handlers) {
    const opId = nextOpId();
    registerOpHandlers(opId, handlers);
    try {
        const brokers = brokerListFromInput(brokersInput);
        return await invokeKafka('kafka:probe', {
            opId,
            ctx: {
                ...buildCtx('probe', brokers, authOptions && authOptions.connection, authOptions && authOptions.secrets, 0),
                brokersText: brokersInput,
            },
        });
    } finally {
        clearOpHandlers(opId);
    }
}

async function getTopicsAndPartitions(ctx, options) {
    const opId = nextOpId();
    const handlers = {
        onProgress: options && options.onProgress,
        onPartial: options && options.onPartial,
    };
    registerOpHandlers(opId, handlers);
    try {
        if (options && options.signal) {
            options.signal.addEventListener('abort', () => {
                cancelOp(opId).catch(() => {});
            }, { once: true });
        }
        return await invokeKafka('kafka:get-topics', {
            opId,
            ctx,
            metadataOnly: Boolean(options && options.metadataOnly),
        });
    } finally {
        clearOpHandlers(opId);
    }
}

async function loadTopicsMessageCounts(ctx, topics, options) {
    const opId = nextOpId();
    const handlers = {
        onProgress: options && options.onProgress,
        onPartial: options && options.onPartial,
    };
    registerOpHandlers(opId, handlers);
    try {
        if (options && options.signal) {
            options.signal.addEventListener('abort', () => {
                cancelOp(opId).catch(() => {});
            }, { once: true });
        }
        return await invokeKafka('kafka:load-topic-message-counts', { opId, ctx, topics });
    } finally {
        clearOpHandlers(opId);
    }
}

async function getTopicOffsets(ctx, topic, handlers) {
    const opId = nextOpId();
    registerOpHandlers(opId, handlers);
    try {
        return await invokeKafka('kafka:get-topic-offsets', { opId, ctx, topic });
    } finally {
        clearOpHandlers(opId);
    }
}

async function getClusterMetadata(ctx, configuredBrokers, handlers) {
    const opId = nextOpId();
    registerOpHandlers(opId, handlers);
    try {
        return await invokeKafka('kafka:get-cluster-metadata', {
            opId,
            ctx: { ...ctx, brokers: configuredBrokers || ctx.brokers },
        });
    } finally {
        clearOpHandlers(opId);
    }
}

async function getConsumerLagOverview(ctx, topicName, handlers) {
    const opId = nextOpId();
    registerOpHandlers(opId, handlers);
    try {
        return await invokeKafka('kafka:get-consumer-lag', { opId, ctx, topicName });
    } finally {
        clearOpHandlers(opId);
    }
}

async function produceMessage(ctx, topic, message, handlers) {
    const opId = nextOpId();
    registerOpHandlers(opId, handlers);
    try {
        return await invokeKafka('kafka:produce', { opId, ctx, topic, message });
    } finally {
        clearOpHandlers(opId);
    }
}

async function pingKafkaAuth(ctx, handlers) {
    const opId = nextOpId();
    registerOpHandlers(opId, handlers);
    try {
        return await invokeKafka('kafka:ping-auth', { opId, ctx });
    } finally {
        clearOpHandlers(opId);
    }
}

async function resetConsumerGroupOffsetsToLatest(ctx, options, handlers) {
    const opId = nextOpId();
    registerOpHandlers(opId, handlers);
    try {
        return await invokeKafka('kafka:reset-offsets', { opId, ctx, options });
    } finally {
        clearOpHandlers(opId);
    }
}

async function deleteConsumerGroups(ctx, options, handlers) {
    const opId = nextOpId();
    registerOpHandlers(opId, handlers);
    try {
        return await invokeKafka('kafka:delete-groups', { opId, ctx, options });
    } finally {
        clearOpHandlers(opId);
    }
}

function appendOffsetResetAudit(event) {
    return ipcRenderer.invoke('kafka:append-audit', { event });
}

let consumeOpId = null;
let consumeMessageHandler = null;
let consumeDoneHandler = null;
let consumeErrorHandler = null;
let consumeLogHandler = null;

async function consumeMessages(ctx, options, onMessage, onDone, onError, onLog) {
    ensureIpcListeners();
    consumeOpId = nextOpId();
    consumeMessageHandler = onMessage;
    consumeDoneHandler = onDone;
    consumeErrorHandler = onError;
    consumeLogHandler = onLog;
    return invokeKafka('kafka:consume-start', { opId: consumeOpId, ctx, options });
}

async function stopConsuming() {
    consumeOpId = null;
    consumeMessageHandler = null;
    consumeDoneHandler = null;
    consumeErrorHandler = null;
    consumeLogHandler = null;
    return invokeKafka('kafka:consume-stop', {});
}

async function disconnectProducer() {
    return invalidateCache(null);
}

module.exports = {
    buildCtx,
    invalidateCache,
    cancelOp,
    probeClusterConnection,
    getTopicsAndPartitions,
    loadTopicsMessageCounts,
    getTopicOffsets,
    getClusterMetadata,
    getConsumerLagOverview,
    produceMessage,
    pingKafkaAuth,
    resetConsumerGroupOffsetsToLatest,
    deleteConsumerGroups,
    appendOffsetResetAudit,
    consumeMessages,
    stopConsuming,
    disconnectProducer,
    brokerListFromInput,
    isKafkaAuthError,
};
