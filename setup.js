const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Ajv = require('ajv');

// Load the schema from file
const schemaPath = path.join(__dirname, 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv();
const saveConfigButton = document.getElementById('saveConfig');
const configTextArea = document.getElementById('configText');

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
            const configPathText = document.getElementById('configPathText');
            configPathText.innerHTML = 'Config location: ' + configPath;

            const config = fs.readFileSync(configPath, 'utf8');
            let envConfig = JSON.parse(config);
            configTextArea.value = JSON.stringify(envConfig, null, 4);
            const valid = ajv.validate(schema, envConfig);
            if (!valid) {
                throw new Error('Invalid configuration format');
            }
            return envConfig;
        } catch (error) {
            console.error('Error reading or parsing the config file:', error);
            showAlert('Configuration error', 'Error reading or parsing the config file. Please check the file and try again.', error.message);
        }
    } else {
        showAlert('Error', 'Config file not found');
    }
}

document.addEventListener('DOMContentLoaded', async () => {

    configTextArea.addEventListener('keyup', () => {
        try {
            const config = configTextArea.value;
            JSON.parse(config);
            saveConfigButton.disabled = false;
        } catch(error) {
            saveConfigButton.disabled = true;
        }
    });

    saveConfigButton.addEventListener('click', async () => {
        try {
            const config = JSON.parse(configTextArea.value);
            const valid = ajv.validate(schema, config);
            if (!valid) {
                showAlert('Invalid configuration', 'Configuration does not match the required schema.');
                return;
            }
            const homeDir = os.homedir();
            const kssDir = path.join(homeDir, '.kss');
            const configPath = path.join(kssDir, '.config');
            if (!fs.existsSync(kssDir)) {
                fs.mkdirSync(kssDir, { recursive: true });
            }
            fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
            ipcRenderer.send('config-saved');
            ipcRenderer.send('close-setup-window');
        } catch(error) {
            console.error('Error reading or parsing the config file:', error);
            showAlert('Save failed', error.message || 'Unable to save configuration.');
        }
    });

    document.querySelector('.custom-alert-close').addEventListener('click', closeAlert);

    // Load the config file
    await loadConfig();
});

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
