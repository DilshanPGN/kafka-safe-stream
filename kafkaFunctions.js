const {createKafkaClient, produceMessage, stopConsuming, consumeMessages} = require("./backend/kafka");

document.addEventListener('DOMContentLoaded', () => {
    const consumedMessages = document.getElementById('consumedMessages');
    let brokers = ["localhost:9092"];

    document.getElementById('produceButton').addEventListener('click', async () => {
        console.log("Button clicked")
        const payload = document.getElementById('payload').value;
        try {
            const kafka = await createKafkaClient("my-app", brokers);
            await produceMessage(kafka, 'alm-kafka-demo-topic', payload);
        } catch (error) {
            console.error(error);
        }
    });

    document.getElementById('stopConsumeButton').addEventListener('click', async () => {
        await stopConsuming();
    });

    document.getElementById('clearMessages').addEventListener('click', () => {
        const consumedMessages = document.getElementById('consumedMessages');
        consumedMessages.value = '';
    });

    document.getElementById('consumeButton').addEventListener('click', async () => {
        try {
            const kafka = await createKafkaClient("my-app", brokers);
            await consumeMessages(kafka, 'alm-kafka-demo-topic', 'test-group', (message) => {
                consumedMessages.value += message + '\n';
            });
        } catch (error) {
            console.error(error);
        }
    });
});

