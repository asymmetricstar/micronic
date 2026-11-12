/**
 * Zone lifecycle: create a domain, list them, delete one, select the active
 * domain and inspect its SOA + records. Writes need the admin or dns role.
 */
import { canonicalName } from '../../lib/zones/manager.js';
import { isIPv4 } from '../../lib/dns/packet.js';
import { DNSType } from '../../lib/dns/constants.js';
import { CliError, answer, cli, prompts } from '../context.js';
import { hasFlag, parseCommandArgs, numberFlag } from '../args.js';
import { printCommandHelp } from '../help.js';
import { bold, gold, dim, faint, field, formatDate, note, success, table } from '../theme.js';
import { recordTable, typeSummary } from '../views.js';
function findZone(name) {
    const zone = cli().app.zones.getZoneByName(canonicalName(name));
    if (!zone)
        throw new CliError(`no domain named "${name}"`);
    return zone;
}
/** The zone a read-only action refers to: argument, active domain, only zone. */
function zoneFor(args, position) {
    const name = args.positionals[position];
    if (name !== undefined)
        return findZone(name);
    const { session } = cli();
    const active = session.activeZone();
    if (active)
        return active;
    if (cli().app.zones.listZones().length === 0) {
        throw new CliError('no domains yet: create one with `domain new <name> <ip>`');
    }
    throw new CliError('no active domain: `domain use <name>` or name one explicitly');
}
function listDomains() {
    const { app } = cli();
    const zones = app.zones.listZones();
    if (zones.length === 0) {
        note('no domains yet');
        note(`create one with ${gold('domain new example.test 127.0.0.1')}`);
        return;
    }
    const rows = zones.map((zone) => {
        const records = app.zones.listRecords(zone.id);
        return [zone.name, zone.masterIp, String(records.length), String(zone.soa.serial), formatDate(zone.createdAt)];
    });
    console.log(table(['DOMAIN', 'MASTER IP', 'RECORDS', 'SERIAL', 'CREATED'], rows));
    note(`${zones.length} ${zones.length === 1 ? 'domain' : 'domains'} · ${app.zones.listRecords().length} record(s)`);
}
async function newDomain(args) {
    const { app, session } = cli();
    const user = session.requireManager();
    const name = args.positionals[1] ?? answer(await prompts().ask('Domain name: '), 'domain name');
    let masterIp = args.positionals[2];
    if (masterIp === undefined) {
        const typed = (await prompts().ask(`Master IP ${faint('[127.0.0.1]')}: `)).trim();
        masterIp = typed === '' ? '127.0.0.1' : typed;
    }
    const ttl = numberFlag(args, 'ttl', 1, 86_400) ?? app.ttl;
    let zone;
    try {
        zone = app.zones.createZone({ name, masterIp }, user.id);
    }
    catch (error) {
        const message = error.message;
        throw new CliError(message.includes('UNIQUE constraint failed') ? `domain "${name}" already exists` : message);
    }
    session.domain = zone.name;
    success(`created ${bold(zone.name)} ${dim('→')} ${zone.masterIp}`);
    note(`serial ${zone.soa.serial} · active domain is now ${bold(zone.name)}`);
    if (!hasFlag(args, 'no-www')) {
        const addWww = await prompts().confirm(`add a www A record for ${zone.name}?`, true);
        if (addWww) {
            if (!isIPv4(zone.masterIp)) {
                note('master IP is not IPv4: skipping the www A record');
            }
            else {
                app.zones.createRecord({ zoneId: zone.id, name: 'www', type: DNSType.A, rdata: zone.masterIp, ttl }, user.id);
                note(`www.${zone.name} ${faint('→')} ${zone.masterIp} ${dim(`ttl ${ttl}`)}`);
            }
        }
    }
}
async function removeDomain(args) {
    const { app, session } = cli();
    session.requireManager();
    const name = args.positionals[1] ?? answer(await prompts().ask('Domain to remove: '), 'domain name');
    const zone = findZone(name);
    const records = app.zones.listRecords(zone.id);
    if (!hasFlag(args, 'yes')) {
        const confirmed = await prompts().confirm(`delete ${bold(zone.name)} and its ${records.length} record(s)?`, false);
        if (!confirmed) {
            note('cancelled');
            return;
        }
    }
    for (const record of records)
        app.zones.deleteRecord(record.id);
    app.zones.deleteZone(zone.id);
    if (session.domain === zone.name)
        session.domain = undefined;
    success(`removed ${bold(zone.name)} ${dim(`(${records.length} record(s))`)}`);
}
async function useDomain(args) {
    const { app, session } = cli();
    if (hasFlag(args, 'clear')) {
        session.domain = undefined;
        note('no active domain');
        return;
    }
    const name = args.positionals[1] ?? answer(await prompts().ask('Active domain: '), 'domain name');
    const zone = findZone(name);
    session.domain = zone.name;
    success(`active domain: ${bold(zone.name)} ${dim(`(${zone.masterIp})`)}`);
    note('`record` and `lookup` now default to this domain');
}
function showDomain(args) {
    const { app } = cli();
    const zone = zoneFor(args, 1);
    const records = app.zones.listRecords(zone.id);
    const owner = zone.ownerId === null ? undefined : app.users.getUserById(zone.ownerId);
    console.log(field('domain', bold(zone.name)));
    console.log(field('master ip', gold(zone.masterIp)));
    console.log(field('owner', owner ? `@${owner.username}` : dim('-')));
    console.log(field('records', `${records.length} ${faint('·')} ${typeSummary(records)}`));
    console.log(field('serial', String(zone.soa.serial)));
    console.log(field('soa', dim(`${zone.soa.mname} ${zone.soa.rname} ${zone.soa.serial} ${zone.soa.refresh} ${zone.soa.retry} ${zone.soa.expire} ${zone.soa.minimum}`)));
    console.log(field('created', formatDate(zone.createdAt)));
    if (records.length > 0) {
        console.log('');
        console.log(recordTable(records, zone.name));
    }
}
export const domainSpec = {
    name: 'domain',
    aliases: ['zone'],
    group: 'Domains',
    summary: 'Create, list, select and remove zones',
    usage: 'domain <new|list|use|show|rm> [name] [ip] [options]',
    notes: 'A domain (zone) is the authoritative namespace this server answers for. Creating one\n' +
        'also makes it the active domain, which `record` and `lookup` use by default.',
    actions: [
        { name: 'new', summary: 'Create a zone and (optionally) its www record' },
        { name: 'list', summary: 'List zones with record count and SOA serial' },
        { name: 'use', summary: 'Select the active domain for this session' },
        { name: 'show', summary: 'SOA details and every record in the zone' },
        { name: 'rm', summary: 'Delete a zone and all of its records' },
    ],
    flags: [
        { name: 'ttl', value: '<seconds>', summary: 'TTL for the created records (default MICRONIC_TTL)' },
        { name: 'no-www', summary: 'Do not ask for the www A record' },
        { name: 'yes', short: 'y', summary: 'Skip the confirmation on rm' },
        { name: 'clear', summary: 'With `use`, clear the active domain' },
    ],
    examples: [
        'domain new example.test 127.0.0.1',
        'domain list',
        'domain use example.test',
        'domain show example.test',
        'domain rm example.test --yes',
    ],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const action = args.positionals[0] ?? 'list';
        switch (action) {
            case 'new':
            case 'create':
                return newDomain(args);
            case 'list':
            case 'ls':
                return listDomains();
            case 'use':
            case 'select':
                return useDomain(args);
            case 'show':
            case 'info':
                return showDomain(args);
            case 'rm':
            case 'delete':
            case 'del':
                return removeDomain(args);
            default:
                throw new CliError(`unknown domain action "${action}"; try: new, list, use, show, rm`);
        }
    },
};
//# sourceMappingURL=domain.js.map