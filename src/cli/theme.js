/**
 * Terminal presentation helpers for the MicroNic shell.
 *
 * Colours follow a GitHub-dark 256-colour palette, and every escape code
 * disappears when stdout is not a TTY (or when NO_COLOR is set), so piped
 * output stays clean.
 */
const colour = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const paint = (spec) => (text) => colour ? `\u001b[${spec}m${text}\u001b[0m` : text;
/** Structural lines and separators. */
export const faint = paint('38;5;240');
/** Secondary text, metadata and hints. */
export const dim = paint('38;5;246');
export const bold = paint('1');
export const red = paint('38;5;203');
export const green = paint('38;5;114');
export const yellow = paint('38;5;179');
/** The single accent colour: nodes, command names, links (#fad83b family). */
export const gold = paint('38;5;221');
export const magenta = paint('38;5;176');
/** Brand colours, truecolour so the exact hex survives. */
const paintHex = (r, g, b) => paint(`38;2;${r};${g};${b}`);
export const accentGreen = paintHex(0x17, 0xb8, 0x8b);
export const accentGold = paintHex(0xfa, 0xd8, 0x3b);
export const accentRed = paintHex(0xdc, 0x5b, 0x5e);
const ANSI = /\u001b\[[0-9;]*m/g;
/** Length of a styled string as it appears on screen. */
export function visibleWidth(value) {
    return value.replace(ANSI, '').length;
}
/** Draw a rounded box around already-styled rows. */
export function box(rows) {
    const width = Math.max(0, ...rows.map(visibleWidth));
    const pad = (row) => ' '.repeat(width - visibleWidth(row));
    return [
        faint(`┌${'─'.repeat(width + 2)}┐`),
        ...rows.map((row) => `${faint('│')} ${row}${pad(row)} ${faint('│')}`),
        faint(`└${'─'.repeat(width + 2)}┘`),
    ].join('\n');
}
/**
 * A small aligned table with a dashed header underline. Cells must be plain
 * text: padding happens before any styling, so alignment never drifts.
 */
export function table(headers, rows) {
    if (rows.length === 0) {
        return headers.map((header) => bold(header)).join('  ');
    }
    const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)));
    const pad = (cells) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0));
    return [
        pad(headers)
            .map((cell) => bold(cell))
            .join('  ')
            .trimEnd(),
        widths.map((width) => faint('─'.repeat(width))).join('  '),
        ...rows.map((row) => pad(row).join('  ').trimEnd()),
    ].join('\n');
}
/** `✓ text` */
export function ok(message) {
    return `${green('✓')} ${message}`;
}
/** `→ text` */
export function info(message) {
    return `${gold('→')} ${message}`;
}
/** `! text` */
export function warn(message) {
    return `${yellow('!')} ${message}`;
}
/** `✗ text` */
export function errorMark(message) {
    return `${red('✗')} ${message}`;
}
/** A successful step. */
export function success(message) {
    console.log(ok(message));
}
/** A neutral next step or piece of information. */
export function note(message) {
    console.log(info(message));
}
/** A warning that does not stop the command. */
export function caution(message) {
    console.error(warn(message));
}
/** A group heading inside a command's output. */
export function title(text) {
    return `${gold('●')} ${bold(text)}`;
}
/** Two-column row used by status-style output. */
export function field(label, value, width = 10) {
    return `  ${dim(label.padEnd(width))}  ${value}`;
}
/** Short local representation of an epoch-millis timestamp. */
export function formatDate(ms) {
    if (!ms)
        return '-';
    return new Date(ms).toLocaleString();
}
//# sourceMappingURL=theme.js.map