/**
 * CLI entry: bare `micronic` opens the interactive shell when a person is at
 * the terminal (piped runs still get `help`), and every other word is a
 * command that can run one-shot.
 */
import { CliError } from './context.js';
import { COMMANDS, GROUPS, dispatch, findCommand } from './registry.js';
import { printCommandHelp, printFullHelp, printVersion } from './help.js';
import { startShell } from './repl.js';
import { runDaemon } from './commands/daemon.js';
export function isInteractive() {
    return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}
export async function main(argv) {
    const [command, ...rest] = argv;
    // `serve --daemon` is accepted as a convenience alias for the same mode.
    if (command === 'serve' && rest.includes('--daemon')) {
        return runDaemon(rest.filter((arg) => arg !== '--daemon'));
    }
    // `--daemon` is a global mode, not a command: it never opens the shell.
    if (argv.includes('--daemon')) {
        return runDaemon(argv.filter((arg) => arg !== '--daemon'));
    }
    if (command === undefined) {
        // Bare `micronic` opens the shell; piped runs still get the help output.
        if (isInteractive())
            return startShell();
        printFullHelp(COMMANDS, GROUPS);
        return;
    }
    if (command === 'help' || command === '--help' || command === '-h' || command === '?') {
        if (rest[0] !== undefined) {
            const target = findCommand(rest[0]);
            if (!target)
                throw new CliError(`unknown command '${rest[0]}'. Type \`help\` to list the commands.`);
            return printCommandHelp(target);
        }
        return printFullHelp(COMMANDS, GROUPS);
    }
    if (command === '--version' || command === '-v' || command === 'version') {
        return printVersion();
    }
    if (command === 'shell' || command === 'repl') {
        return startShell();
    }
    if (command === '--') {
        throw new CliError('expected a command after `--`. Type `help` to list the commands.');
    }
    await dispatch([command, ...rest]);
}
//# sourceMappingURL=index.js.map