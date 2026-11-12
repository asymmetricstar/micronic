/**
 * Records inside the active zone: add, list and remove. Values are normalized
 * and validated by the zone manager, so malformed rdata is rejected before it
 * reaches the database and the resolver.
 */
import { canonicalName, qualifyName } from '../../lib/zones/manager.js';
import { typeLabel } from '../../lib/zones/types.js';
import { CliError, answer, cli, prompts } from '../context.js';
import { flagValue, hasFlag, numberFlag, parseCommandArgs } from '../args.js';
import { printCommandHelp } from '../help.js';
import { bold, dim, faint, note, success } from '../theme.js';
import { RECORD_TYPES, parseRecordType } from '../dnstype.js';
import { recordTable, relativeName } from '../views.js';
/** `--zone <name>` beats the active domain; a lone zone needs no selection. */
function resolveZone(args) {
    const { app, session } = cli();
    const name = flagValue(args, 'zone') ?? session.domain;
    if (name !== undefined) {
        const zone = app.zones.getZoneByName(canonicalName(name));
        if (!zone)
            throw new CliError(`no domain named "${name}"`);
        return zone;
    }
    const zones = app.zones.listZones();
    if (zones.length === 1)
        return zones[0];
    if (zones.length === 0)
        throw new CliError('no domains yet: create one with `domain new <name> <ip>`');
    throw new CliError('no active domain: `domain use <name>` or pass --zone <name>');
}
async function addRecord(args) {
    const { app, session } = cli();
    const user = session.requireManager();
    const zone = resolveZone(args);
    const name = args.positionals[1] ??
        answer(await prompts().ask(`Name in ${zone.name} ${faint('(@ for apex)')}: `), 'record name');
    const typeInput = args.positionals[2] ??
        (await prompts().ask(`Type ${faint(`[${RECORD_TYPES.join('/')}]`)} ${faint('(A)')}: `)).trim();
    const type = parseRecordType(typeInput === '' ? 'A' : typeInput);
    let value = args.positionals.slice(3).join(' ');
    if (value === '')
        value = answer(await prompts().ask('Value: '), 'record value');
    const ttl = numberFlag(args, 'ttl', 1, 86_400) ?? app.ttl;
    let record;
    try {
        record = app.zones.createRecord({ zoneId: zone.id, name, type, rdata: value, ttl }, user.id);
    }
    catch (error) {
        const message = error.message;
        if (message.includes('UNIQUE constraint failed')) {
            throw new CliError(`${relativeName(qualifyName(name, zone.name), zone.name)} already has that ${typeLabel(type)} value`);
        }
        throw new CliError(message);
    }
    success(`${typeLabel(type)} ${bold(relativeName(record.name, zone.name))} ${dim('→')} ${record.rdata} ` +
        `${dim(`· ${zone.name} · ttl ${record.ttl}`)}`);
}
function listRecords(args) {
    const { app } = cli();
    const zone = resolveZone(args);
    let records = app.zones.listRecords(zone.id);
    const filter = args.positionals[1];
    if (filter !== undefined) {
        const name = qualifyName(filter, zone.name);
        records = records.filter((record) => record.name === name);
    }
    if (records.length === 0) {
        note(`no records${filter === undefined ? '' : ` for ${filter}`} in ${bold(zone.name)}`);
        return;
    }
    console.log(recordTable(records, zone.name));
    note(`${records.length} record(s) in ${bold(zone.name)}`);
}
function matches(records, target, zone, type) {
    const name = qualifyName(target, zone.name);
    return records.filter((record) => record.name === name && (type === undefined || record.type === type));
}
async function removeRecord(args) {
    const { app, session } = cli();
    session.requireManager();
    const zone = resolveZone(args);
    const target = args.positionals[1] ?? answer(await prompts().ask('Record id or name: '), 'record id');
    const typeText = args.positionals[2];
    const type = typeText === undefined ? undefined : parseRecordType(typeText);
    let doomed;
    if (/^\d+$/.test(target)) {
        const record = app.zones.getRecordById(Number(target));
        if (!record || record.zoneId !== zone.id) {
            throw new CliError(`no record #${target} in ${zone.name}`);
        }
        doomed = [record];
    }
    else {
        doomed = matches(app.zones.listRecords(zone.id), target, zone, type);
        if (doomed.length === 0) {
            throw new CliError(`no ${typeText ?? 'record'} named "${target}" in ${zone.name}`);
        }
    }
    if (!hasFlag(args, 'yes')) {
        const labels = doomed.map((record) => `#${record.id} ${typeLabel(record.type)} ${record.rdata}`).join(', ');
        const confirmed = await prompts().confirm(`delete ${labels}?`, false);
        if (!confirmed) {
            note('cancelled');
            return;
        }
    }
    for (const record of doomed)
        app.zones.deleteRecord(record.id);
    success(`removed ${doomed.length} record(s) from ${bold(zone.name)}`);
}
export const recordSpec = {
    name: 'record',
    aliases: ['rr'],
    group: 'Records',
    summary: 'Add, list and remove records in a zone',
    usage: 'record <add|list|rm> [name] [type] [value] [options]',
    notes: 'Names are relative to the zone (`www`, `mail`, `*`) or absolute (`www.example.test`).\n' +
        '`@` is the apex. The active domain is used unless --zone names another one.',
    actions: [
        { name: 'add', summary: 'Create a record (prompts for whatever is missing)' },
        { name: 'list', summary: 'Show the zone records, optionally filtered by name' },
        { name: 'rm', summary: 'Delete a record by id, or every record of a name/type' },
    ],
    flags: [
        { name: 'zone', value: '<name>', summary: 'Zone to operate on (default: active domain)' },
        { name: 'ttl', value: '<seconds>', summary: 'TTL for a new record (default MICRONIC_TTL)' },
        { name: 'yes', short: 'y', summary: 'Skip the confirmation on rm' },
    ],
    examples: [
        'record add www A 127.0.0.1',
        'record add mail MX "10 mail.example.test"',
        'record add _sip._tcp SRV "0 5 5060 sip.example.test"',
        'record add git ENDPOINT 127.0.0.1:3000',
        'record list',
        'record rm 4 --yes',
    ],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const action = args.positionals[0] ?? 'list';
        switch (action) {
            case 'add':
            case 'new':
            case 'create':
                return addRecord(args);
            case 'list':
            case 'ls':
                return listRecords(args);
            case 'rm':
            case 'delete':
            case 'del':
                return removeRecord(args);
            default:
                throw new CliError(`unknown record action "${action}"; try: add, list, rm`);
        }
    },
};
//# sourceMappingURL=record.js.map