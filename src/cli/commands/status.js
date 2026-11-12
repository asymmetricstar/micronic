/**
 * One-screen overview: listener, database, account, active domain and the
 * contents of the zone table.
 */
import { cli } from '../context.js';
import { hasFlag, parseCommandArgs } from '../args.js';
import { printCommandHelp } from '../help.js';
import { bold, gold, dim, field, title } from '../theme.js';
import { typeSummary } from '../views.js';
export const statusSpec = {
    name: 'status',
    group: 'Server',
    summary: 'Overview of listener, API, database, session and zones',
    usage: 'status',
    examples: ['status'],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const { app, session } = cli();
        const running = session.server;
        console.log(title('Server'));
        console.log(field('state', running ? `${gold('listening')} ${dim('(udp+tcp)')}` : dim('stopped')));
        console.log(field('address', bold(`${running?.host ?? app.host}:${running?.port ?? app.port}`)));
        if (running) {
            const uptime = Math.max(0, Math.round((Date.now() - running.startedAt) / 1000));
            console.log(field('uptime', dim(`${Math.floor(uptime / 60)}m ${uptime % 60}s`)));
        }
        const api = session.api;
        console.log(field('api', !app.apiEnabled
            ? dim('disabled')
            : api
                ? bold(`http://${api.host}:${api.port}`)
                : dim('stopped')));
        console.log('');
        console.log(title('Database'));
        console.log(field('path', dim(app.dbPath)));
        console.log(field('zones', String(app.zones.listZones().length)));
        console.log(field('records', String(app.zones.listRecords().length)));
        console.log(field('accounts', String(app.users.listUsers().length)));
        console.log('');
        console.log(title('Session'));
        const user = session.user;
        console.log(field('account', user ? `${bold(`@${user.username}`)} ${dim(`(${user.role})`)}` : dim('guest')));
        console.log(field('domain', session.domain ?? dim('not selected')));
        console.log(field('ttl', String(app.ttl)));
        const zones = app.zones.listZones();
        if (zones.length > 0) {
            console.log('');
            console.log(title('Zones'));
            for (const zone of zones) {
                const records = app.zones.listRecords(zone.id);
                console.log(`  ${gold(zone.name.padEnd(28))} ${zone.masterIp.padEnd(16)} ${dim(`${records.length} rec`)}`);
                console.log(`  ${' '.repeat(28)} ${typeSummary(records)}`);
            }
        }
    },
};
//# sourceMappingURL=status.js.map