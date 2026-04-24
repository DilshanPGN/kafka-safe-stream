const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Ajv = require('ajv');
const { probeClusterConnection, brokerListFromInput } = require('./backend/kafka');
const { normalizeConnection } = require('./backend/kafkaConnection');

const THEME_STORAGE_KEY = 'kss-theme';
const ENV_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function logDebug(context, err) {
    if (typeof console !== 'undefined' && console.debug) {
        console.debug(`[kss-setup] ${context}`, err);
    }
}

const schemaPath = path.join(__dirname, 'schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv();

/** @type {{ id: string, label: string, brokersText: string, topicList: string[], topicFilter: string, probeResult: object|null }[]} */
let environments = [];
let activeIndex = 0;
let probeInFlight = false;

function resolveInitialTheme() {
    const arg = process.argv.find((a) => String(a).startsWith('--kss-theme='));
    const fromArg = arg ? String(arg).split('=')[1] : '';
    if (fromArg === 'light' || fromArg === 'dark') {
        return fromArg;
    }
    try {
        const ls = window.localStorage.getItem(THEME_STORAGE_KEY);
        if (ls === 'light' || ls === 'dark') return ls;
    } catch (err) {
        logDebug('localStorage theme read', err);
    }
    return 'dark';
}

function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', t);
    try {
        window.localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch (err) {
        logDebug('localStorage theme write', err);
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function newEnv() {
    return {
        id: '',
        label: '',
        brokersText: '',
        topicList: [],
        topicFilter: '',
        probeResult: null,
        connection: normalizeConnection({}),
        probeSecrets: {
            password: '',
            oauthAccessToken: '',
            awsSecretAccessKey: '',
            awsSessionToken: '',
            sslKeyPassphrase: '',
        },
    };
}

function getActive() {
    return environments[activeIndex] || null;
}

function getConfigPath() {
    return path.join(os.homedir(), '.kss', '.config');
}

function showAlert(topic, message) {
    const alertBox = document.getElementById('custom-alert');
    const alertTopic = document.getElementById('custom-alert-topic');
    const alertMessage = document.getElementById('custom-alert-message');
    alertTopic.textContent = topic;
    alertMessage.textContent = message;
    alertBox.style.display = 'block';
    alertBox.classList.add('is-open');
}

function closeAlert() {
    const el = document.getElementById('custom-alert');
    el.style.display = 'none';
    el.classList.remove('is-open');
}

function buildConfigObject() {
    const obj = {};
    for (const e of environments) {
        const id = e.id.trim();
        if (!id) continue;
        const entry = {
            id,
            label: (e.label.trim() || id),
            brokers: brokerListFromInput(e.brokersText),
            topicList: e.topicList.slice(),
        };
        const conn = normalizeConnection(e.connection);
        const defConn = normalizeConnection({});
        if (JSON.stringify(conn) !== JSON.stringify(defConn)) {
            entry.connection = conn;
        }
        obj[id] = entry;
    }
    return obj;
}

function syncJsonTextarea() {
    const ta = document.getElementById('configJsonText');
    if (!ta) return;
    try {
        ta.value = JSON.stringify(buildConfigObject(), null, 4);
    } catch (err) {
        logDebug('syncJsonTextarea', err);
        ta.value = '{}';
    }
}

function applyConfigFromObject(obj) {
    const valid = ajv.validate(schema, obj);
    if (!valid) {
        throw new Error(ajv.errorsText(ajv.errors, { separator: '\n' }));
    }
    const keys = Object.keys(obj);
    environments = keys.map((key) => {
        const e = obj[key];
        return {
            id: e.id,
            label: e.label,
            brokersText: (e.brokers || []).join('\n'),
            topicList: (e.topicList || []).slice(),
            topicFilter: '',
            probeResult: null,
            connection: normalizeConnection(e.connection),
            probeSecrets: {
                password: '',
                oauthAccessToken: '',
                awsSecretAccessKey: '',
                awsSessionToken: '',
                sslKeyPassphrase: '',
            },
        };
    });
    if (!environments.length) {
        environments = [newEnv()];
    }
    activeIndex = 0;
}

function validateBeforeSave() {
    const active = getActive();
    if (active) syncConnFromPanel(active);
    const trimmedIds = environments.map((e) => e.id.trim()).filter(Boolean);
    if (trimmedIds.length !== new Set(trimmedIds).size) {
        return { ok: false, message: 'Duplicate environment ids. Each id must be unique.' };
    }
    const obj = buildConfigObject();
    const keys = Object.keys(obj);
    if (keys.length === 0) {
        return { ok: false, message: 'Add at least one environment with an Environment id.' };
    }
    for (const k of keys) {
        if (!ENV_ID_PATTERN.test(k)) {
            return { ok: false, message: `Invalid environment id "${k}". Use letters, numbers, underscore, or hyphen only.` };
        }
        const brokers = obj[k].brokers;
        if (!brokers || !brokers.length) {
            return { ok: false, message: `Environment "${k}" needs at least one bootstrap broker.` };
        }
    }
    const valid = ajv.validate(schema, obj);
    if (!valid) {
        return { ok: false, message: ajv.errorsText(ajv.errors, { separator: '\n' }) };
    }
    return { ok: true, obj };
}

function renderEnvList() {
    const ul = document.getElementById('envList');
    ul.innerHTML = '';
    environments.forEach((env, i) => {
        const li = document.createElement('li');
        li.className = `env-list-item${i === activeIndex ? ' is-active' : ''}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'env-list-btn';
        const title = env.label.trim() || env.id.trim() || 'New environment';
        btn.textContent = title;
        btn.addEventListener('click', () => {
            const cur = environments[activeIndex];
            if (cur && document.getElementById('connSecurityProtocol')) {
                syncConnFromPanel(cur);
            }
            activeIndex = i;
            renderAll();
        });
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'env-remove-btn';
        rm.textContent = 'Remove';
        rm.title = 'Remove this environment';
        rm.disabled = environments.length <= 1;
        rm.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (environments.length <= 1) return;
            if (!window.confirm(`Remove environment "${title}"?`)) return;
            const cur = environments[activeIndex];
            if (cur && document.getElementById('connSecurityProtocol')) {
                syncConnFromPanel(cur);
            }
            environments.splice(i, 1);
            if (activeIndex >= environments.length) {
                activeIndex = environments.length - 1;
            }
            renderAll();
        });
        li.appendChild(btn);
        li.appendChild(rm);
        ul.appendChild(li);
    });
}

function buildProbeHtmlForSetup(env) {
    if (probeInFlight) {
        return '<span class="probe-status">Testing connection…</span>';
    }
    const probe = env.probeResult;
    if (probe && probe.ok) {
        return `<span class="probe-status is-ok">Connected — cluster <code>${escapeHtml(probe.clusterId || '—')}</code>, ${probe.brokerCount} broker(s), ${probe.topicNames.length} user topics.</span>`;
    }
    if (probe && !probe.ok) {
        return `<span class="probe-status is-err">${escapeHtml(probe.error)}</span>`;
    }
    return '<span class="probe-status">Run <strong>Test connection</strong> to verify brokers and load topic names.</span>';
}

function buildClusterTopicSectionHtml(env, available) {
    const probe = env.probeResult;
    const clusterOk = probe && probe.ok;
    if (!clusterOk) {
        const failNote = (probe && !probe.ok)
            ? '<p>Fix the broker list if needed, then run <strong>Test connection</strong> again. Loading topics does not change your cluster.</p>'
            : '<p>Run <strong>Test connection</strong> above (or below) to load topic names from the broker. This only reads metadata; it does not create or delete topics.</p>';
        return `
            <div class="topic-scroll topic-scroll--placeholder" id="clusterTopicScroll">
                <div class="topic-placeholder-inner">
                    ${failNote}
                    <button type="button" class="btn btn-secondary" id="testConnBtnPlaceholder"${probeInFlight ? ' disabled' : ''}>Test connection</button>
                </div>
            </div>
        `;
    }
    if (!available.length) {
        return `
                <input type="search" class="topic-search" id="topicFilterInput" placeholder="Search topics…" value="${escapeHtml(env.topicFilter)}" />
                <div class="topic-scroll" id="clusterTopicScroll"><div class="topic-row-muted">No matching topics, or all visible topics are already saved.</div></div>
            `;
    }
    const availableRows = available.slice(0, 400).map((name) => `
                <div class="topic-row">
                    <span class="topic-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <button type="button" class="btn btn-secondary btn-small" data-add-topic="${encodeURIComponent(name)}">Add</button>
                </div>
            `).join('');
    const capNote = available.length > 400
        ? '<div class="topic-row-muted">Showing first 400 matches. Refine search.</div>'
        : '';
    return `
                <input type="search" class="topic-search" id="topicFilterInput" placeholder="Search topics…" value="${escapeHtml(env.topicFilter)}" />
                <div class="topic-scroll" id="clusterTopicScroll">${availableRows}${capNote}</div>
            `;
}

function buildSavedTopicsHtml(env) {
    if (!env.topicList.length) {
        return '<div class="topic-row-muted">No topics saved yet. Add from the list on the left.</div>';
    }
    return env.topicList.map((name) => `
            <span class="chip">
                <span class="chip-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                <button type="button" class="chip-remove" data-remove-topic="${encodeURIComponent(name)}" aria-label="Remove">&times;</button>
            </span>
        `).join('');
}

function syncConnFromPanel(env) {
    const sp = document.getElementById('connSecurityProtocol');
    if (!sp) return;
    env.connection = normalizeConnection({
        securityProtocol: sp.value,
        saslMechanism: document.getElementById('connSaslMechanism').value,
        username: document.getElementById('connUsername').value,
        awsAccessKeyId: document.getElementById('connAwsAccessKeyId').value,
        awsAuthorizationIdentity: document.getElementById('connAwsAuthz').value,
        rejectUnauthorized: document.getElementById('connRejectUnauthorized').checked,
        caFile: document.getElementById('connCaFile').value,
        certFile: document.getElementById('connCertFile').value,
        keyFile: document.getElementById('connKeyFile').value,
    });
    env.probeSecrets = env.probeSecrets || {};
    const pp = document.getElementById('connProbePassword');
    const po = document.getElementById('connProbeOauth');
    const pas = document.getElementById('connProbeAwsSecret');
    const pat = document.getElementById('connProbeAwsSession');
    const pssl = document.getElementById('connProbeSslPass');
    if (pp) env.probeSecrets.password = pp.value;
    if (po) env.probeSecrets.oauthAccessToken = po.value;
    if (pas) env.probeSecrets.awsSecretAccessKey = pas.value;
    if (pat) env.probeSecrets.awsSessionToken = pat.value;
    if (pssl) env.probeSecrets.sslKeyPassphrase = pssl.value;
}

function buildProbeSecretsForTest(env) {
    const conn = normalizeConnection(env.connection);
    const ps = env.probeSecrets || {};
    /** @type {Record<string, string>} */
    const secrets = {};
    if (conn.saslMechanism === 'plain' || conn.saslMechanism === 'scram-sha-256' || conn.saslMechanism === 'scram-sha-512') {
        if (ps.password) secrets.password = ps.password;
    }
    if (conn.saslMechanism === 'oauthbearer' && ps.oauthAccessToken) {
        secrets.oauthAccessToken = String(ps.oauthAccessToken).trim();
    }
    if (conn.saslMechanism === 'aws') {
        if (ps.awsSecretAccessKey) secrets.awsSecretAccessKey = ps.awsSecretAccessKey;
        if (ps.awsSessionToken) secrets.awsSessionToken = ps.awsSessionToken;
    }
    if (conn.keyFile && ps.sslKeyPassphrase) {
        secrets.sslKeyPassphrase = ps.sslKeyPassphrase;
    }
    return secrets;
}

function bindEnvTopicButtons(panel, env) {
    panel.querySelectorAll('[data-add-topic]').forEach((btn) => {
        btn.addEventListener('click', () => {
            let name = '';
            try {
                name = decodeURIComponent(btn.getAttribute('data-add-topic') || '');
            } catch (err) {
                logDebug('decodeURIComponent add-topic', err);
                return;
            }
            if (!name || env.topicList.includes(name)) return;
            env.topicList.push(name);
            env.topicList.sort((a, b) => a.localeCompare(b));
            syncJsonTextarea();
            renderEnvPanel();
        });
    });
    panel.querySelectorAll('[data-remove-topic]').forEach((btn) => {
        btn.addEventListener('click', () => {
            let name = '';
            try {
                name = decodeURIComponent(btn.getAttribute('data-remove-topic') || '');
            } catch (err) {
                logDebug('decodeURIComponent remove-topic', err);
                return;
            }
            env.topicList = env.topicList.filter((t) => t !== name);
            syncJsonTextarea();
            renderEnvPanel();
        });
    });
}

function restoreEnvPanelFocus(focusId) {
    if (!focusId) return;
    const el = document.getElementById(focusId);
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.focus();
        const len = el.value.length;
        if (typeof el.setSelectionRange === 'function') {
            el.setSelectionRange(len, len);
        }
    }
}

function optSel(val, cur) {
    return val === cur ? ' selected' : '';
}

function buildConnectionDetailsHtml(c, ps) {
    return `
                <details class="connection-details">
                    <summary class="connection-details-summary">Connection &amp; security (TLS / SASL)</summary>
                    <div class="connection-details-body">
                        <div class="field" id="connGroupSecurityProtocol">
                            <label for="connSecurityProtocol">Security protocol</label>
                            <select id="connSecurityProtocol" class="conn-control">
                                <option value="PLAINTEXT"${optSel('PLAINTEXT', c.securityProtocol)}>PLAINTEXT</option>
                                <option value="SSL"${optSel('SSL', c.securityProtocol)}>SSL</option>
                                <option value="SASL_PLAINTEXT"${optSel('SASL_PLAINTEXT', c.securityProtocol)}>SASL_PLAINTEXT</option>
                                <option value="SASL_SSL"${optSel('SASL_SSL', c.securityProtocol)}>SASL_SSL</option>
                            </select>
                        </div>
                        <div class="field" id="connGroupSaslMechanism">
                            <label for="connSaslMechanism">SASL mechanism</label>
                            <select id="connSaslMechanism" class="conn-control">
                                <option value="none"${optSel('none', c.saslMechanism)}>none</option>
                                <option value="plain"${optSel('plain', c.saslMechanism)}>PLAIN</option>
                                <option value="scram-sha-256"${optSel('scram-sha-256', c.saslMechanism)}>SCRAM-SHA-256</option>
                                <option value="scram-sha-512"${optSel('scram-sha-512', c.saslMechanism)}>SCRAM-SHA-512</option>
                                <option value="oauthbearer"${optSel('oauthbearer', c.saslMechanism)}>OAUTHBEARER</option>
                                <option value="aws"${optSel('aws', c.saslMechanism)}>AWS_MSK_IAM</option>
                            </select>
                        </div>
                        <div id="connGroupTls" class="connection-card">
                            <div class="connection-card-title">TLS settings</div>
                            <div class="field">
                                <label><input type="checkbox" id="connRejectUnauthorized"${c.rejectUnauthorized ? ' checked' : ''} /> TLS verify server certificate</label>
                            </div>
                            <div class="field">
                                <label for="connCaFile">CA certificate file path (optional)</label>
                                <div class="input-with-action">
                                    <input type="text" id="connCaFile" class="conn-control" autocomplete="off" placeholder="C:\\path\\ca.pem" value="${escapeHtml(c.caFile)}" />
                                    <button type="button" id="connBrowseCaFile" class="btn btn-secondary btn-small input-action-btn">Browse</button>
                                </div>
                            </div>
                            <div class="two-col">
                                <div class="field">
                                    <label for="connCertFile">Client cert path (optional)</label>
                                    <div class="input-with-action">
                                        <input type="text" id="connCertFile" class="conn-control" autocomplete="off" value="${escapeHtml(c.certFile)}" />
                                        <button type="button" id="connBrowseCertFile" class="btn btn-secondary btn-small input-action-btn">Browse</button>
                                    </div>
                                </div>
                                <div class="field">
                                    <label for="connKeyFile">Client key path (optional)</label>
                                    <div class="input-with-action">
                                        <input type="text" id="connKeyFile" class="conn-control" autocomplete="off" value="${escapeHtml(c.keyFile)}" />
                                        <button type="button" id="connBrowseKeyFile" class="btn btn-secondary btn-small input-action-btn">Browse</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="field connection-card" id="connGroupScramUser">
                            <div class="connection-card-title">SASL user</div>
                            <label for="connUsername">SASL username (PLAIN / SCRAM)</label>
                            <input type="text" id="connUsername" class="conn-control" autocomplete="off" value="${escapeHtml(c.username)}" />
                        </div>
                        <div id="connGroupAwsIdentity" class="connection-card">
                            <div class="connection-card-title">AWS MSK IAM identity</div>
                            <div class="two-col">
                                <div class="field">
                                    <label for="connAwsAccessKeyId">AWS access key id (MSK IAM)</label>
                                    <input type="text" id="connAwsAccessKeyId" class="conn-control" autocomplete="off" value="${escapeHtml(c.awsAccessKeyId)}" />
                                </div>
                                <div class="field">
                                    <label for="connAwsAuthz">AWS authorization identity</label>
                                    <input type="text" id="connAwsAuthz" class="conn-control" autocomplete="off" placeholder="Required for MSK IAM" value="${escapeHtml(c.awsAuthorizationIdentity)}" />
                                </div>
                            </div>
                        </div>
                        <p class="field-hint" id="connGroupSecretsHint">Passwords and secrets are not saved in the config file. Use the probe fields only for <strong>Test connection</strong>; in the main app, secrets are requested when needed and stored encrypted when possible.</p>
                        <div class="field connection-card" id="connGroupProbePassword">
                            <div class="connection-card-title">Probe secret</div>
                            <label for="connProbePassword">Probe: SASL password</label>
                            <input type="password" id="connProbePassword" class="conn-control" autocomplete="new-password" value="${escapeHtml(ps.password)}" />
                        </div>
                        <div class="field connection-card" id="connGroupProbeSsl">
                            <div class="connection-card-title">Probe secret</div>
                            <label for="connProbeSslPass">Probe: TLS client key passphrase</label>
                            <input type="password" id="connProbeSslPass" class="conn-control" autocomplete="new-password" value="${escapeHtml(ps.sslKeyPassphrase)}" />
                        </div>
                        <div class="field connection-card" id="connGroupProbeOauth">
                            <div class="connection-card-title">Probe secret</div>
                            <label for="connProbeOauth">Probe: OAuth access token</label>
                            <textarea id="connProbeOauth" class="conn-control" rows="2" spellcheck="false">${escapeHtml(ps.oauthAccessToken)}</textarea>
                        </div>
                        <div id="connGroupProbeAws" class="connection-card">
                            <div class="connection-card-title">Probe secret</div>
                            <div class="two-col">
                                <div class="field">
                                    <label for="connProbeAwsSecret">Probe: AWS secret key</label>
                                    <input type="password" id="connProbeAwsSecret" class="conn-control" autocomplete="new-password" value="${escapeHtml(ps.awsSecretAccessKey)}" />
                                </div>
                                <div class="field">
                                    <label for="connProbeAwsSession">Probe: AWS session token (optional)</label>
                                    <input type="password" id="connProbeAwsSession" class="conn-control" autocomplete="new-password" value="${escapeHtml(ps.awsSessionToken)}" />
                                </div>
                            </div>
                        </div>
                    </div>
                </details>`;
}

function setConnGroupDisplay(id, visible) {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
}

/**
 * Show only TLS / SASL / probe fields that apply to the selected protocol and mechanism.
 */
function updateConnectionFieldVisibility() {
    const protoEl = document.getElementById('connSecurityProtocol');
    const mechEl = document.getElementById('connSaslMechanism');
    if (!protoEl || !mechEl) return;

    const proto = protoEl.value;
    const mech = mechEl.value;
    const useSasl = proto === 'SASL_PLAINTEXT' || proto === 'SASL_SSL';
    const useTls = proto === 'SSL' || proto === 'SASL_SSL';
    const scramLike = mech === 'plain' || mech === 'scram-sha-256' || mech === 'scram-sha-512';

    setConnGroupDisplay('connGroupSaslMechanism', useSasl);
    setConnGroupDisplay('connGroupTls', useTls);

    const showScram = useSasl && scramLike;
    setConnGroupDisplay('connGroupScramUser', showScram);
    setConnGroupDisplay('connGroupProbePassword', showScram);

    const showAws = useSasl && mech === 'aws';
    setConnGroupDisplay('connGroupAwsIdentity', showAws);
    setConnGroupDisplay('connGroupProbeAws', showAws);

    const showOauth = useSasl && mech === 'oauthbearer';
    setConnGroupDisplay('connGroupProbeOauth', showOauth);

    const keyPath = (document.getElementById('connKeyFile') && document.getElementById('connKeyFile').value.trim()) || '';
    const showProbeSsl = useTls && Boolean(keyPath);
    setConnGroupDisplay('connGroupProbeSsl', showProbeSsl);

    const anyProbe = showScram || showAws || showOauth || showProbeSsl;
    setConnGroupDisplay('connGroupSecretsHint', anyProbe);
}

async function pickPemFile() {
    try {
        const result = await ipcRenderer.invoke('kss-select-file', {
            title: 'Select certificate/key file',
            filters: [
                { name: 'PEM/Cert/Key', extensions: ['pem', 'crt', 'cer', 'key'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (!result || result.canceled || !result.filePath) return null;
        return String(result.filePath);
    } catch (err) {
        logDebug('kss-select-file', err);
        showAlert('File picker', err.message || String(err));
        return null;
    }
}

function bindPemBrowseButtons(syncConn) {
    const bindings = [
        ['connBrowseCaFile', 'connCaFile'],
        ['connBrowseCertFile', 'connCertFile'],
        ['connBrowseKeyFile', 'connKeyFile'],
    ];
    bindings.forEach(([btnId, inputId]) => {
        const btn = document.getElementById(btnId);
        const input = document.getElementById(inputId);
        if (!btn || !input) return;
        btn.addEventListener('click', async () => {
            const chosen = await pickPemFile();
            if (!chosen) return;
            input.value = chosen;
            syncConn();
        });
    });
}

function renderEnvPanel() {
    const panel = document.getElementById('envPanel');
    const env = getActive();
    if (!env) {
        panel.innerHTML = '';
        return;
    }

    const focusId = document.activeElement && document.activeElement.id;

    const probe = env.probeResult;
    const clusterOk = probe && probe.ok;
    const topicNames = clusterOk ? probe.topicNames : [];
    const term = (env.topicFilter || '').trim().toLowerCase();
    const available = topicNames.filter(
        (name) => !env.topicList.includes(name) && (!term || name.toLowerCase().includes(term)),
    );
    const brokersHave = brokerListFromInput(env.brokersText).length > 0;

    const probeHtml = buildProbeHtmlForSetup(env);
    const probeCtaHint = (brokersHave && !clusterOk && !probeInFlight)
        ? '<p class="probe-cta-hint">Test connection is required to load topic names from the cluster for this environment.</p>'
        : '';
    const clusterTopicBody = buildClusterTopicSectionHtml(env, available);
    const savedChips = buildSavedTopicsHtml(env);
    const c = normalizeConnection(env.connection);
    const ps = env.probeSecrets || {};

    panel.innerHTML = `
        <div class="env-panel-inner">
            <div class="env-panel-form">
                <div class="two-col">
                    <div class="field">
                        <label for="envIdInput">Environment id</label>
                        <input type="text" id="envIdInput" autocomplete="off" placeholder="e.g. dev" value="${escapeHtml(env.id)}" />
                        <p class="field-hint">Letters, numbers, underscore, hyphen. Used as the config key.</p>
                    </div>
                    <div class="field">
                        <label for="envLabelInput">Display name</label>
                        <input type="text" id="envLabelInput" autocomplete="off" placeholder="e.g. Development" value="${escapeHtml(env.label)}" />
                    </div>
                </div>
                <div class="field">
                    <label for="envBrokersInput">Bootstrap brokers</label>
                    <textarea id="envBrokersInput" placeholder="localhost:9092&#10;broker2:9092">${escapeHtml(env.brokersText)}</textarea>
                    <p class="field-hint">One host:port per line, or comma-separated.</p>
                </div>
                ${buildConnectionDetailsHtml(c, ps)}
                <div class="probe-block">
                    <div class="probe-row">
                        <button type="button" id="testConnBtn" class="btn btn-secondary"${probeInFlight ? ' disabled' : ''}>Test connection</button>
                        ${probeHtml}
                    </div>
                    ${probeCtaHint}
                </div>
            </div>
            <div id="topicSection" class="topic-section">
                <div class="topic-columns">
                    <div class="topic-panel">
                        <h3>Cluster topics</h3>
                        ${clusterTopicBody}
                    </div>
                    <div class="topic-panel">
                        <h3>Saved topics (configuration)</h3>
                        <div class="chip-list" id="savedTopicsList">${savedChips}</div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const idInput = document.getElementById('envIdInput');
    const labelInput = document.getElementById('envLabelInput');
    const brokersInput = document.getElementById('envBrokersInput');
    idInput.addEventListener('input', () => {
        env.id = idInput.value;
        env.probeResult = null;
        syncJsonTextarea();
        renderEnvList();
    });
    labelInput.addEventListener('input', () => {
        env.label = labelInput.value;
        syncJsonTextarea();
        renderEnvList();
    });
    brokersInput.addEventListener('input', () => {
        env.brokersText = brokersInput.value;
        env.probeResult = null;
        syncJsonTextarea();
        renderEnvPanel();
    });

    const filterInput = document.getElementById('topicFilterInput');
    if (filterInput) {
        filterInput.addEventListener('input', () => {
            env.topicFilter = filterInput.value;
            renderEnvPanel();
        });
    }

    bindEnvTopicButtons(panel, env);

    const syncConn = () => {
        syncConnFromPanel(env);
        syncJsonTextarea();
        updateConnectionFieldVisibility();
    };
    [
        'connSecurityProtocol', 'connSaslMechanism', 'connUsername', 'connAwsAccessKeyId',
        'connAwsAuthz', 'connCaFile', 'connCertFile', 'connKeyFile',
        'connProbePassword', 'connProbeOauth', 'connProbeAwsSecret', 'connProbeAwsSession', 'connProbeSslPass',
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', syncConn);
        el.addEventListener('input', syncConn);
    });
    const rejCb = document.getElementById('connRejectUnauthorized');
    if (rejCb) rejCb.addEventListener('change', syncConn);
    bindPemBrowseButtons(syncConn);

    updateConnectionFieldVisibility();

    async function handleTestConnection() {
        if (probeInFlight) return;
        syncConnFromPanel(env);
        probeInFlight = true;
        renderEnvPanel();
        const secrets = buildProbeSecretsForTest(env);
        const result = await probeClusterConnection(env.brokersText, {
            connection: normalizeConnection(env.connection),
            secrets,
        });
        probeInFlight = false;
        env.probeResult = result;
        if (!result.ok) {
            showAlert('Connection failed', result.error);
        }
        syncJsonTextarea();
        renderEnvPanel();
    }

    document.getElementById('testConnBtn').addEventListener('click', handleTestConnection);
    const testPlaceholder = document.getElementById('testConnBtnPlaceholder');
    if (testPlaceholder) {
        testPlaceholder.addEventListener('click', handleTestConnection);
    }

    restoreEnvPanelFocus(focusId);
}

function renderAll() {
    renderEnvList();
    renderEnvPanel();
    syncJsonTextarea();
}

async function loadInitialConfig() {
    const kssDir = path.join(os.homedir(), '.kss');
    const configPath = getConfigPath();
    if (!fs.existsSync(kssDir)) {
        fs.mkdirSync(kssDir, { recursive: true });
    }
    const pathEl = document.getElementById('configPathText');
    if (pathEl) {
        pathEl.textContent = `Config: ${configPath}`;
    }
    if (!fs.existsSync(configPath)) {
        environments = [newEnv()];
        activeIndex = 0;
        return;
    }
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        applyConfigFromObject(parsed);
    } catch (err) {
        console.error(err);
        showAlert('Configuration error', err.message || 'Could not read config. Starting empty.');
        environments = [newEnv()];
        activeIndex = 0;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    applyTheme(resolveInitialTheme());

    document.querySelector('.custom-alert-close').addEventListener('click', closeAlert);

    await loadInitialConfig();
    renderAll();

    document.getElementById('addEnvBtn').addEventListener('click', () => {
        environments.push(newEnv());
        activeIndex = environments.length - 1;
        renderAll();
    });

    document.getElementById('applyJsonBtn').addEventListener('click', () => {
        try {
            const parsed = JSON.parse(document.getElementById('configJsonText').value);
            applyConfigFromObject(parsed);
            renderAll();
            closeAlert();
        } catch (err) {
            showAlert('Invalid JSON', err.message || String(err));
        }
    });

    const adv = document.getElementById('advancedDetails');
    adv.addEventListener('toggle', () => {
        if (adv.open) syncJsonTextarea();
    });

    document.getElementById('saveConfig').addEventListener('click', () => {
        const check = validateBeforeSave();
        if (!check.ok) {
            showAlert('Cannot save', check.message);
            return;
        }
        const configPath = getConfigPath();
        const kssDir = path.dirname(configPath);
        if (!fs.existsSync(kssDir)) {
            fs.mkdirSync(kssDir, { recursive: true });
        }
        try {
            fs.writeFileSync(configPath, JSON.stringify(check.obj, null, 4));
            ipcRenderer.send('config-saved');
            ipcRenderer.send('close-setup-window');
        } catch (err) {
            showAlert('Save failed', err.message || 'Unable to write config file.');
        }
    });
});
