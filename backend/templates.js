const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KSS_DIR = path.join(os.homedir(), '.kss');
const TEMPLATES_FILE = path.join(KSS_DIR, 'templates.json');

function ensureFile() {
    if (!fs.existsSync(KSS_DIR)) {
        fs.mkdirSync(KSS_DIR, { recursive: true });
    }
    if (!fs.existsSync(TEMPLATES_FILE)) {
        fs.writeFileSync(TEMPLATES_FILE, '[]', 'utf8');
    }
}

function readAll() {
    ensureFile();
    try {
        const raw = fs.readFileSync(TEMPLATES_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        if (typeof console !== 'undefined' && console.debug) {
            console.debug('[kss] templates read failed', err);
        }
        return [];
    }
}

function writeAll(list) {
    ensureFile();
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function listTemplates() {
    return readAll().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function getTemplate(id) {
    return readAll().find((t) => t.id === id) || null;
}

function saveTemplate({ name, payload, format }) {
    if (!name || !name.trim()) {
        throw new Error('Template name is required');
    }
    const list = readAll();
    const now = new Date().toISOString();
    const tpl = {
        id: crypto.randomUUID(),
        name: name.trim(),
        payload: payload || '',
        format: format && String(format).trim() ? String(format).trim() : 'json',
        createdAt: now,
        updatedAt: now,
    };
    list.push(tpl);
    writeAll(list);
    return tpl;
}

function updateTemplate(id, updates) {
    const list = readAll();
    const idx = list.findIndex((t) => t.id === id);
    if (idx === -1) {
        throw new Error('Template not found');
    }
    const updated = {
        ...list[idx],
        ...updates,
        id: list[idx].id,
        updatedAt: new Date().toISOString(),
    };
    list[idx] = updated;
    writeAll(list);
    return updated;
}

function deleteTemplate(id) {
    const list = readAll();
    const filtered = list.filter((t) => t.id !== id);
    if (filtered.length === list.length) {
        return false;
    }
    writeAll(filtered);
    return true;
}

module.exports = {
    listTemplates,
    getTemplate,
    saveTemplate,
    updateTemplate,
    deleteTemplate,
    TEMPLATES_FILE,
};
