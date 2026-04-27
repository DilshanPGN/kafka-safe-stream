const { app, BrowserWindow, Menu, shell, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const isMac = process.platform === 'darwin';
const isDev = false;

let mainWindow;
let aboutWindow;
let setupWindow;
/** Last theme from main app when opening setup (File menu uses this if renderer did not pass). */
let lastSetupTheme = 'dark';

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        icon: path.join(__dirname, '../../kss_logo.png'),
    });

    mainWindow.loadFile(path.join(__dirname, '../../index.html'));

    const menu = Menu.buildFromTemplate(isMac ? macMenu : winMenu);
    Menu.setApplicationMenu(menu);
    mainWindow.removeMenu();

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
        icon: path.join(__dirname, '../../kss_logo.png'),
    });

    aboutWindow.loadFile(path.join(__dirname, '../../about.html'));

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
function createSetupWindow(explicitTheme) {
    if (setupWindow) {
        setupWindow.focus();
        return;
    }

    const theme = explicitTheme === 'light' || explicitTheme === 'dark' ? explicitTheme : lastSetupTheme;

    setupWindow = new BrowserWindow({
        width: 960,
        height: 720,
        minWidth: 720,
        minHeight: 520,
        title: 'Setup — Kafka Safe Stream',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            additionalArguments: [`--kss-theme=${theme}`],
        },
        icon: path.join(__dirname, '../../kss_logo.png'),
    });

    setupWindow.loadFile(path.join(__dirname, '../../setup.html'));

    setupWindow.on('closed', () => {
        setupWindow = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('setup-window-closed');
        }
    });
}

ipcMain.on('close-setup-window', () => {
    if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.close();
    }
});

ipcMain.on('open-setup-window', (_event, theme) => {
    if (theme === 'light' || theme === 'dark') {
        lastSetupTheme = theme;
    }
    createSetupWindow(theme === 'light' || theme === 'dark' ? theme : undefined);
});

ipcMain.on('config-saved', () => {
    try {
        const configPath = path.join(os.homedir(), '.kss', '.config');
        if (!fs.existsSync(configPath)) {
            return;
        }
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('config-updated', parsed);
        }
    } catch (err) {
        console.error('Failed to forward config-updated:', err);
    }
});

function credentialsStorePath() {
    return path.join(os.homedir(), '.kss', 'credentials.store.json');
}

function loadCredentialsStore() {
    const p = credentialsStorePath();
    try {
        if (!fs.existsSync(p)) return {};
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        console.error('kss-credentials: load failed', err);
        return {};
    }
}

function saveCredentialsStore(store) {
    const dir = path.join(os.homedir(), '.kss');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(credentialsStorePath(), JSON.stringify(store, null, 2), 'utf8');
}

ipcMain.handle('kss-credentials:get', (_event, { envId }) => {
    if (!envId || typeof envId !== 'string') return null;
    const store = loadCredentialsStore();
    const entry = store[envId];
    if (!entry) return null;
    try {
        if (entry.encrypted === true && entry.payload && safeStorage.isEncryptionAvailable()) {
            const decrypted = safeStorage.decryptString(Buffer.from(entry.payload, 'base64'));
            return JSON.parse(decrypted);
        }
        if (entry.payload && typeof entry.payload === 'object') {
            return entry.payload;
        }
    } catch (err) {
        console.error('kss-credentials:get decrypt failed', err);
        return null;
    }
    return null;
});

ipcMain.handle('kss-credentials:set', (_event, { envId, payload }) => {
    if (!envId || typeof envId !== 'string' || !payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid arguments' };
    }
    const store = loadCredentialsStore();
    const plain = JSON.stringify(payload);
    if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(plain);
        store[envId] = {
            encrypted: true,
            payload: Buffer.from(encrypted).toString('base64'),
        };
    } else {
        store[envId] = { encrypted: false, payload };
    }
    saveCredentialsStore(store);
    return { ok: true, usedEncryption: safeStorage.isEncryptionAvailable() };
});

ipcMain.handle('kss-credentials:clear', (_event, { envId }) => {
    if (!envId || typeof envId !== 'string') return { ok: false };
    const store = loadCredentialsStore();
    delete store[envId];
    saveCredentialsStore(store);
    return { ok: true };
});

ipcMain.handle('kss-credentials:encryption-available', () => ({
    available: safeStorage.isEncryptionAvailable(),
}));

ipcMain.handle('kss-select-file', async (_event, options) => {
    const win = BrowserWindow.getFocusedWindow() || setupWindow || mainWindow;
    if (!win) {
        return { canceled: true, filePath: undefined };
    }
    const dialogOpts = {
        title: (options && options.title) || 'Select file',
        properties: ['openFile'],
        filters: (options && Array.isArray(options.filters) && options.filters.length > 0)
            ? options.filters
            : [{ name: 'All files', extensions: ['*'] }],
    };
    const result = await dialog.showOpenDialog(win, dialogOpts);
    return {
        canceled: !!result.canceled,
        filePath: result.canceled ? undefined : (result.filePaths && result.filePaths[0]),
    };
});

ipcMain.handle('save-consumed-export', async (_event, { defaultPath, filters }) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win) {
        return { canceled: true, filePath: undefined };
    }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: defaultPath || 'consumed-messages.json',
        filters: filters && filters.length ? filters : [
            { name: 'JSON', extensions: ['json'] },
            { name: 'JSON Lines', extensions: ['jsonl', 'ndjson'] },
            { name: 'CSV', extensions: ['csv'] },
        ],
    });
    return { canceled, filePath };
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
                click: () => createSetupWindow(),
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
                click: () => createSetupWindow(),
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