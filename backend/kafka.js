const { Kafka, Partitioners } = require('kafkajs');

let consumer;
let consumerStopping = false;

async function createKafkaClient(brokers) {
    return new Kafka({
        clientId: 'kafka-safe-stream-app',
        brokers: brokers,
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
async function probeClusterConnection(brokersInput) {
    const brokers = brokerListFromInput(brokersInput);
    if (!brokers.length) {
        return { ok: false, error: 'Enter at least one broker (e.g. localhost:9092).' };
    }
    const kafka = await createKafkaClient(brokers);
    const admin = kafka.admin();
    try {
        await admin.connect();
        const described = await admin.describeCluster();
        const topicNames = await admin.listTopics();
        const filtered = topicNames.filter((t) => !t.startsWith('__')).sort((a, b) => a.localeCompare(b));
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
        try { await admin.disconnect(); } catch (_) { /* ignore */ }
    }
}

async function produceMessage(kafka, topic, message, key) {
    const producer = kafka.producer({
        createPartitioner: Partitioners.LegacyPartitioner
    });

    await producer.connect();
    const payload = { value: message };
    if (key !== undefined && key !== null && key !== '') {
        payload.key = String(key);
    }
    await producer.send({
        topic: topic,
        messages: [payload],
    });

    await producer.disconnect();
}

async function getTopicsAndPartitions(kafka) {
    const admin = kafka.admin();
    try {
        await admin.connect();
        const topicNames = await admin.listTopics();
        const filtered = topicNames.filter((t) => !t.startsWith('__'));
        const metadata = await admin.fetchTopicMetadata({ topics: filtered });
        const offsetsMap = {};
        await Promise.all(filtered.map(async (t) => {
            try {
                offsetsMap[t] = await admin.fetchTopicOffsets(t);
            } catch (err) {
                offsetsMap[t] = [];
            }
        }));

        return metadata.topics
            .map((t) => {
                const partitions = (t.partitions || []).map((p) => ({
                    partitionId: p.partitionId,
                    leader: p.leader,
                    replicas: p.replicas,
                    isr: p.isr,
                }));
                const offsets = offsetsMap[t.name] || [];
                const totalMessages = offsets.reduce((sum, o) => {
                    const high = Number(o.high || 0);
                    const low = Number(o.low || 0);
                    return sum + Math.max(0, high - low);
                }, 0);
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
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    } finally {
        try { await admin.disconnect(); } catch (_) { /* ignore */ }
    }
}

async function getTopicOffsets(kafka, topic) {
    const admin = kafka.admin();
    try {
        await admin.connect();
        return await admin.fetchTopicOffsets(topic);
    } finally {
        try { await admin.disconnect(); } catch (_) { /* ignore */ }
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
            const replicas = Array.isArray(p.replicas) ? p.replicas : [];
            const isr = Array.isArray(p.isr) ? p.isr : [];
            const errCode = Number(p.partitionErrorCode || 0);
            if (errCode !== 0) {
                erroredPartitions += 1;
                topicErr += 1;
            }
            const leaderNum = Number(p.leader);
            const noLeader = p.leader === null || p.leader === undefined
                || !Number.isFinite(leaderNum) || leaderNum < 0;
            if (noLeader) {
                offlineOrNoLeaderPartitions += 1;
                topicOffline += 1;
            }
            if (replicas.length > 0 && isr.length < replicas.length) {
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
async function getClusterMetadata(kafka, configuredBrokers) {
    const admin = kafka.admin();
    const configuredSet = new Set(
        (configuredBrokers || []).map((b) => {
            const p = parseConfiguredBroker(b);
            return `${p.host}:${p.port}`;
        })
    );
    try {
        await admin.connect();
        const described = await admin.describeCluster();
        const topicNames = await admin.listTopics();
        const userTopics = topicNames.filter((t) => !t.startsWith('__'));

        let groupCount = null;
        try {
            const lg = await admin.listGroups();
            groupCount = new Set((lg.groups || []).map((g) => g.groupId)).size;
        } catch (_) {
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
            topicHealth = await buildTopicHealthSummary(admin);
        } catch (err) {
            topicHealth = { error: err.message || String(err) };
        }

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
        try { await admin.disconnect(); } catch (_) { /* ignore */ }
    }
}

/**
 * List consumer groups that have at least one committed offset for the topic,
 * with log end / lag per partition and describeGroups metadata.
 */
async function getConsumerLagOverview(kafka, topicName) {
    if (!topicName || typeof topicName !== 'string') {
        throw new Error('Topic is required');
    }
    const admin = kafka.admin();
    try {
        await admin.connect();

        const topicOffsetRows = await admin.fetchTopicOffsets(topicName);
        const byPartition = new Map();
        for (const row of topicOffsetRows) {
            const p = Number(row.partition);
            const high = Number(row.high !== undefined ? row.high : row.offset);
            const low = Number(row.low !== undefined ? row.low : 0);
            byPartition.set(p, { high, low });
        }

        const listResult = await admin.listGroups();
        const rawIds = (listResult.groups || []).map((g) => g.groupId).filter(Boolean);
        const groupIds = [...new Set(rawIds)];

        const FETCH_CONCURRENCY = 10;
        const rawGroups = [];

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
        }

        const withCommits = rawGroups.filter(
            (g) =>
                !g.error &&
                g.partitionRows.some((pr) => pr.committed !== null)
        );

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
            } catch (_) {
                /* describe is best-effort */
            }
        }

        const groups = withCommits.map((g) => {
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

        groups.sort((a, b) => b.totalLag - a.totalLag);

        return {
            topic: topicName,
            scannedGroupCount: groupIds.length,
            matchedGroupCount: groups.length,
            groups,
        };
    } finally {
        try { await admin.disconnect(); } catch (_) { /* ignore */ }
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
    } = options || {};

    if (!topic) {
        throw new Error('Topic is required');
    }
    if (!groupId) {
        throw new Error('Consumer group is required');
    }

    consumerStopping = false;
    consumer = kafka.consumer({ groupId });

    let received = 0;
    const limit = (typeof maxMessages === 'number' && maxMessages > 0) ? maxMessages : null;
    let stopRequested = false;

    const stopFromInside = async () => {
        if (stopRequested) return;
        stopRequested = true;
        setImmediate(async () => {
            try {
                await stopConsuming();
            } finally {
                if (typeof onDone === 'function') {
                    try { onDone(); } catch (_) { /* ignore */ }
                }
            }
        });
    };

    try {
        await consumer.connect();
        await consumer.subscribe({
            topic,
            fromBeginning: startMode === 'earliest',
        });

        await consumer.run({
            eachMessage: async ({ topic: t, partition: p, message }) => {
                if (stopRequested || consumerStopping) return;
                if (partition !== null && partition !== undefined && Number(p) !== Number(partition)) {
                    return;
                }
                received += 1;
                try {
                    onMessage({
                        topic: t,
                        partition: p,
                        offset: message.offset,
                        timestamp: message.timestamp,
                        key: message.key ? message.key.toString() : null,
                        value: message.value ? message.value.toString() : '',
                        headers: message.headers || {},
                    });
                } catch (_) { /* ignore */ }

                if (limit !== null && received >= limit) {
                    await stopFromInside();
                }
            },
        });

        if (startMode === 'offset' && offset !== null && offset !== undefined) {
            const targetOffset = String(offset);
            if (partition !== null && partition !== undefined) {
                consumer.seek({ topic, partition: Number(partition), offset: targetOffset });
            } else {
                try {
                    const admin = kafka.admin();
                    await admin.connect();
                    const partitionOffsets = await admin.fetchTopicOffsets(topic);
                    await admin.disconnect();
                    partitionOffsets.forEach((po) => {
                        consumer.seek({ topic, partition: po.partition, offset: targetOffset });
                    });
                } catch (err) {
                    throw new Error('Failed to seek offsets: ' + err.message);
                }
            }
        }
    } catch (error) {
        throw new Error('Failed to connect to Kafka: ' + error.message);
    }
}

async function stopConsuming() {
    if (consumer && !consumerStopping) {
        consumerStopping = true;
        try {
            await consumer.disconnect();
        } catch (_) { /* ignore */ }
        consumer = null;
        consumerStopping = false;
    }
}

module.exports = {
    createKafkaClient,
    brokerListFromInput,
    probeClusterConnection,
    produceMessage,
    consumeMessages,
    stopConsuming,
    getTopicsAndPartitions,
    getTopicOffsets,
    getConsumerLagOverview,
    getClusterMetadata,
};
