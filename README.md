# Kafka Safe Stream
A Lightweight Kafka user interface for sending messages to and receiving messages from Kafka topics. 

### Configuration
Initiate the File > Setup for configuration or create a .config file in the `%userprofile%\.kss\` on Windows.

###### This is tested only on Windows so far. Check under the [Release](https://github.com/DilshanPGN/kafka-safe-stream/releases) for the latest release.


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

