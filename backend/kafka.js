const { Kafka, Partitioners } = require('kafkajs');
let consumer;

async function createKafkaClient(clientId, brokers) {
    return new Kafka({
        clientId: 'my-app',
        brokers: brokers,
    });
}

async function produceMessage(kafka, topic, message) {
    const producer = kafka.producer({
        createPartitioner: Partitioners.LegacyPartitioner
    });

    await producer.connect();
    await producer.send({
        topic: topic,
        messages: [
            { value: message },
        ],
    });

    await producer.disconnect();
}

async function consumeMessages(kafka, topic, groupId, onMessage) {
    consumer = kafka.consumer({ groupId: groupId });
    try {
        await consumer.connect();
        await consumer.subscribe({ topic: topic, fromBeginning: true });

        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                onMessage(message.value.toString());
            },
        });
    } catch (error) {
        throw new Error('Failed to connect to Kafka: ' + error.message);
    }
}

async function stopConsuming() {
    if (consumer) {
        await consumer.disconnect();
        consumer = null;
    }
}

module.exports = {
    createKafkaClient,
    produceMessage,
    consumeMessages,
    stopConsuming,
};