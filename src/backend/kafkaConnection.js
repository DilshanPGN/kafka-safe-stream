const fs = require('fs');
const os = require('os');
const path = require('path');

const VALID_PROTOCOLS = new Set(['PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL']);
const VALID_MECHANISMS = new Set(['none', 'plain', 'scram-sha-256', 'scram-sha-512', 'oauthbearer', 'aws']);

const DEFAULT_CONNECTION = Object.freeze({
    securityProtocol: 'PLAINTEXT',
    saslMechanism: 'none',
    username: '',
    awsAccessKeyId: '',
    awsAuthorizationIdentity: '',
    awsRoleArn: '',
    awsRoleSessionName: '',
    awsProfile: '',
    rejectUnauthorized: true,
    caFile: '',
    certFile: '',
    keyFile: '',
});

/**
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONNECTION}
 */
function normalizeConnection(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const securityProtocol = VALID_PROTOCOLS.has(c.securityProtocol)
        ? c.securityProtocol
        : 'PLAINTEXT';
    let saslMechanism = String(c.saslMechanism || 'none').toLowerCase();
    if (saslMechanism === 'scram-sha-256' || saslMechanism === 'SCRAM-SHA-256') saslMechanism = 'scram-sha-256';
    else if (saslMechanism === 'scram-sha-512' || saslMechanism === 'SCRAM-SHA-512') saslMechanism = 'scram-sha-512';
    if (!VALID_MECHANISMS.has(saslMechanism)) saslMechanism = 'none';

    return {
        securityProtocol,
        saslMechanism,
        username: typeof c.username === 'string' ? c.username : '',
        awsAccessKeyId: typeof c.awsAccessKeyId === 'string' ? c.awsAccessKeyId : '',
        awsAuthorizationIdentity: typeof c.awsAuthorizationIdentity === 'string' ? c.awsAuthorizationIdentity : '',
        awsRoleArn: typeof c.awsRoleArn === 'string' ? c.awsRoleArn : '',
        awsRoleSessionName: typeof c.awsRoleSessionName === 'string' ? c.awsRoleSessionName : '',
        awsProfile: typeof c.awsProfile === 'string' ? c.awsProfile : '',
        rejectUnauthorized: c.rejectUnauthorized !== false,
        caFile: typeof c.caFile === 'string' ? c.caFile : '',
        certFile: typeof c.certFile === 'string' ? c.certFile : '',
        keyFile: typeof c.keyFile === 'string' ? c.keyFile : '',
    };
}

function nonEmpty(value) {
    const s = String(value || '').trim();
    return s || '';
}

function inferAwsRegionFromBrokers(brokers) {
    const list = Array.isArray(brokers) ? brokers : [];
    for (const broker of list) {
        const s = String(broker || '').trim().toLowerCase();
        if (!s) continue;
        const host = s.split(':')[0];
        const m = host.match(/kafka\.([a-z0-9-]+)\.amazonaws\.com$/);
        if (m && m[1]) return m[1];
    }
    return '';
}

function loadMskSigner() {
    try {
        // Loaded lazily so users not using AWS IAM can still run normally.
        return require('aws-msk-iam-sasl-signer-js');
    } catch (err) {
        throw new Error(
            `AWS_MSK_IAM requires the "aws-msk-iam-sasl-signer-js" package. Install it and retry. ${err.message}`
        );
    }
}

async function buildAwsMskIamToken(connection, brokers) {
    const region = inferAwsRegionFromBrokers(brokers);
    if (!region) {
        throw new Error('Could not infer AWS region from broker host. Use an MSK broker endpoint (*.kafka.<region>.amazonaws.com).');
    }
    const signer = loadMskSigner();
    const roleArn = nonEmpty(connection.awsRoleArn);
    const roleSessionName = nonEmpty(connection.awsRoleSessionName) || 'kafka-safe-stream';
    const profile = nonEmpty(connection.awsProfile || process.env.AWS_PROFILE);

    let response;
    if (roleArn && typeof signer.generateAuthTokenFromRole === 'function') {
        response = await signer.generateAuthTokenFromRole({
            region,
            awsRoleArn: roleArn,
            awsRoleSessionName: roleSessionName,
        });
    } else if (profile && typeof signer.generateAuthTokenFromProfile === 'function') {
        response = await signer.generateAuthTokenFromProfile({
            region,
            awsProfileName: profile,
        });
    } else if (typeof signer.generateAuthToken === 'function') {
        response = await signer.generateAuthToken({ region });
    } else {
        throw new Error('aws-msk-iam-sasl-signer-js does not expose a supported token generator');
    }
    if (!response || !response.token) {
        throw new Error('MSK IAM token generator returned an empty token');
    }
    return String(response.token);
}

/**
 * Stable JSON for client cache fingerprint (no secrets).
 * @param {typeof DEFAULT_CONNECTION} connection
 * @param {string[]} brokers
 * @param {boolean} hasPersistedOrSessionSecret
 */
function connectionFingerprint(connection, brokers, hasPersistedOrSessionSecret) {
    const b = [...(brokers || [])].map((x) => String(x).trim().toLowerCase()).sort();
    return JSON.stringify({
        ...connection,
        brokers: b,
        hasSecret: !!hasPersistedOrSessionSecret,
    });
}

function expandPath(p) {
    if (!p || typeof p !== 'string') return '';
    const t = p.trim();
    if (!t) return '';
    if (t.startsWith('~')) return path.join(os.homedir(), t.slice(1));
    return path.resolve(t);
}

function readTlsFileOptional(filePath) {
    const resolved = expandPath(filePath);
    if (!resolved) return undefined;
    if (!fs.existsSync(resolved)) {
        throw new Error(`TLS file not found: ${resolved}`);
    }
    return fs.readFileSync(resolved);
}

/**
 * @param {typeof DEFAULT_CONNECTION} connection
 * @param {{ sslKeyPassphrase?: string }} sec
 */
function buildTlsSslObject(connection, sec) {
    const hasPemPaths = !!(connection.caFile || connection.certFile || connection.keyFile);
    if (!hasPemPaths) {
        return connection.rejectUnauthorized === false
            ? { rejectUnauthorized: false }
            : true;
    }
    const ssl = {};
    if (connection.rejectUnauthorized === false) {
        ssl.rejectUnauthorized = false;
    }
    if (connection.caFile) ssl.ca = readTlsFileOptional(connection.caFile);
    if (connection.certFile) ssl.cert = readTlsFileOptional(connection.certFile);
    if (connection.keyFile) {
        ssl.key = readTlsFileOptional(connection.keyFile);
        if (sec.sslKeyPassphrase) ssl.passphrase = String(sec.sslKeyPassphrase);
    }
    return ssl;
}

/**
 * @param {typeof DEFAULT_CONNECTION} connection
 * @param {{ password?: string, oauthAccessToken?: string }} sec
 * @param {string[]} brokers
 */
function buildSaslObject(connection, sec, brokers) {
    const mech = connection.saslMechanism;
    if (mech === 'plain' || mech === 'scram-sha-256' || mech === 'scram-sha-512') {
        return {
            mechanism: mech,
            username: String(connection.username || ''),
            password: String(sec.password || ''),
        };
    }
    if (mech === 'oauthbearer') {
        const token = String(sec.oauthAccessToken || '');
        return {
            mechanism: 'oauthbearer',
            oauthBearerProvider: async () => ({ value: token }),
        };
    }
    if (mech === 'aws') {
        return {
            mechanism: 'oauthbearer',
            oauthBearerProvider: async () => {
                const token = await buildAwsMskIamToken(connection, brokers);
                return { value: token };
            },
        };
    }
    return undefined;
}

/**
 * @param {typeof DEFAULT_CONNECTION} connection
 * @param {{ password?: string, oauthAccessToken?: string, awsSecretAccessKey?: string, awsSessionToken?: string, sslKeyPassphrase?: string }} secrets
 * @returns {{ ssl?: boolean|object, sasl?: object }}
 */
function buildSslAndSasl(connection, secrets, brokers) {
    const sec = secrets && typeof secrets === 'object' ? secrets : {};
    const useTls = connection.securityProtocol === 'SSL' || connection.securityProtocol === 'SASL_SSL';
    const useSasl = connection.securityProtocol === 'SASL_PLAINTEXT' || connection.securityProtocol === 'SASL_SSL';
    const mech = connection.saslMechanism;

    let ssl;
    if (useTls) {
        ssl = buildTlsSslObject(connection, sec);
    }

    let sasl;
    if (useSasl && mech !== 'none') {
        sasl = buildSaslObject(connection, sec, brokers);
    }

    return { ssl, sasl };
}

/**
 * @param {{ brokers: string[], connection?: unknown, secrets?: object }} args
 * @returns {import('kafkajs').KafkaConfig}
 */
function buildKafkaClientConfig(args) {
    const brokers = Array.isArray(args.brokers) ? args.brokers.map((b) => String(b).trim()).filter(Boolean) : [];
    if (!brokers.length) {
        throw new Error('At least one broker is required');
    }
    const connection = normalizeConnection(args.connection);
    const { ssl, sasl } = buildSslAndSasl(connection, args.secrets, brokers);

    /** @type {import('kafkajs').KafkaConfig} */
    const cfg = { brokers };
    if (ssl !== undefined) cfg.ssl = ssl;
    if (sasl) cfg.sasl = sasl;
    return cfg;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isKafkaAuthError(err) {
    if (!err) return false;
    const name = err.name || '';
    if (name === 'KafkaJSSASLAuthenticationError') return true;
    const msg = String(err.message || err);
    if (/SASL|Authentication failed|authentication failed|Invalid username or password/i.test(msg)) return true;
    if (/self[- ]signed certificate|unable to verify the first certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|certificate has expired|EPROTO|wrong version number|tlsv1 alert/i.test(msg)) return true;
    return false;
}

module.exports = {
    DEFAULT_CONNECTION,
    normalizeConnection,
    connectionFingerprint,
    buildKafkaClientConfig,
    isKafkaAuthError,
};
