/**
 * Zone + record data model persisted in SQLite.
 * A zone is an authoritative namespace (e.g. "example.com"). Records live
 * inside it. The manager owns persistence; the resolver only reads.
 */
/** Human-readable label for a record type (for logs / API). */
export function typeLabel(type) {
    return {
        1: 'A',
        2: 'NS',
        5: 'CNAME',
        6: 'SOA',
        12: 'PTR',
        15: 'MX',
        16: 'TXT',
        28: 'AAAA',
        33: 'SRV',
        35: 'NAPTR',
        257: 'CAA',
        65280: 'ENDPOINT',
    }[type] ?? `TYPE${type}`;
}
//# sourceMappingURL=types.js.map