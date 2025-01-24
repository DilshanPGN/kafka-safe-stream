const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { createKafkaClient, produceMessage, consumeMessages, stopConsuming } = require('./backend/kafka');
const isDev = process.env.NODE_ENV !== 'production';

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: isDev ? 800 : 400,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: true,
            contextIsolation: false,
        },
    });
    if (isDev) {
        mainWindow.webContents.openDevTools();
    }
    mainWindow.loadFile('index.html');
}

app.on('ready', createWindow);

ipcMain.on('produce-payload', async (event, payload) => {
    try {
        const kafka = await createKafkaClient();
        await produceMessage(kafka, 'alm-kafka-demo-topic', payload);
    } catch (error) {
        event.sender.send('produce-error', error.message);
    }
});

ipcMain.on('start-consuming', async (event) => {
    try {
        const kafka = await createKafkaClient();
        await consumeMessages(kafka, 'alm-kafka-demo-topic', 'test-group', (message) => {
            mainWindow.webContents.send('consumed-message', message);
        });
    } catch (error) {
        event.sender.send('consume-error', error.message);
    }
});

ipcMain.on('stop-consuming', async (event) => {
    await stopConsuming();
});