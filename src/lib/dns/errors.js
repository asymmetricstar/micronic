/**
 * Resolver outcome codes. The server maps each of these to a DNS response
 * RCODE so callers never have to interpret error strings themselves.
 */
/**
 * Thrown by the resolver to signal a specific resolution outcome.
 * The UDP/TCP server catches these and builds the correct DNS response.
 */
export class ResolverError extends Error {
    rcode;
    constructor(rcode, reason) {
        super(`[resolver] ${rcode}: ${reason}`);
        this.name = 'ResolverError';
        this.rcode = rcode;
    }
}
export const NXDOMAIN = new ResolverError('NXDOMAIN', 'name does not exist');
export const FORMERR = new ResolverError('FORMERR', 'malformed question section');
export const NOTIMP = new ResolverError('NOTIMP', 'record type not implemented');
export const SERVFAIL = new ResolverError('SERVFAIL', 'internal resolution failure');
//# sourceMappingURL=errors.js.map