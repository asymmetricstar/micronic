/**
 * Help output: the boxed wordmark with every command by group, and a focused
 * page for one command. Both are rendered from the command table, so the help
 * can never drift away from what is actually implemented.
 */
import { logoBox, logoTiny } from './logo.js';
import { BIN, SETTINGS } from './settings.js';
import { bold, gold, dim, faint } from './theme.js';
const ENV = (name) => `${SETTINGS.envPrefix}_${name}`;
/** `--version`: one line, no logo, safe for scripts. */
export function printVersion() {
    console.log(logoTiny());
}
export function fullHelpText(commands, groups) {
    const nameWidth = Math.max(...commands.map((command) => command.name.length));
    const aliasLabels = commands.map((command) => command.aliases?.length ? `(${command.aliases.join(', ')})` : '');
    const aliasWidth = Math.max(...aliasLabels.map((label) => label.length));
    const out = [''];
    out.push(logoBox());
    out.push('');
    out.push(`  ${dim('usage')}  ${gold(BIN)} ${dim('<command> [options]')}`);
    out.push(`         ${gold(BIN)}                ${dim('start the interactive shell')}`);
    for (const group of groups) {
        const inGroup = commands.filter((command) => command.group === group);
        if (inGroup.length === 0)
            continue;
        out.push('');
        out.push(`  ${gold('●')} ${bold(group)}`);
        for (const command of inGroup) {
            const index = commands.indexOf(command);
            const alias = aliasWidth === 0 ? '' : `${faint((aliasLabels[index] ?? '').padEnd(aliasWidth))}  `;
            out.push(`    ${gold(command.name.padEnd(nameWidth))}  ${alias}${command.summary}`);
        }
    }
    const section = (heading) => {
        out.push('');
        out.push(`  ${gold('●')} ${bold(heading)}`);
    };
    section('Options');
    const globalOptions = [
        ['--help', 'Help for one command'],
        ['--version', 'Version without the banner'],
        ['--daemon', 'Headless DNS + API start (no shell)'],
    ];
    const optionWidth = Math.max(...globalOptions.map(([name]) => name.length));
    for (const [name, summary] of globalOptions) {
        out.push(`    ${dim(name.padEnd(optionWidth))}  ${dim(summary)}`);
    }
    section('Shell');
    out.push(`    ${dim('help · clear · exit')}   ${faint('↑↓ history · tab complete · Ctrl+C cancels')}`);
    section('Environment');
    out.push(`    ${dim(`${ENV('HOST')} · ${ENV('PORT')} · ${ENV('TTL')} · ${ENV('DB')}`)}`);
    out.push(`    ${dim(`${ENV('ADMIN_PASSWORD')} · ${ENV('SEED_ZONE')} · ${ENV('SEED_IP')}`)}`);
    out.push(`    ${dim(`${ENV('USERNAME')} · ${ENV('PASSWORD')}`)}   ${faint('one-shot auto-login')}`);
    out.push('');
    return out.join('\n');
}
export function printFullHelp(commands, groups) {
    console.log(fullHelpText(commands, groups));
}
/** `help <command>` and `<command> --help`. */
export function printCommandHelp(spec) {
    const out = [''];
    out.push(`  ${dim('usage')}  ${gold(BIN)} ${dim(spec.usage)}`);
    if (spec.aliases?.length) {
        out.push(`         ${dim('alias')}  ${spec.aliases.join(', ')}`);
    }
    if (spec.notes) {
        out.push('');
        for (const line of spec.notes.split('\n'))
            out.push(`  ${dim(line)}`);
    }
    const section = (heading) => {
        out.push('');
        out.push(`  ${gold('●')} ${bold(heading)}`);
    };
    if (spec.actions?.length) {
        section('Actions');
        const width = Math.max(...spec.actions.map((action) => action.name.length));
        for (const action of spec.actions) {
            out.push(`    ${gold(action.name.padEnd(width))}  ${action.summary}`);
        }
    }
    section('Options');
    const label = (flag) => {
        const short = flag.short === undefined ? '    ' : `-${flag.short}, `;
        return `${short}--${flag.name}${flag.value === undefined ? '' : ` ${flag.value}`}`;
    };
    const flags = spec.flags ?? [];
    const optionWidth = Math.max('-h, --help'.length, ...flags.map((flag) => label(flag).length));
    for (const flag of flags) {
        out.push(`    ${dim(label(flag).padEnd(optionWidth))}  ${flag.summary}`);
    }
    out.push(`    ${dim('-h, --help'.padEnd(optionWidth))}  ${'Show this help'}`);
    if (spec.examples?.length) {
        section('Examples');
        for (const example of spec.examples)
            out.push(`    ${dim(`${BIN} ${example}`)}`);
    }
    out.push('');
    console.log(out.join('\n'));
}
//# sourceMappingURL=help.js.map