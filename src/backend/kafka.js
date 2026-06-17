const { Kafka, Partitioners, KafkaJSDeleteGroupsError } = require('kafkajs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildKafkaClientConfig } = require('./kafkaConnection');
const { mapWithConcurrency } = require('./concurrency');

/**
 * KafkaJS record headers: values are Buffer, string, or an array of those.
 * Normalize to UTF-8 strings for UI, export, and JSON safety.
 * @param {import('kafkajs').IHeaders|Record<string, unknown>|null|undefined} headers
 * @returns {Record<string, string>}
 */
function normalizeConsumedMessageHeaders(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;

    function headerValueToUtf8(v) {
        if (v == null) return '';
        if (Buffer.isBuffer(v)) return v.toString('utf8');
        if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
        if (typeof v === 'object' && v !== null && v.type === 'Buffer' && Array.isArray(v.data)) {
            return Buffer.from(v.data).toString('utf8');
        }
        if (Array.isArray(v)) {
            return v.map(headerValueToUtf8).filter((s) => s !== '').join(' | ');
        }
        if (typeof v === 'string') return v;
        return String(v);
    }

    for (const [k, v] of Object.entries(headers)) {
        if (k === '__proto__') continue;
        out[k] = headerValueToUtf8(v);
    }
    return out;
}

function logDebug(context, err) {
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
        console.debug(`[kss-kafka] ${context}`, err);
    }
}

function createOperationCancelledError(message) {
    const err = new Error(message || 'Operation cancelled');
    err.name = 'AbortError';
    return err;
}

function throwIfAborted(signal) {
    if (signal && signal.aborted) {
        throw createOperationCancelledError();
    }
}

async function safeAdminDisconnect(admin) {
    try {
        await admin.disconnect();
    } catch (err) {
        logDebug('admin.disconnect', err);
    }
}

let consumer;
let consumerStopping = false;
/**
 * Cache one connected producer per Kafka client instance.
 * WeakMap avoids leaks when Kafka clients are replaced.
 */
const producerCacheByKafka = new WeakMap();

/**
 * @param {string[]|import('kafkajs').KafkaConfig} brokersOrConfig
 * @param {{ connection?: unknown, secrets?: object }} [options]
 * @returns {import('kafkajs').Kafka}
 */
function createKafkaClient(brokersOrConfig, options) {
    if (brokersOrConfig && typeof brokersOrConfig === 'object' && !Array.isArray(brokersOrConfig)) {
        return new Kafka({
            clientId: 'kafka-safe-stream-app',
            ...brokersOrConfig,
        });
    }
    const brokers = Array.isArray(brokersOrConfig) ? brokersOrConfig : [];
    const fragment = buildKafkaClientConfig({
        brokers,
        connection: options && options.connection,
        secrets: options && options.secrets,
    });
    return new Kafka({
        clientId: 'kafka-safe-stream-app',
        ...fragment,
    });
}

/**
 * Parse broker textarea / comma-separated string into host:port strings for KafkaJS.
 * @param {string|string[]} raw
 * @returns {string[]}
 */
function brokerListFromInput(raw) {
    const text = Array.isArray(raw) ? raw.join('\n') : String(raw || '');
    const parts = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    return parts.map((p) => {
        const { host, port } = parseConfiguredBroker(p);
        return `${host}:${port}`;
    });
}

/**
 * Quick connectivity check + topic names (no partition metadata).
 * @param {string|string[]} brokersInput
 * @returns {Promise<{ ok: true, clusterId: string, controller: number|null, brokerCount: number, topicNames: string[] }|{ ok: false, error: string }>}
 */
/**
 * @param {string|string[]} brokersInput
 * @param {{ connection?: unknown, secrets?: object }} [authOptions]
 */
function emitProgress(options, payload) {
    if (options && typeof options.onProgress === 'function') {
        options.onProgress(payload);
    }
}

function computeTotalMessagesFromOffsets(offsets) {
    if (!Array.isArray(offsets)) return null;
    return offsets.reduce((sum, o) => {
        const high = Number(o.high || 0);
        const low = Number(o.low || 0);
        return sum + Math.max(0, high - low);
    }, 0);
}

function buildTopicRowFromMetadata(t, offsetsInfo) {
    const partitions = (t.partitions || []).map((p) => ({
        partitionId: p.partitionId,
        leader: p.leader,
        replicas: p.replicas,
        isr: p.isr,
    }));
    const offsets = offsetsInfo && offsetsInfo.offsets ? offsetsInfo.offsets : [];
    const offsetError = offsetsInfo && offsetsInfo.offsetError ? offsetsInfo.offsetError : null;
    const totalMessages = (() => {
        if (offsetsInfo && offsetsInfo.totalMessages != null) return offsetsInfo.totalMessages;
        if (offsets.length) return computeTotalMessagesFromOffsets(offsets);
        return null;
    })();
    const replicationFactor = partitions.length > 0
        ? (partitions[0].replicas || []).length
        : 0;
    return {
        name: t.name,
        partitions,
        partitionCount: partitions.length,
        replicationFactor,
        offsets,
        totalMessages,
        offsetError,
        offsetsPending: offsetsInfo && offsetsInfo.offsetsPending === true,
        messagesLoaded: Boolean(offsetsInfo && offsetsInfo.messagesLoaded),
    };
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- batched per-topic offset fetches
async function fetchTopicOffsetCounts(admin, topicNames, offsetsMap, opts) {
    const signal = opts && opts.signal;
    const concurrency = (opts && opts.concurrency) || 10;
    const computeBatch = typeof opts.computeTopicMessagesBatch === 'function'
        ? opts.computeTopicMessagesBatch
        : null;
    let aborting = false;
    const onAbort = () => { aborting = true; };
    if (signal) {
        throwIfAborted(signal);
        signal.addEventListener('abort', onAbort, { once: true });
    }

    const offsetResults = await mapWithConcurrency(
        topicNames,
        concurrency,
        async (topicName) => {
            throwIfAborted(signal);
            try {
                const offsets = await admin.fetchTopicOffsets(topicName);
                return { name: topicName, offsets, offsetError: null };
            } catch (err) {
                if (aborting || (signal && signal.aborted)) {
                    throw createOperationCancelledError();
                }
                logDebug(`fetchTopicOffsets:${topicName}`, err);
                return { name: topicName, offsets: [], offsetError: err.message || String(err) };
            }
        },
        (opts && opts.onOffsetProgress) || undefined
    );

    throwIfAborted(signal);
    if (signal) signal.removeEventListener('abort', onAbort);

    const batches = chunkArray(offsetResults, 25);
    for (const batch of batches) {
        let computed = batch;
        if (computeBatch) {
            try {
                computed = await computeBatch(batch);
            } catch (err) {
                logDebug('computeTopicMessagesBatch', err);
            }
        }
        for (const entry of computed) {
            offsetsMap.set(entry.name, {
                offsets: entry.offsets || [],
                totalMessages: entry.totalMessages != null
                    ? entry.totalMessages
                    : computeTotalMessagesFromOffsets(entry.offsets),
                offsetError: entry.offsetError || null,
                offsetsPending: false,
                messagesLoaded: true,
            });
        }
        if (typeof opts.onPartial === 'function') {
            opts.onPartial(offsetsMap);
        }
    }
}

/**
 * @param {string|string[]} brokersInput
 * @param {{ connection?: unknown, secrets?: object, onProgress?: Function }} [authOptions]
 */
async function probeClusterConnection(brokersInput, authOptions) {
    const brokers = brokerListFromInput(brokersInput);
    if (!brokers.length) {
        return { ok: false, error: 'Enter at least one broker (e.g. localhost:9092).' };
    }
    const kafka = createKafkaClient(brokers, authOptions || {});
    const admin = kafka.admin();
    try {
        emitProgress(authOptions, { phase: 'connect', current: 0, total: 3, message: 'Connecting to cluster…' });
        await admin.connect();
        emitProgress(authOptions, { phase: 'describe', current: 1, total: 3, message: 'Describing cluster…' });
        const described = await admin.describeCluster();
        emitProgress(authOptions, { phase: 'topics', current: 2, total: 3, message: 'Listing topics…' });
        const topicNames = await admin.listTopics();
        const filtered = topicNames.filter((t) => !t.startsWith('__')).sort((a, b) => a.localeCompare(b));
        emitProgress(authOptions, { phase: 'done', current: 3, total: 3, message: `Found ${filtered.length} topics` });
        return {
            ok: true,
            clusterId: described.clusterId || '',
            controller: described.controller != null ? described.controller : null,
            brokerCount: (described.brokers || []).length,
            topicNames: filtered,
        };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    } finally {
        await safeAdminDisconnect(admin);
    }
}

async function getOrCreateProducer(kafka) {
    const cached = producerCacheByKafka.get(kafka);
    if (cached && cached.producer) {
        if (cached.connected) return cached.producer;
        if (cached.connectPromise) {
            await cached.connectPromise;
            return cached.producer;
        }
    }

    const producer = cached && cached.producer
        ? cached.producer
        : kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });
    const entry = cached && cached.producer
        ? cached
        : { producer, connected: false, connectPromise: null };
    producerCacheByKafka.set(kafka, entry);

    if (!entry.connected) {
        entry.connectPromise = producer.connect()
            .then(() => {
                entry.connected = true;
            })
            .finally(() => {
                entry.connectPromise = null;
            });
        await entry.connectPromise;
    }
    return producer;
}

async function disconnectProducer(kafka) {
    const entry = producerCacheByKafka.get(kafka);
    if (!entry || !entry.producer) return;
    if (entry.connectPromise) {
        try {
            await entry.connectPromise;
        } catch (err) {
            logDebug('producer.connect', err);
        }
    }
    try {
        await entry.producer.disconnect();
    } catch (err) {
        logDebug('producer.disconnect', err);
    } finally {
        producerCacheByKafka.delete(kafka);
    }
}

async function produceMessage(kafka, topic, message, key) {
    const producer = await getOrCreateProducer(kafka);
    const payload = { value: message };
    if (key !== undefined && key !== null && key !== '') {
        payload.key = String(key);
    }
    await producer.send({
        topic: topic,
        messages: [payload],
    });
}

function bindAdminAbortHandler(signal, admin, shouldDisconnect) {
    if (!signal) return null;
    const onAbort = () => {
        if (shouldDisconnect) {
            safeAdminDisconnect(admin).catch((err) => logDebug('topics.abort.disconnect', err));
        }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return onAbort;
}

async function getTopicsAndPartitions(kafka, options) {
    const opts = options || {};
    const signal = opts.signal;
    const useExternalAdmin = Boolean(opts.admin);
    const admin = useExternalAdmin ? opts.admin : kafka.admin();
    const shouldDisconnect = !useExternalAdmin;
    const concurrency = opts.concurrency || 10;
    const computeBatch = typeof opts.computeTopicMessagesBatch === 'function'
        ? opts.computeTopicMessagesBatch
        : null;
    const onAbort = bindAdminAbortHandler(signal, admin, shouldDisconnect);
    if (signal) {
        throwIfAborted(signal);
    }

    /** @type {Map<string, { offsets: object[], totalMessages: number|null, offsetError: string|null, offsetsPending?: boolean }>} */
    const offsetsMap = new Map();

    function buildPartialRows(metadataTopics) {
        return metadataTopics
            .map((t) => {
                const info = offsetsMap.get(t.name) || {
                    offsetsPending: false,
                    messagesLoaded: false,
                    offsets: [],
                    totalMessages: null,
                    offsetError: null,
                };
                return buildTopicRowFromMetadata(t, info);
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    function emitPartial(metadataTopics) {
        if (typeof opts.onPartial === 'function') {
            opts.onPartial(buildPartialRows(metadataTopics));
        }
    }

    try {
        if (!useExternalAdmin) {
            emitProgress(opts, { phase: 'connect', current: 0, total: 100, message: 'Connecting…' });
            await admin.connect();
        }
        throwIfAborted(signal);

        emitProgress(opts, { phase: 'list', current: 5, total: 100, message: 'Listing topics…' });
        const topicNames = await admin.listTopics();
        throwIfAborted(signal);
        const filtered = topicNames.filter((t) => !t.startsWith('__'));

        emitProgress(opts, { phase: 'metadata', current: 15, total: 100, message: 'Fetching topic metadata…' });
        const metadata = await admin.fetchTopicMetadata({ topics: filtered });
        throwIfAborted(signal);

        const metadataTopics = metadata.topics || [];
        for (const t of metadataTopics) {
            offsetsMap.set(t.name, {
                offsetsPending: false,
                offsets: [],
                totalMessages: null,
                offsetError: null,
                messagesLoaded: false,
            });
        }
        emitPartial(metadataTopics);
        emitProgress(opts, {
            phase: 'metadata-done',
            current: opts.metadataOnly ? 100 : 30,
            total: 100,
            message: opts.metadataOnly
                ? `Loaded ${metadataTopics.length} topics`
                : `Loaded metadata for ${metadataTopics.length} topics`,
        });

        if (filtered.length === 0) {
            return [];
        }

        if (opts.metadataOnly) {
            emitProgress(opts, { phase: 'done', current: 100, total: 100, message: 'Topics loaded' });
            return buildPartialRows(metadataTopics);
        }

        await fetchTopicOffsetCounts(admin, filtered, offsetsMap, {
            signal,
            concurrency,
            computeTopicMessagesBatch: computeBatch,
            onOffsetProgress: ({ current, total }) => {
                const pct = 30 + Math.round((current / total) * 70);
                emitProgress(opts, {
                    phase: 'offsets',
                    current,
                    total,
                    percent: pct,
                    message: `Loading offsets (${current}/${total})…`,
                });
            },
            onPartial: () => emitPartial(metadataTopics),
        });

        emitProgress(opts, { phase: 'done', current: 100, total: 100, message: 'Topics loaded' });
        return buildPartialRows(metadataTopics);
    } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        if (shouldDisconnect) {
            await safeAdminDisconnect(admin);
        }
    }
}

/**
 * Fetch message counts (offsets) for topics already loaded via metadata.
 * @param {import('kafkajs').Kafka} kafka
 * @param {object[]} existingTopics topic rows from getTopicsAndPartitions(metadataOnly)
 */
async function loadTopicsMessageCounts(kafka, existingTopics, options) {
    const opts = options || {};
    const signal = opts.signal;
    const useExternalAdmin = Boolean(opts.admin);
    const admin = useExternalAdmin ? opts.admin : kafka.admin();
    const shouldDisconnect = !useExternalAdmin;
    const computeBatch = typeof opts.computeTopicMessagesBatch === 'function'
        ? opts.computeTopicMessagesBatch
        : null;
    const list = Array.isArray(existingTopics) ? existingTopics : [];
    const topicNames = list.map((t) => t.name).filter(Boolean);

    if (!topicNames.length) return [];

    /** @type {Map<string, object>} */
    const offsetsMap = new Map();
    for (const t of list) {
        offsetsMap.set(t.name, {
            offsetsPending: true,
            offsets: t.offsets || [],
            totalMessages: t.totalMessages,
            offsetError: t.offsetError || null,
            messagesLoaded: false,
        });
    }

    const metadataTopics = list.map((t) => ({
        name: t.name,
        partitions: (t.partitions || []).map((p) => ({
            partitionId: p.partitionId,
            leader: p.leader,
            replicas: p.replicas,
            isr: p.isr,
        })),
    }));

    function buildRows() {
        return metadataTopics
            .map((meta) => buildTopicRowFromMetadata(meta, offsetsMap.get(meta.name) || {}))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (typeof opts.onPartial === 'function') {
        opts.onPartial(buildRows());
    }

    const onAbort = bindAdminAbortHandler(signal, admin, shouldDisconnect);
    if (signal) {
        throwIfAborted(signal);
    }

    try {
        if (!useExternalAdmin) {
            emitProgress(opts, { phase: 'connect', current: 0, total: 100, message: 'Connecting…' });
            await admin.connect();
        }
        throwIfAborted(signal);

        await fetchTopicOffsetCounts(admin, topicNames, offsetsMap, {
            signal,
            concurrency: opts.concurrency || 10,
            computeTopicMessagesBatch: computeBatch,
            onOffsetProgress: ({ current, total }) => {
                const pct = Math.round((current / total) * 100);
                emitProgress(opts, {
                    phase: 'offsets',
                    current,
                    total,
                    percent: pct,
                    message: `Loading message counts (${current}/${total})…`,
                });
            },
            onPartial: () => {
                if (typeof opts.onPartial === 'function') {
                    opts.onPartial(buildRows());
                }
            },
        });

        emitProgress(opts, { phase: 'done', current: 100, total: 100, message: 'Message counts loaded' });
        return buildRows();
    } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        if (shouldDisconnect) {
            await safeAdminDisconnect(admin);
        }
    }
}

async function getTopicOffsets(kafka, topic) {
    const admin = kafka.admin();
    try {
        await admin.connect();
        return await admin.fetchTopicOffsets(topic);
    } finally {
        await safeAdminDisconnect(admin);
    }
}

function parseCommittedOffset(offset) {
    if (offset === undefined || offset === null) return null;
    const n = Number(offset);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
}

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

function normalizeBrokerEndpoint(host, port) {
    return `${String(host).toLowerCase()}:${Number(port)}`;
}

function parseConfiguredBroker(str) {
    const s = String(str).trim();
    const idx = s.lastIndexOf(':');
    if (idx === -1) {
        return { host: s.toLowerCase(), port: 9092 };
    }
    return {
        host: s.slice(0, idx).toLowerCase(),
        port: Number(s.slice(idx + 1)) || 9092,
    };
}

function partitionHealthFlags(p) {
    const replicas = Array.isArray(p.replicas) ? p.replicas : [];
    const isr = Array.isArray(p.isr) ? p.isr : [];
    const errCode = Number(p.partitionErrorCode || 0);
    const leaderNum = Number(p.leader);
    const noLeader = p.leader === null || p.leader === undefined
        || !Number.isFinite(leaderNum) || leaderNum < 0;
    return {
        hasMetadataError: errCode !== 0,
        noLeader,
        underReplicated: replicas.length > 0 && isr.length < replicas.length,
    };
}

/**
 * Per-topic and aggregate signals from Metadata (ISR vs replicas, leaders, error codes).
 */
async function buildTopicHealthSummary(admin) {
    const { topics } = await admin.fetchTopicMetadata({ topics: [] });
    let partitionCount = 0;
    let underReplicatedPartitions = 0;
    let offlineOrNoLeaderPartitions = 0;
    let erroredPartitions = 0;
    const rows = [];

    for (const t of topics) {
        if (!t.name || t.name.startsWith('__')) continue;
        const parts = t.partitions || [];
        let topicUrp = 0;
        let topicOffline = 0;
        let topicErr = 0;

        for (const p of parts) {
            partitionCount += 1;
            const flags = partitionHealthFlags(p);
            if (flags.hasMetadataError) {
                erroredPartitions += 1;
                topicErr += 1;
            }
            if (flags.noLeader) {
                offlineOrNoLeaderPartitions += 1;
                topicOffline += 1;
            }
            if (flags.underReplicated) {
                underReplicatedPartitions += 1;
                topicUrp += 1;
            }
        }

        rows.push({
            name: t.name,
            partitionCount: parts.length,
            underReplicated: topicUrp,
            offlineOrNoLeader: topicOffline,
            errors: topicErr,
        });
    }

    rows.sort((a, b) => {
        const score = (r) => r.underReplicated + r.offlineOrNoLeader + r.errors;
        return score(b) - score(a);
    });

    const issuesOnly = rows.filter((r) => r.underReplicated + r.offlineOrNoLeader + r.errors > 0);
    const MAX_ISSUE_TOPICS = 500;
    const topicsWithIssues = issuesOnly.slice(0, MAX_ISSUE_TOPICS);

    return {
        totals: {
            topics: rows.length,
            partitions: partitionCount,
            underReplicatedPartitions,
            offlineOrNoLeaderPartitions,
            erroredPartitions,
        },
        healthyTopics: rows.length - issuesOnly.length,
        topicsWithIssues,
        truncatedIssues: issuesOnly.length > MAX_ISSUE_TOPICS,
        totalIssueTopics: issuesOnly.length,
    };
}

/**
 * Cluster-level metadata from the broker metadata API (not JVM health / metrics).
 */
async function getClusterMetadata(kafka, configuredBrokers, options) {
    const admin = kafka.admin();
    const opts = options || {};
    const configuredSet = new Set(
        (configuredBrokers || []).map((b) => {
            const p = parseConfiguredBroker(b);
            return `${p.host}:${p.port}`;
        })
    );
    try {
        emitProgress(opts, { phase: 'connect', current: 0, total: 4, message: 'Connecting…' });
        await admin.connect();
        emitProgress(opts, { phase: 'describe', current: 1, total: 4, message: 'Describing cluster…' });
        const described = await admin.describeCluster();
        const topicNames = await admin.listTopics();
        const userTopics = topicNames.filter((t) => !t.startsWith('__'));

        let groupCount = null;
        try {
            emitProgress(opts, { phase: 'groups', current: 2, total: 4, message: 'Listing consumer groups…' });
            const lg = await admin.listGroups();
            groupCount = new Set((lg.groups || []).map((g) => g.groupId)).size;
        } catch (err) {
            logDebug('listGroups', err);
            groupCount = null;
        }

        const brokers = (described.brokers || []).map((b) => ({
            nodeId: b.nodeId,
            host: b.host,
            port: b.port,
            endpoint: `${b.host}:${b.port}`,
            isController: described.controller === b.nodeId,
            inBootstrap: configuredSet.has(normalizeBrokerEndpoint(b.host, b.port)),
        }));

        let topicHealth = null;
        try {
            emitProgress(opts, { phase: 'health', current: 3, total: 4, message: 'Analyzing topic health…' });
            topicHealth = await buildTopicHealthSummary(admin);
        } catch (err) {
            topicHealth = { error: err.message || String(err) };
        }

        emitProgress(opts, { phase: 'done', current: 4, total: 4, message: 'Cluster metadata loaded' });

        return {
            clusterId: described.clusterId || '—',
            controllerId: described.controller,
            brokerCount: brokers.length,
            brokers,
            topicCount: userTopics.length,
            groupCount,
            topicHealth,
        };
    } finally {
        await safeAdminDisconnect(admin);
    }
}

/**
 * List consumer groups that have at least one committed offset for the topic,
 * with log end / lag per partition and describeGroups metadata.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- multi-phase lag scan with progress
async function getConsumerLagOverview(kafka, topicName, options) {
    if (!topicName || typeof topicName !== 'string') {
        throw new Error('Topic is required');
    }
    const opts = options || {};
    const mergeBatch = typeof opts.mergeLagPartitionsBatch === 'function'
        ? opts.mergeLagPartitionsBatch
        : null;
    const admin = kafka.admin();
    try {
        emitProgress(opts, { phase: 'connect', current: 0, total: 100, message: 'Connecting…' });
        await admin.connect();

        emitProgress(opts, { phase: 'offsets', current: 5, total: 100, message: 'Fetching topic offsets…' });
        const topicOffsetRows = await admin.fetchTopicOffsets(topicName);
        const byPartition = new Map();
        for (const row of topicOffsetRows) {
            const p = Number(row.partition);
            const high = Number(row.high !== undefined ? row.high : row.offset);
            const low = Number(row.low !== undefined ? row.low : 0);
            byPartition.set(p, { high, low });
        }

        emitProgress(opts, { phase: 'groups', current: 10, total: 100, message: 'Listing consumer groups…' });
        const listResult = await admin.listGroups();
        const rawIds = (listResult.groups || []).map((g) => g.groupId).filter(Boolean);
        const groupIds = [...new Set(rawIds)];

        const FETCH_CONCURRENCY = opts.concurrency || 10;
        const rawGroups = [];
        let scanned = 0;

        for (let i = 0; i < groupIds.length; i += FETCH_CONCURRENCY) {
            const slice = groupIds.slice(i, i + FETCH_CONCURRENCY);
            const settled = await Promise.all(
                slice.map(async (groupId) => {
                    try {
                        const blocks = await admin.fetchOffsets({ groupId, topics: [topicName] });
                        const block = blocks.find((b) => b.topic === topicName);
                        if (!block || !Array.isArray(block.partitions)) {
                            return { groupId, error: null, partitionRows: [] };
                        }
                        const partitionRows = block.partitions.map((pr) => {
                            const partition = Number(pr.partition);
                            const meta = byPartition.get(partition) || { high: 0, low: 0 };
                            const committedRaw = pr.offset;
                            const committed = parseCommittedOffset(committedRaw);
                            let lag = null;
                            if (committed !== null && Number.isFinite(meta.high)) {
                                lag = Math.max(0, meta.high - committed);
                            }
                            return {
                                partition,
                                committedDisplay:
                                    committed === null
                                        ? null
                                        : String(committedRaw),
                                committed,
                                logEnd: meta.high,
                                logStart: meta.low,
                                lag,
                            };
                        });
                        return { groupId, error: null, partitionRows };
                    } catch (err) {
                        return { groupId, error: err.message || String(err), partitionRows: [] };
                    }
                })
            );
            rawGroups.push(...settled);
            scanned += slice.length;
            const pct = 10 + Math.round((scanned / Math.max(groupIds.length, 1)) * 60);
            emitProgress(opts, {
                phase: 'scan',
                current: scanned,
                total: groupIds.length,
                percent: pct,
                message: `Scanning groups (${scanned}/${groupIds.length})…`,
            });
        }

        const withCommits = rawGroups.filter(
            (g) =>
                !g.error &&
                g.partitionRows.some((pr) => pr.committed !== null)
        );

        emitProgress(opts, { phase: 'describe', current: 75, total: 100, message: 'Describing consumer groups…' });
        const describeMap = new Map();
        for (const batch of chunkArray(
            withCommits.map((g) => g.groupId),
            10
        )) {
            if (batch.length === 0) continue;
            try {
                const { groups: descGroups } = await admin.describeGroups(batch);
                for (const g of descGroups || []) {
                    describeMap.set(g.groupId, g);
                }
            } catch (err) {
                logDebug('describeGroups', err);
            }
        }

        let groups = withCommits.map((g) => {
            const d = describeMap.get(g.groupId) || {};
            const members = (d.members || []).map((m) => ({
                memberId: m.memberId,
                clientId: m.clientId,
                host: m.host,
            }));
            let totalLag = 0;
            for (const pr of g.partitionRows) {
                if (typeof pr.lag === 'number') totalLag += pr.lag;
            }
            return {
                groupId: g.groupId,
                state: d.state || '—',
                protocolType: d.protocolType || '',
                memberCount: members.length,
                members,
                totalLag,
                partitions: g.partitionRows,
            };
        });

        if (mergeBatch && groups.length > 0) {
            try {
                const batches = chunkArray(groups, 50);
                const merged = [];
                for (const batch of batches) {
                    const part = await mergeBatch(batch);
                    merged.push(...part);
                }
                groups = merged;
            } catch (err) {
                logDebug('mergeLagPartitionsBatch', err);
            }
        }

        groups.sort((a, b) => b.totalLag - a.totalLag);

        emitProgress(opts, { phase: 'done', current: 100, total: 100, message: 'Lag overview loaded' });

        return {
            topic: topicName,
            scannedGroupCount: groupIds.length,
            matchedGroupCount: groups.length,
            groups,
        };
    } finally {
        await safeAdminDisconnect(admin);
    }
}

function topicOffsetsToLatestPartitions(topicOffsets) {
    return (topicOffsets || [])
        .map((row) => ({
            partition: Number(row.partition),
            offset: String(row.high !== undefined ? row.high : row.offset),
        }))
        .filter((row) => Number.isFinite(row.partition) && row.partition >= 0);
}

/**
 * Reset committed offsets for a consumer group on a topic to latest.
 * This clears lag relative to current log-end offsets.
 */
async function resetConsumerGroupOffsetsToLatest(kafka, options) {
    const groupId = options && String(options.groupId || '').trim();
    const topic = options && String(options.topic || '').trim();
    if (!groupId) throw new Error('groupId is required');
    if (!topic) throw new Error('topic is required');

    const admin = kafka.admin();
    try {
        await admin.connect();
        const topicOffsets = await admin.fetchTopicOffsets(topic);
        const partitions = topicOffsetsToLatestPartitions(topicOffsets);
        if (!partitions.length) {
            throw new Error(`No partition offsets found for topic "${topic}"`);
        }

        await admin.setOffsets({
            groupId,
            topic,
            partitions,
        });

        return {
            ok: true,
            groupId,
            topic,
            partitionCount: partitions.length,
            partitions,
        };
    } finally {
        await safeAdminDisconnect(admin);
    }
}

/**
 * Delete consumer groups via the broker (groups must be inactive / empty per Kafka rules).
 */
async function deleteConsumerGroups(kafka, options) {
    const groupIds = [...new Set((options && options.groupIds ? options.groupIds : [])
        .map((g) => String(g || '').trim())
        .filter(Boolean))];
    if (!groupIds.length) throw new Error('At least one groupId is required');

    const admin = kafka.admin();
    try {
        await admin.connect();
        try {
            const brokerResults = await admin.deleteGroups(groupIds);
            const byId = new Map();
            for (const r of brokerResults || []) {
                const gid = r && r.groupId;
                if (!gid) continue;
                const code = Number(r.errorCode);
                if (code !== 0) {
                    byId.set(gid, r.error || `Broker error code ${code}`);
                } else {
                    byId.set(gid, null);
                }
            }
            const results = groupIds.map((groupId) => {
                if (!byId.has(groupId)) {
                    return { ok: false, groupId, error: 'No broker response for this group' };
                }
                const errMsg = byId.get(groupId);
                if (errMsg) return { ok: false, groupId, error: errMsg };
                return { ok: true, groupId };
            });
            const successCount = results.filter((r) => r.ok).length;
            return {
                total: results.length,
                successCount,
                failureCount: results.length - successCount,
                results,
            };
        } catch (err) {
            if (err instanceof KafkaJSDeleteGroupsError && Array.isArray(err.groups)) {
                const failed = new Map(
                    err.groups.map((g) => [g.groupId, g.error || `Broker error code ${g.errorCode}`])
                );
                const results = groupIds.map((groupId) => {
                    if (failed.has(groupId)) {
                        return { ok: false, groupId, error: failed.get(groupId) };
                    }
                    return { ok: true, groupId };
                });
                const successCount = results.filter((r) => r.ok).length;
                return {
                    total: results.length,
                    successCount,
                    failureCount: results.length - successCount,
                    results,
                };
            }
            throw err;
        }
    } finally {
        await safeAdminDisconnect(admin);
    }
}

function appendOffsetResetAudit(event) {
    const dir = path.join(os.homedir(), '.kss');
    const file = path.join(dir, 'audit-offset-resets.log');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const payload = {
        timestamp: new Date().toISOString(),
        ...event,
    };
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
}

function hasConfiguredValue(value) {
    return value !== null && value !== undefined && value !== '';
}

function runConsumerDoneCallback(onDone) {
    if (typeof onDone !== 'function') return;
    try {
        onDone();
    } catch (err) {
        logDebug('consume onDone', err);
    }
}

function shouldSkipConsumedMessage(args) {
    if (args.stopRequested || consumerStopping) return true;
    if (hasConfiguredValue(args.partition) && Number(args.messagePartition) !== Number(args.partition)) return true;
    if (args.targetOffsetNumber === null || !Number.isFinite(args.targetOffsetNumber)) return false;
    const msgOffset = Number(args.message.offset);
    return Number.isFinite(msgOffset) && msgOffset < args.targetOffsetNumber;
}

function emitConsumeLog(onLog, level, message) {
    if (typeof onLog !== 'function') return;
    try {
        onLog({
            timestamp: new Date().toISOString(),
            level: level || 'info',
            message: String(message || ''),
        });
    } catch (err) {
        logDebug('consume onLog', err);
    }
}

async function fetchGroupTopicCommittedOffsets(kafka, groupId, topic) {
    const admin = kafka.admin();
    try {
        await admin.connect();
        const blocks = await admin.fetchOffsets({ groupId, topics: [topic] });
        const block = blocks.find((b) => b.topic === topic);
        if (!block || !Array.isArray(block.partitions)) return new Map();
        const map = new Map();
        for (const pr of block.partitions) {
            const partition = Number(pr.partition);
            const committed = parseCommittedOffset(pr.offset);
            if (committed !== null && Number.isFinite(partition)) {
                map.set(partition, String(pr.offset));
            }
        }
        return map;
    } finally {
        await safeAdminDisconnect(admin);
    }
}

async function fetchTopicPartitionBounds(kafka, topic) {
    const admin = kafka.admin();
    try {
        await admin.connect();
        const rows = await admin.fetchTopicOffsets(topic);
        const map = new Map();
        for (const row of rows || []) {
            const partition = Number(row.partition);
            const high = Number(row.high !== undefined ? row.high : row.offset);
            const low = Number(row.low !== undefined ? row.low : 0);
            if (Number.isFinite(partition) && Number.isFinite(high) && Number.isFinite(low)) {
                map.set(partition, { low, high });
            }
        }
        return map;
    } finally {
        await safeAdminDisconnect(admin);
    }
}

function logPartitionOffsetDiagnostics(topic, groupId, committedMap, boundsMap, onLog) {
    const partitions = [...new Set([...committedMap.keys(), ...boundsMap.keys()])].sort((a, b) => a - b);
    if (!partitions.length) {
        emitConsumeLog(onLog, 'warn', `No partition offset metadata returned for topic "${topic}".`);
        return;
    }
    for (const partition of partitions) {
        const bounds = boundsMap.get(partition) || { low: null, high: null };
        const committedRaw = committedMap.get(partition);
        const committed = committedRaw !== undefined ? Number(committedRaw) : null;
        let lag = null;
        if (committed !== null && Number.isFinite(bounds.high)) {
            lag = Math.max(0, bounds.high - committed);
        }
        const committedLabel = committedRaw !== undefined ? String(committedRaw) : 'none';
        const lagLabel = lag === null ? '—' : String(lag);
        emitConsumeLog(
            onLog,
            'info',
            `Partition ${partition}: log start=${bounds.low}, log end=${bounds.high}, committed=${committedLabel}, lag=${lagLabel}`
        );
    }
    if (!committedMap.size) {
        emitConsumeLog(
            onLog,
            'info',
            `Group "${groupId}" has no committed offsets on "${topic}" — beginning reads will start at log start.`
        );
    }
}

async function prepareConsumeSeekPlan(kafka, topic, groupId, startMode, onLog) {
    if (startMode === 'offset') return null;

    emitConsumeLog(onLog, 'info', 'Fetching committed offsets and topic watermarks…');
    const committedMap = await fetchGroupTopicCommittedOffsets(kafka, groupId, topic);
    const boundsMap = await fetchTopicPartitionBounds(kafka, topic);
    const hasCommits = committedMap.size > 0;

    logPartitionOffsetDiagnostics(topic, groupId, committedMap, boundsMap, onLog);

    if (startMode === 'committed' && !hasCommits) {
        emitConsumeLog(onLog, 'warn', 'No committed offsets found for this group on this topic.');
    }

    return { committedMap, hasCommits, boundsMap, startMode };
}

function seekConsumerPartition(topic, partition, offset, onLog, contextLabel) {
    try {
        consumer.seek({ topic, partition, offset: String(offset) });
        emitConsumeLog(onLog, 'info', `Partition ${partition}: ${contextLabel} ${offset}`);
        return true;
    } catch (err) {
        emitConsumeLog(
            onLog,
            'warn',
            `Partition ${partition}: seek skipped (${err.message || String(err)})`
        );
        return false;
    }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- per-partition seek rules vary by start mode
function applySeekPlanToAssignedPartitions(topic, assignedPartitions, seekPlan, onLog) {
    if (!seekPlan || !assignedPartitions.length) return;

    const { committedMap, hasCommits, boundsMap, startMode } = seekPlan;
    for (const partition of assignedPartitions) {
        const bounds = boundsMap.get(partition);
        const committedOffset = committedMap.get(partition);

        if (startMode === 'earliest') {
            if (committedOffset !== undefined && bounds && Number.isFinite(bounds.high)) {
                const lag = Math.max(0, bounds.high - Number(committedOffset));
                if (lag === 0) {
                    emitConsumeLog(
                        onLog,
                        'warn',
                        `Partition ${partition}: group is caught up (committed at log end) — Beginning will read from log start anyway (read-only, offsets not committed).`
                    );
                }
            }
            if (bounds) {
                if (bounds.high <= bounds.low) {
                    emitConsumeLog(onLog, 'warn', `Partition ${partition}: topic partition is empty (log start ${bounds.low}, log end ${bounds.high}).`);
                } else {
                    seekConsumerPartition(topic, partition, bounds.low, onLog, 'seeking to log start');
                }
            } else {
                emitConsumeLog(onLog, 'warn', `Partition ${partition}: no watermark metadata — relying on broker default position`);
            }
            continue;
        }

        if (startMode === 'committed' || (startMode === 'latest' && hasCommits)) {
            if (committedOffset !== undefined) {
                seekConsumerPartition(topic, partition, committedOffset, onLog, 'seeking to committed offset');
                continue;
            }
            if (startMode === 'committed') {
                emitConsumeLog(
                    onLog,
                    'warn',
                    `Partition ${partition}: no committed offset for this group — will use broker default`
                );
            }
        }

        if (startMode === 'latest' && !hasCommits && bounds) {
            seekConsumerPartition(topic, partition, bounds.high, onLog, 'new group — seeking to log end');
        }
    }
}

function seekAssignedPartitionsForOffsetMode(topic, assignedPartitions, partition, offset, onLog) {
    const targetOffset = String(offset);
    if (hasConfiguredValue(partition)) {
        seekConsumerPartition(topic, Number(partition), targetOffset, onLog, 'seeking to offset');
        return;
    }
    for (const p of assignedPartitions) {
        seekConsumerPartition(topic, p, targetOffset, onLog, 'seeking to offset');
    }
}

async function consumeMessages(kafka, options, onMessage, onDone) {
    const {
        topic,
        groupId,
        startMode = 'latest',
        partition = null,
        offset = null,
        maxMessages = null,
        onLog = null,
    } = options || {};

    if (!topic) {
        throw new Error('Topic is required');
    }
    if (!groupId) {
        throw new Error('Consumer group is required');
    }

    consumerStopping = false;
    const consumerConfig = { groupId };
    if (startMode === 'offset' || startMode === 'committed' || startMode === 'earliest') {
        // Read-only inspection modes should not advance committed group offsets.
        consumerConfig.autoCommit = false;
    }
    consumer = kafka.consumer(consumerConfig);

    let received = 0;
    const limit = (typeof maxMessages === 'number' && maxMessages > 0) ? maxMessages : null;
    let stopRequested = false;
    const targetOffsetNumber = startMode === 'offset' && hasConfiguredValue(offset)
        ? Number(offset)
        : null;
    const stopFromInside = async () => {
        if (stopRequested) return;
        stopRequested = true;
        setImmediate(async () => {
            try {
                await stopConsuming();
            } finally {
                runConsumerDoneCallback(onDone);
            }
        });
    };

    let seekPlan = null;

    const { GROUP_JOIN } = consumer.events;
    consumer.on(GROUP_JOIN, (event) => {
        if (consumerStopping) return;
        const payload = event && event.payload ? event.payload : {};
        const assignment = payload.memberAssignment || {};
        const assigned = Array.isArray(assignment[topic]) ? assignment[topic].slice() : [];
        emitConsumeLog(
            onLog,
            'info',
            `Joined consumer group "${groupId}" — assigned ${assigned.length} partition(s): [${assigned.join(', ')}]`
        );
        if (!assigned.length) {
            emitConsumeLog(
                onLog,
                'warn',
                'No partitions were assigned. Another active member may hold all partitions for this group, or the topic has no partitions.'
            );
            return;
        }
        if (startMode === 'offset' && hasConfiguredValue(offset)) {
            seekAssignedPartitionsForOffsetMode(topic, assigned, partition, offset, onLog);
        } else {
            applySeekPlanToAssignedPartitions(topic, assigned, seekPlan, onLog);
        }
        emitConsumeLog(onLog, 'info', 'Partition positions set — waiting for messages…');
    });

    try {
        emitConsumeLog(onLog, 'info', `Connecting consumer (group: ${groupId}, topic: ${topic}, start: ${startMode})…`);
        await consumer.connect();
        emitConsumeLog(onLog, 'info', `Subscribing to topic "${topic}"…`);
        await consumer.subscribe({
            topic,
            fromBeginning: startMode === 'earliest',
        });

        if (startMode !== 'offset') {
            seekPlan = await prepareConsumeSeekPlan(kafka, topic, groupId, startMode, onLog);
        }

        emitConsumeLog(onLog, 'info', 'Starting consumer loop and waiting for group assignment…');
        await consumer.run({
            eachMessage: async ({ topic: t, partition: p, message }) => {
                if (shouldSkipConsumedMessage({
                    stopRequested,
                    partition,
                    targetOffsetNumber,
                    messagePartition: p,
                    message,
                })) return;
                received += 1;
                if (received === 1) {
                    emitConsumeLog(onLog, 'info', `First message received (partition ${p}, offset ${message.offset})`);
                }
                try {
                    onMessage({
                        topic: t,
                        partition: p,
                        offset: message.offset,
                        timestamp: message.timestamp,
                        key: message.key ? message.key.toString() : null,
                        value: message.value ? message.value.toString() : '',
                        headers: normalizeConsumedMessageHeaders(message.headers),
                    });
                } catch (err) {
                    logDebug('consume onMessage', err);
                }

                if (limit !== null && received >= limit) {
                    emitConsumeLog(onLog, 'info', `Reached max messages (${limit}) — stopping consumer`);
                    await stopFromInside();
                }
            },
        });
    } catch (error) {
        emitConsumeLog(onLog, 'error', error.message || String(error));
        throw new Error('Failed to connect to Kafka: ' + error.message);
    }
}

async function stopConsuming() {
    if (consumer && !consumerStopping) {
        consumerStopping = true;
        try {
            await consumer.disconnect();
        } catch (err) {
            logDebug('consumer.disconnect', err);
        }
        consumer = null;
        consumerStopping = false;
    }
}

module.exports = {
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
    computeTotalMessagesFromOffsets,
    buildTopicRowFromMetadata,
    createOperationCancelledError,
};
