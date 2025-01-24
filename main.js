// const { app, BrowserWindow, ipcMain } = require('electron');
// const path = require('path');
// const fs = require('fs');
//
// const isDev = process.env.NODE_ENV !== 'production';
//
// function createWindow() {
//     const win = new BrowserWindow({
//         width: isDev ? 800 : 400,
//         height: 600,
//         title: 'Electron App',
//         webPreferences: {
//             nodeIntegration: true,
//             contextIsolation: false
//         }
//     });
//
//     //open dev tools if in development mode
//     if (isDev) {
//         win.webContents.openDevTools();
//     }
//
//     win.loadFile('index.html');
// }
//
// app.whenReady().then(createWindow);
//
// ipcMain.on('load-config', (event) => {
//     const configPath = path.join(__dirname, '.config');
//     fs.readFile(configPath, 'utf8', (err, data) => {
//         if (err) {
//             console.error('Error reading the config file:', err);
//             return;
//         }
//         event.sender.send('config-data', data);
//     });
// });
//
// app.on('window-all-closed', () => {
//     if (process.platform !== 'darwin') {
//         app.quit();
//     }
// });
//
// app.on('activate', () => {
//     if (BrowserWindow.getAllWindows().length === 0) {
//         createWindow();
//     }
// });


const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { createKafkaClient, produceMessage, consumeMessages } = require('./backend/kafka');
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
// open dev tools if in development mode
    if (isDev) {
        mainWindow.webContents.openDevTools();
    }
    mainWindow.loadFile('index.html');
}

app.on('ready', createWindow);

ipcMain.on('produce-payload', async (event, payload) => {
    const kafka = await createKafkaClient();
    await produceMessage(kafka, 'alm-kafka-demo-topic', payload);
});

ipcMain.on('start-consuming', async (event) => {
    const kafka = await createKafkaClient();
    await consumeMessages(kafka, 'alm-kafka-demo-topic', 'test-group', (message) => {
        mainWindow.webContents.send('consumed-message', message);
    });
});