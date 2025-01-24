const { Kafka } = require('kafkajs');
let consumer;

async function createKafkaClient() {
    return new Kafka({
        clientId: 'my-app',
        brokers: ['localhost:9092'],
    });
}

async function produceMessage(kafka, topic, message) {
    const producer = kafka.producer();
    try {
        await producer.connect();
        await producer.send({
            topic: topic,
            messages: [{ value: message }],
        });
    } catch (error) {
        throw new Error('Failed to connect to Kafka: ' + error.message);
    } finally {
        await producer.disconnect();
    }
}

async function consumeMessages(kafka, topic, groupId, onMessage) {
    consumer = kafka.consumer({ groupId: groupId });
    await consumer.connect();
    await consumer.subscribe({ topic: topic, fromBeginning: true });

    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            onMessage(message.value.toString());
        },
    });
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