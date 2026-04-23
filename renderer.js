const { ipcRenderer } = require('electron');
const {
    createKafkaClient,
    produceMessage,
    stopConsuming,
    consumeMessages,
    getTopicsAndPartitions,
    getTopicOffsets,
    getConsumerLagOverview,
    getClusterMetadata,
} = require('./backend/kafka');
const templatesApi = require('./backend/templates');
const { expandTokens, TOKEN_INSERT_OPTIONS } = require('./backend/randomTokens');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Ajv = require('ajv');

const TAB_ICONS = {
    producer: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M22 2 11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 2 15 22l-4-9-9-4 20-7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    consumer: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 14v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    topicsBrowser: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
    consumerLag: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 12a9 9 0 1 1 18 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 12 16 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
    clusterInfo: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="3" y="3" width="18" height="6" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="3" y="15" width="18" height="6" rx="1.5" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="6" r="1" fill="currentColor"/><circle cx="7" cy="18" r="1" fill="currentColor"/></svg>',
};

const method = {
    producer: {
        id: 'producer',
        label: 'Produce',
        containerId: 'producerContainer',
        icon: TAB_ICONS.producer,
    },
    consumer: {
        id: 'consumer',
        label: 'Consume',
        containerId: 'consumerContainer',
        icon: TAB_ICONS.consumer,
    },
    topicsBrowser: {
        id: 'topicsBrowser',
        label: 'Topics',
        containerId: 'topicsBrowserContainer',
        icon: TAB_ICONS.topicsBrowser,
    },
    consumerLag: {
        id: 'consumerLag',
        label: 'Consumer lag',
        containerId: 'consumerLagContainer',
        icon: TAB_ICONS.consumerLag,
    },
    clusterInfo: {
        id: 'clusterInfo',
        label: 'Cluster',
        containerId: 'clusterInfoContainer',
        icon: TAB_ICONS.clusterInfo,
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

const PAYLOAD_FORMATS = {
    json: { id: 'json', label: 'JSON', cmMode: { name: 'javascript', json: true } },
    xml: { id: 'xml', label: 'XML', cmMode: 'xml' },
    text: { id: 'text', label: 'Plain text', cmMode: null },
};
const DEFAULT_FORMAT = 'json';
const PRODUCER_FORMAT_STORAGE_KEY = 'kss-producer-format';
const CONSUMER_FORMAT_STORAGE_KEY = 'kss-consumer-format';

let activeEnv = null;
let activeMethod = 'producer';
let activeTopicList = null;
let producerTopic = '';
let consumerTopic = '';
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
let producerFormat = DEFAULT_FORMAT;
let consumerFormat = DEFAULT_FORMAT;
let kafkaClientCache = { env: null, client: null };
let rendererInitialized = false;
let pendingConfigUpdate = null;
window.refreshIntervalId = null;
let lagTopic = '';
let consumerBlurIdleTimerId = null;
let consumerIdleCountdownIntervalId = null;
let consumerIdleModalActive = false;

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

/**
 * Consumer background-idle prompt. Stored in preferences.json (~/.kss/preferences.json).
 * consumerIdle.blurUnfocusedMinutes — unfocused time before "still there?" (default 60 = 1 hour).
 * consumerIdle.promptResponseMinutes — countdown before auto-stop if no confirmation (default 3).
 */
function getConsumerIdlePrefs() {
    const prefs = loadPreferences();
    const raw = prefs.consumerIdle || {};
    let blurMin = Number(raw.blurUnfocusedMinutes);
    let responseMin = Number(raw.promptResponseMinutes);
    if (!Number.isFinite(blurMin) || blurMin <= 0) blurMin = 60;
    if (!Number.isFinite(responseMin) || responseMin <= 0) responseMin = 3;
    const blurMs = blurMin * 60 * 1000;
    const maxMs = 2147483647;
    return {
        blurUnfocusedMs: Math.min(blurMs, maxMs),
        promptResponseSec: Math.round(responseMin * 60),
    };
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
        btn.title = readOnlyMode
            ? 'Read-only: consumer group locked. Click to allow editing.'
            : 'Editable: click to lock consumer group (read-only).';
        btn.setAttribute('aria-label', readOnlyMode ? 'Read-only mode' : 'Editable mode');
    }
    const groupInput = document.getElementById('consumerGroupInput');
    if (groupInput) {
        groupInput.disabled = readOnlyMode || consumeStarted;
        groupInput.title = readOnlyMode
            ? 'Click the lock in the toolbar to allow editing the consumer group'
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

function applyActiveMethodLayout() {
    const hideTopicsChrome = activeMethod === 'topicsBrowser'
        || activeMethod === 'consumerLag'
        || activeMethod === 'clusterInfo';
    const ribbon = document.getElementById('summaryCards');
    if (ribbon) ribbon.style.display = hideTopicsChrome ? 'none' : '';
    const optionsSection = document.getElementById('topics');
    if (optionsSection) optionsSection.style.display = hideTopicsChrome ? 'none' : '';

    const producerOptionsSection = document.getElementById('optionsProducerSection');
    const consumerOptionsSection = document.getElementById('optionsConsumerSection');
    if (producerOptionsSection) {
        producerOptionsSection.style.display = activeMethod === 'producer' ? '' : 'none';
    }
    if (consumerOptionsSection) {
        consumerOptionsSection.style.display = activeMethod === 'consumer' ? '' : 'none';
    }

    const envCard = document.getElementById('summaryCardActiveEnv');
    const groupCard = document.getElementById('summaryCardConsumerGroup');
    if (hideTopicsChrome) {
        if (envCard) envCard.style.display = '';
        if (groupCard) groupCard.style.display = '';
    } else {
        const hideActiveEnv = activeMethod === 'producer' || activeMethod === 'consumer';
        if (envCard) envCard.style.display = hideActiveEnv ? 'none' : '';
        if (groupCard) groupCard.style.display = activeMethod === 'producer' ? 'none' : '';
    }
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

    const selectedTopicLabel = activeMethod === 'consumer'
        ? consumerTopic
        : (activeMethod === 'consumerLag'
            ? lagTopic
            : (activeMethod === 'clusterInfo' ? '' : producerTopic));
    activeTopicName.textContent = selectedTopicLabel || '-';
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
        mode: { name: 'javascript', json: true },
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
        mode: { name: 'javascript', json: true },
        theme: 'default',
        placeholder: 'Consumed messages will display here...',
    });
}

function validatePayload(format, text) {
    if (format === 'text') return true;
    const raw = text == null ? '' : String(text);
    if (format === 'json') {
        try {
            JSON.parse(raw);
            return true;
        } catch (_) {
            return false;
        }
    }
    if (format === 'xml') {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        const doc = new DOMParser().parseFromString(raw, 'application/xml');
        return !doc.querySelector('parsererror');
    }
    return false;
}

function formatPayloadXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid XML');

    function escAttr(v) {
        return String(v)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
    }

    function walk(node, depth) {
        const pad = '  '.repeat(depth);
        if (node.nodeType === 3) {
            const t = node.textContent;
            if (!t || !t.trim()) return '';
            return `${pad}${t.trim()}\n`;
        }
        if (node.nodeType !== 1) return '';
        let out = '';
        let attrs = '';
        for (let i = 0; i < node.attributes.length; i += 1) {
            const a = node.attributes[i];
            attrs += ` ${a.name}="${escAttr(a.value)}"`;
        }
        const childEls = [...node.childNodes].filter((n) => n.nodeType === 1);
        const textNodes = [...node.childNodes].filter((n) => n.nodeType === 3);
        const textJoined = textNodes.map((n) => n.textContent.trim()).filter(Boolean).join(' ');
        if (!childEls.length && !textJoined) {
            return `${pad}<${node.nodeName}${attrs}/>\n`;
        }
        out += `${pad}<${node.nodeName}${attrs}>\n`;
        if (textJoined) out += `${'  '.repeat(depth + 1)}${textJoined}\n`;
        for (const ch of childEls) out += walk(ch, depth + 1);
        out += `${pad}</${node.nodeName}>\n`;
        return out;
    }

    return walk(doc.documentElement, 0).trimEnd();
}

function formatPayload(format, text) {
    if (format === 'json') {
        return JSON.stringify(JSON.parse(text), null, 2);
    }
    if (format === 'xml') {
        return formatPayloadXml(text);
    }
    return text;
}

function applyEditorMode(cmEditor, formatId) {
    const spec = PAYLOAD_FORMATS[formatId] || PAYLOAD_FORMATS[DEFAULT_FORMAT];
    if (!cmEditor) return;
    cmEditor.setOption('mode', spec.cmMode);
}

function revalidateProducerPayload() {
    const formatButton = document.getElementById('formatButton');
    if (!editor) return;
    const text = editor.getValue();
    validPayload = validatePayload(producerFormat, text);
    if (formatButton) {
        formatButton.disabled = !validPayload || producerFormat === 'text';
    }
    reloadProduceButton();
}

function applyProducerFormat(format, { skipStorage } = {}) {
    const id = PAYLOAD_FORMATS[format] ? format : DEFAULT_FORMAT;
    producerFormat = id;
    const sel = document.getElementById('producerFormatSelect');
    if (sel) sel.value = producerFormat;
    if (editor) applyEditorMode(editor, producerFormat);
    revalidateProducerPayload();
    if (!skipStorage) {
        try {
            window.localStorage.setItem(PRODUCER_FORMAT_STORAGE_KEY, producerFormat);
        } catch (_) { /* ignore */ }
    }
}

function applyConsumerFormat(format, { skipStorage } = {}) {
    const id = PAYLOAD_FORMATS[format] ? format : DEFAULT_FORMAT;
    consumerFormat = id;
    const sel = document.getElementById('consumerFormatSelect');
    if (sel) sel.value = consumerFormat;
    if (consumer) applyEditorMode(consumer, consumerFormat);
    applyFilter();
    if (!skipStorage) {
        try {
            window.localStorage.setItem(CONSUMER_FORMAT_STORAGE_KEY, consumerFormat);
        } catch (_) { /* ignore */ }
    }
}

function formatConsumedEntry(msg) {
    let body = msg.value;
    if (consumerFormat === 'json') {
        try {
            body = JSON.stringify(JSON.parse(msg.value), null, 2);
        } catch (_) { /* keep as-is */ }
    }
    const metaLine = `partition=${msg.partition} offset=${msg.offset} ts=${msg.timestamp}` +
        (msg.key ? ` key=${msg.key}` : '');
    let meta;
    if (consumerFormat === 'xml') {
        meta = `<!-- ${metaLine} -->`;
    } else if (consumerFormat === 'text') {
        meta = `# ${metaLine}`;
    } else {
        meta = `// ${metaLine}`;
    }
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
    const byGroup = new Map();
    for (const row of TOKEN_INSERT_OPTIONS) {
        const g = row.group || 'Other';
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(row);
    }
    for (const [groupName, rows] of byGroup) {
        const og = document.createElement('optgroup');
        og.label = groupName;
        for (const td of rows) {
            const opt = document.createElement('option');
            opt.value = td.token;
            opt.textContent = `${td.token}  —  ${td.label}`;
            og.appendChild(opt);
        }
        select.appendChild(og);
    }
    select.onchange = () => {
        const token = select.value;
        if (!token || !editor) return;
        editor.replaceSelection(token);
        select.value = '';
        editor.focus();
    };
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

function clearConsumerBlurIdleTimer() {
    if (consumerBlurIdleTimerId) {
        clearTimeout(consumerBlurIdleTimerId);
        consumerBlurIdleTimerId = null;
    }
}

function scheduleConsumerBlurIdleTimer() {
    clearConsumerBlurIdleTimer();
    if (!consumeStarted || consumerIdleModalActive) return;
    consumerBlurIdleTimerId = setTimeout(() => {
        consumerBlurIdleTimerId = null;
        showConsumerStillThereModal();
    }, getConsumerIdlePrefs().blurUnfocusedMs);
}

function onWindowBlurForConsumerIdle() {
    if (!consumeStarted) return;
    scheduleConsumerBlurIdleTimer();
}

function onWindowFocusForConsumerIdle() {
    clearConsumerBlurIdleTimer();
}

function hideConsumerStillThereModal() {
    const overlay = document.getElementById('consumer-idle-overlay');
    if (overlay) overlay.style.display = 'none';
    if (consumerIdleCountdownIntervalId) {
        clearInterval(consumerIdleCountdownIntervalId);
        consumerIdleCountdownIntervalId = null;
    }
    consumerIdleModalActive = false;
}

function resetConsumerIdleWatchdog() {
    clearConsumerBlurIdleTimer();
    hideConsumerStillThereModal();
}

function resetConsumeUIState() {
    if (window.refreshIntervalId) {
        clearInterval(window.refreshIntervalId);
        window.refreshIntervalId = null;
    }
    renderConsumerTabBlink(false);
    setConsumeRunningUI(false);
    consumeStarted = false;
    applyReadOnlyState();
}

async function stopConsumingAndResetUI() {
    resetConsumerIdleWatchdog();
    try {
        await stopConsuming();
    } catch (_) {
        /* ignore */
    }
    resetConsumeUIState();
}

function showConsumerStillThereModal() {
    if (!consumeStarted || consumerIdleModalActive) return;
    const overlay = document.getElementById('consumer-idle-overlay');
    const cdEl = document.getElementById('consumer-idle-countdown');
    const confirmBtn = document.getElementById('consumer-idle-confirm');
    const stopBtn = document.getElementById('consumer-idle-stop');
    if (!overlay || !cdEl || !confirmBtn || !stopBtn) return;

    clearConsumerBlurIdleTimer();
    consumerIdleModalActive = true;
    overlay.style.display = 'flex';
    setTimeout(() => confirmBtn.focus(), 50);

    let remaining = getConsumerIdlePrefs().promptResponseSec;
    const updateDisplay = () => {
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        cdEl.textContent = `Stopping in ${m}:${String(s).padStart(2, '0')} unless you keep consuming.`;
    };
    updateDisplay();

    const clearCountdown = () => {
        if (consumerIdleCountdownIntervalId) {
            clearInterval(consumerIdleCountdownIntervalId);
            consumerIdleCountdownIntervalId = null;
        }
    };

    consumerIdleCountdownIntervalId = setInterval(() => {
        remaining -= 1;
        updateDisplay();
        if (remaining <= 0) {
            clearCountdown();
            void stopConsumingAndResetUI();
        }
    }, 1000);

    confirmBtn.onclick = () => {
        clearCountdown();
        hideConsumerStillThereModal();
        if (consumeStarted && !document.hasFocus()) {
            scheduleConsumerBlurIdleTimer();
        }
    };

    stopBtn.onclick = () => {
        clearCountdown();
        void stopConsumingAndResetUI();
    };
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
                <button class="btn-secondary" data-action="lag" title="Open Consumer lag for this topic">Lag</button>
            </td>
        `;
        tr.querySelector('[data-action="produce"]').addEventListener('click', () => {
            useTopic(t.name, 'producer');
        });
        tr.querySelector('[data-action="consume"]').addEventListener('click', () => {
            useTopic(t.name, 'consumer');
        });
        tr.querySelector('[data-action="lag"]').addEventListener('click', () => {
            navigateToConsumerLag(t.name);
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

function clearLagOverviewUI(message) {
    const body = document.getElementById('lagTableBody');
    const empty = document.getElementById('lagEmptyState');
    const status = document.getElementById('lagStatus');
    if (body) body.innerHTML = '';
    if (empty) {
        empty.textContent = message || 'Select a topic and click Load.';
        empty.style.display = 'block';
    }
    if (status) status.textContent = '';
}

function populateLagTopicSelect() {
    const sel = document.getElementById('lagTopicSelect');
    if (!sel) return;
    const prev = lagTopic;
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Select a topic…';
    sel.appendChild(ph);
    activeTopicList.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        sel.appendChild(opt);
    });
    if (prev && activeTopicList.includes(prev)) {
        lagTopic = prev;
    } else {
        lagTopic = '';
    }
    sel.value = lagTopic;
    sel.onchange = () => {
        lagTopic = sel.value;
    };
}

function renderLagOverviewResult(data) {
    const body = document.getElementById('lagTableBody');
    const empty = document.getElementById('lagEmptyState');
    const status = document.getElementById('lagStatus');
    if (!body || !empty || !status) return;

    status.textContent = `Scanned ${data.scannedGroupCount} groups — ${data.matchedGroupCount} with commits on "${data.topic}".`;

    if (!data.groups.length) {
        body.innerHTML = '';
        empty.textContent = 'No consumer groups have committed offsets for this topic yet.';
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';
    body.innerHTML = '';

    for (const g of data.groups) {
        const clients = (g.members || []).map((m) => m.clientId || m.memberId).filter(Boolean);
        const clientsStr = clients.join(', ');
        const clientsShort = clientsStr.length > 48 ? `${clientsStr.slice(0, 45)}…` : clientsStr;
        for (const pr of g.partitions) {
            const tr = document.createElement('tr');
            const committedCell = pr.committedDisplay === null ? '—' : escapeHtml(pr.committedDisplay);
            const lagCell = pr.lag === null ? '—' : escapeHtml(String(pr.lag));
            const clientsTitle = escapeHtml(clientsStr);
            const clientsBody = clientsShort ? escapeHtml(clientsShort) : '—';
            tr.innerHTML = `
                <td class="topic-cell">${escapeHtml(g.groupId)}</td>
                <td>${escapeHtml(String(g.state))}</td>
                <td>${g.memberCount}</td>
                <td class="lag-clients-cell" title="${clientsTitle}">${clientsBody}</td>
                <td>${pr.partition}</td>
                <td>${committedCell}</td>
                <td>${escapeHtml(String(pr.logEnd))}</td>
                <td>${lagCell}</td>
            `;
            body.appendChild(tr);
        }
    }
}

async function loadConsumerLagOverview() {
    if (!lagTopic) {
        showAlert('Consumer lag', 'Please select a topic.');
        return;
    }
    const status = document.getElementById('lagStatus');
    if (status) status.textContent = 'Loading…';
    showLoading();
    try {
        const kafka = await getKafkaClient();
        const data = await getConsumerLagOverview(kafka, lagTopic);
        renderLagOverviewResult(data);
    } catch (err) {
        showAlert('Consumer lag', err.message);
        clearLagOverviewUI();
    } finally {
        hideLoading();
    }
}

async function navigateToConsumerLag(topicName) {
    if (!topicName) return;
    if (!activeTopicList.includes(topicName)) {
        activeTopicList = [...activeTopicList, topicName];
    }
    lagTopic = topicName;
    populateTopicSelect();
    clearLagOverviewUI();
    onMethodTabClick(document.getElementById('consumerLag'));
    await loadConsumerLagOverview();
}

function renderTopicHealthSection(th) {
    const statsEl = document.getElementById('topicHealthStats');
    const tbody = document.getElementById('topicHealthBody');
    const empty = document.getElementById('topicHealthEmpty');
    const trunc = document.getElementById('topicHealthTruncated');
    if (!statsEl || !tbody || !empty) return;

    if (!th || th.error) {
        statsEl.innerHTML = '';
        tbody.innerHTML = '';
        empty.style.display = 'block';
        empty.textContent = (th && th.error)
            ? `Topic health could not be loaded: ${th.error}`
            : '—';
        if (trunc) trunc.textContent = '';
        return;
    }

    const t = th.totals;
    statsEl.innerHTML = `
        <div class="cluster-stat"><div class="cluster-stat-value">${t.partitions}</div><div class="cluster-stat-label">Partitions (user topics)</div></div>
        <div class="cluster-stat"><div class="cluster-stat-value">${t.underReplicatedPartitions}</div><div class="cluster-stat-label">Under-replicated</div></div>
        <div class="cluster-stat"><div class="cluster-stat-value">${t.offlineOrNoLeaderPartitions}</div><div class="cluster-stat-label">No leader</div></div>
        <div class="cluster-stat"><div class="cluster-stat-value">${t.erroredPartitions}</div><div class="cluster-stat-label">Metadata errors</div></div>
        <div class="cluster-stat"><div class="cluster-stat-value">${th.healthyTopics}</div><div class="cluster-stat-label">Topics with no issues</div></div>
    `;

    const issues = th.topicsWithIssues || [];
    if (issues.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        empty.textContent = `All ${t.topics} non-internal topics look healthy in metadata (no under-replicated, leaderless, or errored partitions).`;
        if (trunc) trunc.textContent = '';
        return;
    }

    empty.style.display = 'none';
    tbody.innerHTML = '';
    issues.forEach((r) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="topic-cell">${escapeHtml(r.name)}</td>
            <td>${r.partitionCount}</td>
            <td>${r.underReplicated}</td>
            <td>${r.offlineOrNoLeader}</td>
            <td>${r.errors}</td>
        `;
        tbody.appendChild(tr);
    });

    if (trunc) {
        trunc.textContent = th.truncatedIssues
            ? `Showing first ${issues.length} of ${th.totalIssueTopics} topics that have at least one partition issue.`
            : '';
    }
}

function renderClusterMetadata(data) {
    const summary = document.getElementById('clusterSummary');
    const tbody = document.getElementById('clusterBrokersBody');
    const status = document.getElementById('clusterStatus');
    if (status) {
        status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }
    if (!summary || !tbody) return;

    renderTopicHealthSection(data.topicHealth);

    const controller = data.controllerId;
    const controllerBroker = (data.brokers || []).find((b) => b.nodeId === controller);
    const controllerStr = controllerBroker
        ? `${controllerBroker.host}:${controllerBroker.port} (node ${controller})`
        : (controller == null ? '—' : `node ${controller}`);

    const groupLabel = data.groupCount === null ? '—' : String(data.groupCount);

    summary.innerHTML = `
        <div class="cluster-stat"><div class="cluster-stat-value">${escapeHtml(String(data.clusterId))}</div><div class="cluster-stat-label">Cluster ID</div></div>
        <div class="cluster-stat"><div class="cluster-stat-value">${data.brokerCount}</div><div class="cluster-stat-label">Brokers (metadata)</div></div>
        <div class="cluster-stat"><div class="cluster-stat-value">${data.topicCount}</div><div class="cluster-stat-label">Topics (non-internal)</div></div>
        <div class="cluster-stat"><div class="cluster-stat-value">${groupLabel}</div><div class="cluster-stat-label">Consumer groups</div></div>
        <div class="cluster-stat"><div class="cluster-stat-value cluster-stat-value--sm">${escapeHtml(controllerStr)}</div><div class="cluster-stat-label">Controller</div></div>
    `;

    tbody.innerHTML = '';
    [...(data.brokers || [])].sort((a, b) => a.nodeId - b.nodeId).forEach((b) => {
        const tr = document.createElement('tr');
        const role = b.isController ? 'Controller' : 'Broker';
        const boot = b.inBootstrap ? 'Yes' : 'No';
        tr.innerHTML = `
            <td>${b.nodeId}</td>
            <td class="topic-cell">${escapeHtml(b.endpoint)}</td>
            <td>${role}</td>
            <td>${boot}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function loadClusterOverview() {
    showLoading();
    try {
        const kafka = await getKafkaClient();
        const configured = (envConfig && activeEnv && envConfig[activeEnv])
            ? envConfig[activeEnv].brokers
            : [];
        const data = await getClusterMetadata(kafka, configured);
        renderClusterMetadata(data);
    } catch (err) {
        showAlert('Cluster overview', err.message);
    } finally {
        hideLoading();
    }
}

function wireClusterOverviewControls() {
    const btn = document.getElementById('clusterRefreshButton');
    if (btn) btn.addEventListener('click', () => loadClusterOverview());
}

function wireLagOverviewControls() {
    const btn = document.getElementById('lagLoadButton');
    if (btn) btn.addEventListener('click', () => loadConsumerLagOverview());
}

function ensureTopicInList(topicName) {
    if (!activeTopicList.includes(topicName)) {
        activeTopicList = [...activeTopicList, topicName];
    }
}

async function useTopic(topicName, methodId) {
    ensureTopicInList(topicName);
    onMethodTabClick(document.getElementById(methodId));
    populateTopicSelect();
    onTopicChange(topicName, methodId);
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

        const producerFormatSelect = document.getElementById('producerFormatSelect');
        if (producerFormatSelect) {
            producerFormatSelect.addEventListener('change', (e) => {
                applyProducerFormat(e.target.value);
            });
        }
        let storedProducerFormat = null;
        try {
            storedProducerFormat = window.localStorage.getItem(PRODUCER_FORMAT_STORAGE_KEY);
        } catch (_) { /* ignore */ }
        applyProducerFormat(PAYLOAD_FORMATS[storedProducerFormat] ? storedProducerFormat : DEFAULT_FORMAT, { skipStorage: true });

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
                await produceMessage(kafka, producerTopic, expanded);
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
                        resetConsumerIdleWatchdog();
                        resetConsumeUIState();
                    }).catch((err) => {
                        showAlert('Kafka Consumer Error', err.message);
                        resetConsumerIdleWatchdog();
                        resetConsumeUIState();
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
                    if (!document.hasFocus()) {
                        scheduleConsumerBlurIdleTimer();
                    }
                } catch (error) {
                    showAlert('Kafka Consumer Error', error.message);
                    resetConsumerIdleWatchdog();
                    resetConsumeUIState();
                    hideLoading();
                }
            } else {
                try {
                    await stopConsumingAndResetUI();
                } finally {
                    hideLoading();
                }
            }
        });

        document.getElementById('payload').addEventListener('keyup', () => {
            revalidateProducerPayload();
        });
        document.getElementById('payload').addEventListener('input', () => {
            revalidateProducerPayload();
        });

        formatButton.addEventListener('click', () => {
            try {
                const formatted = formatPayload(producerFormat, editor.getValue());
                editor.setValue(formatted);
            } catch (error) {
                const label = (PAYLOAD_FORMATS[producerFormat] || PAYLOAD_FORMATS[DEFAULT_FORMAT]).label;
                showAlert(`${label} format error`, error.message || 'Could not format the payload.');
            }
            revalidateProducerPayload();
        });

        wireConsumerControls();
        let storedConsumerFormat = null;
        try {
            storedConsumerFormat = window.localStorage.getItem(CONSUMER_FORMAT_STORAGE_KEY);
        } catch (_) { /* ignore */ }
        applyConsumerFormat(PAYLOAD_FORMATS[storedConsumerFormat] ? storedConsumerFormat : DEFAULT_FORMAT, { skipStorage: true });

        wireTemplateControls();
        wireTopicsBrowserControls();
        wireLagOverviewControls();
        wireClusterOverviewControls();
        wireSetupButton();
        window.addEventListener('blur', onWindowBlurForConsumerIdle);
        window.addEventListener('focus', onWindowFocusForConsumerIdle);
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
    consumeBtn.disabled = !running && (consumerTopic === '');
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
        topic: consumerTopic,
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
            if (consumerTopic) refreshPartitions(consumerTopic);
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
            if (consumerTopic) {
                setGroupForTopic(activeEnv, consumerTopic, consumerGroup);
            }
        });
    }

    const consumerFormatSelect = document.getElementById('consumerFormatSelect');
    if (consumerFormatSelect) {
        consumerFormatSelect.addEventListener('change', (e) => {
            applyConsumerFormat(e.target.value);
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
                applyProducerFormat(tpl.format || DEFAULT_FORMAT, { skipStorage: true });
            }
        });
    }
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const name = await showPrompt('Save template', 'Template name:', '');
            if (!name) return;
            try {
                const tpl = templatesApi.saveTemplate({
                    name,
                    payload: editor ? editor.getValue() : '',
                    format: producerFormat,
                });
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
                    format: producerFormat,
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
            await stopConsumingAndResetUI();
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
    if (!produceButton) return;
    produceButton.disabled = producerTopic === '' || !validPayload;
}

const onEnvChange = (envId) => {
    showLoading();

    activeEnv = envId;
    activeTopicList = (envConfig[activeEnv].topicList || []).slice();
    producerTopic = '';
    consumerTopic = '';
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
    lagTopic = '';
    populateLagTopicSelect();
    clearLagOverviewUI();

    topicsCache = [];
    kafkaClientCache = { env: null, client: null };

    reloadProduceButton();
    updateSummaryCards();
    applyReadOnlyState();

    hideLoading();
};

const onTopicChange = (topic, methodId) => {
    showLoading();
    const m = methodId || activeMethod;
    if (m === 'consumer') {
        consumerTopic = topic;
        consumerGroup = consumerTopic ? getGroupForTopic(activeEnv, consumerTopic) : DEFAULT_GROUP;
        const groupInput = document.getElementById('consumerGroupInput');
        if (groupInput) groupInput.value = consumerGroup;

        const stopConsumeButton = document.getElementById('consumeButton');
        if (!consumeStarted) {
            stopConsumeButton.disabled = consumerTopic === '';
        }
        if (consumerTopic) {
            refreshPartitions(consumerTopic);
        } else {
            refreshPartitions('');
        }
    } else if (m === 'producer') {
        producerTopic = topic;
    }
    reloadProduceButton();
    updateSummaryCards();
    applyReadOnlyState();
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

    if (tab.id === 'consumerLag') {
        populateLagTopicSelect();
    }

    if (tab.id === 'clusterInfo') {
        loadClusterOverview();
    }

    applyActiveMethodLayout();

    const topicSelect = document.getElementById('topicSelect');
    if (topicSelect && tab.id !== 'topicsBrowser' && tab.id !== 'consumerLag' && tab.id !== 'clusterInfo') {
        topicSelect.value = tab.id === 'consumer' ? consumerTopic : producerTopic;
    }

    if (tab.id === 'consumer') {
        consumerGroup = consumerTopic ? getGroupForTopic(activeEnv, consumerTopic) : DEFAULT_GROUP;
        const groupInput = document.getElementById('consumerGroupInput');
        if (groupInput) groupInput.value = consumerGroup;
        if (consumerTopic) {
            refreshPartitions(consumerTopic);
        } else {
            refreshPartitions('');
        }
        const stopConsumeButton = document.getElementById('consumeButton');
        if (!consumeStarted && stopConsumeButton) {
            stopConsumeButton.disabled = consumerTopic === '';
        }
    } else if (tab.id === 'producer') {
        reloadProduceButton();
    }

    updateSummaryCards();
};

const buildMethodTab = (methodTabContainer, m) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = m.id;
    tab.classList.add('tab');
    tab.title = m.label;
    if (m.icon) {
        const icon = document.createElement('span');
        icon.classList.add('tab-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = m.icon;
        tab.appendChild(icon);
    }
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

    topicSelect.value = activeMethod === 'consumer' ? consumerTopic : producerTopic;
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

const OPTIONS_WIDTH_STORAGE_KEY = 'kss-options-width';
const OPTIONS_WIDTH_MIN = 260;
const OPTIONS_WIDTH_MAX = 560;
const OPTIONS_WIDTH_DEFAULT = 340;

function clampOptionsWidth(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return OPTIONS_WIDTH_DEFAULT;
    return Math.min(OPTIONS_WIDTH_MAX, Math.max(OPTIONS_WIDTH_MIN, Math.round(num)));
}

function applyOptionsWidth(width) {
    const clamped = clampOptionsWidth(width);
    const optionsPanel = document.getElementById('topics');
    if (optionsPanel) {
        optionsPanel.style.setProperty('--options-width', `${clamped}px`);
    }
    return clamped;
}

function initializeOptionsResizer() {
    const optionsPanel = document.getElementById('topics');
    const resizer = document.getElementById('optionsResizer');
    if (!optionsPanel || !resizer) return;

    let stored = null;
    try {
        stored = window.localStorage.getItem(OPTIONS_WIDTH_STORAGE_KEY);
    } catch (_) { /* ignore */ }
    applyOptionsWidth(stored != null ? stored : OPTIONS_WIDTH_DEFAULT);

    let dragStartX = 0;
    let dragStartWidth = 0;
    let dragging = false;

    function onMouseMove(event) {
        if (!dragging) return;
        const delta = event.clientX - dragStartX;
        applyOptionsWidth(dragStartWidth + delta);
    }

    function onMouseUp() {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('is-dragging');
        document.body.classList.remove('options-resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        const finalWidth = clampOptionsWidth(optionsPanel.getBoundingClientRect().width);
        try {
            window.localStorage.setItem(OPTIONS_WIDTH_STORAGE_KEY, String(finalWidth));
        } catch (_) { /* ignore */ }
    }

    resizer.addEventListener('mousedown', (event) => {
        event.preventDefault();
        dragging = true;
        dragStartX = event.clientX;
        dragStartWidth = optionsPanel.getBoundingClientRect().width;
        resizer.classList.add('is-dragging');
        document.body.classList.add('options-resizing');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    resizer.addEventListener('dblclick', () => {
        applyOptionsWidth(OPTIONS_WIDTH_DEFAULT);
        try {
            window.localStorage.setItem(OPTIONS_WIDTH_STORAGE_KEY, String(OPTIONS_WIDTH_DEFAULT));
        } catch (_) { /* ignore */ }
    });
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'kss-sidebar-collapsed';

function applySidebarCollapsedState(collapsed) {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebarCollapseToggle');
    if (!sidebar || !toggle) return;
    sidebar.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    toggle.setAttribute('title', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
}

function initializeSidebarCollapse() {
    const toggle = document.getElementById('sidebarCollapseToggle');
    if (!toggle) return;

    let stored = null;
    try {
        stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    } catch (_) { /* ignore */ }
    applySidebarCollapsedState(stored === '1');

    toggle.addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        const next = !sidebar.classList.contains('collapsed');
        applySidebarCollapsedState(next);
        try {
            window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? '1' : '0');
        } catch (_) { /* ignore */ }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#custom-alert .custom-alert-close').addEventListener('click', closeAlert);
    initializeOptionsResizer();
    initializeSidebarCollapse();
});
