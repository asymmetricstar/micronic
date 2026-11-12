/**
 * Shared renderers for records and DNS answers, so `domain show`, `record
 * list` and `lookup` print the same shape.
 */
import { typeLabel } from '../lib/zones/types.js';
import { decodeRdata } from '../lib/dns/packet.js';
import { dim, faint, table } from './theme.js';
import { nameOfType } from './dnstype.js';
/** `@` for the apex, `www` for www.example.com, otherwise the full name. */
export function relativeName(name, zone) {
    if (name === zone)
        return '@';
    return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}
export function recordTable(records, zone) {
    const rows = records.map((record) => [
        String(record.id),
        relativeName(record.name, zone),
        typeLabel(record.type),
        String(record.ttl),
        record.rdata,
    ]);
    return table(['ID', 'NAME', 'TYPE', 'TTL', 'DATA'], rows);
}
/** Answer table for `lookup`: wire records, with rdlength fallback. */
export function answerTable(records, message) {
    const rows = records.map((record) => [
        record.name,
        String(record.ttl),
        nameOfType(record.type),
        rdataText(record, message),
    ]);
    return table(['NAME', 'TTL', 'TYPE', 'DATA'], rows);
}
function rdataText(record, message) {
    try {
        return decodeRdata(record, message);
    }
    catch {
        return faint(`<${record.rdlength} bytes>`);
    }
}
/** `A ×2 · MX ×1`, or `no records`. */
export function typeSummary(records) {
    if (records.length === 0)
        return dim('no records');
    const counts = new Map();
    for (const record of records)
        counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
    return [...counts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([type, count]) => `${typeLabel(type)} ×${count}`)
        .join(dim(' · '));
}
//# sourceMappingURL=views.js.map