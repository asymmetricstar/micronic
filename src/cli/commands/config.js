/**
 * Effective runtime configuration. `host`, `port` and `ttl` live in the
 * `settings` table: the environment only seeds them on the first start, and
 * `config set` is how they change afterwards.
 */
import path from 'node:path';
import { CliError, answer, cli, errorMessage, historyFile, prompts } from '../context.js';
import { hasFlag, parseCommandArgs } from '../args.js';
import { printCommandHelp } from '../help.js';
import { SETTINGS } from '../settings.js';
import { SETTING_KEYS } from '../../lib/settings/manager.js';
import { bold, caution, dim, field, gold, note, success, title } from '../theme.js';
import { startApi, startListener, stopServer } from './server.js';
const env = (name) => dim(`${SETTINGS.envPrefix}_${name}`);
/** Validate and normalize one stored setting. */
function normalize(key, raw) {
    const value = raw.trim();
    if (value === '')
        throw new CliError(`${key} cannot be empty`);
    if (key === 'host') {
        if (/\s/.test(value))
            throw new CliError('host cannot contain whitespace');
        return value;
    }
    if (key === 'register' || key === 'api') {
        const option = value.toLowerCase();
        if (['on', 'true', '1', 'yes', 'enable', 'enabled'].includes(option))
            return 'on';
        if (['off', 'false', '0', 'no', 'disable', 'disabled'].includes(option))
            return 'off';
        throw new CliError(`${key} must be on or off (got "${raw}")`);
    }
    const number = Number(value);
    if (!Number.isInteger(number))
        throw new CliError(`${key} must be a whole number (got "${raw}")`);
    // Port 0 is only useful per run (`serve --port 0`), not as a stored value:
    // it would pick a different port on every start.
    if (number < 1 || number > 65535)
        throw new CliError(`${key} must be between 1 and 65535`);
    return String(number);
}
async function setSetting(argv) {
    const { app, session } = cli();
    const keyInput = argv[0] ?? answer(await prompts().ask(`Setting ${dim(`[${SETTING_KEYS.join('/')}]`)}: `), 'setting');
    const key = keyInput.trim().toLowerCase();
    if (!SETTING_KEYS.includes(key)) {
        throw new CliError(`unknown setting "${keyInput}"; use ${SETTING_KEYS.join(', ')}`);
    }
    const raw = argv[1] ?? answer(await prompts().ask(`Value for ${key}: `), 'value');
    const value = normalize(key, raw);
    app.settings.set(key, value);
    success(`${bold(key)} set to ${bold(value)}`);
    explainEffect(key, value, Boolean(session.server));
}
/** What a changed setting means for the running server and new records. */
function explainEffect(key, value, serverRunning) {
    if (key === 'register') {
        note(value === 'on'
            ? 'self-service `register` now creates read-only (none) accounts; the first account is always admin'
            : 'self-service `register` is closed; admins can still add people with `user add`');
        return;
    }
    if (key === 'host' || key === 'port' || key === 'api' || key === 'api_port') {
        note(serverRunning
            ? 'a server is running: `serve restart` applies the new address or API setting'
            : 'takes effect on the next `serve`');
    }
    else {
        note('new records use this TTL; restart a running server for synthesised apex records');
    }
}
/** Ask for one editable setting with its current value as the default. */
async function promptSetting(key) {
    const { app } = cli();
    const current = key === 'host'
        ? app.host
        : key === 'port'
            ? String(app.port)
            : key === 'ttl'
                ? String(app.ttl)
                : key === 'api_port'
                    ? String(app.apiPort)
                    : key === 'api'
                        ? app.settings.bool('api', true)
                            ? 'on'
                            : 'off'
                        : app.settings.bool('register', false)
                            ? 'on'
                            : 'off';
    const label = key === 'host'
        ? 'Host'
        : key === 'port'
            ? 'Port'
            : key === 'ttl'
                ? 'TTL'
                : key === 'api_port'
                    ? 'API port'
                    : key === 'api'
                        ? 'API'
                        : 'Registration';
    const typed = (await prompts().ask(`${label} [${current}]: `)).trim();
    if (typed === '') {
        note(`${label.toLowerCase()} unchanged`);
        return;
    }
    let value;
    try {
        value = normalize(key, typed);
    }
    catch (error) {
        caution(errorMessage(error));
        return;
    }
    app.settings.set(key, value);
    success(`${bold(key)} set to ${bold(value)}`);
    // A host/port change only reaches the sockets on a restart, so offer it
    // right here instead of making the user remember the follow-up command.
    const running = cli().session.server;
    if (running && ['host', 'port', 'api', 'api_port'].includes(key)) {
        const wantsRestart = await prompts().confirm(`The server is listening on ${running.host}:${running.port}. Restart the services now?`, false);
        if (!wantsRestart) {
            note('the change applies on the next `serve restart`');
            return;
        }
        try {
            await stopServer();
            const address = await startListener();
            success(`DNS server listening on ${bold(`${address.host}:${address.port}`)} ${dim('(udp+tcp)')}`);
            try {
                const api = await startApi();
                if (api)
                    success(`API listening on ${bold(`http://${api.host}:${api.port}`)}`);
            }
            catch (error) {
                caution(`API server not started: ${errorMessage(error)}`);
            }
        }
        catch (error) {
            caution(`the server could not restart: ${errorMessage(error)}`);
            note('it is stopped; fix the address and run `serve start`');
        }
        return;
    }
    explainEffect(key, value, Boolean(running));
}
/**
 * `config` without arguments: a numbered settings menu, so host, port, ttl and
 * registration are changed by picking an entry instead of typing a command.
 * Enter on an empty line, or option 7, closes the menu. No sign-in is needed.
 */
async function settingsMenu() {
    const { app } = cli();
    const io = prompts();
    const labelWidth = 18;
    for (;;) {
        const registration = app.settings.bool('register', false) ? 'on' : 'off';
        const api = app.settings.bool('api', true) ? 'on' : 'off';
        const options = [
            ['1', 'Host', app.host],
            ['2', 'Port', String(app.port)],
            ['3', 'TTL', String(app.ttl)],
            ['4', 'Registration', registration],
            ['5', 'API', api],
            ['6', 'API port', String(app.apiPort)],
            ['7', 'Show all settings', ''],
            ['8', 'Database path', ''],
            ['9', 'Exit', ''],
        ];
        console.log('');
        for (const [number, label, value] of options) {
            const suffix = value === '' ? '' : `  ${dim(value)}`;
            console.log(`  ${gold(`[${number}]`)} ${label.padEnd(labelWidth)}${suffix}`.trimEnd());
        }
        const choice = (await io.ask('\nSelect an option [1-9]: ')).trim();
        if (choice === '' || choice === '9')
            return;
        switch (choice) {
            case '1':
                await promptSetting('host');
                break;
            case '2':
                await promptSetting('port');
                break;
            case '3':
                await promptSetting('ttl');
                break;
            case '4':
                await promptSetting('register');
                break;
            case '5':
                await promptSetting('api');
                break;
            case '6':
                await promptSetting('api_port');
                break;
            case '7':
                showConfig();
                break;
            case '8':
                console.log(dim(app.dbPath));
                break;
            default:
                caution(`invalid option "${choice}"; pick 1-9`);
        }
    }
}
function showConfig() {
    const { app, session } = cli();
    const running = session.server;
    console.log(title('Listener'));
    console.log(field('host', `${app.host.padEnd(22)} ${dim('settings.host')}`));
    console.log(field('port', `${String(app.port).padEnd(22)} ${dim('settings.port')}`));
    console.log(field('ttl', `${String(app.ttl).padEnd(22)} ${dim('settings.ttl')}`));
    const registration = app.settings.bool('register', false) ? 'on' : 'off';
    console.log(field('register', `${registration.padEnd(22)} ${dim('settings.register')}`));
    const apiOn = app.settings.bool('api', true) ? 'on' : 'off';
    console.log(field('api', `${apiOn.padEnd(22)} ${dim('settings.api')}`));
    console.log(field('api port', `${String(app.apiPort).padEnd(22)} ${dim('settings.api_port')}`));
    console.log(field('state', running ? `${dim('listening on')} ${running.host}:${running.port}` : dim('stopped')));
    const api = session.api;
    console.log(field('api state', !app.apiEnabled
        ? dim('disabled')
        : api
            ? `${dim('listening on')} http://${api.host}:${api.port}`
            : dim('stopped')));
    console.log('');
    console.log(title('Storage'));
    console.log(field('database', `${app.dbPath.padEnd(22)} ${env('DB')}`));
    console.log(field('data dir', dim(path.dirname(app.dbPath))));
    console.log('');
    console.log(title('Console'));
    console.log(field('binary', dim(`${SETTINGS.bin} v${SETTINGS.version}`)));
    console.log(field('history', dim(historyFile())));
    console.log(field('cwd', dim(process.cwd())));
    note(`change these from the menu: ${bold('config')} (or ${bold('config set <key> <value>')})`);
    note(`environment seeds a setting only while it is missing (${env('HOST')}, ${env('PORT')}, ${env('TTL')}, ${env('API')}, ${env('API_PORT')})`);
}
function printDatabasePath() {
    console.log(cli().app.dbPath);
}
export const configSpec = {
    name: 'config',
    group: 'Config',
    summary: 'Open the settings menu or print the stored server settings',
    usage: 'config [menu|show|set <key> <value>|path]',
    notes: 'host, port, ttl, register, api and api_port are stored in the settings table of the\n' +
        'database, so they apply to every later run. The environment only seeds them on the\n' +
        'first start. `register` opens or closes self-service signups; `api`/`api_port`\n' +
        'control the HTTP API. No sign-in is required: the console is local. `config` with no\n' +
        'arguments opens the numbered menu; `show`, `set` and `path` remain for scripts.',
    actions: [
        { name: 'menu', summary: 'Numbered menu for host, port, ttl, registration and API (default)' },
        { name: 'show', summary: 'Print listener, storage and console settings' },
        { name: 'set', summary: 'Change one setting without the menu' },
        { name: 'path', summary: 'Print just the database path' },
    ],
    examples: [
        'config',
        'config set port 5400',
        'config set host 0.0.0.0',
        'config set ttl 60',
        'config set register on',
        'config set api off',
        'config set api_port 8080',
        'config path',
    ],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const action = args.positionals[0] ?? 'menu';
        switch (action) {
            case 'menu':
                return settingsMenu();
            case 'set':
                return setSetting(args.positionals.slice(1));
            case 'show':
            case 'info':
                return showConfig();
            case 'path':
                return printDatabasePath();
            default:
                throw new CliError(`unknown config action "${action}"; try: menu, show, set, path`);
        }
    },
};
//# sourceMappingURL=config.js.map