const crypto = require('crypto');
const { faker } = require('@faker-js/faker');

function randomInt(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    return faker.number.int({ min: lo, max: hi });
}

function randomFloat(min, max, decimals = 2) {
    return faker.number.float({
        min,
        max,
        fractionDigits: decimals,
    });
}

function randomUUID() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return faker.string.uuid();
}

function randomPhone() {
    const a = faker.string.numeric(3);
    const b = faker.string.numeric(3);
    const c = faker.string.numeric(4);
    return `+1-${a}-${b}-${c}`;
}

const TOKENS = {
    guid: () => randomUUID(),
    randomUUID: () => randomUUID(),
    timestamp: () => String(Date.now()),
    isoTimestamp: () => new Date().toISOString(),
    pastDateIso: () => faker.date.past().toISOString(),
    futureDateIso: () => faker.date.future().toISOString(),
    recentIso: () => faker.date.recent({ days: 30 }).toISOString(),
    soonIso: () => faker.date.soon({ days: 30 }).toISOString(),
    randomInt: (args) => {
        if (args && args.length === 2) {
            return String(randomInt(Number(args[0]), Number(args[1])));
        }
        if (args && args.length === 1) {
            return String(randomInt(0, Number(args[0])));
        }
        return String(randomInt(0, 10000));
    },
    randomFloat: (args) => {
        if (args && args.length >= 2) {
            const decimals = args.length >= 3 ? Number(args[2]) : 2;
            return String(randomFloat(Number(args[0]), Number(args[1]), decimals));
        }
        return String(randomFloat(0, 1, 4));
    },
    randomBool: () => (faker.datatype.boolean() ? 'true' : 'false'),
    randomBigInt: () => String(faker.number.bigInt({ min: 0n, max: 9999999999999n })),
    name: () => faker.person.fullName(),
    firstName: () => faker.person.firstName(),
    lastName: () => faker.person.lastName(),
    jobTitle: () => faker.person.jobTitle(),
    sex: () => faker.person.sex(),
    company: () => faker.company.name(),
    email: () => faker.internet.email(),
    username: () => faker.internet.username(),
    phone: () => randomPhone(),
    url: () => faker.internet.url(),
    ipv4: () => faker.internet.ipv4(),
    ipv6: () => faker.internet.ipv6(),
    userAgent: () => faker.internet.userAgent(),
    httpMethod: () => faker.helpers.arrayElement(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    streetAddress: () => faker.location.streetAddress(),
    city: () => faker.location.city(),
    randomCity: () => faker.location.city(),
    state: () => faker.location.state(),
    zipCode: () => faker.location.zipCode(),
    country: () => faker.location.country(),
    randomCountry: () => faker.location.country(),
    countryCode: () => faker.location.countryCode(),
    weekday: () => faker.date.weekday(),
    randomWord: () => faker.lorem.word(),
    randomSentence: () => faker.lorem.sentence(),
    paragraph: () => faker.lorem.paragraph(),
    randomColor: () => faker.color.rgb({ format: 'hex', casing: 'lower' }),
    alphanumeric: (args) => {
        const len = args && args[0] ? Number(args[0]) : 16;
        const n = Math.min(256, Math.max(1, Number.isFinite(len) ? len : 16));
        return faker.string.alphanumeric({ length: n });
    },
    randomHex: (args) => {
        const nbytes = args && args[0] ? Number(args[0]) : 8;
        const n = Math.min(64, Math.max(1, Number.isFinite(nbytes) ? nbytes : 8));
        return crypto.randomBytes(n).toString('hex');
    },
    iban: () => faker.finance.iban(),
    amount: () => String(faker.finance.amount({ min: 1, max: 10000, dec: 2 })),
};

/**
 * Insert-token dropdown: token string, short label, optgroup heading.
 */
const TOKEN_INSERT_OPTIONS = [
    { group: 'IDs & time', token: '{{$guid}}', label: 'GUID (UUID v4)' },
    { group: 'IDs & time', token: '{{$randomUUID}}', label: 'UUID (alias)' },
    { group: 'IDs & time', token: '{{$timestamp}}', label: 'Epoch ms' },
    { group: 'IDs & time', token: '{{$isoTimestamp}}', label: 'ISO 8601 (now)' },
    { group: 'IDs & time', token: '{{$pastDateIso}}', label: 'ISO past' },
    { group: 'IDs & time', token: '{{$futureDateIso}}', label: 'ISO future' },
    { group: 'IDs & time', token: '{{$recentIso}}', label: 'ISO recent (~30d)' },
    { group: 'IDs & time', token: '{{$soonIso}}', label: 'ISO soon (~30d)' },

    { group: 'Numbers', token: '{{$randomInt}}', label: 'Int 0–10000' },
    { group: 'Numbers', token: '{{$randomInt:1,100}}', label: 'Int 1–100 (edit range)' },
    { group: 'Numbers', token: '{{$randomInt:0,1}}', label: 'Int 0 or 1' },
    { group: 'Numbers', token: '{{$randomFloat}}', label: 'Float 0–1' },
    { group: 'Numbers', token: '{{$randomFloat:0,100,2}}', label: 'Float 0–100, 2 dp' },
    { group: 'Numbers', token: '{{$randomBool}}', label: 'true / false' },
    { group: 'Numbers', token: '{{$randomBigInt}}', label: 'BigInt string' },
    { group: 'Numbers', token: '{{$amount}}', label: 'Money amount' },

    { group: 'People & org', token: '{{$name}}', label: 'Full name' },
    { group: 'People & org', token: '{{$firstName}}', label: 'First name' },
    { group: 'People & org', token: '{{$lastName}}', label: 'Last name' },
    { group: 'People & org', token: '{{$jobTitle}}', label: 'Job title' },
    { group: 'People & org', token: '{{$sex}}', label: 'Sex' },
    { group: 'People & org', token: '{{$company}}', label: 'Company' },

    { group: 'Contact & web', token: '{{$email}}', label: 'Email' },
    { group: 'Contact & web', token: '{{$username}}', label: 'Username' },
    { group: 'Contact & web', token: '{{$phone}}', label: 'Phone +1' },
    { group: 'Contact & web', token: '{{$url}}', label: 'URL' },
    { group: 'Contact & web', token: '{{$ipv4}}', label: 'IPv4' },
    { group: 'Contact & web', token: '{{$ipv6}}', label: 'IPv6' },
    { group: 'Contact & web', token: '{{$userAgent}}', label: 'User-Agent' },
    { group: 'Contact & web', token: '{{$httpMethod}}', label: 'HTTP method' },

    { group: 'Location', token: '{{$streetAddress}}', label: 'Street address' },
    { group: 'Location', token: '{{$city}}', label: 'City' },
    { group: 'Location', token: '{{$state}}', label: 'State / region' },
    { group: 'Location', token: '{{$zipCode}}', label: 'ZIP / postal' },
    { group: 'Location', token: '{{$country}}', label: 'Country' },
    { group: 'Location', token: '{{$randomCity}}', label: 'City (alias)' },
    { group: 'Location', token: '{{$randomCountry}}', label: 'Country (alias)' },
    { group: 'Location', token: '{{$countryCode}}', label: 'Country code' },
    { group: 'Location', token: '{{$weekday}}', label: 'Weekday name' },

    { group: 'Text & binary', token: '{{$randomWord}}', label: 'Word' },
    { group: 'Text & binary', token: '{{$randomSentence}}', label: 'Sentence' },
    { group: 'Text & binary', token: '{{$paragraph}}', label: 'Paragraph' },
    { group: 'Text & binary', token: '{{$randomColor}}', label: 'Hex color' },
    { group: 'Text & binary', token: '{{$alphanumeric}}', label: 'A–Z0–9 (16 chars)' },
    { group: 'Text & binary', token: '{{$alphanumeric:24}}', label: 'A–Z0–9 (24 chars)' },
    { group: 'Text & binary', token: '{{$randomHex}}', label: 'Random hex (8 bytes)' },
    { group: 'Text & binary', token: '{{$randomHex:4}}', label: 'Random hex (4 bytes)' },

    { group: 'Finance', token: '{{$iban}}', label: 'IBAN' },
];

const TOKEN_PLACEHOLDER =
    /\{\{\s*\$([a-zA-Z]+)(?::([^}]{0,512}))?\s*\}\}/g;

function expandTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text.replace(TOKEN_PLACEHOLDER, (match, name, argString) => {
        const handler = TOKENS[name];
        if (!handler) return match;
        const args = (argString || '').length
            ? argString.split(',').map((s) => s.trim())
            : null;
        try {
            return String(handler(args));
        } catch (err) {
            if (typeof console !== 'undefined' && console.debug) {
                console.debug('[kss] token expansion failed', name, err);
            }
            return match;
        }
    });
}

module.exports = {
    expandTokens,
    TOKEN_INSERT_OPTIONS,
    /** @deprecated use TOKEN_INSERT_OPTIONS */
    TOKEN_DESCRIPTIONS: TOKEN_INSERT_OPTIONS,
};
