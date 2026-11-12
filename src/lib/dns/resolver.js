/**
 * Authoritative resolver: given a question, find the owning zone and return
 * the answer records (or the right RCODE plus a negative-cache SOA).
 *
 * Supports:
 *   - Longest-suffix zone selection (parent and child zones both exist).
 *   - NXDOMAIN vs NODATA (empty non-terminals count as existing names).
 *   - CNAME chains, including targets outside the zone (chain is returned).
 *   - Wildcard records (*.example.com).
 *   - Apex A synthesis from the zone master IP.
 *   - Additional-section glue for NS / MX / SRV targets inside the zone.
 */
import { canonicalName } from '../zones/manager.js';
import { decodeRdata, encodeRdata, isIPv4 } from './packet.js';
import { DNSType, DNSClass, isSupportedType } from './constants.js';
const MAX_CNAME_HOPS = 16;
const QTYPE_ANY = 255;
const QCLASS_ANY = 255;
export function resolveQuestion(manager, question, opts) {
    const empty = (rcode) => ({ rcode, answers: [], authority: [], additionals: [] });
    if (question.qtype === DNSType.OPT)
        return empty('FORMERR');
    if (question.qclass !== DNSClass.IN && question.qclass !== QCLASS_ANY)
        return empty('REFUSED');
    if (question.qtype !== QTYPE_ANY && !isSupportedType(question.qtype))
        return empty('REFUSED');
    const name = canonicalName(question.name);
    if (name === '')
        return empty('NXDOMAIN');
    const zone = manager.findZoneFor(name);
    if (!zone)
        return empty('REFUSED');
    const records = manager.listRecords(zone.id);
    const result = resolveInZone(zone, records, name, question.qtype, opts);
    return { zone: { id: zone.id, name: zone.name }, ...result };
}
function resolveInZone(zone, records, name, qtype, opts) {
    const exact = records.filter((r) => r.name === name);
    // A CNAME redirects everything except a direct CNAME/ANY query.
    const cname = exact.find((r) => r.type === DNSType.CNAME);
    if (cname && qtype !== DNSType.CNAME && qtype !== QTYPE_ANY) {
        return followCname(zone, records, name, qtype, cname, opts);
    }
    if (exact.length > 0) {
        const answers = answersFor(zone, exact, name, qtype, opts);
        if (answers.length > 0)
            return positive(zone, records, answers);
        // The name exists but has no data for this type.
        return { rcode: 'NOERROR', answers: [], authority: [soaRecord(zone, records)], additionals: [] };
    }
    // The zone apex always exists, even without stored records (and may still
    // answer A from the master IP).
    if (name === zone.name) {
        const answers = answersFor(zone, exact, name, qtype, opts);
        if (answers.length > 0)
            return positive(zone, records, answers);
        return { rcode: 'NOERROR', answers: [], authority: [soaRecord(zone, records)], additionals: [] };
    }
    // No exact records: try the closest wildcard, then decide NXDOMAIN vs NODATA.
    const wildcard = findWildcard(records, name);
    if (wildcard.length > 0) {
        const wildcardCname = wildcard.find((r) => r.type === DNSType.CNAME);
        if (wildcardCname && qtype !== DNSType.CNAME && qtype !== QTYPE_ANY) {
            return followCname(zone, records, name, qtype, wildcardCname, opts);
        }
        const answers = answersFor(zone, wildcard, name, qtype, opts);
        if (answers.length > 0)
            return positive(zone, records, answers);
    }
    // Empty non-terminals (a.b.example.com exists => b.example.com exists).
    const isNonTerminal = records.some((r) => r.name.endsWith('.' + name));
    return {
        rcode: isNonTerminal ? 'NOERROR' : 'NXDOMAIN',
        answers: [],
        authority: [soaRecord(zone, records)],
        additionals: [],
    };
}
function answersFor(zone, candidates, ownerName, qtype, opts) {
    if (qtype === QTYPE_ANY) {
        return candidates.map((r) => toRr(ownerName, r.type, r.ttl, r.rdata));
    }
    const matches = candidates.filter((r) => r.type === qtype);
    if (matches.length > 0) {
        return matches.map((r) => toRr(ownerName, r.type, r.ttl, r.rdata));
    }
    // Apex A synthesis: answer with the zone master IP when no A is stored.
    if (qtype === DNSType.A && ownerName === zone.name && isIPv4(zone.masterIp)) {
        return [toRr(ownerName, DNSType.A, opts.ttl, zone.masterIp)];
    }
    // The apex SOA is synthesized from the zone row, so `SOA` queries answer it
    // directly instead of only carrying it in the authority section.
    if (qtype === DNSType.SOA && ownerName === zone.name) {
        return [soaRecord(zone, candidates)];
    }
    return [];
}
function followCname(zone, records, startName, qtype, firstCname, opts) {
    const answers = [];
    const seen = new Set([startName]);
    let current = startName;
    let cname = firstCname;
    for (let hops = 0; hops < MAX_CNAME_HOPS; hops++) {
        answers.push(toRr(current, DNSType.CNAME, cname.ttl, cname.rdata));
        const target = canonicalName(cname.rdata);
        if (target === '' || seen.has(target)) {
            return { rcode: 'SERVFAIL', answers: [], authority: [], additionals: [] };
        }
        seen.add(target);
        if (zone.name !== target && !target.endsWith('.' + zone.name)) {
            // Target is outside this zone: an authoritative server returns the
            // chain and lets the client continue resolving.
            return { rcode: 'NOERROR', answers, authority: [], additionals: [] };
        }
        const exact = records.filter((r) => r.name === target);
        const nextCname = exact.find((r) => r.type === DNSType.CNAME);
        if (nextCname) {
            current = target;
            cname = nextCname;
            continue;
        }
        const targetAnswers = answersFor(zone, exact, target, qtype, opts);
        if (targetAnswers.length > 0) {
            return positive(zone, records, [...answers, ...targetAnswers]);
        }
        return {
            rcode: 'NOERROR',
            answers,
            authority: [soaRecord(zone, records)],
            additionals: [],
        };
    }
    // Chain longer than the hop limit: treat as a loop.
    return { rcode: 'SERVFAIL', answers: [], authority: [], additionals: [] };
}
/** Records of the closest wildcard (*.parent) enclosing this name. */
function findWildcard(records, name) {
    const labels = name.split('.');
    for (let i = 1; i < labels.length; i++) {
        const candidate = '*.' + labels.slice(i).join('.');
        const matches = records.filter((r) => r.name === candidate);
        if (matches.length > 0)
            return matches;
    }
    return [];
}
function positive(zone, records, answers) {
    return {
        rcode: 'NOERROR',
        answers,
        authority: [],
        additionals: glueFor(zone, records, answers),
    };
}
/** A/AAAA glue for in-zone NS, MX and SRV targets. */
function glueFor(zone, records, answers) {
    const targets = new Set();
    for (const rr of answers) {
        if (rr.type !== DNSType.NS && rr.type !== DNSType.MX && rr.type !== DNSType.SRV)
            continue;
        // NS rdata is a name; MX/SRV keep it after their numeric fields.
        const text = decodeRdata(rr);
        const parts = text.split(' ');
        const target = canonicalName(rr.type === DNSType.NS ? text : parts[parts.length - 1]);
        if (target !== '' && (target === zone.name || target.endsWith('.' + zone.name))) {
            targets.add(target);
        }
    }
    const glue = [];
    for (const target of targets) {
        for (const record of records) {
            if (record.name !== target)
                continue;
            if (record.type !== DNSType.A && record.type !== DNSType.AAAA)
                continue;
            glue.push(toRr(target, record.type, record.ttl, record.rdata));
        }
    }
    return glue;
}
function soaRecord(zone, records) {
    const stored = records.find((r) => r.name === zone.name && r.type === DNSType.SOA);
    if (stored)
        return toRr(zone.name, DNSType.SOA, stored.ttl, stored.rdata);
    const soa = `${zone.soa.mname} ${zone.soa.rname} ${zone.soa.serial} ${zone.soa.refresh} ${zone.soa.retry} ${zone.soa.expire} ${zone.soa.minimum}`;
    return toRr(zone.name, DNSType.SOA, Math.min(zone.soa.minimum, 3600), soa);
}
function toRr(name, type, ttl, rdata) {
    const bytes = encodeRdata({ type, value: rdata });
    return { name, type, class: DNSClass.IN, ttl, rdlength: bytes.length, rdata: bytes };
}
//# sourceMappingURL=resolver.js.map