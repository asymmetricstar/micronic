/**
 * Shell runtime: database bootstrap, the signed-in session, the running DNS
 * server and the prompt IO abstraction that lets the same command run under the
 * REPL (which owns the terminal) or a one-shot invocation (which opens its own
 * readline).
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Sqlite } from '../lib/db/sqlite.js';
import { SettingsManager, SETTING_KEYS } from '../lib/settings/manager.js';
import { ZoneManager } from '../lib/zones/manager.js';
import { UserManager } from '../lib/users/manager.js';
import { TokenManager } from '../lib/auth/tokens.js';
import { DNSType } from '../lib/dns/constants.js';
import { SETTINGS } from './settings.js';
/** An expected failure: printed as one line, never as a stack trace. */
export class CliError extends Error {
    exitCode;
    constructor(message, exitCode = 1) {
        super(message);
        this.name = 'CliError';
        this.exitCode = exitCode;
    }
}
/** One-line message for anything thrown by a command. */
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
function numberFromEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new CliError(`${name} must be an integer between 0 and 65535 (got "${raw}")`);
    }
    return value;
}
/**
 * Open (and migrate) the NIC database the shell and the server share, applying
 * the same bootstrap as the old server entry point:
 *   MICRONIC_ADMIN_PASSWORD  create "admin" when no users exist
 *   MICRONIC_SEED_ZONE       create this zone on first start
 */
export function openApp() {
    const dbPath = path.resolve(process.env.MICRONIC_DB ?? 'data/dns.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Sqlite(dbPath);
    const zones = new ZoneManager(db);
    const users = new UserManager(db);
    const settings = new SettingsManager(db);
    const tokens = new TokenManager(db);
    const notes = [];
    // The environment seeds the settings table on the first start; afterwards the
    // database is the source of truth (see `config set`).
    const apiEnv = (process.env.MICRONIC_API ?? '').trim().toLowerCase();
    const defaults = {
        host: process.env.MICRONIC_HOST?.trim() || '127.0.0.1',
        port: String(numberFromEnv('MICRONIC_PORT', 5354)),
        ttl: String(numberFromEnv('MICRONIC_TTL', 300)),
        // Self-service signups are opt-in; the first account is always allowed.
        register: 'off',
        // The HTTP API is on by default, bound to the same host as DNS.
        api: ['off', 'false', '0', 'no', 'disabled'].includes(apiEnv) ? 'off' : 'on',
        api_port: String(numberFromEnv('MICRONIC_API_PORT', 8080)),
    };
    const seeded = [];
    for (const key of SETTING_KEYS) {
        if (settings.seed(key, defaults[key]))
            seeded.push(key);
    }
    const fromEnvironment = [
        'MICRONIC_HOST',
        'MICRONIC_PORT',
        'MICRONIC_TTL',
        'MICRONIC_API',
        'MICRONIC_API_PORT',
    ].some((name) => (process.env[name] ?? '') !== '');
    if (seeded.length > 0 && fromEnvironment) {
        notes.push(`seeded ${seeded.join(', ')} in the settings table from the environment`);
    }
    const adminPassword = process.env.MICRONIC_ADMIN_PASSWORD;
    if (adminPassword && users.listUsers().length === 0) {
        users.createUser({ username: 'admin', password: adminPassword, role: 'admin' });
        notes.push('created admin user from MICRONIC_ADMIN_PASSWORD');
    }
    const seedZone = process.env.MICRONIC_SEED_ZONE;
    if (seedZone && zones.listZones().length === 0) {
        const masterIp = process.env.MICRONIC_SEED_IP ?? '127.0.0.1';
        const zone = zones.createZone({ name: seedZone, masterIp }, null);
        zones.createRecord({ zoneId: zone.id, name: 'www', type: DNSType.A, rdata: masterIp, ttl: Number(defaults.ttl) }, null);
        notes.push(`seeded zone ${zone.name} (www -> ${masterIp})`);
    }
    return {
        db,
        dbPath,
        zones,
        users,
        settings,
        tokens,
        notes,
        // Getters: a `config set` in this shell is visible immediately.
        get host() {
            return settings.get('host') ?? defaults.host;
        },
        get port() {
            return settings.number('port', Number(defaults.port));
        },
        get ttl() {
            return settings.number('ttl', Number(defaults.ttl));
        },
        get apiEnabled() {
            return settings.bool('api', true);
        },
        get apiPort() {
            return settings.number('api_port', Number(defaults.api_port));
        },
    };
}
/**
 * In-memory login state. The user row is re-read on every check, so a role
 * change made by another admin session takes effect immediately.
 */
export class Session {
    app;
    username;
    /** Active domain (`domain use`), used by record and lookup defaults. */
    domain;
    /** DNS server started with `serve`, when there is one. */
    server;
    /** HTTP API started with the DNS listener, when enabled. */
    api;
    constructor(app) {
        this.app = app;
    }
    get user() {
        return this.username === undefined ? undefined : this.app.users.getUserByName(this.username);
    }
    get signedIn() {
        return this.user !== undefined;
    }
    signIn(user) {
        this.username = user.username;
        if (this.domain !== undefined && this.app.zones.getZoneByName(this.domain) === undefined) {
            this.domain = undefined;
        }
    }
    signOut() {
        this.username = undefined;
    }
    requireUser() {
        const user = this.user;
        if (!user)
            throw new CliError('sign in first: `login`');
        return user;
    }
    /** Domain/record writes need the admin or dns role. */
    requireManager() {
        const user = this.requireUser();
        if (!this.app.users.canManageZones(user)) {
            throw new CliError(`@${user.username} has role "${user.role}"; changing zones needs admin or dns`);
        }
        return user;
    }
    requireAdmin() {
        const user = this.requireUser();
        if (user.role !== 'admin') {
            throw new CliError(`@${user.username} has role "${user.role}"; this needs an admin`);
        }
        return user;
    }
    requireServer() {
        if (!this.server)
            throw new CliError('the DNS server is not running: start it with `serve`');
        return this.server;
    }
    /**
     * Zone used by `record` and `lookup` when no name is given: the active
     * domain, else the only zone in the database.
     */
    activeZone() {
        if (this.domain !== undefined) {
            const zone = this.app.zones.getZoneByName(this.domain);
            if (zone)
                return zone;
            this.domain = undefined;
        }
        const zones = this.app.zones.listZones();
        return zones.length === 1 ? zones[0] : undefined;
    }
}
let context;
/**
 * One database connection and one session for the whole process. One-shot runs
 * can sign in up front with MICRONIC_USERNAME / MICRONIC_PASSWORD; the shell
 * ignores them once it has a session of its own.
 */
export function cli() {
    if (!context) {
        const app = openApp();
        const session = new Session(app);
        context = { app, session };
        const username = process.env.MICRONIC_USERNAME;
        const password = process.env.MICRONIC_PASSWORD;
        if (username && password) {
            const user = app.users.authenticate(username, password);
            if (user)
                session.signIn(user);
            else
                console.error(`! MICRONIC_USERNAME/MICRONIC_PASSWORD do not match an account; continuing signed out`);
        }
    }
    return context;
}
export function closeCli() {
    if (!context)
        return;
    try {
        context.app.db.close();
    }
    catch {
        // Closing twice (or after an abrupt exit) is harmless.
    }
    context = undefined;
}
/** True while the interactive shell owns the terminal. */
let shellMode = false;
export function setShellMode(value) {
    shellMode = value;
}
export function inShell() {
    return shellMode;
}
/** `~/.micronic/history`; the history file is a convenience only. */
export function historyFile() {
    return path.join(os.homedir(), SETTINGS.configDir, 'history');
}
let activePrompter;
let stdio;
let closeStdio;
/** Install or remove the prompt handlers used by `prompts()`. */
export function usePrompter(io) {
    activePrompter = io ?? undefined;
}
/** The prompter for the current context: the shell's, or the stdio one. */
export function prompts() {
    if (activePrompter)
        return activePrompter;
    stdio ??= stdioPrompter();
    return stdio;
}
/** Release the one-shot readline so the process can exit. */
export function closePrompts() {
    closeStdio?.();
    closeStdio = undefined;
    stdio = undefined;
}
/** Reject an empty answer: Enter means the command was cancelled. */
export function answer(value, label) {
    const trimmed = value.trim();
    if (trimmed === '')
        throw new CliError(`${label} is required.`);
    return trimmed;
}
/**
 * Prompter for one-shot runs. One readline serves every question: opening and
 * closing an interface per question drops piped answers that were already
 * buffered. The shell never uses this; `closePrompts` releases it at exit.
 */
export function stdioPrompter() {
    let rl;
    const queued = [];
    let waiter;
    const ensure = () => {
        if (rl)
            return rl;
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: Boolean(process.stdin.isTTY),
        });
        rl.on('line', (line) => {
            if (waiter) {
                const resolve = waiter;
                waiter = undefined;
                resolve(line);
            }
            else {
                queued.push(line);
            }
        });
        // EOF: answer with an empty line so a command cancels instead of hanging.
        rl.on('close', () => {
            if (waiter) {
                const resolve = waiter;
                waiter = undefined;
                resolve('');
            }
        });
        return rl;
    };
    const nextLine = () => {
        ensure();
        const ready = queued.shift();
        if (ready !== undefined)
            return Promise.resolve(ready);
        return new Promise((resolve) => {
            waiter = resolve;
        });
    };
    const ask = async (question) => {
        const iface = ensure();
        if (process.stdin.isTTY) {
            iface.setPrompt(question);
            iface.prompt();
            return (await nextLine()).trim();
        }
        process.stdout.write(`${question}\n`);
        return (await nextLine()).trim();
    };
    const secret = async (question) => {
        if (!process.stdin.isTTY) {
            process.stdout.write(`${question}\n`);
            return nextLine();
        }
        const iface = ensure();
        const internal = iface;
        const echo = internal._writeToOutput;
        iface.setPrompt(question);
        iface.prompt();
        internal._writeToOutput = () => { };
        try {
            return await nextLine();
        }
        finally {
            internal._writeToOutput = echo;
            process.stdout.write('\n');
        }
    };
    const confirm = async (question, fallback = false) => {
        const typed = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
        if (typed === '')
            return fallback;
        return typed === 'y' || typed === 'yes';
    };
    closeStdio = () => {
        queued.length = 0;
        waiter = undefined;
        rl?.close();
        rl = undefined;
    };
    return { ask, secret, confirm };
}
//# sourceMappingURL=context.js.map