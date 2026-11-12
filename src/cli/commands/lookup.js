/**
 * `lookup` answers a DNS question two ways:
 *   - default: the authoritative resolver over the zone database (no sockets),
 *   - `--live`: a real UDP query to the server started with `serve`, which also
 *     shows the wire behaviour (AA, truncation, additional glue).
 */
import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';
import { resolveQuestion } from '../../lib/dns/resolver.js';
import { canonicalName } from '../../lib/zones/manager.js';
import { decodeMessage, encodeMessage } from '../../lib/dns/packet.js';
import { DNSType } from '../../lib/dns/constants.js';
import { CliError, answer, cli, prompts } from '../context.js';
import { hasFlag, parseCommandArgs } from '../args.js';
import { printCommandHelp } from '../help.js';
import { bold, gold, dim, faint, field, note } from '../theme.js';
import { answerTable } from '../views.js';
import { nameOfType, parseRecordType } from '../dnstype.js';
const RCODE_NAMES = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'];
function showSection(heading, body) {
    console.log(`  ${gold('●')} ${dim(heading)}`);
    for (const line of body.split('\n'))
        console.log(`    ${line}`);
}
function localLookup(name, type) {
    const { app } = cli();
    const started = performance.now();
    const resolution = resolveQuestion(app.zones, { name: canonicalName(name), qtype: type, qclass: 1 }, { ttl: app.ttl });
    const elapsed = performance.now() - started;
    console.log('');
    console.log(`${faint('#')} ${dim('lookup')} ${bold(name)} ${gold(nameOfType(type))} ` +
        `${faint('·')} ${dim('authoritative zone data')}`);
    const authority = resolution.zone === undefined ? dim('none') : resolution.zone.name;
    console.log(field('status', `${code(resolution.rcode)} ${faint('·')} ${dim(`zone ${authority}`)}`));
    if (resolution.answers.length > 0)
        showSection('answer', answerTable(resolution.answers));
    if (resolution.authority.length > 0)
        showSection('authority', answerTable(resolution.authority));
    if (resolution.additionals.length > 0)
        showSection('additional', answerTable(resolution.additionals));
    if (resolution.answers.length === 0 && resolution.rcode === 'NOERROR') {
        const what = type === DNSType.ANY ? 'records' : `${nameOfType(type)} record`;
        note(`the name exists but has no ${what} (NODATA)`);
    }
    else if (resolution.rcode === 'REFUSED') {
        note('not inside any zone this server is authoritative for');
    }
    console.log(field('time', dim(`${elapsed.toFixed(2)} ms`)));
}
function code(rcode) {
    return rcode === 'NOERROR' ? gold(rcode) : dim(rcode);
}
async function liveLookup(name, type) {
    const { session } = cli();
    const server = session.requireServer();
    const query = {
        header: {
            id: randomInt(0, 0xffff),
            flags: { qr: false, opcode: 0, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: 0 },
            qdcount: 1,
            ancount: 0,
            nscount: 0,
            arcount: 0,
        },
        questions: [{ name: name.endsWith('.') ? name : `${name}.`, qtype: type, qclass: 1 }],
        answers: [],
        authorities: [],
        additionals: [],
    };
    const wire = encodeMessage(query);
    const socket = dgram.createSocket('udp4');
    const started = performance.now();
    const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new CliError(`no answer from ${server.host}:${server.port} within 2000 ms`));
        }, 2000);
        socket.once('message', (message) => {
            clearTimeout(timer);
            socket.close();
            resolve(new Uint8Array(message));
        });
        socket.once('error', (error) => {
            clearTimeout(timer);
            socket.close();
            reject(new CliError(`cannot reach ${server.host}:${server.port}: ${error.message}`));
        });
        socket.send(Buffer.from(wire), server.port, server.host);
    });
    const elapsed = performance.now() - started;
    const decoded = decodeMessage(response);
    console.log('');
    console.log(`${faint('#')} ${dim('lookup')} ${bold(name)} ${gold(nameOfType(type))} ${faint('·')} ` +
        `${dim(`udp ${server.host}:${server.port}`)}`);
    const rcode = RCODE_NAMES[decoded.header.flags.rcode] ?? `RCODE${decoded.header.flags.rcode}`;
    const flags = [
        decoded.header.flags.aa ? 'AA' : undefined,
        decoded.header.flags.tc ? 'TC' : undefined,
        decoded.header.flags.rd ? 'RD' : undefined,
    ].filter((flag) => flag !== undefined);
    console.log(field('status', `${code(rcode)}${flags.length ? ` ${faint('·')} ${dim(flags.join(' '))}` : ''}`));
    if (decoded.answers.length > 0)
        showSection('answer', answerTable(decoded.answers, response));
    if (decoded.authorities.length > 0)
        showSection('authority', answerTable(decoded.authorities, response));
    if (decoded.additionals.length > 0)
        showSection('additional', answerTable(decoded.additionals, response));
    if (decoded.answers.length === 0 && rcode === 'NOERROR') {
        note('the name exists but has no data for this type (NODATA)');
    }
    console.log(field('time', dim(`${elapsed.toFixed(2)} ms`)));
}
export const lookupSpec = {
    name: 'lookup',
    aliases: ['dig', 'resolve'],
    group: 'Domains',
    summary: 'Resolve a name against the zone database or the live server',
    usage: 'lookup [name] [type] [--live]',
    notes: 'Without --live the authoritative resolver answers from the SQLite zones, exactly as\n' +
        'the server would. With --live a real UDP query is sent to the running `serve` instance.\n' +
        'The default type is A; ANY is accepted.',
    flags: [{ name: 'live', summary: 'Query the running DNS server over UDP' }],
    examples: [
        'lookup www.example.test',
        'lookup example.test MX',
        'lookup git.local.host ENDPOINT',
        'lookup www.example.test A --live',
    ],
    run: async (argv, spec) => {
        const args = parseCommandArgs(argv, spec);
        if (hasFlag(args, 'help'))
            return printCommandHelp(spec);
        const name = args.positionals[0] ?? answer(await prompts().ask('Name to look up: '), 'name');
        const typeText = args.positionals[1] ?? 'A';
        const type = parseRecordType(typeText, true);
        if (hasFlag(args, 'live'))
            return liveLookup(name, type);
        return localLookup(name, type);
    },
};
//# sourceMappingURL=lookup.js.map