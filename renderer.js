const { app } = require('electron');
const { createKafkaClient, produceMessage, stopConsuming, consumeMessages } = require("./backend/kafka");
const path = require('path');
const fs = require('fs');

const method = {
    'producer': {
        id: 'producer',
        label: 'Producer',
        containerId: 'producerContainer'
    },
    'consumer': {
        id: 'consumer',
        label: '⚫ Consumer',
        containerId: 'consumerContainer'
    }
}
const kafkaSafeStreamGroup = 'kafka-safe-stream-group';
const LINE_SEPARATOR = '\n\n◀▶\n\n';

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

function loadConfig() {
    const configPath = path.join(__dirname, '.config');
    try {
        const config = fs.readFileSync(configPath, 'utf8');
        envConfig = JSON.parse(config);
        activeEnv = Object.keys(envConfig)[0];
        activeTopicList = envConfig[activeEnv].topicList;
        return envConfig;
    } catch (err) {
        console.error('Error reading or parsing the config file:', err);
        showAlert("File Read/Parse Error', 'Error reading or parsing the config file. Please check the file and try again.", error.message);
        app.quit();
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
        theme: 'dracula',
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
        theme: 'dracula',
        placeholder: 'Consumed messages will display here...',
    })
}

document.addEventListener('DOMContentLoaded', async () => {
    showLoading();
    loadConfig();
    initializeEditor();
    initializeConsumer();

    const buttonContainer = document.getElementById('sidebar');
    const formatButton = document.getElementById('formatButton');

    Object.values(envConfig).forEach(env => {
        buildEnvButton(buttonContainer, env);
    });

    const methodTabContainer = document.querySelector('#main #tabs');
    Object.values(method).forEach(method => {
        buildMethodTab(methodTabContainer, method);
    });

    Object.values(method).forEach(method => {
        document.getElementById(method.containerId).style.display = method.id === activeMethod ? 'flex' : 'none';
    });

    onEnvBtnClick(document.getElementById(activeEnv));

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
                    consumer.setValue(consumer.getValue() + message + LINE_SEPARATOR);
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
                let consumingTopic = '[' + activeEnv.toUpperCase() + ' ← ' + activeTopic + ']';
                window.refreshIntervalId = setInterval(function () {
                    consumerTab.innerHTML = consumerTab.innerHTML === '⚫ Consumer ' + consumingTopic ? '🔴 Consumer ' + consumingTopic : '⚫ Consumer ' + consumingTopic;
                }, 1000);

            } catch (error) {
                showAlert("Kafka Consumer Error", error.message);
            }
        } else {
            await stopConsuming().finally(() => {
                hideLoading();
            });
            clearInterval(window.refreshIntervalId);
            consumerTab.innerHTML = '⚫ Consumer';
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
        } catch (e) {
            showAlert("JSON Format Error", "Error formatting JSON. Please check the JSON and try again.", e.message);
        }
        reloadProduceButton();
    });

    hideLoading();
});

function reloadProduceButton() {
    const produceButton = document.getElementById('produceButton');
    produceButton.disabled = activeTopic === '' || !validPayload;
}

const onEnvBtnClick = (btn) => {
    showLoading();
    document.querySelectorAll('#sidebar button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    activeEnv = btn.id;
    activeTopicList = envConfig[activeEnv].topicList;
    activeTopic = '';

    if (!consumeStarted) {
        const stopConsumeButton = document.getElementById('consumeButton');
        stopConsumeButton.disabled = true;
    }

    activeMethod = 'producer';

    const topicContainer = document.querySelector('#main #content #topics');
    while (topicContainer.firstChild) {
        topicContainer.removeChild(topicContainer.firstChild);
    }
    topicContainer.appendChild(document.createElement('h3')).textContent = 'TOPICS';

    activeTopicList.forEach((topic, index) => {
        setTimeout(() => {
            buildTopicButton(topicContainer, topic);
        }, index * 100);
    });

    reloadProduceButton();

    hideLoading();
}

const onTopicBtnClick = (btn) => {
    showLoading();
    document.querySelectorAll('#main #content #topics button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTopic = btn.id;
    const stopConsumeButton = document.getElementById('consumeButton');
    stopConsumeButton.disabled = false;
    reloadProduceButton();
    hideLoading();
}

const onMethodTabClick = (tab) => {
    activeMethod = tab.id;
    document.querySelectorAll('#main #tabs button').forEach(b => b.classList.remove('active'));
    tab.classList.add('active');

    Object.values(method).forEach(method => {
        document.getElementById(method.containerId).style.display = method.id === tab.id ? 'flex' : 'none';
    });
}

const buildEnvButton = (buttonContainer, env) => {
    const btn = document.createElement('button');
    btn.textContent = env.label;
    btn.id = env.id;
    btn.onclick = () => onEnvBtnClick(btn);
    if (env.id === activeEnv) {
        btn.classList.add('active');
    }
    buttonContainer.appendChild(btn);
}

const buildMethodTab = (methodTabContainer, method) => {
    const tab = document.createElement('button');
    tab.textContent = method.label;
    tab.id = method.id;
    tab.classList.add('tab');
    tab.onclick = () => onMethodTabClick(tab);
    if (method.id === activeMethod) {
        tab.classList.add('active');
    }
    methodTabContainer.appendChild(tab);
}

const buildTopicButton = (topicContainer, topic) => {
    const btn = document.createElement('button');
    btn.classList.add('list-item');
    btn.textContent = topic;
    btn.id = topic;
    btn.onclick = () => onTopicBtnClick(btn);
    if (topic.id === activeTopic) {
        btn.classList.add('active');
    }
    topicContainer.appendChild(btn);
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
