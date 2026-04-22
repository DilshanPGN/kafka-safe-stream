const { ipcRenderer } = require('electron');
const { createKafkaClient, produceMessage, stopConsuming, consumeMessages } = require("./backend/kafka");
const path = require('path');
const fs = require('fs');
const os = require('os');
const Ajv = require('ajv');

const method = {
    'producer': {
        id: 'producer',
        label: 'Producer',
        containerId: 'producerContainer'
    },
    'consumer': {
        id: 'consumer',
        label: 'Consumer',
        containerId: 'consumerContainer'
    }
}

// Load the schema from file
const schemaPath = path.join(__dirname, 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv();
const kafkaSafeStreamGroup = 'kafka-safe-stream-group';
const LINE_SEPARATOR = '\n\n◀▶\n\n';
const THEME_STORAGE_KEY = 'kss-theme';

let activeEnv = null;
let activeMethod = 'producer';
let activeTopicList = null;
let activeTopic = '';
let consumeStarted = false;
let envConfig = null;
let validPayload = false;
let editor = null;
let consumer = null;
window.refreshIntervalId = null;
let consumerBlinkOn = false;

function applyTheme(theme) {
    const targetTheme = theme === 'light' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', targetTheme);
    const toggle = document.getElementById('themeToggle');
    const themeModeLabel = document.getElementById('themeModeLabel');
    if (toggle) {
        toggle.checked = targetTheme === 'dark';
    }
    if (themeModeLabel) {
        themeModeLabel.innerHTML = targetTheme === 'dark'
            ? '<span class="theme-icon moon">🌙</span>Dark'
            : '<span class="theme-icon sun">☀</span>Light';
    }
    try {
        localStorage.setItem(THEME_STORAGE_KEY, targetTheme);
    } catch (error) {
        console.warn('Failed to persist theme selection', error);
    }
}

function initializeThemeToggle() {
    let savedTheme = 'dark';
    try {
        savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
    } catch (error) {
        console.warn('Failed to read persisted theme selection', error);
    }
    applyTheme(savedTheme);

    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('change', () => {
            applyTheme(themeToggle.checked ? 'dark' : 'light');
        });
    }
}

function renderConsumerTabBlink(show) {
    const statusNode = document.querySelector('#consumer .tab-status');
    if (!statusNode) {
        return;
    }
    statusNode.textContent = show ? '●' : '';
}

function updateSummaryCards() {
    const brokerCount = document.getElementById('brokerCount');
    const topicCount = document.getElementById('topicCount');
    const activeEnvName = document.getElementById('activeEnvName');
    const activeTopicName = document.getElementById('activeTopicName');

    if (envConfig && activeEnv && envConfig[activeEnv]) {
        const env = envConfig[activeEnv];
        const brokers = Array.isArray(env.brokers) ? env.brokers : [];
        const topics = Array.isArray(env.topicList) ? env.topicList : [];
        brokerCount.textContent = String(brokers.length);
        topicCount.textContent = String(topics.length);
        activeEnvName.textContent = env.label || activeEnv;
    }

    activeTopicName.textContent = activeTopic || '-';
}

async function loadConfig() {
    const homeDir = os.homedir();
    const kssDir = path.join(homeDir, '.kss');
    const configPath = path.join(kssDir, '.config');

    // Check if .kss directory exists, if not create it
    if (!fs.existsSync(kssDir)) {
        fs.mkdirSync(kssDir);
    }

    // Check if .config file exists
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
            // open setup window
            ipcRenderer.send('open-setup-window');
            await new Promise(resolve => {
                ipcRenderer.once('setup-window-closed', resolve);
            });
            loadConfig();
        }
    } else {
        hideLoading();
        closeAlert();
        //open setup window
        ipcRenderer.send('open-setup-window');
        await new Promise(resolve => {
            ipcRenderer.once('setup-window-closed', resolve);
        });
        loadConfig();
    }
}

function initializeEditor() {
    let editorContainer = document.getElementById('payload');
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
    })
}

function initializeConsumer() {
    let consumerContainer = document.getElementById('consumedMessages');
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
    })
}

document.addEventListener('DOMContentLoaded', async () => {
    initializeThemeToggle();
    showLoading();
    loadConfig().then(() => {
        
        activeEnv = Object.keys(envConfig)[0];
        activeTopicList = envConfig[activeEnv].topicList;

        initializeEditor();
        initializeConsumer();
    
        const envSelect = document.getElementById('envSelect');
        const formatButton = document.getElementById('formatButton');
    
        Object.values(envConfig).forEach(env => {
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
        Object.values(method).forEach(method => {
            buildMethodTab(methodTabContainer, method);
        });
    
        Object.values(method).forEach(method => {
            document.getElementById(method.containerId).style.display = method.id === activeMethod ? 'flex' : 'none';
        });
    
        onEnvChange(activeEnv);
        updateSummaryCards();
    
        document.getElementById('produceButton').addEventListener('click', async () => {
            showLoading();
            try {
                const kafka = await createKafkaClient(envConfig[activeEnv].brokers);
                await produceMessage(kafka, activeTopic, editor.getValue());
            } catch (error) {
                showAlert("Kafka Producer Error", error.message);
            }
            hideLoading();
        });
    
        document.getElementById('clearMessages').addEventListener('click', () => {
            consumer.setValue('');
        });
    
        document.getElementById('consumeButton').addEventListener('click', async () => {
            showLoading();
    
            const consumerTab = document.getElementById('consumer');
            consumerTab.addEventListener('click', () => {
                consumer.refresh();
                // Scroll to the bottom of the editor
                const lastLine = consumer.getScrollInfo().height;
                consumer.scrollTo(0, lastLine);
            });
    
            if (!consumeStarted) {
                try {
                    const kafka = await createKafkaClient(envConfig[activeEnv].brokers);
                    await consumeMessages(kafka, activeTopic, kafkaSafeStreamGroup, (message) => {
                        const formattedMessage = JSON.stringify(JSON.parse(message), null, 2);
                        consumer.setValue(consumer.getValue() + formattedMessage + LINE_SEPARATOR);
                        // Scroll to the bottom of the editor
                        const lastLine = consumer.getScrollInfo().height;
                        consumer.scrollTo(0, lastLine);
                    }).finally(() => {
                        hideLoading();
                    });
                    let consumeBtn = document.getElementById('consumeButton');
                    consumeBtn.innerHTML = 'Stop Consuming';
                    consumeBtn.style.backgroundColor = '#dc3545';
                    consumeStarted = true;
                    consumerBlinkOn = false;
                    window.refreshIntervalId = setInterval(function () {
                        consumerBlinkOn = !consumerBlinkOn;
                        renderConsumerTabBlink(consumerBlinkOn);
                    }, 1000);
    
                } catch (error) {
                    showAlert("Kafka Consumer Error", error.message);
                }
            } else {
                await stopConsuming().finally(() => {
                    hideLoading();
                });
                clearInterval(window.refreshIntervalId);
                renderConsumerTabBlink(false);
                let consumeBtn = document.getElementById('consumeButton');
                consumeBtn.innerHTML = 'Start Consuming';
                consumeBtn.style.backgroundColor = '#007bff';
                consumeStarted = false;
            }
        });
    
        document.getElementById('payload').addEventListener('keyup', () => {
            try {
                JSON.parse(editor.getValue());
                validPayload = true;
                formatButton.disabled = false;
            } catch (e) {
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
                showAlert("JSON Format Error", "Error formatting JSON. Please check the JSON and try again.", error.message);
            }
            reloadProduceButton();
        });
    }).finally(() => {
        hideLoading();
    });
});

function reloadProduceButton() {
    const produceButton = document.getElementById('produceButton');
    produceButton.disabled = activeTopic === '' || !validPayload;
}

const onEnvChange = (envId) => {
    showLoading();

    activeEnv = envId;
    activeTopicList = envConfig[activeEnv].topicList;
    activeTopic = '';
    document.getElementById('envSelect').value = activeEnv;

    if (!consumeStarted) {
        const stopConsumeButton = document.getElementById('consumeButton');
        stopConsumeButton.disabled = true;
    }

    activeMethod = 'producer';
    onMethodTabClick(document.getElementById(activeMethod));
    populateTopicSelect();

    reloadProduceButton();
    updateSummaryCards();

    hideLoading();
}

const onTopicChange = (topic) => {
    showLoading();
    activeTopic = topic;
    const stopConsumeButton = document.getElementById('consumeButton');
    if (!consumeStarted) {
        stopConsumeButton.disabled = activeTopic === '';
    }
    reloadProduceButton();
    updateSummaryCards();
    hideLoading();
}

const onMethodTabClick = (tab) => {
    activeMethod = tab.id;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    tab.classList.add('active');

    Object.values(method).forEach(method => {
        document.getElementById(method.containerId).style.display = method.id === tab.id ? 'flex' : 'none';
    });
}

const buildMethodTab = (methodTabContainer, method) => {
    const tab = document.createElement('button');
    tab.id = method.id;
    tab.classList.add('tab');
    const label = document.createElement('span');
    label.classList.add('tab-label');
    label.textContent = method.label;
    tab.appendChild(label);
    if (method.id === 'consumer') {
        const status = document.createElement('span');
        status.classList.add('tab-status');
        tab.appendChild(status);
    }
    tab.onclick = () => onMethodTabClick(tab);
    if (method.id === activeMethod) {
        tab.classList.add('active');
    }
    methodTabContainer.appendChild(tab);
}

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
}

const showLoading = () => {
    document.getElementById('loading-container').style.display = 'flex';
}

const hideLoading = () => {
    document.getElementById('loading-container').style.display = 'none';
}

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
    document.querySelector('.custom-alert-close').addEventListener('click', closeAlert);
});
