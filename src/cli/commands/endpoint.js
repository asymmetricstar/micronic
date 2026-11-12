/**
 * `endpoint` is the script-facing view of an ENDPOINT record: it writes exactly
 * one `host:port` line to stdout, with no banner, table, colours or prompts.
 * Errors still go through CliError, so a missing record exits non-zero.
 */
import { DNSType } from '../../lib/dns/constants.js';
import { canonicalEndpoint } from '../../lib/dns/packet.js';
import { canonicalName } from '../../lib/zones/manager.js';
import { CliError, cli } from '../context.js';
import { hasFlag, parseCommandArgs } from '../args.js';
import { printCommandHelp } from '../help.js';
export const endpointSpec = {
    name: 'endpoint',
    aliases: ['ep'],
    group: 'Records',
    summary: 'Print only the host:port stored in an ENDPOINT record',
    usage: 'endpoint <name>',
    notes: 'Resolves the exact ENDPOINT record for a fully-qualified name and writes only its\n' +
        '`host:port` value to stdout. It never prompts, so it is safe in shell scripts and\n' +
        'command substitution. If several ENDPOINT values exist, the first one is printed.',
    examples: ['endpoint git.local.host'],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const input = args.positionals[0];
        if (input === undefined || input.trim() === '') {
            throw new CliError('name is required: `endpoint <name>`');
        }
        if (args.positionals.length > 1) {
            throw new CliError('endpoint takes exactly one name');
        }
        const { app } = cli();
        const name = canonicalName(input);
        if (name === '')
            throw new CliError(`invalid name "${input}"`);
        const zone = app.zones.findZoneFor(name);
        if (!zone)
            throw new CliError(`no zone serves "${name}"`);
        const record = app.zones
            .listRecords(zone.id)
            .find((candidate) => candidate.name === name && candidate.type === DNSType.ENDPOINT);
        if (record === undefined) {
            throw new CliError(`no ENDPOINT record for ${name}`);
        }
        // Validate and normalise here as well, so a hand-edited SQLite row cannot
        // make the script consume an invalid endpoint.
        console.log(canonicalEndpoint(record.rdata));
    },
};
//# sourceMappingURL=endpoint.js.map