const { app, BrowserWindow, ipcMain } = require('electron');


let envConfig = {
    "dev": {
        "id": "dev",
        "label": "DEV",
        "brokers": "ip-te-kfkbd01.aws.wiley.com:9092,ip-te-kfkbd02.aws.wiley.com:9092,ip-te-kfkbd03.aws.wiley.com:9092",
        "topicList": [
            "dev-abc",
            "dev-xyz"
        ]
    },
    "qa": {
        "id": "qa",
        "label": "QA",
        "brokers": "ip-te-kfkbq01.aws.wiley.com:9092,ip-te-kfkbq02.aws.wiley.com:9092,ip-te-kfkbq03.aws.wiley.com:9092",
        "topicList": [
            "qa-abc",
            "qa-xyz"
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
    console.log('DOM loaded');
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

    hideLoading();
});




const onEnvBtnClick = (btn) => {
    showLoading();
    document.querySelectorAll('#sidebar button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    activeEnv = btn.id;
    activeTopicList = envConfig[activeEnv].topicList;
    activeTopic = '';
    activeMethod = 'producer';

    const topicContainer = document.querySelector('#main #content #topics');
    while (topicContainer.firstChild) {
        topicContainer.removeChild(topicContainer.firstChild);
    }
    topicContainer.appendChild(document.createElement('h3')).textContent = 'TOPICS';

    activeTopicList.forEach(topic => {
        buildTopicButton(topicContainer, topic);
    });
    hideLoading();
}


const onTopicBtnClick = (btn) => {
    showLoading();
    document.querySelectorAll('#main #content #topics button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
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
    // document.getElementById('loading-container').style.display = 'flex';
}

const hideLoading = () => {
    document.getElementById('loading-container').style.display = 'none';
}
