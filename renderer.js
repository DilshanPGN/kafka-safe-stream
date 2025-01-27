const { createKafkaClient, produceMessage, stopConsuming, consumeMessages } = require("./backend/kafka");

let envConfig = {
    "dev": {
        "id": "dev",
        "label": "DEV",
        "brokers": ["localhost:9092"],
        "topicList": [
            "test.topic",
            "alm-kafka-demo-topic"
        ]
    },
    "qa": {
        "id": "qa",
        "label": "QA",
        "brokers": ["localhost:9092"],
        "topicList": [
            "qa-abc",
            "alm-kafka-demo-topic"
        ]
    }
};


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

let activeEnv = 'dev';
let activeMethod = 'producer';
let activeTopicList = envConfig[activeEnv].topicList;
let activeTopic = '';
const kafkaSafeStreamGroup = 'kafka-safe-stream-group';
let consumeStarted = false;

// ipcMain.on('load-config', (event) => {
//     const configPath = path.join(__dirname, '.config');
//     fs.readFile(configPath, 'utf8', (err, config) => {
//         if (err) {
//             console.error('Error reading the config file:', err);
//             dialog.showErrorBox('File Read Error', 'Error reading the config file. Please check the file and try again.');
//             app.quit();
//             return;
//         }
//         try {
//             envConfig = JSON.parse(config);
//             // event.sender.send('config-data', configJson);
//         } catch (parseErr) {
//             console.error('Invalid JSON format:', parseErr);
//             dialog.showErrorBox('JSON Parse Error', 'Invalid JSON format in the config file. Please correct the file and try again.');
//             app.quit();
//             return;
//         }
//     });
// });


document.addEventListener('DOMContentLoaded', () => {
    showLoading();
    const buttonContainer = document.getElementById('sidebar');
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

    const consumedMessages = document.getElementById('consumedMessages');

    document.getElementById('produceButton').addEventListener('click', async () => {
        showLoading();
        const payload = document.getElementById('payload').value;
        try {
            const kafka = await createKafkaClient("my-app", envConfig[activeEnv].brokers);
            await produceMessage(kafka, activeTopic, payload);
        } catch (error) {
            showAlert("Kafka Producer Error" ,error.message);
        }
        hideLoading();
    });

    document.getElementById('clearMessages').addEventListener('click', () => {
        const consumedMessages = document.getElementById('consumedMessages');
        consumedMessages.value = '';
    });

    document.getElementById('consumeButton').addEventListener('click', async () => {
        showLoading();

        if (!consumeStarted) {
            try {
                const kafka = await createKafkaClient("my-app", envConfig[activeEnv].brokers);
                await consumeMessages(kafka, activeTopic, kafkaSafeStreamGroup, (message) => {
                    consumedMessages.value += message + '\n\n\n';
                }).then(() => {
                    hideLoading();
                });
                let consumeBtn = document.getElementById('consumeButton');
                consumeBtn.innerHTML = 'Stop Consuming';
                consumeBtn.style.backgroundColor = '#dc3545';
                consumeStarted = true;
            } catch (error) {
                showAlert("Kafka Consumer Error" ,error.message);
            }
        } else {
            await stopConsuming().then(() => {
                hideLoading();
            });
            let consumeBtn = document.getElementById('consumeButton');
            consumeBtn.innerHTML = 'Start Consuming';
            consumeBtn.style.backgroundColor = '#007bff';
            consumeStarted = false;
        }

    });

    hideLoading();
});

async function reloadConsumerProducerButtons() {
    const produceButton = document.getElementById('produceButton');
    produceButton.disabled = activeTopic === '';
    consumeStarted = false;
    await stopConsuming();
}

const onEnvBtnClick = (btn) => {
    showLoading();
    document.querySelectorAll('#sidebar button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    activeEnv = btn.id;
    activeTopicList = envConfig[activeEnv].topicList;
    activeTopic = '';
    const stopConsumeButton = document.getElementById('consumeButton');
    stopConsumeButton.disabled = true;
    activeMethod = 'producer';

    const topicContainer = document.querySelector('#main #content #topics');
    while (topicContainer.firstChild) {
        topicContainer.removeChild(topicContainer.firstChild);
    }
    topicContainer.appendChild(document.createElement('h3')).textContent = 'TOPICS';

    activeTopicList.forEach(topic => {
        buildTopicButton(topicContainer, topic);
    });

    reloadConsumerProducerButtons();

    hideLoading();
}

const onTopicBtnClick = (btn) => {
    showLoading();
    document.querySelectorAll('#main #content #topics button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTopic = btn.id;
    const stopConsumeButton = document.getElementById('consumeButton');
    stopConsumeButton.disabled = false;
    reloadConsumerProducerButtons();
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
    btn.textContent = topic;
    btn.id = topic;
    btn.onclick = () => onTopicBtnClick(btn);
    if (topic.id === activeTopic) {
        btn.classList.add('active');
    }
    topicContainer.appendChild(btn);
}

const showLoading = () => {
    console.log('show loading');
    document.getElementById('loading-container').style.display = 'flex';
}

const hideLoading = () => {
    console.log('stop loading');
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
