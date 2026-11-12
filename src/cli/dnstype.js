/**
 * Record type names accepted on the command line: the zone database supports a
 * fixed set, and `lookup` additionally accepts ANY.
 */
import { DNSType, isSupportedType } from '../lib/dns/constants.js';
import { typeLabel } from '../lib/zones/types.js';
import { CliError } from './context.js';
export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'NS', 'PTR', 'MX', 'TXT', 'SRV', 'NAPTR', 'CAA', 'ENDPOINT'];
/** Parse a type name or number; `ANY` only when `allowAny` is set. */
export function parseRecordType(input, allowAny = false) {
    const text = input.trim().toUpperCase();
    if (/^\d+$/.test(text)) {
        const value = Number(text);
        if (isSupportedType(value))
            return value;
        if (allowAny && value === DNSType.ANY)
            return value;
        throw new CliError(`unsupported record type ${input}`);
    }
    if (text === 'ANY' || text === '*') {
        if (allowAny)
            return DNSType.ANY;
        throw new CliError('ANY is only meaningful for `lookup`, not for a stored record');
    }
    const value = DNSType[text];
    if (value === undefined || !isSupportedType(value)) {
        throw new CliError(`unknown record type "${input}". Use: ${RECORD_TYPES.join(', ')}`);
    }
    if (value === DNSType.SOA && !allowAny) {
        throw new CliError('the SOA record is managed by the zone; edit it with `domain show`/`domain new`');
    }
    return value;
}
export function nameOfType(type) {
    return type === DNSType.ANY ? 'ANY' : typeLabel(type);
}
//# sourceMappingURL=dnstype.js.map