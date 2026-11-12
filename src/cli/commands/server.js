/**
 * The DNS listener. Inside the shell `serve` starts the UDP+TCP server in the
 * background and returns to the prompt; as a one-shot command it keeps the
 * process open until Ctrl+C.
 */
import { DnsServer } from '../../server/dns-server.js';
import { ApiServer } from '../../server/http-api.js';
import { CliError, cli, errorMessage, inShell } from '../context.js';
import { flagValue, hasFlag, numberFlag, parseCommandArgs } from '../args.js';
import { printCommandHelp } from '../help.js';
import { SETTINGS } from '../settings.js';
import { bold, caution, gold, dim, field, formatDate, note, success } from '../theme.js';
/** Stop the HTTP API and DNS listener started in this session, if any. */
export async function stopServer() {
    const { session } = cli();
    const api = session.api;
    const running = session.server;
    session.api = undefined;
    session.server = undefined;
    try {
        if (api)
            await api.instance.stop();
    }
    finally {
        if (running)
            await running.instance.stop();
    }
}
/**
 * Start the DNS listener and remember it in the session. Idempotent: when a
 * server is already up its address is returned. Throws CliError when the
 * address cannot be opened, so the shell can report it and keep running.
 *
 * The shell calls this on start-up, which is why `npm start` serves DNS without
 * a `serve start`; the `serve` command uses the same path with its flags.
 */
export async function startListener(options = {}) {
    const { app, session } = cli();
    if (session.server)
        return { host: session.server.host, port: session.server.port };
    const host = options.host ?? app.host;
    const port = options.port ?? app.port;
    const instance = new DnsServer({
        zones: app.zones,
        host,
        port,
        ttl: app.ttl,
        logger: options.verbose ? (line) => console.log(dim(line)) : () => { },
    });
    try {
        const address = await instance.start();
        session.server = { instance, host: address.host, port: address.port, startedAt: Date.now() };
        return address;
    }
    catch (error) {
        throw new CliError(`cannot listen on ${host}:${port}: ${error.message}`);
    }
}
/**
 * Start the HTTP API when `settings.api` is on. Returns undefined when the API
 * is disabled, otherwise the bound address. A failure is thrown as CliError so
 * the shell can warn without losing the DNS listener.
 */
export async function startApi(options = {}) {
    const { app, session } = cli();
    if (!app.apiEnabled || options.api === false)
        return undefined;
    if (session.api)
        return { host: session.api.host, port: session.api.port };
    const host = options.host ?? app.host;
    const port = options.apiPort ?? app.apiPort;
    const instance = new ApiServer({
        zones: app.zones,
        users: app.users,
        tokens: app.tokens,
        ttl: app.ttl,
        version: SETTINGS.version,
        host,
        port,
        dns: session.server === undefined ? null : { host: session.server.host, port: session.server.port },
        logger: options.verbose ? (line) => console.log(dim(line)) : () => { },
    });
    try {
        const address = await instance.start();
        session.api = { instance, host: address.host, port: address.port, startedAt: Date.now() };
        return address;
    }
    catch (error) {
        throw new CliError(`cannot listen on http://${host}:${port}: ${error.message}`);
    }
}
async function startServer(args) {
    const { app, session } = cli();
    const host = flagValue(args, 'host') ?? app.host;
    const port = numberFlag(args, 'port', 0, 65535) ?? app.port;
    const apiPort = numberFlag(args, 'api-port', 1, 65535);
    const wantsApi = !hasFlag(args, 'no-api');
    if (session.server) {
        note(`already listening on ${gold(`${session.server.host}:${session.server.port}`)}`);
    }
    else {
        const address = await startListener({ host, port, verbose: hasFlag(args, 'verbose') });
        success(`DNS server listening on ${bold(`${address.host}:${address.port}`)} ${dim('(udp+tcp)')}`);
        note(`${app.zones.listZones().length} zone(s) · ${app.zones.listRecords().length} record(s) · ${app.dbPath}`);
    }
    if (!wantsApi) {
        note('HTTP API skipped for this run (--no-api)');
    }
    else if (!app.apiEnabled) {
        note('HTTP API is disabled; enable it with `config set api on`');
    }
    else {
        try {
            const api = await startApi({ host, apiPort, verbose: hasFlag(args, 'verbose') });
            if (api)
                success(`API listening on ${bold(`http://${api.host}:${api.port}`)} ${dim('/api/v1')}`);
        }
        catch (error) {
            caution(`API server not started: ${errorMessage(error)}`);
        }
    }
    if (!inShell()) {
        note('press Ctrl+C to stop');
        await new Promise((resolve) => {
            const done = () => {
                process.off('SIGINT', done);
                process.off('SIGTERM', done);
                resolve();
            };
            process.on('SIGINT', done);
            process.on('SIGTERM', done);
        });
        await stopServer();
        note('servers stopped');
    }
}
function statusServer() {
    const { app, session } = cli();
    const running = session.server;
    const api = session.api;
    if (!running) {
        console.log(field('state', dim('stopped')));
    }
    else {
        const uptime = Math.max(0, Math.round((Date.now() - running.startedAt) / 1000));
        console.log(field('state', `${gold('listening')} ${dim('(udp+tcp)')}`));
        console.log(field('address', bold(`${running.host}:${running.port}`)));
        console.log(field('uptime', dim(`${Math.floor(uptime / 60)}m ${uptime % 60}s`)));
        console.log(field('since', formatDate(running.startedAt)));
    }
    if (!app.apiEnabled) {
        console.log(field('api', dim('disabled')));
    }
    else if (api) {
        console.log(field('api', bold(`http://${api.host}:${api.port}`)));
        console.log(field('api since', dim(formatDate(api.startedAt))));
    }
    else {
        console.log(field('api', dim('stopped')));
    }
    if (!running && !api)
        note('start it with `serve`');
}
export const serveSpec = {
    name: 'serve',
    aliases: ['server'],
    group: 'Server',
    summary: 'Start, stop or inspect the DNS listener and HTTP API',
    usage: 'serve <start|stop|restart|status> [options]',
    notes: 'Inside the shell the listener runs in the background of this process, so `lookup --live`\n' +
        'and the prompt keep working. Started as a one-shot command it stays in the foreground\n' +
        'until Ctrl+C. Defaults come from MICRONIC_HOST and MICRONIC_PORT. When `settings.api`\n' +
        'is on, the REST API starts too (see `config set api` / `api_port`).',
    actions: [
        { name: 'start', summary: 'Open UDP and TCP on the configured address' },
        { name: 'stop', summary: 'Close the sockets' },
        { name: 'restart', summary: 'Stop, then start again' },
        { name: 'status', summary: 'Show listener state, address and uptime' },
    ],
    flags: [
        { name: 'host', value: '<addr>', summary: 'Listen address (default MICRONIC_HOST)' },
        { name: 'port', value: '<port>', summary: 'Port for UDP and TCP (default MICRONIC_PORT)' },
        { name: 'api-port', value: '<port>', summary: 'HTTP API port for this run (default settings.api_port)' },
        { name: 'no-api', summary: 'Skip the HTTP API for this run' },
        { name: 'verbose', summary: 'Log every query the server answers' },
    ],
    examples: [
        'serve',
        'serve start',
        'serve start --port 5354',
        'serve restart',
        'serve status',
        'serve stop',
        'serve start --no-api',
    ],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const action = args.positionals[0] ?? 'start';
        switch (action) {
            case 'start':
            case 'up':
                return startServer(args);
            case 'stop':
            case 'down': {
                const { session } = cli();
                if (!session.server && !session.api) {
                    note('the servers are not running');
                    return;
                }
                const hadApi = session.api !== undefined;
                await stopServer();
                success(hadApi ? 'DNS and API servers stopped' : 'DNS server stopped');
                return;
            }
            case 'restart':
                await stopServer();
                return startServer(args);
            case 'status':
            case 'info':
                return statusServer();
            default:
                throw new CliError(`unknown serve action "${action}"; try: start, stop, restart, status`);
        }
    },
};
//# sourceMappingURL=server.js.map