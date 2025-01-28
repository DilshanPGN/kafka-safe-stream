# Kafka Safe Stream
A Lightweight Kafka user interface for sending messages to and receiving messages from Kafka topics. 

### Configuration
Create a file named `.config` in the root directory following below schema

```json
{
    "dev": {
        "id": "dev",
        "label": "DEV",
        "brokers": ["dev-host1:9092", "dev-host2:9092"],
        "topicList": [
            "test.topic"
        ]
    },
    "qa": {
        "id": "qa",
        "label": "QA",
        "brokers": ["qa-host1:9092", "qa-host2:9092"],
        "topicList": [
            "topic-abc",
            "kafka-demo-topic"
        ]
    }
}

```