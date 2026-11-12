/**
 * Session banner printed when the interactive shell starts: the wordmark, then
 * the facts a DNS operator needs at a glance (listener, database, account,
 * active domain) and two readiness lines.
 */
import path from 'node:path';
import { logoCompact } from './logo.js';
import { accentGreen, bold, gold, dim, faint, red } from './theme.js';
import { BIN } from './settings.js';
/** `data\dns.db` instead of the full path, when it is shorter. */
function shortDatabase(database) {
    const relative = path.relative(process.cwd(), database);
    return relative !== '' && relative.length < database.length ? relative : database;
}
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
export function shellBanner(state) {
    const rows = ['', logoCompact(), ''];
    const meta = (label, value) => `  ${faint('#')} ${dim(label.padEnd(8))} ${value}`;
    const state_ = state.listening ? accentGreen('listening') : dim('stopped');
    rows.push(meta('server', `${gold(`${state.host}:${state.port}`)} ${faint('·')} ${state_}`));
    const apiState = !state.apiEnabled
        ? dim('disabled')
        : state.apiListening
            ? accentGreen('listening')
            : dim('stopped');
    rows.push(meta('api', `${gold(`${state.apiHost}:${state.apiPort}`)} ${faint('·')} ${apiState}`));
    rows.push(meta('database', `${dim(shortDatabase(state.database))} ${faint('·')} ${plural(state.zones, 'zone')} ${faint('·')} ${plural(state.records, 'record')}`));
    if (state.username !== undefined) {
        const role = state.role === undefined ? '' : ` ${faint('·')} ${dim(state.role)}`;
        rows.push(meta('account', `${bold(state.username)}${role}`));
    }
    else {
        rows.push(meta('account', `${red('not signed in')} ${faint('·')} ${gold('login')} ${dim('to start a session')}`));
    }
    if (state.domain !== undefined) {
        rows.push(meta('domain', bold(state.domain)));
    }
    if (state.users === 0) {
        rows.push('');
        rows.push(`  ${faint('#')} ${dim('setup')}    ${dim('no accounts yet')} ${faint('·')} ${gold('register')} ${dim('creates the first admin')}`);
    }
    rows.push('');
    rows.push(`  ${accentGreen('✓')} ${dim('ready')} ${faint('·')} ${dim('type')} ${gold('help')} ${dim('to list the commands')}`);
    rows.push(state.listening
        ? `  ${accentGreen('✓')} ${dim('ready')} ${faint('·')} ${dim('resolver live')} ${faint('·')} ${gold('lookup')} ${dim('answers now')}`
        : `  ${accentGreen('✓')} ${dim('ready')} ${faint('·')} ${dim('start the resolver with')} ${gold('serve')}`);
    rows.push(`  ${faint('#')} ${dim('one-shot')} ${dim(`${BIN} --help`)}`);
    return rows.join('\n');
}
//# sourceMappingURL=banner.js.map