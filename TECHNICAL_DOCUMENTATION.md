# Kafka Safe Stream Technical Documentation

This document explains how Kafka Safe Stream is implemented, including architecture, key methods, operation flows, and the libraries used for each operation.

## 1) Technical Overview

Kafka Safe Stream is an Electron desktop application with:

- Main process orchestration in `main.js`
- Main-process Kafka service in `kafkaService.js` (client cache, admin pool, IPC handlers, progress streaming)
- Worker pool in `kafkaWorkerPool.js` + `workers/kafkaBatchWorker.js` for parallel offset aggregation
- Renderer/UI and workflow logic in `renderer.js`
- Renderer Kafka IPC bridge in `kafkaBridge.js`
- Kafka integration and operations in `backend/kafka.js`
- Connection/security config builder in `backend/kafkaConnection.js`
- Setup/configuration UI logic in `setup.js`
- Template persistence in `backend/templates.js`
- Random token expansion in `backend/randomTokens.js`
- Detached payload viewer in `payload-viewer.js`
- Shared progress UI in `progress.js`

The app reads configuration from `~/.kss/.config` and user preferences from `~/.kss/preferences.json`.

## 2) Runtime Architecture

### 2.1 Main Process (`main.js`)

Responsibilities:
- Creates main window (`createWindow()`), setup window (`createSetupWindow()`), and about window (`createAboutWindow()`).
- Defines application menus for macOS and Windows/Linux.
- Hosts IPC handlers for:
  - setup window lifecycle (`open-setup-window`, `close-setup-window`)
  - config update broadcast (`config-saved` -> `config-updated`)
  - credential storage (`kss-credentials:get`, `kss-credentials:set`, `kss-credentials:clear`)
  - secure storage capability probe (`kss-credentials:encryption-available`)
  - file dialogs (`kss-select-file`, `save-consumed-export`)
  - Kafka operations (`kafka:*` channels; delegated to `kafkaService.js`)

Credential model:
- Saved to `~/.kss/credentials.store.json`
- Uses `electron.safeStorage` encryption when available.
- Falls back to plain JSON payload only when OS encryption is unavailable.

### 2.2 Main-Process Kafka Service (`kafkaService.js`)

Kafka network I/O runs in the main process (not the renderer) to keep the UI responsive on large clusters.

Responsibilities:
- Caches Kafka clients per environment + connection fingerprint (`clientCache`).
- Reuses admin connections via an admin session pool (`adminPool`).
- Tracks cancellable operations (`activeOps`) and streams progress/partial results to the renderer.
- Delegates heavy offset aggregation to `kafkaWorkerPool.js` (worker threads).

Progress events:
- `kafka:progress` — phase, percent, message (e.g. listing topics, fetching metadata, loading offsets).
- `kafka:partial` — incremental topic rows while a load is in progress.

Key handlers (invoked from `main.js` IPC):
- `handleGetTopics(ctx, opId, metadataOnly)` — topic list + metadata; skips offsets when `metadataOnly: true`.
- `handleLoadTopicMessageCounts(ctx, opId, topics)` — fetches retained message counts for existing topic rows.
- `handleGetClusterMetadata`, `handleGetConsumerLag`, `handleProduce`, `handleConsumeStart`, etc.

IPC channels (renderer → main via `kafkaBridge.js`):

| Channel | Purpose |
|---------|---------|
| `kafka:get-topics` | List topics + metadata; `metadataOnly` skips offset fetches |
| `kafka:load-topic-message-counts` | Fetch retained message counts for existing topic rows |
| `kafka:cancel` | Cancel in-flight operation by `opId` |
| `kafka:progress` / `kafka:partial` | Main → renderer streaming updates during loads |
| `kafka:probe`, `kafka:produce`, `kafka:consume-start`, … | Other cluster/produce/consume operations |

### 2.3 Renderer Process (`renderer.js`)

Responsibilities:
- Loads and validates environment config (`loadConfig()`).
- Initializes producer and consumer editors (CodeMirror).
- Manages UI tabs/modes/theme.
- Coordinates Kafka operations with auth recovery.
- Maintains in-memory state (active env, topics, cached Kafka client, consumed messages, template selection, etc.).
- Handles user interactions for Produce, Consume, Topics, Consumer lag, and Cluster tabs.

### 2.4 Renderer Kafka Bridge (`kafkaBridge.js`)

Thin IPC wrapper used by the renderer instead of requiring `kafka.js` directly.

- Assigns operation ids (`opId`) and registers progress/partial handlers per operation.
- Maps `AbortSignal` abort to `kafka:cancel`.
- Exposes `getTopicsAndPartitions(ctx, { metadataOnly, onProgress, onPartial, signal })` and `loadTopicsMessageCounts(ctx, topics, options)`.

### 2.5 Backend Layer (`backend/*.js`)

- `kafka.js`: Kafka producer, consumer, admin operations; phased topic loading.
- `kafkaConnection.js`: TLS/SASL normalization and Kafka client config assembly.
- `concurrency.js`: bounded concurrency (`mapWithConcurrency`) and retries (`withRetry`).
- `templates.js`: local template CRUD against `~/.kss/templates.json`.
- `randomTokens.js`: Faker-based token expansion (e.g., `{{$guid}}`, `{{$email}}`).

## 3) Key Libraries and Why They Are Used

### Core runtime
- `electron`: desktop shell, windows, IPC, dialogs, OS integrations.
- `kafkajs`: producer/consumer/admin APIs for Kafka operations.
- `ajv`: JSON schema validation for config.
- `@faker-js/faker`: data generation for token placeholders.

### Editor/UI
- `CodeMirror` (bundled assets under `codemirror/`): payload editing and read-only consume stream display.

### Packaging/build
- `electron-forge` + makers (`squirrel`, `zip`, `deb`, `rpm`, `portable`): distribution artifacts.
- Electron fuses plugin in `forge.config.js`: hardening options (e.g., `RunAsNode=false`, embedded asar integrity validation).

## 4) Method Reference by Module

## 4.1 `backend/kafkaConnection.js`

- `normalizeConnection(raw)`
  - Validates and normalizes protocol/mechanism/TLS fields.
  - Ensures only supported values are used.

- `connectionFingerprint(connection, brokers, hasPersistedOrSessionSecret)`
  - Produces stable JSON signature used for Kafka client cache keys.

- `buildKafkaClientConfig({ brokers, connection, secrets })`
  - Builds KafkaJS config by combining broker list with TLS/SASL objects.
  - Calls `buildSslAndSasl()` internally.

- `isKafkaAuthError(err)`
  - Detects authentication/TLS related failures by error name/message pattern.
  - Used for retry + credential prompt flow in renderer.

## 4.2 `backend/kafka.js`

Client lifecycle:
- `createKafkaClient(brokersOrConfig, options)`
  - Creates KafkaJS client with merged connection fragment.
- `getOrCreateProducer(kafka)` and `disconnectProducer(kafka)`
  - Caches one connected producer per Kafka client using `WeakMap`.

Produce:
- `produceMessage(kafka, topic, message, key)`
  - Sends one message to a topic (optional key).

Consume:
- `consumeMessages(kafka, options, onMessage, onDone)`
  - Connects consumer, subscribes, streams messages via callback.
  - Supports:
    - `startMode` (`earliest`, `latest`, `offset`)
    - optional partition pinning
    - optional max message limit
- `stopConsuming()`
  - Graceful consumer disconnect.

Cluster/topic metadata:
- `getTopicsAndPartitions(kafka, options)`
  - Phased load: list topics → fetch metadata → optionally fetch offsets.
  - When `options.metadataOnly === true`, returns after metadata (no per-topic offset requests).
  - Emits `onProgress` and `onPartial` callbacks for progressive UI updates.
  - Each topic row includes `messagesLoaded`, `offsetsPending`, `totalMessages`, and optional `offsetError`.
- `loadTopicsMessageCounts(kafka, existingTopics, options)`
  - Second phase: fetches low/high offsets per partition for topics already loaded via metadata.
  - Uses bounded concurrency and optional worker-pool batching (`computeTopicMessagesBatch`).
  - Updates rows incrementally via `onPartial`.
- `getTopicOffsets(kafka, topic)`
  - Returns low/high offsets per partition.
- `getClusterMetadata(kafka, configuredBrokers)`
  - Fetches cluster id, brokers, controller, topic count, group count.
  - Includes topic health summary via `buildTopicHealthSummary()`.

Consumer lag and group operations:
- `getConsumerLagOverview(kafka, topicName)`
  - Scans groups, resolves committed offsets vs log-end, computes lag.
- `resetConsumerGroupOffsetsToLatest(kafka, { groupId, topic })`
  - Sets committed offsets to latest for all partitions on a topic.
- `deleteConsumerGroups(kafka, { groupIds })`
  - Deletes groups and returns per-group success/failure result.
- `appendOffsetResetAudit(event)`
  - Appends JSON audit events to `~/.kss/audit-offset-resets.log`.

Setup helper:
- `probeClusterConnection(brokersInput, authOptions)`
  - Lightweight connection test used by Setup.
  - Returns basic cluster info + topic names.

## 4.3 `renderer.js` (critical methods)

Config and app state:
- `loadConfig()`
  - Reads `~/.kss/.config`, validates with AJV schema.
  - On missing/invalid config, opens setup window.
- `reapplyConfig(newConfig)`
  - Runtime revalidation + state refresh after setup save.
- `loadPreferences()` / `savePreferences(prefs)`
  - Reads/writes `~/.kss/preferences.json`.

Kafka client/auth recovery:
- `getKafkaClient()`
  - Builds cache key from env + connection fingerprint + secret epoch.
  - Reuses client unless connection/secrets changed.
- `withKafkaAuthRecovery(topicLabel, fn)`
  - Wraps Kafka operations with auth/TLS error recovery:
    1. execute operation
    2. if auth/TLS error, prompt user for credentials
    3. persist session/disk secrets
    4. invalidate client cache and retry (up to 3 rounds)
- `showKafkaCredentialModal(args)`
  - Dynamic credential prompt (password/OAuth/AWS/TLS passphrase) based on protocol/mechanism.

Producer:
- `validatePayload(format, text)` and `formatPayload(format, text)`
  - Format-aware validation/pretty formatting (JSON/XML/text).
- Produce button handler:
  - Expands tokens via `expandTokens()`
  - Calls `produceMessage()` inside `withKafkaAuthRecovery()`.

Consumer:
- `readConsumerOptions()`
  - Reads group/start mode/partition/offset/max message options from UI.
- `setConsumeRunningUI(running)` and `stopConsumingAndResetUI()`
  - Toggle controls and consistent stop/reset flow.
- `applyFilter()`, `renderConsumerTable(filtered)`, `handleExportConsumed()`
  - Filtering, table rendering, and export (`json`, `jsonl`, `csv`).

Topics browser:
- `loadTopicsBrowser(forceRefresh)` -> `getTopicsAndPartitions({ metadataOnly: true })` via `kafkaBridge`
- `loadTopicsMessageCounts()` -> `loadTopicsMessageCounts()` via `kafkaBridge` (separate toolbar action)
- `buildTopicMessageCountCell(t)` — renders Messages column state:
  - **Not loaded** (`!messagesLoaded`): muted *Not loaded* label
  - **Loading** (`offsetsPending`): spinner + *Loading…*
  - **Loaded**: numeric count (`0` shown explicitly for empty topics)
  - **Failed** (`offsetError`): red *Failed* with tooltip
- `updateTopicsMessagesColumnChrome()` — updates column header (`Messages (not loaded)` / `Messages (loading…)` / `Messages`), hint banner, and button label (`Load message counts` / `↻ Reload message counts`)
- `renderTopicsTable()` with quick actions:
  - jump to Producer / Consumer / Consumer lag for a topic.
- Shared cancel via `cancelTopicsBrowserLoad()` for both Refresh and message-count loads.

Consumer lag:
- `loadConsumerLagOverview()` -> `getConsumerLagOverview()`
- `handleLagReset(groupId)` -> `resetConsumerGroupOffsetsToLatest()`
- `handleLagDelete(groupId)` -> `deleteConsumerGroups()`
- Guarded by `isUnsafeConsumerGroupOpsAllowed()` (`allowedUnsafeOperations`).

Cluster:
- `loadClusterOverview()` -> `getClusterMetadata()`
- `renderClusterMetadata(data)` and `renderTopicHealthSection(th)`

## 4.4 `setup.js`

Config management:
- `loadInitialConfig()` and `applyConfigFromObject(obj)`
  - Read + validate existing config and hydrate setup form state.
- `validateBeforeSave()`
  - Checks unique env IDs, broker presence, schema validity.
- `buildConfigObject()`
  - Serializes current setup state into config object.

Connection and probe:
- `syncConnFromPanel(env)`
  - Pulls TLS/SASL values and probe-only secrets from form controls.
- `buildProbeSecretsForTest(env)`
  - Builds minimal secret payload needed for test connection.
- `handleTestConnection()` (inside `renderEnvPanel()`)
  - Executes `probeClusterConnection()` and displays result.

UI helpers:
- Topic add/remove from cluster result
- dynamic field visibility via `updateConnectionFieldVisibility()`
- PEM file pickers via IPC (`kss-select-file`)

## 4.5 `backend/templates.js`

- `listTemplates()`, `getTemplate(id)`, `saveTemplate(data)`, `updateTemplate(id, updates)`, `deleteTemplate(id)`
- Persistent file: `~/.kss/templates.json`
- Template ids generated with `crypto.randomUUID()`

## 4.6 `backend/randomTokens.js`

- `expandTokens(text)`
  - Replaces placeholders like `{{$guid}}`, `{{$randomInt:1,100}}`.
  - Backed by `TOKENS` map and Faker generators.
- `TOKEN_INSERT_OPTIONS`
  - Metadata for grouped dropdown options in UI.

## 4.7 `payload-viewer.js`

- `init()`
  - Reads payload object from `sessionStorage`
  - Opens read-only CodeMirror instance in a detached window.
- `modeForFormat(formatId)`
  - Chooses JSON/XML/text editor mode.

## 5) End-to-End Operation Flows

### 5.1 Startup flow
1. `DOMContentLoaded` in `renderer.js`
2. `loadConfig()` from `~/.kss/.config`
3. if missing/invalid, open Setup window via IPC
4. initialize editors, tabs, handlers, preferences
5. ready for Produce/Consume/Inspect flows

### 5.2 Produce flow
1. User enters payload in producer editor.
2. `validatePayload()` + `revalidateProducerPayload()` manage button state.
3. On produce:
   - `expandTokens()` for placeholders
   - `withKafkaAuthRecovery()` wraps operation
   - `produceMessage()` sends to Kafka

### 5.3 Consume flow
1. User selects options (`readConsumerOptions()`).
2. `pingKafkaAuth()` pre-check.
3. `consumeMessages()` starts Kafka consumer.
4. each message -> `pushConsumedMessage()` -> `applyFilter()` -> view/table render.
5. Optional export via `handleExportConsumed()`.
6. Stop via `stopConsumingAndResetUI()`.

### 5.4 Consumer lag flow
1. Select topic and load.
2. `getConsumerLagOverview()` computes lag per group/partition.
3. Optional reset/delete (if enabled):
   - `resetConsumerGroupOffsetsToLatest()`
   - `deleteConsumerGroups()`
4. Offset reset writes audit event via `appendOffsetResetAudit()`.

### 5.5 Cluster flow
1. Trigger refresh.
2. `getClusterMetadata()` gathers broker/controller/topic/group information.
3. `buildTopicHealthSummary()` reports URP/no-leader/errors.

### 5.6 Topics browser flow (phased loading)

**Phase 1 — Refresh (metadata only)**
1. User clicks **Refresh** on the Topics tab.
2. Renderer calls `getTopicsAndPartitions(ctx, { metadataOnly: true, onProgress, onPartial, signal })` through `kafkaBridge`.
3. Main process `handleGetTopics` runs `getTopicsAndPartitions` with `metadataOnly: true`.
4. Topics appear quickly with partition count, replication factor, and leaders.
5. Messages column shows *Not loaded*; hint banner explains counts are optional.

**Phase 2 — Load message counts (optional)**
1. User clicks **Load message counts** (or **↻ Reload message counts** after first load).
2. Renderer calls `loadTopicsMessageCounts(ctx, topicsCache, { onProgress, onPartial, signal })`.
3. Main process fetches low/high offsets per topic (bounded concurrency; worker pool for batch math).
4. Rows update incrementally; per-row state transitions *Not loaded* → *Loading…* → number or *Failed*.
5. Column header changes to `Messages (loading…)` then `Messages`; hint banner hides when complete.

**Cancellation**
- **Cancel** aborts the in-flight operation via `AbortController` + `kafka:cancel`.
- Partial metadata or counts already received remain visible.

**Message count meaning**
- `totalMessages` ≈ sum over partitions of `(high watermark − low watermark)` — approximate retained messages, not all-time produced volume.

## 6) Operation to Libraries Matrix

| Operation | Primary Methods | Libraries Used |
|---|---|---|
| Config validation | `loadConfig()`, `validateBeforeSave()`, `applyConfigFromObject()` | `ajv`, `fs`, `path`, `os` |
| Kafka client creation | `createKafkaClient()`, `buildKafkaClientConfig()` | `kafkajs` |
| Secure credential storage | IPC `kss-credentials:*`, `persistKafkaSecretsFromModal()` | `electron.safeStorage`, `fs` |
| Produce message | `produceMessage()`, `withKafkaAuthRecovery()` | `kafkajs`, `electron` (IPC for secrets) |
| Consume messages | `consumeMessages()`, `stopConsuming()` | `kafkajs` |
| Topic browser (metadata) | `getTopicsAndPartitions({ metadataOnly: true })`, `renderTopicsTable()` | `kafkajs`, Electron IPC |
| Topic message counts | `loadTopicsMessageCounts()`, `buildTopicMessageCountCell()` | `kafkajs`, worker threads, Electron IPC |
| Consumer lag | `getConsumerLagOverview()` | `kafkajs` |
| Offset reset | `resetConsumerGroupOffsetsToLatest()`, `appendOffsetResetAudit()` | `kafkajs`, `fs` |
| Delete group | `deleteConsumerGroups()` | `kafkajs` |
| Payload editing | `initializeEditor()`, `formatPayload()` | `CodeMirror`, browser `DOMParser` |
| Token expansion | `expandTokens()` | `@faker-js/faker`, `crypto` |
| Template storage | `saveTemplate()`, `updateTemplate()`, etc. | `fs`, `crypto` |
| Export consumed data | `handleExportConsumed()` | `electron` dialog IPC, `fs` |
| Packaging | `forge.config.js` makers/plugins | `electron-forge`, `@electron/fuses` |

## 7) Data Files and Paths

- `~/.kss/.config` : environment configuration
- `~/.kss/preferences.json` : UI/user preferences
- `~/.kss/templates.json` : saved producer templates
- `~/.kss/credentials.store.json` : remembered secrets (encrypted when available)
- `~/.kss/audit-offset-resets.log` : audit records for offset reset actions

## 8) Security and Safety Controls

- Unsafe consumer group actions are disabled unless `allowedUnsafeOperations: true` in env config.
- Credentials are not stored in `.config`.
- TLS/SASL secrets can be session-only or persisted securely.
- Runtime auth/TLS retry flow is bounded (`maxRounds = 3`).
- Electron fuse hardening enabled in packaging config.

## 9) Technical Q&A Quick Answers

- Why are some fields hidden in Setup?
  - `updateConnectionFieldVisibility()` only shows fields relevant to selected protocol/mechanism.

- How does client reuse work?
  - `getKafkaClient()` caches by fingerprint; secret changes bump epoch and invalidate cache.

- Why does consume sometimes not show old messages?
  - Kafka group offsets + selected `startMode`; in basic mode app defaults to `earliest`.

- How is lag computed?
  - `lag = logEndOffset - committedOffset` per partition in `getConsumerLagOverview()`.

- How are offset resets audited?
  - `appendOffsetResetAudit()` appends JSON lines with reason, user, env, and result.

- Why does Refresh not show message counts?
  - By design: offset fetches are one broker request per topic and can block for minutes on large MSK clusters. **Refresh** loads metadata only; **Load message counts** is a separate optional step.

- What do Messages column states mean?
  - *Not loaded* — metadata loaded, counts not requested. *Loading…* — offset fetch in progress. Number — retained message estimate. *Failed* — offset fetch error (see tooltip).

- Why is Kafka in the main process?
  - Keeps the renderer thread free for UI updates; progress and partial results stream over IPC (`kafka:progress`, `kafka:partial`).

---

For code-level exploration, start with:
- `renderer.js` (UI + orchestration)
- `kafkaBridge.js` (renderer IPC)
- `kafkaService.js` (main-process Kafka ops)
- `backend/kafka.js` (Kafka operations)
- `backend/kafkaConnection.js` (security/protocol config builder)
- `main.js` (IPC + windows + secure storage handlers)
