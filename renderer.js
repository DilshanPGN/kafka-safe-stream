const { ipcRenderer } = require('electron');
const {
    createKafkaClient,
    produceMessage,
    stopConsuming,
    consumeMessages,
    getTopicsAndPartitions,
    getTopicOffsets,
} = require('./backend/kafka');
const templatesApi = require('./backend/templates');
const { expandTokens, TOKEN_DESCRIPTIONS } = require('./backend/randomTokens');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Ajv = require('ajv');

const method = {
    producer: {
        id: 'producer',
        label: 'Producer',
        containerId: 'producerContainer',
    },
    consumer: {
        id: 'consumer',
        label: 'Consumer',
        containerId: 'consumerContainer',
    },
    topicsBrowser: {
        id: 'topicsBrowser',
        label: 'Topics & Partitions',
        containerId: 'topicsBrowserContainer',
    },
};

const schemaPath = path.join(__dirname, 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv();
const DEFAULT_GROUP = 'kafka-safe-stream-group';
const LINE_SEPARATOR = '\n\n◀▶\n\n';
const THEME_STORAGE_KEY = 'kss-theme';
const READONLY_STORAGE_KEY = 'kss-readonly';
const PREFS_PATH = path.join(os.homedir(), '.kss', 'preferences.json');

let activeEnv = null;
let activeMethod = 'producer';
let activeTopicList = null;
let activeTopic = '';
let consumeStarted = false;
let envConfig = null;
let validPayload = false;
let editor = null;
let consumer = null;
let consumerBlinkOn = false;
let readOnlyMode = true;
let consumerGroup = DEFAULT_GROUP;
let topicsCache = [];
let consumedMessages = [];
let selectedTemplateId = '';
let kafkaClientCache = { env: null, client: null };
let rendererInitialized = false;
let pendingConfigUpdate = null;
window.refreshIntervalId = null;

function loadPreferences() {
    try {
        if (fs.existsSync(PREFS_PATH)) {
            const raw = fs.readFileSync(PREFS_PATH, 'utf8');
            return JSON.parse(raw) || {};
        }
    } catch (_) { /* ignore */ }
    return {};
}

function savePreferences(prefs) {
    try {
        const dir = path.dirname(PREFS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf8');
    } catch (err) {
        console.warn('Failed to persist preferences', err);
    }
}

function getGroupForTopic(envId, topic) {
    const prefs = loadPreferences();
    return (prefs.groupsByTopic && prefs.groupsByTopic[`${envId}::${topic}`]) || DEFAULT_GROUP;
}

function setGroupForTopic(envId, topic, group) {
    const prefs = loadPreferences();
    prefs.groupsByTopic = prefs.groupsByTopic || {};
    prefs.groupsByTopic[`${envId}::${topic}`] = group;
    savePreferences(prefs);
}

async function getKafkaClient() {
    if (kafkaClientCache.env === activeEnv && kafkaClientCache.client) {
        return kafkaClientCache.client;
    }
    const client = await createKafkaClient(envConfig[activeEnv].brokers);
    kafkaClientCache = { env: activeEnv, client };
    return client;
}

function applyTheme(theme) {
    const targetTheme = theme === 'light' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', targetTheme);
    const toggle = document.getElementById('themeToggle');
    const themeModeLabel = document.getElementById('themeModeLabel');
    if (toggle) toggle.checked = targetTheme === 'dark';
    if (themeModeLabel) {
        themeModeLabel.innerHTML = targetTheme === 'dark'
            ? '<span class="theme-icon moon">🌙</span>Dark'
            : '<span class="theme-icon sun">☀</span>Light';
    }
    try {
        localStorage.setItem(THEME_STORAGE_KEY, targetTheme);
    } catch (_) { /* ignore */ }
}

function initializeThemeToggle() {
    let savedTheme = 'dark';
    try {
        savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
    } catch (_) { /* ignore */ }
    applyTheme(savedTheme);
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('change', () => {
            applyTheme(themeToggle.checked ? 'dark' : 'light');
        });
    }
}

function loadReadOnlyState() {
    try {
        const stored = localStorage.getItem(READONLY_STORAGE_KEY);
        if (stored === null) return true;
        return stored === 'true';
    } catch (_) {
        return true;
    }
}

function applyReadOnlyState() {
    const btn = document.getElementById('readonlyToggle');
    if (btn) {
        btn.classList.toggle('active', readOnlyMode);
        btn.setAttribute('aria-pressed', readOnlyMode ? 'true' : 'false');
        btn.textContent = readOnlyMode ? 'Read-only' : 'Editable';
    }
    const groupInput = document.getElementById('consumerGroupInput');
    if (groupInput) {
        groupInput.disabled = readOnlyMode || consumeStarted;
        groupInput.title = readOnlyMode
            ? 'Disable Read-only mode in the topbar to edit the consumer group'
            : '';
    }
}

function initializeReadOnlyToggle() {
    readOnlyMode = loadReadOnlyState();
    applyReadOnlyState();
    const btn = document.getElementById('readonlyToggle');
    if (btn) {
        btn.addEventListener('click', () => {
            readOnlyMode = !readOnlyMode;
            try { localStorage.setItem(READONLY_STORAGE_KEY, String(readOnlyMode)); }
            catch (_) { /* ignore */ }
            applyReadOnlyState();
        });
    }
}

function renderConsumerTabBlink(show) {
    const statusNode = document.querySelector('#consumer .tab-status');
    if (!statusNode) return;
    statusNode.textContent = show ? '●' : '';
}

function updateSummaryCards() {
    const brokerCount = document.getElementById('brokerCount');
    const topicCount = document.getElementById('topicCount');
    const activeEnvName = document.getElementById('activeEnvName');
    const activeTopicName = document.getElementById('activeTopicName');
    const activeGroupName = document.getElementById('activeGroupName');

    if (envConfig && activeEnv && envConfig[activeEnv]) {
        const env = envConfig[activeEnv];
        const brokers = Array.isArray(env.brokers) ? env.brokers : [];
        const topics = Array.isArray(env.topicList) ? env.topicList : [];
        brokerCount.textContent = String(brokers.length);
        topicCount.textContent = String(topics.length);
        activeEnvName.textContent = env.label || activeEnv;
    }

    activeTopicName.textContent = activeTopic || '-';
    if (activeGroupName) activeGroupName.textContent = consumerGroup || '-';
}

async function loadConfig() {
    const homeDir = os.homedir();
    const kssDir = path.join(homeDir, '.kss');
    const configPath = path.join(kssDir, '.config');

    if (!fs.existsSync(kssDir)) {
        fs.mkdirSync(kssDir);
    }

    if (fs.existsSync(configPath)) {
        try {
            const config = fs.readFileSync(configPath, 'utf8');
            envConfig = JSON.parse(config);

            const valid = ajv.validate(schema, envConfig);
            if (!valid) {
                throw new Error('Invalid configuration format');
            }
            return envConfig;
        } catch (error) {
            console.error('Error reading or parsing the config file:', error);
            hideLoading();
            closeAlert();
            ipcRenderer.send('open-setup-window');
            await new Promise((resolve) => {
                ipcRenderer.once('setup-window-closed', resolve);
            });
            return loadConfig();
        }
    } else {
        hideLoading();
        closeAlert();
        ipcRenderer.send('open-setup-window');
        await new Promise((resolve) => {
            ipcRenderer.once('setup-window-closed', resolve);
        });
        return loadConfig();
    }
}

function initializeEditor() {
    const editorContainer = document.getElementById('payload');
    editor = CodeMirror(editorContainer, {
        lineSeparator: null,
        indentUnit: 2,
        smartIndent: true,
        tabSize: 2,
        indentWithTabs: false,
        lineNumbers: true,
        firstLineNumber: 1,
        lineWrapping: true,
        lineWiseCopyCut: true,
        undoDepth: 200,
        historyEventDelay: 1250,
        autofocus: true,
        theme: 'default',
        placeholder: 'Enter a JSON payload...',
    });
}

function initializeConsumer() {
    const consumerContainer = document.getElementById('consumedMessages');
    consumer = CodeMirror(consumerContainer, {
        lineSeparator: null,
        indentUnit: 2,
        smartIndent: true,
        tabSize: 2,
        indentWithTabs: false,
        lineNumbers: true,
        firstLineNumber: 1,
        lineWrapping: true,
        lineWiseCopyCut: true,
        readOnly: true,
        undoDepth: 200,
        historyEventDelay: 1250,
        autofocus: true,
        theme: 'default',
        placeholder: 'Consumed messages will display here...',
    });
}

function formatConsumedEntry(msg) {
    let body = msg.value;
    try {
        body = JSON.stringify(JSON.parse(msg.value), null, 2);
    } catch (_) { /* keep as-is */ }
    const meta = `// partition=${msg.partition} offset=${msg.offset} ts=${msg.timestamp}` +
        (msg.key ? ` key=${msg.key}` : '');
    return `${meta}\n${body}`;
}

function applyFilter() {
    const filterInput = document.getElementById('filterInput');
    const regexToggle = document.getElementById('filterRegex');
    const messageCount = document.getElementById('messageCount');
    const term = (filterInput && filterInput.value) || '';
    const useRegex = regexToggle && regexToggle.checked;

    let filtered = consumedMessages;
    if (term.trim().length > 0) {
        if (useRegex) {
            try {
                const re = new RegExp(term, 'i');
                filtered = consumedMessages.filter((m) => re.test(m.value) || re.test(String(m.key || '')));
            } catch (_) {
                filtered = consumedMessages;
            }
        } else {
            const lower = term.toLowerCase();
            filtered = consumedMessages.filter((m) =>
                m.value.toLowerCase().includes(lower) ||
                String(m.key || '').toLowerCase().includes(lower));
        }
    }

    const text = filtered.map(formatConsumedEntry).join(LINE_SEPARATOR) +
        (filtered.length > 0 ? LINE_SEPARATOR : '');
    consumer.setValue(text);
    const lastLine = consumer.getScrollInfo().height;
    consumer.scrollTo(0, lastLine);

    if (messageCount) {
        messageCount.textContent = `${filtered.length} / ${consumedMessages.length}`;
    }
}

function pushConsumedMessage(msg) {
    consumedMessages.push(msg);
    applyFilter();
}

function clearConsumedMessages() {
    consumedMessages = [];
    applyFilter();
}

function refreshTemplateSelect() {
    const select = document.getElementById('templateSelect');
    if (!select) return;
    const items = templatesApi.listTemplates();
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— select template —';
    select.appendChild(placeholder);
    items.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        select.appendChild(opt);
    });
    if (selectedTemplateId && items.find((t) => t.id === selectedTemplateId)) {
        select.value = selectedTemplateId;
    } else {
        selectedTemplateId = '';
        select.value = '';
    }
    refreshTemplateButtons();
}

function refreshTemplateButtons() {
    const updateBtn = document.getElementById('updateTemplateButton');
    const deleteBtn = document.getElementById('deleteTemplateButton');
    if (updateBtn) updateBtn.disabled = !selectedTemplateId;
    if (deleteBtn) deleteBtn.disabled = !selectedTemplateId;
}

function populateTokenInsert() {
    const select = document.getElementById('tokenInsertSelect');
    if (!select) return;
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Insert token…';
    select.appendChild(placeholder);
    TOKEN_DESCRIPTIONS.forEach((td) => {
        const opt = document.createElement('option');
        opt.value = td.token;
        opt.textContent = `${td.token}  —  ${td.label}`;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => {
        const token = select.value;
        if (!token || !editor) return;
        editor.replaceSelection(token);
        select.value = '';
        editor.focus();
    });
}

function showPrompt(title, message, defaultValue = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('prompt-modal');
        const titleEl = document.getElementById('prompt-title');
        const messageEl = document.getElementById('prompt-message');
        const input = document.getElementById('prompt-input');
        const confirmBtn = document.getElementById('prompt-confirm');
        const cancelBtn = document.getElementById('prompt-cancel');
        const closeBtn = document.getElementById('prompt-close');
        titleEl.textContent = title;
        messageEl.textContent = message;
        input.value = defaultValue;
        modal.style.display = 'block';
        setTimeout(() => input.focus(), 50);

        const cleanup = (value) => {
            modal.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKey);
            resolve(value);
        };
        const onConfirm = () => cleanup(input.value);
        const onCancel = () => cleanup(null);
        const onKey = (e) => {
            if (e.key === 'Enter') onConfirm();
            if (e.key === 'Escape') onCancel();
        };
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKey);
    });
}

function showConfirm(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('prompt-modal');
        const titleEl = document.getElementById('prompt-title');
        const messageEl = document.getElementById('prompt-message');
        const input = document.getElementById('prompt-input');
        const confirmBtn = document.getElementById('prompt-confirm');
        const cancelBtn = document.getElementById('prompt-cancel');
        const closeBtn = document.getElementById('prompt-close');
        titleEl.textContent = title;
        messageEl.textContent = message;
        input.value = '';
        input.style.display = 'none';
        modal.style.display = 'block';

        const cleanup = (value) => {
            modal.style.display = 'none';
            input.style.display = '';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
            resolve(value);
        };
        const onConfirm = () => cleanup(true);
        const onCancel = () => cleanup(false);
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
    });
}

async function refreshPartitions(topicName) {
    const select = document.getElementById('partitionSelect');
    if (!select) return;
    select.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All partitions';
    select.appendChild(allOpt);
    if (!topicName || !envConfig || !envConfig[activeEnv]) return;
    try {
        const kafka = await getKafkaClient();
        const offsets = await getTopicOffsets(kafka, topicName);
        offsets
            .sort((a, b) => Number(a.partition) - Number(b.partition))
            .forEach((o) => {
                const opt = document.createElement('option');
                opt.value = String(o.partition);
                opt.textContent = `Partition ${o.partition} (low=${o.low}, high=${o.high})`;
                select.appendChild(opt);
            });
    } catch (err) {
        console.warn('Could not load partitions for topic', topicName, err);
    }
}

async function loadTopicsBrowser(forceRefresh = false) {
    const tbody = document.getElementById('topicsTableBody');
    const empty = document.getElementById('topicsEmptyState');
    const countEl = document.getElementById('topicsCount');
    if (!tbody) return;
    showLoading();
    try {
        if (forceRefresh || topicsCache.length === 0) {
            const kafka = await getKafkaClient();
            topicsCache = await getTopicsAndPartitions(kafka);
        }
        renderTopicsTable();
        if (countEl) countEl.textContent = `${topicsCache.length} topic${topicsCache.length === 1 ? '' : 's'}`;
        if (empty) empty.style.display = topicsCache.length === 0 ? 'block' : 'none';
    } catch (err) {
        showAlert('Failed to load topics', err.message);
    } finally {
        hideLoading();
    }
}

function renderTopicsTable() {
    const tbody = document.getElementById('topicsTableBody');
    const searchInput = document.getElementById('topicsSearchInput');
    if (!tbody) return;
    const term = (searchInput && searchInput.value || '').trim().toLowerCase();
    const filtered = term
        ? topicsCache.filter((t) => t.name.toLowerCase().includes(term))
        : topicsCache;

    tbody.innerHTML = '';
    filtered.forEach((t) => {
        const tr = document.createElement('tr');
        const leaders = t.partitions
            .map((p) => `${p.partitionId}→${p.leader}`)
            .join(', ');
        tr.innerHTML = `
            <td class="topic-cell">${escapeHtml(t.name)}</td>
            <td>${t.partitionCount}</td>
            <td>${t.replicationFactor}</td>
            <td class="leaders-cell" title="${escapeHtml(leaders)}">${escapeHtml(leaders)}</td>
            <td>${t.totalMessages}</td>
            <td class="actions-cell">
                <button class="btn-secondary" data-action="produce">Producer</button>
                <button class="btn-secondary" data-action="consume">Consumer</button>
            </td>
        `;
        tr.querySelector('[data-action="produce"]').addEventListener('click', () => {
            useTopic(t.name, 'producer');
        });
        tr.querySelector('[data-action="consume"]').addEventListener('click', () => {
            useTopic(t.name, 'consumer');
        });
        tbody.appendChild(tr);
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function ensureTopicInList(topicName) {
    if (!activeTopicList.includes(topicName)) {
        activeTopicList = [...activeTopicList, topicName];
    }
    populateTopicSelect();
    activeTopic = topicName;
    document.getElementById('topicSelect').value = activeTopic;
}

async function useTopic(topicName, methodId) {
    ensureTopicInList(topicName);
    onTopicChange(topicName);
    onMethodTabClick(document.getElementById(methodId));
}

document.addEventListener('DOMContentLoaded', async () => {
    initializeThemeToggle();
    initializeReadOnlyToggle();
    showLoading();
    loadConfig().then(() => {
        activeEnv = Object.keys(envConfig)[0];
        activeTopicList = (envConfig[activeEnv].topicList || []).slice();

        initializeEditor();
        initializeConsumer();
        populateTokenInsert();
        refreshTemplateSelect();

        const envSelect = document.getElementById('envSelect');
        const formatButton = document.getElementById('formatButton');

        Object.values(envConfig).forEach((env) => {
            const option = document.createElement('option');
            option.value = env.id;
            option.textContent = env.label;
            envSelect.appendChild(option);
        });
        envSelect.value = activeEnv;
        envSelect.addEventListener('change', (event) => {
            onEnvChange(event.target.value);
        });

        const methodTabContainer = document.getElementById('tabs');
        Object.values(method).forEach((m) => buildMethodTab(methodTabContainer, m));

        Object.values(method).forEach((m) => {
            document.getElementById(m.containerId).style.display =
                m.id === activeMethod ? 'flex' : 'none';
        });

        onEnvChange(activeEnv);
        updateSummaryCards();

        document.getElementById('produceButton').addEventListener('click', async () => {
            showLoading();
            try {
                const expanded = expandTokens(editor.getValue());
                const kafka = await getKafkaClient();
                await produceMessage(kafka, activeTopic, expanded);
            } catch (error) {
                showAlert('Kafka Producer Error', error.message);
            }
            hideLoading();
        });

        document.getElementById('clearMessages').addEventListener('click', () => {
            clearConsumedMessages();
        });

        document.getElementById('consumeButton').addEventListener('click', async () => {
            showLoading();
            const consumerTab = document.getElementById('consumer');
            consumerTab.addEventListener('click', () => {
                consumer.refresh();
                const lastLine = consumer.getScrollInfo().height;
                consumer.scrollTo(0, lastLine);
            });

            if (!consumeStarted) {
                try {
                    const opts = readConsumerOptions();
                    if (!opts.topic) {
                        showAlert('Consumer', 'Please select a topic first.');
                        hideLoading();
                        return;
                    }
                    consumerGroup = opts.groupId;
                    setGroupForTopic(activeEnv, opts.topic, consumerGroup);
                    updateSummaryCards();

                    const kafka = await getKafkaClient();
                    setConsumeRunningUI(true);
                    consumeMessages(kafka, opts, (msg) => {
                        pushConsumedMessage(msg);
                    }, () => {
                        clearInterval(window.refreshIntervalId);
                        renderConsumerTabBlink(false);
                        setConsumeRunningUI(false);
                        consumeStarted = false;
                        applyReadOnlyState();
                    }).catch((err) => {
                        showAlert('Kafka Consumer Error', err.message);
                        setConsumeRunningUI(false);
                        consumeStarted = false;
                        applyReadOnlyState();
                    }).finally(() => {
                        hideLoading();
                    });

                    consumeStarted = true;
                    consumerBlinkOn = false;
                    window.refreshIntervalId = setInterval(() => {
                        consumerBlinkOn = !consumerBlinkOn;
                        renderConsumerTabBlink(consumerBlinkOn);
                    }, 1000);
                    applyReadOnlyState();
                } catch (error) {
                    showAlert('Kafka Consumer Error', error.message);
                    hideLoading();
                }
            } else {
                await stopConsuming().finally(() => hideLoading());
                clearInterval(window.refreshIntervalId);
                renderConsumerTabBlink(false);
                setConsumeRunningUI(false);
                consumeStarted = false;
                applyReadOnlyState();
            }
        });

        document.getElementById('payload').addEventListener('keyup', () => {
            try {
                JSON.parse(editor.getValue());
                validPayload = true;
                formatButton.disabled = false;
            } catch (_) {
                validPayload = false;
                formatButton.disabled = true;
            }
            reloadProduceButton();
        });

        formatButton.addEventListener('click', () => {
            try {
                const formatted = JSON.stringify(JSON.parse(editor.getValue()), null, 2);
                editor.setValue(formatted);
            } catch (error) {
                showAlert('JSON Format Error', 'Error formatting JSON. Please check the JSON and try again.');
            }
            reloadProduceButton();
        });

        wireConsumerControls();
        wireTemplateControls();
        wireTopicsBrowserControls();
        wireSetupButton();
        rendererInitialized = true;
        if (pendingConfigUpdate) {
            const cfg = pendingConfigUpdate;
            pendingConfigUpdate = null;
            reapplyConfig(cfg).catch((err) => showAlert('Failed to apply configuration', err.message));
        }
    }).finally(() => {
        hideLoading();
    });

    ipcRenderer.on('config-updated', (_event, newConfig) => {
        if (!rendererInitialized) {
            pendingConfigUpdate = newConfig;
            return;
        }
        reapplyConfig(newConfig).catch((err) => {
            showAlert('Failed to apply configuration', err.message);
        });
    });
});

function setConsumeRunningUI(running) {
    const consumeBtn = document.getElementById('consumeButton');
    if (!consumeBtn) return;
    consumeBtn.innerHTML = running ? 'Stop Consuming' : 'Start Consuming';
    consumeBtn.style.backgroundColor = running ? '#dc3545' : '';
    consumeBtn.disabled = !running && (activeTopic === '');
    const fields = ['startModeGroup', 'partitionSelect', 'offsetInput', 'maxMessagesInput', 'consumerGroupInput'];
    fields.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const inputs = el.tagName === 'INPUT' || el.tagName === 'SELECT' ? [el] : el.querySelectorAll('input, select');
        inputs.forEach((i) => { i.disabled = running; });
    });
}

function readConsumerOptions() {
    const startMode = (document.querySelector('input[name="startMode"]:checked') || {}).value || 'latest';
    const partitionRaw = document.getElementById('partitionSelect').value;
    const offsetRaw = document.getElementById('offsetInput').value;
    const maxMessagesRaw = document.getElementById('maxMessagesInput').value;
    const groupRaw = document.getElementById('consumerGroupInput').value.trim();
    return {
        topic: activeTopic,
        groupId: groupRaw || DEFAULT_GROUP,
        startMode,
        partition: partitionRaw === '' ? null : Number(partitionRaw),
        offset: startMode === 'offset' && offsetRaw !== '' ? offsetRaw : null,
        maxMessages: maxMessagesRaw === '' ? null : Number(maxMessagesRaw),
    };
}

function wireConsumerControls() {
    const startModeRadios = document.querySelectorAll('input[name="startMode"]');
    const offsetRow = document.getElementById('offsetRow');
    startModeRadios.forEach((r) => {
        r.addEventListener('change', () => {
            const mode = document.querySelector('input[name="startMode"]:checked').value;
            offsetRow.style.display = mode === 'offset' ? 'flex' : 'none';
        });
    });

    const refreshPartitionsButton = document.getElementById('refreshPartitionsButton');
    if (refreshPartitionsButton) {
        refreshPartitionsButton.addEventListener('click', () => {
            if (activeTopic) refreshPartitions(activeTopic);
        });
    }

    const filterInput = document.getElementById('filterInput');
    const filterRegex = document.getElementById('filterRegex');
    if (filterInput) filterInput.addEventListener('input', applyFilter);
    if (filterRegex) filterRegex.addEventListener('change', applyFilter);

    const groupInput = document.getElementById('consumerGroupInput');
    if (groupInput) {
        groupInput.addEventListener('change', () => {
            consumerGroup = groupInput.value.trim() || DEFAULT_GROUP;
            updateSummaryCards();
            if (activeTopic) {
                setGroupForTopic(activeEnv, activeTopic, consumerGroup);
            }
        });
    }
}

function wireTemplateControls() {
    const templateSelect = document.getElementById('templateSelect');
    const loadBtn = document.getElementById('loadTemplateButton');
    const updateBtn = document.getElementById('updateTemplateButton');
    const saveBtn = document.getElementById('saveTemplateButton');
    const deleteBtn = document.getElementById('deleteTemplateButton');

    if (templateSelect) {
        templateSelect.addEventListener('change', () => {
            selectedTemplateId = templateSelect.value;
            refreshTemplateButtons();
        });
    }
    if (loadBtn) {
        loadBtn.addEventListener('click', () => {
            if (!selectedTemplateId) return;
            const tpl = templatesApi.getTemplate(selectedTemplateId);
            if (tpl && editor) {
                editor.setValue(tpl.payload || '');
                try {
                    JSON.parse(editor.getValue());
                    validPayload = true;
                    document.getElementById('formatButton').disabled = false;
                } catch (_) {
                    validPayload = false;
                    document.getElementById('formatButton').disabled = true;
                }
                reloadProduceButton();
            }
        });
    }
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const name = await showPrompt('Save template', 'Template name:', '');
            if (!name) return;
            try {
                const tpl = templatesApi.saveTemplate({ name, payload: editor ? editor.getValue() : '' });
                selectedTemplateId = tpl.id;
                refreshTemplateSelect();
            } catch (err) {
                showAlert('Save template failed', err.message);
            }
        });
    }
    if (updateBtn) {
        updateBtn.addEventListener('click', () => {
            if (!selectedTemplateId) return;
            try {
                templatesApi.updateTemplate(selectedTemplateId, {
                    payload: editor ? editor.getValue() : '',
                });
                refreshTemplateSelect();
            } catch (err) {
                showAlert('Update template failed', err.message);
            }
        });
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (!selectedTemplateId) return;
            const ok = await showConfirm('Delete template', 'Are you sure you want to delete this template?');
            if (!ok) return;
            try {
                templatesApi.deleteTemplate(selectedTemplateId);
                selectedTemplateId = '';
                refreshTemplateSelect();
            } catch (err) {
                showAlert('Delete template failed', err.message);
            }
        });
    }
}

function wireTopicsBrowserControls() {
    const refreshBtn = document.getElementById('refreshTopicsButton');
    const searchInput = document.getElementById('topicsSearchInput');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => loadTopicsBrowser(true));
    }
    if (searchInput) {
        searchInput.addEventListener('input', renderTopicsTable);
    }
}

function wireSetupButton() {
    const setupBtn = document.getElementById('setupButton');
    if (setupBtn) {
        setupBtn.addEventListener('click', () => {
            ipcRenderer.send('open-setup-window');
        });
    }
}

async function reapplyConfig(newConfig) {
    showLoading();
    try {
        const valid = ajv.validate(schema, newConfig);
        if (!valid) {
            throw new Error('Invalid configuration format');
        }

        if (consumeStarted) {
            try { await stopConsuming(); } catch (_) { /* ignore */ }
            clearInterval(window.refreshIntervalId);
            renderConsumerTabBlink(false);
            setConsumeRunningUI(false);
            consumeStarted = false;
        }

        envConfig = newConfig;
        kafkaClientCache = { env: null, client: null };
        topicsCache = [];

        const envSelect = document.getElementById('envSelect');
        envSelect.innerHTML = '';
        Object.values(envConfig).forEach((env) => {
            const option = document.createElement('option');
            option.value = env.id;
            option.textContent = env.label;
            envSelect.appendChild(option);
        });

        const envIds = Object.keys(envConfig);
        const nextEnv = envIds.includes(activeEnv) ? activeEnv : envIds[0];
        envSelect.value = nextEnv;
        onEnvChange(nextEnv);
        if (activeMethod === 'topicsBrowser') {
            loadTopicsBrowser(true);
        }
    } finally {
        hideLoading();
        applyReadOnlyState();
    }
}

function reloadProduceButton() {
    const produceButton = document.getElementById('produceButton');
    produceButton.disabled = activeTopic === '' || !validPayload;
}

const onEnvChange = (envId) => {
    showLoading();

    activeEnv = envId;
    activeTopicList = (envConfig[activeEnv].topicList || []).slice();
    activeTopic = '';
    consumerGroup = DEFAULT_GROUP;
    document.getElementById('envSelect').value = activeEnv;

    const groupInput = document.getElementById('consumerGroupInput');
    if (groupInput) groupInput.value = consumerGroup;

    if (!consumeStarted) {
        const stopConsumeButton = document.getElementById('consumeButton');
        stopConsumeButton.disabled = true;
    }

    activeMethod = 'producer';
    onMethodTabClick(document.getElementById(activeMethod));
    populateTopicSelect();

    topicsCache = [];
    kafkaClientCache = { env: null, client: null };

    reloadProduceButton();
    updateSummaryCards();
    applyReadOnlyState();

    hideLoading();
};

const onTopicChange = (topic) => {
    showLoading();
    activeTopic = topic;
    consumerGroup = activeTopic ? getGroupForTopic(activeEnv, activeTopic) : DEFAULT_GROUP;
    const groupInput = document.getElementById('consumerGroupInput');
    if (groupInput) groupInput.value = consumerGroup;

    const stopConsumeButton = document.getElementById('consumeButton');
    if (!consumeStarted) {
        stopConsumeButton.disabled = activeTopic === '';
    }
    reloadProduceButton();
    updateSummaryCards();
    applyReadOnlyState();
    if (activeTopic) {
        refreshPartitions(activeTopic);
    }
    hideLoading();
};

const onMethodTabClick = (tab) => {
    activeMethod = tab.id;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.remove('active'));
    tab.classList.add('active');

    Object.values(method).forEach((m) => {
        document.getElementById(m.containerId).style.display = m.id === tab.id ? 'flex' : 'none';
    });

    if (tab.id === 'topicsBrowser' && topicsCache.length === 0) {
        loadTopicsBrowser(true);
    }
};

const buildMethodTab = (methodTabContainer, m) => {
    const tab = document.createElement('button');
    tab.id = m.id;
    tab.classList.add('tab');
    const label = document.createElement('span');
    label.classList.add('tab-label');
    label.textContent = m.label;
    tab.appendChild(label);
    if (m.id === 'consumer') {
        const status = document.createElement('span');
        status.classList.add('tab-status');
        tab.appendChild(status);
    }
    tab.onclick = () => onMethodTabClick(tab);
    if (m.id === activeMethod) {
        tab.classList.add('active');
    }
    methodTabContainer.appendChild(tab);
};

const populateTopicSelect = () => {
    const topicSelect = document.getElementById('topicSelect');
    topicSelect.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a topic...';
    topicSelect.appendChild(placeholder);

    activeTopicList.forEach((topic) => {
        const option = document.createElement('option');
        option.value = topic;
        option.textContent = topic;
        topicSelect.appendChild(option);
    });

    topicSelect.value = activeTopic;
    topicSelect.onchange = (event) => onTopicChange(event.target.value);
};

const showLoading = () => {
    document.getElementById('loading-container').style.display = 'flex';
};

const hideLoading = () => {
    document.getElementById('loading-container').style.display = 'none';
};

function showAlert(topic, message) {
    const alertBox = document.getElementById('custom-alert');
    const alertTopic = document.getElementById('custom-alert-topic');
    const alertMessage = document.getElementById('custom-alert-message');
    alertTopic.textContent = topic;
    alertMessage.textContent = message;
    alertBox.style.display = 'block';
}

function closeAlert() {
    const alertBox = document.getElementById('custom-alert');
    alertBox.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#custom-alert .custom-alert-close').addEventListener('click', closeAlert);
});
