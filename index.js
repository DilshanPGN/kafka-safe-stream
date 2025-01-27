const { ipcRenderer } = require('electron');

let configJson = null;

ipcRenderer.on('config-data', (event, data) => {
    configJson = data;
    createButtons();
});

window.onload = () => {
    ipcRenderer.send('load-config');
};

function createButtons() {
    const container = document.getElementById('button-container');
    container.innerHTML = ''; // Clear existing buttons

    for (const env in configJson) {
        const button = document.createElement('button');
        button.innerText = env;
        button.onclick = () => {
            document.getElementById('output').value = configJson[env].brokers;
        };
        container.appendChild(button);
    }
}