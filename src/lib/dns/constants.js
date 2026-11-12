/**
 * DNS protocol constants - RFC 1035 / RFC 2065 (RR types) / RFC 6891 (EDNS).
 * Values are numbers as they appear on the wire; string aliases keep the code
 * readable and safe (no magic numbers).
 */
export const DNSClass = {
    IN: 1,
    CS: 2,
    CH: 3,
    HS: 4,
};
export const DNSType = {
    A: 1,
    NS: 2,
    CNAME: 5,
    SOA: 6,
    PTR: 12,
    MX: 15,
    TXT: 16,
    AAAA: 28,
    SRV: 33,
    OPT: 41,
    NAPTR: 35,
    CAA: 257,
    /**
     * Non-standard endpoint record: UTF-8 `host:port` (or `[ipv6]:port`).
     * 65280 is in the DNS private-use range (RFC 6895), so it cannot collide
     * with a public RR type. Clients must ask for it explicitly.
     */
    ENDPOINT: 65280,
    ANY: 255,
};
/**
 * RR types we fully support in the zone database (authoritative).
 * Everything else is still parseable on the wire but answers with REFUSED.
 */
export const SUPPORTED_TYPES = new Set([
    DNSType.A,
    DNSType.NS,
    DNSType.CNAME,
    DNSType.SOA,
    DNSType.PTR,
    DNSType.MX,
    DNSType.TXT,
    DNSType.AAAA,
    DNSType.SRV,
    DNSType.NAPTR,
    DNSType.CAA,
    DNSType.ENDPOINT,
]);
export function isSupportedType(type) {
    return SUPPORTED_TYPES.has(type);
}
//# sourceMappingURL=constants.js.map