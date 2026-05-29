# Kafka Safe Stream

<p align="center">
  <strong>A lightweight desktop Kafka UI for producing and consuming messages</strong>
</p>

<p align="center">
  <a href="https://github.com/DilshanPGN/kafka-safe-stream/releases"><img src="https://img.shields.io/github/v/release/DilshanPGN/kafka-safe-stream?style=flat-square" alt="Release"></a>
  <a href="https://github.com/DilshanPGN/kafka-safe-stream/blob/main/package.json"><img src="https://img.shields.io/badge/license-ISC-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/DilshanPGN/kafka-safe-stream/issues"><img src="https://img.shields.io/github/issues/DilshanPGN/kafka-safe-stream?style=flat-square" alt="Issues"></a>
</p>

---

## Overview

**Kafka Safe Stream (KSS)** is a cross-platform desktop app built with Electron. You pick an environment and topic, produce payloads, consume in real time, and inspect the cluster (topic list, consumer-group lag, broker and partition health). **Basic** mode hides advanced consumer and ops UI; **Advanced** exposes full controls.

> **Note:** Primarily exercised on **Windows**. See [Releases](https://github.com/DilshanPGN/kafka-safe-stream/releases) for builds.

---

## Features

| Feature | Description |
|--------|-------------|
| **Environments** | Per-env brokers, topics, and TLS/SASL settings; switch from the top bar |
| **Tabs** | **Produce**, **Consume**, **Topics**, **Consumer lag**, **Cluster** (sidebar) |
| **Producer** | JSON, XML, or plain text; format button; optional **templates** and **random token** inserts |
| **Consumer** | Start/stop, filters (plain or regex), optional **table view** with metadata, **export** (JSON / JSONL / CSV), **view payload** in a separate window |
| **Consumer options** | Group id, start from (beginning / latest / partition+offset), max messages; **background idle** prompt to avoid leaving a consumer running unnoticed |
| **Topics browser** | List topics from the cluster (beyond the configured `topicList`); **Refresh** loads metadata only (fast); optional **Load message counts** for retained message estimates (slow on large clusters) |
| **Consumer lag** | Per-group lag for a chosen topic; optional **offset reset to latest** and **delete group** when `allowedUnsafeOperations` is enabled in config |
| **Cluster** | Cluster id, brokers, controller, topic/partition health summary |
| **Editor** | CodeMirror with syntax modes per format |
| **Theme** | Light / dark (persisted); Setup window follows theme from the main app |
| **Config** | Schema-validated **File → Setup** or `~/.kss/.config`; credentials via overlay + optional **Remember** (OS-backed encryption when available) |
| **Portable build** | Optional portable Windows executable (no install) |

---

## Architecture

### High-level architecture

```mermaid
flowchart TB
    subgraph Electron["Electron App"]
        subgraph Main["Main process (src/main/main.js)"]
            Menu[Menu]
            Win[Windows: main / setup / about]
            IPC[IPC: setup, config, credentials, kafka:*]
            KS[kafkaService.js + worker pool]
        end

        subgraph Renderer["Renderer (src/renderer/renderer.js)"]
            Tabs[Produce · Consume · Topics · Lag · Cluster]
            CM[CodeMirror · filters · table · payload viewer window]
            Bridge[kafkaBridge.js]
            Tabs --> CM
            Tabs --> Bridge
        end

        subgraph Backend["src/backend/"]
            K[kafka.js]
            KC[kafkaConnection.js]
            Tmpl[templates.js]
            RT[randomTokens.js]
        end
    end

    Bridge --> IPC
    IPC --> KS
    KS --> K
    Main --> IPC
    IPC --> Renderer
    Menu --> Win
    K --> Kafka[(Apache Kafka)]
    Renderer --> KC
    Renderer --> Tmpl
    Renderer --> RT
```

### Producer flow

```mermaid
sequenceDiagram
    participant User
    participant UI
    participant K as src/backend/kafka.js
    participant Kafka

    User->>UI: Env, topic, payload (and format / template if used)
    User->>UI: Produce to Topic
    UI->>K: createKafkaClient + produceMessage
    K->>Kafka: producer.send
    Kafka-->>K: ACK
    K-->>UI: OK
    UI->>User: Confirmation
```

### Consumer flow

```mermaid
sequenceDiagram
    participant User
    participant UI
    participant K as src/backend/kafka.js
    participant Kafka

    User->>UI: Env, topic, options (group, start, max, view)
    User->>UI: Start Consuming
    UI->>K: createKafkaClient + consumeMessages
    K->>Kafka: subscribe + run
    loop Messages
        Kafka-->>K: record
        K-->>UI: onMessage
        UI->>UI: Append / table / filter
    end
    User->>UI: Stop (or idle timeout flow)
    UI->>K: stopConsuming
    K->>Kafka: disconnect consumer
```

### Configuration flow

```mermaid
flowchart LR
    A[App start] --> B{Valid config?}
    B -->|No| C[Setup window]
    B -->|Yes| D[Load environments]
    C --> E[Save → .kss/.config]
    E --> F[Notify main → reload renderer]
    D --> G[Ready]
    F --> A
```

---

## Prerequisites

- **Node.js** (LTS recommended)
- **Apache Kafka** reachable from your machine
- **npm** or **yarn**

---

## Installation

### From source

```bash
git clone https://github.com/DilshanPGN/kafka-safe-stream.git
cd kafka-safe-stream
npm install
npm start
```

### From release (Windows)

1. Open [Releases](https://github.com/DilshanPGN/kafka-safe-stream/releases).
2. Download the installer or portable executable.
3. Run the installer, or run the portable `.exe`.

---

## Configuration

Stored as one JSON object. Missing or invalid config opens **Setup**.

### Config location

| OS | Path |
|----|------|
| Windows | `%USERPROFILE%\.kss\.config` |
| Linux/macOS | `~/.kss/.config` |

**File → Setup** shows the path and validates on save.

### Environment object (per key)

| Field | Required | Notes |
|-------|----------|--------|
| `id`, `label`, `brokers`, `topicList` | Yes | Key must match `^[a-zA-Z0-9_-]+$` |
| `connection` | No | TLS / SASL (same protocols and mechanisms as before) |
| `allowedUnsafeOperations` | No | If `true`, enables consumer-group **offset reset** and **delete group** in the Consumer lag tab (config JSON only, not the simple Setup form) |

Secrets (passwords, OAuth token, AWS secret key, TLS key passphrase) are **not** in `.config`. Enter when prompted or in Setup probe; **Remember** stores under `~/.kss/credentials.store.json` with **safeStorage** when the OS supports it. **SASL/GSSAPI (Kerberos)** is not supported the same way as the Java client.

### Example

```json
{
  "dev": {
    "id": "dev",
    "label": "DEV",
    "brokers": ["localhost:9092"],
    "topicList": ["demo.events"],
    "connection": {
      "securityProtocol": "SASL_SSL",
      "saslMechanism": "scram-sha-256",
      "username": "app",
      "rejectUnauthorized": true
    }
  }
}
```

---

## Usage

1. **First run** — Complete **Setup** (or place a valid `.config` under `~/.kss/`).
2. **Environment** — Choose env in the **top bar**; topics come from config (and you can browse more on the **Topics** tab).
3. **Produce** — Open **Produce**, pick topic and **format**, edit payload, **Format** if needed, then **Produce to Topic**. Optional: **Templates** (save/load/update) and **Insert token** for placeholders.
4. **Consume** — **Consume** tab: filters, optional **table view**, **Export**, **Start** / **Stop**. In **Advanced**, set consumer group, **Start from**, partition/offset, and max messages.
5. **Inspect** — **Topics** (list), **Consumer lag** (groups on a topic), **Cluster** (brokers + health). Dangerous lag actions require `allowedUnsafeOperations`.
   - **Topics tab:** Click **Refresh** to load topic names, partitions, replication, and leaders (fast). Message counts are **not** fetched automatically — click **Load message counts** when you need them (one broker request per topic; can take minutes on large MSK clusters). Use **Cancel** to stop either operation.
   - **Messages column states:** *Not loaded* (counts not fetched yet), *Loading…* (spinner while fetching), a number (retained messages: high watermark − low watermark), or *Failed* (hover for error). An info banner appears when topics are loaded but counts are not.
6. **Menu** — **File → Setup**, **File → Quit**, **Help → About**.

---

## Project structure

```
kafka-safe-stream/
├── src/
│   ├── main/
│   │   ├── main.js             # Main process, menu, windows, IPC
│   │   ├── kafkaService.js     # Kafka ops in main process (client cache, admin pool, progress)
│   │   └── kafkaWorkerPool.js  # Worker pool for parallel offset/count batches
│   ├── workers/
│   │   └── kafkaBatchWorker.js # Batch offset aggregation worker
│   ├── renderer/
│   │   ├── renderer.js         # UI, tabs, producer/consumer/inspector
│   │   ├── kafkaBridge.js      # Renderer IPC bridge to kafkaService
│   │   ├── progress.js         # Shared progress bar UI
│   │   ├── setup.js
│   │   └── payload-viewer.js
│   └── backend/
│       ├── kafka.js            # KafkaJS: produce, consume, admin, lag, phased topics
│       ├── kafkaConnection.js
│       ├── concurrency.js      # Bounded concurrency + retries
│       ├── templates.js        # Saved producer templates
│       └── randomTokens.js     # Token expansion for templates
├── index.html              # Main shell
├── setup.html / setup.css
├── payload-viewer.html / payload-viewer.css  # Detached payload window
├── about.html / about.css
├── styles.css
├── theme-variables.css
├── schema.json
├── codemirror/
├── package.json
├── forge.config.js
└── README.md
```

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Desktop | Electron 41 |
| Kafka | KafkaJS 2.x |
| Validation | AJV + `schema.json` |
| Editor | CodeMirror (JSON / XML modes) |
| Test data tokens | @faker-js/faker (via `randomTokens`) |
| Packaging | Electron Forge (Squirrel, ZIP, deb, rpm, portable) |

---

## Building and packaging

```bash
npm start          # dev (electronmon)
npm run package    # output under out/
npm run make       # installers / distributables (see forge.config.js)
```

---

## Contributing

1. Fork the repository.
2. Branch, change, verify with `npm start`.
3. Open a PR with a short, clear description.

---

## Developers

- [DilshanPGN](https://github.com/DilshanPGN)
- [uabeykoon](https://github.com/uabeykoon)
- [skaveesh](https://github.com/skaveesh)
- [chiran-wijesekara](https://github.com/chiran-wijesekara)

---

## License

ISC © DilshanPGN, uabeykoon, skaveesh, chiran-wijesekara

---

## Links

- **Releases:** [github.com/DilshanPGN/kafka-safe-stream/releases](https://github.com/DilshanPGN/kafka-safe-stream/releases)
- **Issues:** [github.com/DilshanPGN/kafka-safe-stream/issues](https://github.com/DilshanPGN/kafka-safe-stream/issues)
