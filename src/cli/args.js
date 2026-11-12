/**
 * Minimal option parser for the shell commands: positionals plus `--flag`,
 * `--flag value` and `--flag=value`. Every command accepts `-h/--help`
 * without declaring it.
 */
import { CliError } from './context.js';
export function parseCommandArgs(argv, spec) {
    const known = new Map();
    known.set('help', { name: 'help' });
    known.set('h', { name: 'help' });
    for (const flag of spec.flags ?? []) {
        known.set(flag.name, { name: flag.name, value: flag.value });
        if (flag.short !== undefined)
            known.set(flag.short, { name: flag.name, value: flag.value });
    }
    const positionals = [];
    const values = new Map();
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') {
            positionals.push(...argv.slice(index + 1));
            break;
        }
        if (arg === '-' || !arg.startsWith('-')) {
            positionals.push(arg);
            continue;
        }
        const raw = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
        const equals = raw.indexOf('=');
        const key = equals === -1 ? raw : raw.slice(0, equals);
        const option = known.get(key);
        if (option === undefined) {
            throw new CliError(`unknown option ${arg} for \`${spec.name}\`; try \`help ${spec.name}\``);
        }
        if (option.value === undefined) {
            if (equals !== -1)
                throw new CliError(`option ${arg} does not take a value`);
            values.set(option.name, true);
            continue;
        }
        const inline = equals === -1 ? undefined : raw.slice(equals + 1);
        const value = inline ?? argv[++index];
        if (value === undefined || value === '') {
            throw new CliError(`option --${option.name} needs ${option.value}`);
        }
        values.set(option.name, value);
    }
    return { positionals, values };
}
export function hasFlag(args, name) {
    return args.values.get(name) === true;
}
export function flagValue(args, name) {
    const value = args.values.get(name);
    return typeof value === 'string' ? value : undefined;
}
/** A whole number flag, or undefined when it was not given. */
export function numberFlag(args, name, min = 0, max = 2_147_483_647) {
    const raw = flagValue(args, name);
    if (raw === undefined)
        return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new CliError(`--${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    }
    return value;
}
//# sourceMappingURL=args.js.map