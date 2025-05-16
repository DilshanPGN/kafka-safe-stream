const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const isMac = process.platform === 'darwin';
const isDev = false;

let mainWindow;
let aboutWindow;
let setupWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        icon: path.join(__dirname, 'kss_logo.png'),
    });

    mainWindow.loadFile('index.html');

    const menu = Menu.buildFromTemplate(isMac ? macMenu : winMenu);
    Menu.setApplicationMenu(menu);

    if (isDev) {
        mainWindow.webContents.openDevTools(); // Open DevTools to see renderer process logs
    }
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

// About Window
function createAboutWindow() {

    if (aboutWindow) {
        aboutWindow.focus();
        return;
    }

    aboutWindow = new BrowserWindow({
        width: 600,
        height: 400,
        title: 'About Kafka Safe Stream',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: true,
        },
        resizable: false,
        icon: path.join(__dirname, 'kss_logo.png'),
    });

    aboutWindow.loadFile(path.join(__dirname, './about.html'));

    aboutWindow.on('closed', () => {
        aboutWindow = null;
    });

    // Open links in default web browser
    aboutWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// About Window
function createSetupWindow() {

    if (setupWindow) {
        setupWindow.focus();
        return;
    }

    setupWindow = new BrowserWindow({
        width: 600,
        height: 400,
        title: 'Setup Configurations',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        icon: path.join(__dirname, 'kss_logo.png'),
    });

    setupWindow.loadFile(path.join(__dirname, './setup.html'));

    setupWindow.on('closed', () => {
        setupWindow = null;
        // Notify the renderer process that the About window is closed
        mainWindow.webContents.send('setup-window-closed');
    });
}

ipcMain.on('close-setup-window', () => {
    setupWindow.close();
});

ipcMain.on('open-setup-window', () => {
    createSetupWindow();
});

// Menu template
// Menu template for macOS
const macMenu = [
    {
        label: app.name,
        submenu: [
            {
                label: 'About',
                click: createAboutWindow,
            },
        ],
    },
    {
        label: 'File',
        submenu: [
            {
                label: 'Setup',
                click: createSetupWindow,
            },
            {
                label: 'Quit',
                click: () => app.quit(),
                accelerator: 'Cmd+Q',
            },
        ],
    },
    {
        role: 'fileMenu',
    },
    {
        label: 'Help',
        submenu: [
            {
                label: 'About',
                click: createAboutWindow,
            },
        ],
    },
    ...(isDev
        ? [
            {
                label: 'Developer',
                submenu: [
                    { role: 'reload' },
                    { role: 'forcereload' },
                    { type: 'separator' },
                    { role: 'toggledevtools' },
                ],
            },
        ]
        : []),
];

// Menu template for Windows/Linux
const winMenu = [
    {
        label: 'File',
        submenu: [
            {
                label: 'Setup',
                click: createSetupWindow,
            },
            {
                label: 'Quit',
                click: () => app.quit(),
                accelerator: 'Ctrl+Q',
            },
        ],
    },
    {
        label: 'Help',
        submenu: [
            {
                label: 'About',
                click: createAboutWindow,
            },
        ],
    },
    ...(isDev
        ? [
            {
                label: 'Developer',
                submenu: [
                    { role: 'reload' },
                    { role: 'forcereload' },
                    { type: 'separator' },
                    { role: 'toggledevtools' },
                ],
            },
        ]
        : []),
];