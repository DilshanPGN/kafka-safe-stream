const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const isDev = process.env.NODE_ENV !== 'production';

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: isDev ? 800 : 400,
        height: 600,
        webPreferences: {
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
