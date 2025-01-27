const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { dialog } = require('electron');

let configJson = null;

function createWindow() {
    const win = new BrowserWindow({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            icon: path.join(__dirname, 'kss_logo.png')
        }
    });

    win.loadFile('index.html');
    win.webContents.openDevTools(); // Open DevTools to see renderer process logs

    console.log('Main process: Window created');
}

app.whenReady().then(createWindow);


app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});