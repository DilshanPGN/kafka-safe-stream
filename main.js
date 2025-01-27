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
}

app.whenReady().then(createWindow);

ipcMain.on('load-config', (event) => {
    const configPath = path.join(__dirname, '.config');
    fs.readFile(configPath, 'utf8', (err, config) => {
        if (err) {
            console.error('Error reading the config file:', err);
            dialog.showErrorBox('File Read Error', 'Error reading the config file. Please check the file and try again.');
            app.quit();
            return;
        }
        try {
            configJson = JSON.parse(config);
            event.sender.send('config-data', configJson);
        } catch (parseErr) {
            console.error('Invalid JSON format:', parseErr);
            dialog.showErrorBox('JSON Parse Error', 'Invalid JSON format in the config file. Please correct the file and try again.');
            app.quit();
            return;
        }
    });
});

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