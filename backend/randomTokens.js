const crypto = require('crypto');

const FIRST_NAMES = [
    'Alex', 'Avery', 'Blake', 'Casey', 'Dakota', 'Eden', 'Finley', 'Gray',
    'Harper', 'Indigo', 'Jordan', 'Kai', 'Logan', 'Morgan', 'Nova', 'Oakley',
    'Parker', 'Quinn', 'Riley', 'Sage', 'Taylor', 'Reese', 'Sky', 'Rowan',
    'Emery', 'Hayden', 'Phoenix', 'River', 'Skyler', 'Aria', 'Mason', 'Liam',
    'Olivia', 'Noah', 'Emma', 'Ava', 'Sophia', 'Mia', 'Ethan', 'Lucas',
];

const LAST_NAMES = [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
    'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
    'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
    'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark',
    'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King',
    'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
];

const CITIES = [
    'New York', 'Los Angeles', 'London', 'Tokyo', 'Paris', 'Berlin', 'Sydney',
    'Toronto', 'Mumbai', 'Singapore', 'Dubai', 'Cape Town', 'Sao Paulo',
    'Mexico City', 'Bangkok', 'Seoul', 'Madrid', 'Rome', 'Amsterdam',
    'Stockholm', 'Oslo', 'Helsinki', 'Vienna', 'Prague', 'Warsaw', 'Athens',
    'Lisbon', 'Dublin', 'Edinburgh', 'Vancouver',
];

const COUNTRIES = [
    'United States', 'United Kingdom', 'Canada', 'Australia', 'Germany',
    'France', 'Japan', 'China', 'India', 'Brazil', 'Mexico', 'Italy',
    'Spain', 'Netherlands', 'Sweden', 'Norway', 'Finland', 'Denmark',
    'Ireland', 'New Zealand', 'South Africa', 'Singapore', 'South Korea',
    'United Arab Emirates', 'Switzerland', 'Belgium', 'Austria', 'Poland',
    'Portugal', 'Greece',
];

const WORDS = [
    'apple', 'mountain', 'river', 'cloud', 'forest', 'ocean', 'desert',
    'meadow', 'storm', 'thunder', 'crystal', 'shadow', 'meteor', 'galaxy',
    'planet', 'star', 'comet', 'falcon', 'tiger', 'panther', 'wolf',
    'eagle', 'phoenix', 'dragon', 'silver', 'golden', 'crimson', 'azure',
    'emerald', 'amber',
];

const EMAIL_DOMAINS = ['example.com', 'mail.com', 'test.io', 'demo.dev', 'kss.local'];

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function randomFloat(min, max, decimals = 2) {
    const value = Math.random() * (max - min) + min;
    return Number(value.toFixed(decimals));
}

function randomColor() {
    const n = Math.floor(Math.random() * 0xffffff);
    return '#' + n.toString(16).padStart(6, '0');
}

function randomUUID() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
}

function randomPhone() {
    const part = () => String(randomInt(0, 999)).padStart(3, '0');
    return `+1-${part()}-${part()}-${String(randomInt(0, 9999)).padStart(4, '0')}`;
}

function randomSentence() {
    const len = randomInt(4, 9);
    const words = [];
    for (let i = 0; i < len; i++) {
        words.push(pick(WORDS));
    }
    const sentence = words.join(' ');
    return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

const TOKENS = {
    guid: () => randomUUID(),
    randomUUID: () => randomUUID(),
    timestamp: () => String(Date.now()),
    isoTimestamp: () => new Date().toISOString(),
    randomInt: (args) => {
        if (args && args.length === 2) {
            return String(randomInt(Number(args[0]), Number(args[1])));
        }
        if (args && args.length === 1) {
            return String(randomInt(0, Number(args[0])));
        }
        return String(randomInt(0, 10000));
    },
    name: () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    firstName: () => pick(FIRST_NAMES),
    lastName: () => pick(LAST_NAMES),
    email: () => {
        const first = pick(FIRST_NAMES).toLowerCase();
        const last = pick(LAST_NAMES).toLowerCase();
        return `${first}.${last}${randomInt(1, 99)}@${pick(EMAIL_DOMAINS)}`;
    },
    phone: () => randomPhone(),
    randomBool: () => (Math.random() < 0.5 ? 'true' : 'false'),
    randomFloat: (args) => {
        if (args && args.length >= 2) {
            const decimals = args.length >= 3 ? Number(args[2]) : 2;
            return String(randomFloat(Number(args[0]), Number(args[1]), decimals));
        }
        return String(randomFloat(0, 1, 4));
    },
    randomColor: () => randomColor(),
    randomWord: () => pick(WORDS),
    randomSentence: () => randomSentence(),
    randomCity: () => pick(CITIES),
    randomCountry: () => pick(COUNTRIES),
};

const TOKEN_DESCRIPTIONS = [
    { token: '{{$guid}}', label: 'GUID (UUID v4)' },
    { token: '{{$randomUUID}}', label: 'Random UUID' },
    { token: '{{$timestamp}}', label: 'Epoch ms timestamp' },
    { token: '{{$isoTimestamp}}', label: 'ISO 8601 timestamp' },
    { token: '{{$randomInt}}', label: 'Random int 0–10000' },
    { token: '{{$randomInt:1,100}}', label: 'Random int 1–100' },
    { token: '{{$name}}', label: 'Full name' },
    { token: '{{$firstName}}', label: 'First name' },
    { token: '{{$lastName}}', label: 'Last name' },
    { token: '{{$email}}', label: 'Email address' },
    { token: '{{$phone}}', label: 'Phone number' },
    { token: '{{$randomBool}}', label: 'true / false' },
    { token: '{{$randomFloat}}', label: 'Random float 0–1' },
    { token: '{{$randomColor}}', label: 'Hex color' },
    { token: '{{$randomWord}}', label: 'Random word' },
    { token: '{{$randomSentence}}', label: 'Random sentence' },
    { token: '{{$randomCity}}', label: 'Random city' },
    { token: '{{$randomCountry}}', label: 'Random country' },
];

function expandTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text.replace(/\{\{\s*\$([a-zA-Z]+)(?::([^}]*))?\s*\}\}/g, (match, name, argString) => {
        const handler = TOKENS[name];
        if (!handler) return match;
        const args = (argString || '').length
            ? argString.split(',').map((s) => s.trim())
            : null;
        try {
            return String(handler(args));
        } catch (_) {
            return match;
        }
    });
}

module.exports = {
    expandTokens,
    TOKEN_DESCRIPTIONS,
};
