/**
 * Interactive shell: the same commands as the one-shot CLI, with history, tab
 * completion and a prompt. It owns stdin, so commands ask their questions
 * through the prompter installed here instead of opening a second readline.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { cli, closeCli, errorMessage, historyFile, setShellMode, usePrompter, } from './context.js';
import { COMMANDS, GROUPS, commandNames, dispatch, findCommand } from './registry.js';
import { shellBanner } from './banner.js';
import { printCommandHelp, printFullHelp, printVersion } from './help.js';
import { BIN } from './settings.js';
import { accentGold, accentGreen, dim, errorMark, faint, warn } from './theme.js';
import { startApi, startListener, stopServer } from './commands/server.js';
const HISTORY_LIMIT = 500;
const EXIT_WORDS = ['exit', 'quit', 'q', ':q'];
/** Split a line into arguments, keeping quoted phrases in one argument. */
function tokenize(line) {
    const tokens = [];
    let current = '';
    let quote = null;
    let started = false;
    for (const char of line) {
        if (quote !== null) {
            if (char === quote)
                quote = null;
            else
                current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            started = true;
            continue;
        }
        if (char === ' ' || char === '\t') {
            if (started || current !== '') {
                tokens.push(current);
                current = '';
                started = false;
            }
            continue;
        }
        current += char;
        started = true;
    }
    if (started || current !== '')
        tokens.push(current);
    return tokens;
}
/** Previous lines, oldest first; the history file is a convenience only. */
function readHistory() {
    try {
        return fs
            .readFileSync(historyFile(), 'utf8')
            .split(/\r?\n/)
            .filter((line) => line.trim() !== '')
            .slice(-HISTORY_LIMIT);
    }
    catch {
        return [];
    }
}
function writeHistory(entries) {
    const oldestFirst = [...entries].reverse().slice(-HISTORY_LIMIT);
    if (oldestFirst.length === 0)
        return;
    try {
        fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
        fs.writeFileSync(historyFile(), `${oldestFirst.join('\n')}\n`, 'utf8');
    }
    catch {
        // Losing the history file must never break the shell.
    }
}
function shellState() {
    const { app, session } = cli();
    let zones = 0;
    let records = 0;
    let users = 0;
    try {
        zones = app.zones.listZones().length;
        records = app.zones.listRecords().length;
        users = app.users.listUsers().length;
    }
    catch {
        // A banner is not worth failing the shell over.
    }
    const user = session.user;
    return {
        host: session.server?.host ?? app.host,
        port: session.server?.port ?? app.port,
        listening: session.server !== undefined,
        apiEnabled: app.apiEnabled,
        apiListening: session.api !== undefined,
        apiHost: session.api?.host ?? app.host,
        apiPort: session.api?.port ?? app.apiPort,
        database: app.dbPath,
        zones,
        records,
        users,
        username: user?.username,
        role: user?.role,
        domain: session.domain,
    };
}
/** `admin@µnic:example.test $`, guest in blue, signed-in user in green. */
function promptText() {
    const { session } = cli();
    let user = 'guest';
    let signedIn = false;
    try {
        const current = session.user;
        if (current) {
            user = current.username;
            signedIn = true;
        }
    }
    catch {
        // Fall back to the guest prompt.
    }
    const place = session.domain ?? '~';
    const colour = signedIn ? accentGreen : accentGold;
    return `${colour(user)}${faint('@')}${accentGold(BIN)}${dim(`:${place}`)} ${faint('$')} `;
}
/** Commands and, after one is typed, its actions or flags. */
function complete(line) {
    const tokens = line.split(/\s+/);
    const current = tokens[tokens.length - 1] ?? '';
    const first = tokens[0] ?? '';
    let pool;
    if (tokens.length <= 1) {
        pool = [...commandNames(), ...EXIT_WORDS.slice(0, 1), 'clear', 'help', 'version'];
    }
    else {
        const command = findCommand(first);
        if (tokens.length === 2 && command?.actions) {
            pool = command.actions.map((action) => action.name);
        }
        else if (current.startsWith('-') && command?.flags) {
            pool = command.flags.map((flag) => `--${flag.name}`);
        }
        else {
            pool = [];
        }
    }
    const hits = [...new Set(pool)].filter((candidate) => candidate.startsWith(current)).sort();
    if (hits.length === 0)
        return [[], current];
    // A single match is completed with a trailing space, ready for its arguments.
    return [hits.length === 1 ? [`${hits[0]} `] : hits, current];
}
function printHeader(terminal) {
    console.log(shellBanner(shellState()));
    for (const message of cli().app.notes) {
        console.log(`  ${faint('#')} ${dim(message)}`);
    }
    console.log('');
    if (terminal)
        console.log(`  ${faint('↑↓ history   tab complete   clear to reset')}`);
}
/** Wipe the screen and the scrollback, so the shell opens on a clean page. */
function clearScreen() {
    process.stdout.write('\u001b[2J\u001b[3J\u001b[H');
}
export async function startShell() {
    const terminal = Boolean(process.stdin.isTTY);
    setShellMode(true);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal,
        history: readHistory(),
        historySize: HISTORY_LIMIT,
        removeHistoryDuplicates: true,
        completer: complete,
    });
    /** stdin reached EOF or the user asked to leave; the queue still finishes. */
    let inputClosed = false;
    let draining = false;
    /**
     * Lines read ahead but not yet used. The same queue feeds commands (when the
     * shell is idle) and a running command's questions, because piped input is
     * read faster than a command can prompt.
     */
    const lines = [];
    /** Set while a running command is waiting for an answer. */
    let pending = null;
    const finishPending = (value) => {
        const current = pending;
        pending = null;
        if (current === null)
            return;
        current.resolve(value);
    };
    const askLine = (question) => new Promise((resolve) => {
        if (lines.length > 0) {
            const value = lines.shift();
            process.stdout.write(`${question}${value}\n`);
            resolve(value);
            return;
        }
        rl.setPrompt(question);
        rl.prompt();
        pending = { resolve };
    });
    const askSecretLine = (question) => new Promise((resolve) => {
        if (lines.length > 0) {
            // Never echo a buffered secret; the question alone is enough.
            process.stdout.write(`${question}\n`);
            resolve(lines.shift());
            return;
        }
        const internal = rl;
        // Capture the real echo function before overriding it, draw the question
        // through readline, then hide what is typed.
        const echo = internal._writeToOutput;
        rl.setPrompt(question);
        rl.prompt();
        internal._writeToOutput = () => { };
        pending = {
            resolve: (value) => {
                internal._writeToOutput = echo;
                process.stdout.write('\n');
                resolve(value);
            },
        };
    });
    const prompter = {
        ask: askLine,
        secret: askSecretLine,
        confirm: async (question, fallback = false) => {
            const typed = (await askLine(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
            if (typed.trim() === '')
                return fallback;
            return typed === 'y' || typed === 'yes';
        },
    };
    const prompt = () => {
        if (inputClosed)
            return;
        rl.setPrompt(promptText());
        rl.prompt();
    };
    const runBuiltin = (word, rest) => {
        switch (word) {
            case 'help': {
                const target = rest[0] === undefined ? undefined : findCommand(rest[0]);
                if (target)
                    printCommandHelp(target);
                else
                    printFullHelp(COMMANDS, GROUPS);
                return true;
            }
            case 'clear':
                if (terminal) {
                    clearScreen();
                    printHeader(terminal);
                }
                else {
                    process.stdout.write('\n');
                }
                return true;
            case 'version':
                printVersion();
                return true;
            default:
                return false;
        }
    };
    /** Returns true when the shell should stop. */
    const handleLine = async (raw) => {
        const input = raw.trim();
        if (input === '') {
            prompt();
            return false;
        }
        const [word, ...args] = tokenize(input);
        if (word === undefined) {
            prompt();
            return false;
        }
        if (EXIT_WORDS.includes(word)) {
            inputClosed = true;
            rl.close();
            return true;
        }
        if (runBuiltin(word, args)) {
            prompt();
            return false;
        }
        // Commands keep printing on their own; only their questions come back here.
        usePrompter(prompter);
        try {
            await dispatch([word, ...args]);
        }
        catch (error) {
            console.log(`${errorMark(errorMessage(error))}`);
        }
        finally {
            usePrompter(null);
            prompt();
        }
        return false;
    };
    const drain = async () => {
        if (draining)
            return;
        draining = true;
        try {
            while (lines.length > 0) {
                const line = lines.shift();
                if (line === undefined)
                    break;
                if (await handleLine(line))
                    break;
            }
        }
        finally {
            draining = false;
        }
    };
    /** Answers typed at a command's prompt are not kept, and a password must
     * never reach the history file. */
    const dropFromHistory = (answer) => {
        const history = rl.history;
        if (history !== undefined && history[0] === answer)
            history.shift();
    };
    rl.on('line', (line) => {
        if (pending !== null) {
            finishPending(line);
            dropFromHistory(line);
            return;
        }
        lines.push(line);
        void drain();
    });
    rl.on('SIGINT', () => {
        if (pending !== null) {
            // Cancel the question; the command reports the empty answer itself.
            finishPending('');
            return;
        }
        if (draining)
            return;
        if (rl.line.trim() !== '') {
            rl.write(null, { ctrl: true, name: 'u' });
            process.stdout.write('\n');
            prompt();
            return;
        }
        process.stdout.write('\n');
        rl.close();
    });
    rl.on('close', () => {
        inputClosed = true;
        if (pending !== null)
            finishPending('');
        // Piped runs are automation: keep their answers and commands out of the
        // history file (a password could be in there).
        if (terminal)
            writeHistory(rl.history);
        if (terminal)
            process.stdout.write('\n');
    });
    // The DNS server starts with the shell, so `npm start` serves DNS without a
    // `serve start`. A listen failure is reported but never stops the console.
    let bootError;
    let apiError;
    try {
        await startListener();
    }
    catch (error) {
        bootError = errorMessage(error);
    }
    try {
        await startApi();
    }
    catch (error) {
        apiError = errorMessage(error);
    }
    // Clear whatever was on screen before the shell took over.
    if (terminal)
        clearScreen();
    printHeader(terminal);
    if (bootError !== undefined)
        console.error(warn(`DNS server not started: ${bootError}`));
    if (apiError !== undefined)
        console.error(warn(`API server not started: ${apiError}`));
    prompt();
    await new Promise((resolve) => rl.once('close', resolve));
    // Let queued and running commands finish before the DB goes away.
    while (draining || lines.length > 0)
        await new Promise((resolve) => setTimeout(resolve, 10));
    try {
        await stopServer();
    }
    catch (error) {
        console.error(`${errorMark(`could not stop the DNS server: ${errorMessage(error)}`)}`);
    }
    setShellMode(false);
    closeCli();
}
//# sourceMappingURL=repl.js.map