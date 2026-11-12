/**
 * ASCII wordmark for the MicroNic shell: three lines for the banner and a
 * boxed variant for `help`.
 */
import { bold, gold, dim, faint, box } from './theme.js';
import { SETTINGS } from './settings.js';
const NODE = '●';
const RULE = '━━━';
export const MARK = gold(SETTINGS.mark);
const NAME = `${bold(SETTINGS.name)} ${faint('•')} ${gold(SETTINGS.label)}`;
const VERSION = `v${SETTINGS.version}`;
/** One line, for `--version` and the shell's `version` builtin. */
export function logoTiny() {
    return `${MARK} ${faint('──')}${gold(NODE)}  ${NAME} ${faint('·')} ${dim(VERSION)}`;
}
/** Three lines, for the interactive shell banner. */
export function logoCompact() {
    const stem = ' '.repeat(SETTINGS.mark.length + 3);
    return [
        `  ${MARK} ${faint('━━━━')} ${gold(NODE)}`,
        `${stem}${faint(`┣${RULE}`)} ${gold(NODE)}   ${NAME}  ${dim(VERSION)}`,
        `${stem}${faint(`┗${RULE}`)} ${gold(NODE)}   ${dim(SETTINGS.tagline)}`,
    ].join('\n');
}
/** Boxed mark, for `help`. */
export function logoBox() {
    const lead = '   ';
    const stem = ' '.repeat(lead.length + SETTINGS.mark.length + 3);
    return box([
        '',
        `${lead}${MARK} ${faint('──┬─')}${gold(NODE)}`,
        `${stem}${faint('├─')}${gold(NODE)}   ${NAME}  ${dim(VERSION)}`,
        `${stem}${faint('└─')}${gold(NODE)}   ${dim(SETTINGS.tagline)}`,
        '',
        `${lead}${dim(SETTINGS.footer)} ${faint('·')} ${dim(SETTINGS.label)}`,
        `${lead}${dim(SETTINGS.description)}`,
        '',
    ]);
}
//# sourceMappingURL=logo.js.map