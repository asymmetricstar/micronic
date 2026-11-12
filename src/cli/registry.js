/**
 * One table drives the entry point, `help`, tab completion and dispatch, so a
 * new command only has to be added here.
 */
import { CliError } from './context.js';
import { loginSpec, logoutSpec, registerSpec, whoamiSpec } from './commands/auth.js';
import { domainSpec } from './commands/domain.js';
import { recordSpec } from './commands/record.js';
import { endpointSpec } from './commands/endpoint.js';
import { lookupSpec } from './commands/lookup.js';
import { serveSpec } from './commands/server.js';
import { statusSpec } from './commands/status.js';
import { userSpec } from './commands/user.js';
import { configSpec } from './commands/config.js';
export const GROUPS = ['Account', 'Domains', 'Records', 'Server', 'Config'];
export const COMMANDS = [
    loginSpec,
    registerSpec,
    logoutSpec,
    whoamiSpec,
    domainSpec,
    lookupSpec,
    recordSpec,
    endpointSpec,
    serveSpec,
    statusSpec,
    userSpec,
    configSpec,
];
/** Commands the interactive shell handles itself. */
export const SHELL_BUILTINS = ['clear', 'exit', 'help', 'version'];
/** Look a command up by name or alias, case-insensitively. */
export function findCommand(name) {
    const needle = name.trim().toLowerCase();
    if (needle === '')
        return undefined;
    return COMMANDS.find((command) => command.name === needle || command.aliases?.includes(needle) === true);
}
/** Every accepted command word, sorted, for completion. */
export function commandNames() {
    const names = COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
    return [...new Set(names)].sort();
}
/** Run one command line; unknown names fail like the one-shot CLI does. */
export async function dispatch(argv) {
    const [name, ...rest] = argv;
    const command = name === undefined ? undefined : findCommand(name);
    if (command === undefined) {
        const label = name === undefined ? '' : ` '${name}'`;
        throw new CliError(`unknown command${label}. Type \`help\` to list the commands.`);
    }
    await command.run(rest, command);
}
//# sourceMappingURL=registry.js.map