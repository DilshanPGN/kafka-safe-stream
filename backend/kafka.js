const { Kafka, Partitioners } = require('kafkajs');

let consumer;
let consumerStopping = false;

async function createKafkaClient(brokers) {
    return new Kafka({
        clientId: 'kafka-safe-stream-app',
        brokers: brokers,
    });
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
    produceMessage,
    consumeMessages,
    stopConsuming,
    getTopicsAndPartitions,
    getTopicOffsets,
    getConsumerLagOverview,
};
