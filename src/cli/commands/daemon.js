/**
 * Headless mode: bind the DNS listener (and the HTTP API when enabled) without
 * opening the interactive shell. It is meant for service managers and
 * containers, so it prints exactly one readiness line and stays in the
 * foreground until SIGINT/SIGTERM:
 *
 *   Server Running 127.0.0.1:53
 *
 * Reached with `micronic --daemon` (also `npm start -- --daemon` and
 * `micronic serve --daemon`).
 */
import { CliError, errorMessage } from '../context.js';
import { flagValue, hasFlag, numberFlag, parseCommandArgs } from '../args.js';
import { printCommandHelp } from '../help.js';
import { startApi, startListener, stopServer } from './server.js';
const daemonSpec = {
    name: 'daemon',
    group: 'Server',
    summary: 'Headless DNS + API start, no shell, one readiness line',
    usage: '--daemon [--host <addr>] [--port <port>] [--api-port <port>] [--no-api]',
    notes: 'Starts the DNS listener and, when `settings.api` is on, the HTTP API without opening\n' +
        'the interactive shell. Prints one line ("Server Running <ip>:<port>") and stays in the\n' +
        'foreground until SIGINT/SIGTERM, so systemd, Docker or a process manager can supervise it.',
    flags: [
        { name: 'host', value: '<addr>', summary: 'Listen address (default settings.host)' },
        { name: 'port', value: '<port>', summary: 'DNS UDP+TCP port (default settings.port)' },
        { name: 'api-port', value: '<port>', summary: 'HTTP API port (default settings.api_port)' },
        { name: 'no-api', summary: 'Do not start the HTTP API' },
    ],
    examples: ['--daemon', '--daemon --port 53', '--daemon --no-api', 'serve --daemon'],
    // The entry point calls runDaemon directly; this keeps CommandSpec satisfied
    // if the spec is ever reused for help output.
    run: async () => { },
};
export async function runDaemon(argv) {
    const args = parseCommandArgs(argv, daemonSpec);
    if (hasFlag(args, 'help'))
        return printCommandHelp(daemonSpec);
    if (args.positionals.length > 0) {
        throw new CliError(`--daemon does not take a command (got "${args.positionals.join(' ')}")`);
    }
    const host = flagValue(args, 'host');
    const port = numberFlag(args, 'port', 0, 65535);
    const apiPort = numberFlag(args, 'api-port', 1, 65535);
    const noApi = hasFlag(args, 'no-api');
    const address = await startListener({ host, port });
    console.log(`Server Running ${address.host}:${address.port}`);
    if (!noApi) {
        try {
            await startApi({ host, apiPort });
        }
        catch (error) {
            console.error(`! API server not started: ${errorMessage(error)}`);
        }
    }
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
}
//# sourceMappingURL=daemon.js.map