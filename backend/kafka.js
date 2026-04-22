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
};
