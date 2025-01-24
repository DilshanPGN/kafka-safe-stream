const envConfig = {
    'dev': {
        id: 'dev',
        label: 'DEV',
        topicList: [
            "dev-abc",
            "dev-xyz",
        ]
    },
    'qa': {
        id: 'qa',
        label: 'QA',
        topicList: [
            "qa-abc",
            "qa-xyz",
        ]
    },
    'perf': {
        id: 'perf',
        label: 'PERF',
        topicList: [
            "perf-abc",
            "perf-xyz",
        ]
    },
    'ppf': {
        id: 'ppf',
        label: 'PPD',
        topicList: [
            "ppd-abc",
            "ppd-xyz",
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
    document.getElementById('loading-container').style.display = 'flex';
}

const hideLoading = () => {
    document.getElementById('loading-container').style.display = 'none';
}
