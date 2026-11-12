/**
 * DNS message codec - RFC 1035 section 4.1.2 & 4.1.4.
 *
 * Design goals:
 *  - Zero runtime dependencies.
 *  - Every byte read is bounds-checked; out-of-range => throw (never silent).
 *  - Parsing supports name compression pointers (queries and upstream answers).
 *  - Encoding emits uncompressed names and derives section counts from the
 *    actual arrays, so a response can never advertise records it did not write.
 *  - RDATA for A/AAAA/CNAME/NS/PTR/MX/TXT/SOA/SRV/NAPTR/CAA/ENDPOINT is (de)serialised
 *    to/from the wire with strict validation.
 */
import { Buffer } from 'node:buffer';
import { DNSType } from './constants.js';
// ---------------------------------------------------------------------------
// Low-level byte helpers (network byte order = big-endian)
// ---------------------------------------------------------------------------
export function u8(buf, off) {
    if (off < 0 || off + 1 > buf.length)
        throw new RangeError(`u8: offset ${off} out of range`);
    return buf[off];
}
export function u16(buf, off) {
    if (off < 0 || off + 2 > buf.length)
        throw new RangeError(`u16: offset ${off} out of range`);
    return ((buf[off] << 8) | buf[off + 1]) >>> 0;
}
export function u32(buf, off) {
    if (off < 0 || off + 4 > buf.length)
        throw new RangeError(`u32: offset ${off} out of range`);
    return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}
function u16Bytes(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff)
        throw new RangeError(`u16: value ${n} out of range`);
    return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
}
function u32Bytes(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff)
        throw new RangeError(`u32: value ${n} out of range`);
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function concat(parts) {
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}
export function parseFlags(flags16) {
    return {
        qr: ((flags16 >>> 15) & 1) === 1,
        opcode: (flags16 >>> 11) & 0xf,
        aa: ((flags16 >>> 10) & 1) === 1,
        tc: ((flags16 >>> 9) & 1) === 1,
        rd: ((flags16 >>> 8) & 1) === 1,
        ra: ((flags16 >>> 7) & 1) === 1,
        ad: ((flags16 >>> 5) & 1) === 1,
        cd: ((flags16 >>> 4) & 1) === 1,
        rcode: flags16 & 0xf,
    };
}
export function flagsToWire(flags) {
    let wire = 0;
    if (flags.qr)
        wire |= 0x8000;
    wire |= (flags.opcode & 0xf) << 11;
    if (flags.aa)
        wire |= 0x0400;
    if (flags.tc)
        wire |= 0x0200;
    if (flags.rd)
        wire |= 0x0100;
    if (flags.ra)
        wire |= 0x0080;
    if (flags.ad)
        wire |= 0x0020;
    if (flags.cd)
        wire |= 0x0010;
    wire |= flags.rcode & 0xf;
    return wire >>> 0;
}
const MAX_POINTER_JUMPS = 64;
/**
 * Decode a (possibly compressed) domain name starting at `off`.
 * `end` bounds the message; pointers must resolve inside it.
 */
export function decodeName(buf, off, end) {
    if (off < 0 || off >= end)
        throw new RangeError(`decodeName: offset ${off} out of range`);
    const labels = [];
    let pos = off;
    let nextOffset = -1;
    let jumps = 0;
    while (true) {
        const len = u8(buf, pos);
        if (len === 0) {
            if (nextOffset === -1)
                nextOffset = pos + 1;
            break;
        }
        const kind = len & 0xc0;
        if (kind === 0xc0) {
            if (pos + 1 >= end)
                throw new RangeError('decodeName: truncated compression pointer');
            const pointer = ((len & 0x3f) << 8) | buf[pos + 1];
            if (nextOffset === -1)
                nextOffset = pos + 2;
            if (pointer >= end)
                throw new RangeError(`decodeName: pointer ${pointer} outside message`);
            if (pointer >= pos)
                throw new RangeError('decodeName: forward compression pointer (loop)');
            if (++jumps > MAX_POINTER_JUMPS)
                throw new RangeError('decodeName: too many compression pointers');
            pos = pointer;
            continue;
        }
        if (kind !== 0x00)
            throw new RangeError(`decodeName: reserved label type 0x${kind.toString(16)}`);
        if (len > 63)
            throw new RangeError(`decodeName: label length ${len} > 63`);
        pos += 1;
        if (pos + len > end)
            throw new RangeError('decodeName: label exceeds message');
        labels.push(new TextDecoder().decode(buf.subarray(pos, pos + len)));
        pos += len;
    }
    const name = labels.length === 0 ? '.' : labels.join('.').toLowerCase() + '.';
    return { name, nextOffset };
}
/**
 * Encode a domain name as uncompressed labels (RFC 1035 section 3.1).
 * Accepts relative or absolute input; output is always absolute.
 */
export function encodeName(name) {
    if (typeof name !== 'string')
        throw new TypeError('encodeName: expected a string');
    const absolute = name.endsWith('.') || name === '' ? name : name + '.';
    const parts = absolute === '.' ? [] : absolute.slice(0, -1).split('.');
    const chunks = [];
    let wireLength = 1; // terminating root
    for (const part of parts) {
        if (part.length === 0)
            throw new RangeError(`encodeName: empty label in "${name}"`);
        const bytes = new TextEncoder().encode(part);
        if (bytes.length > 63)
            throw new RangeError(`encodeName: label "${part}" longer than 63 bytes`);
        chunks.push(new Uint8Array([bytes.length]), bytes);
        wireLength += bytes.length + 1;
    }
    if (wireLength > 255)
        throw new RangeError(`encodeName: "${name}" longer than 255 bytes`);
    chunks.push(new Uint8Array([0]));
    return concat(chunks);
}
export function decodeQuestion(buf, off, end) {
    const decoded = decodeName(buf, off, end);
    const qtype = u16(buf, decoded.nextOffset);
    const qclass = u16(buf, decoded.nextOffset + 2);
    return {
        question: { name: decoded.name, qtype, qclass },
        nextOffset: decoded.nextOffset + 4,
    };
}
export function decodeRR(buf, off, end) {
    const decoded = decodeName(buf, off, end);
    const fixed = decoded.nextOffset;
    if (fixed + 10 > end)
        throw new RangeError('decodeRR: truncated resource record header');
    const type = u16(buf, fixed);
    const rclass = u16(buf, fixed + 2);
    const ttl = u32(buf, fixed + 4);
    const rdlength = u16(buf, fixed + 8);
    const rdataOffset = fixed + 10;
    const rdataEnd = rdataOffset + rdlength;
    if (rdataEnd > end)
        throw new RangeError('decodeRR: rdata exceeds message');
    return {
        rr: {
            name: decoded.name,
            type,
            class: rclass,
            ttl,
            rdlength,
            rdata: buf.subarray(rdataOffset, rdataEnd),
            rdataOffset,
        },
        nextOffset: rdataEnd,
    };
}
// ---------------------------------------------------------------------------
// RDATA (de)serialisation
// ---------------------------------------------------------------------------
/** Split on spaces, keeping "quoted strings" (and their spaces) together. */
export function tokenize(value) {
    const tokens = [];
    let current = '';
    let quoted = false;
    let hasToken = false;
    for (const ch of value.trim()) {
        if (ch === '"') {
            quoted = !quoted;
            hasToken = true;
            continue;
        }
        if (!quoted && /\s/.test(ch)) {
            if (hasToken) {
                tokens.push(current);
                current = '';
                hasToken = false;
            }
            continue;
        }
        current += ch;
        hasToken = true;
    }
    if (quoted)
        throw new Error(`tokenize: unterminated quote in "${value}"`);
    if (hasToken)
        tokens.push(current);
    return tokens;
}
function requireTokens(value, count, type) {
    const tokens = tokenize(value);
    if (tokens.length !== count) {
        throw new Error(`${type}: expected ${count} fields, got ${tokens.length} in "${value}"`);
    }
    return tokens;
}
function wireNumber(value, field) {
    if (!/^\d+$/.test(value))
        throw new Error(`${field}: not a number "${value}"`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
        throw new Error(`${field}: out of range "${value}"`);
    return n;
}
/**
 * ENDPOINT is a private-use RR type (65280) whose RDATA is the UTF-8 text
 * `host:port` (IPv6 targets are bracketed). DNS itself only carries the data;
 * a client that knows this type can connect to the returned endpoint.
 */
function endpointError(message) {
    return new Error(`ENDPOINT: ${message}`);
}
function canonicalEndpointHostname(host) {
    const name = host.toLowerCase().replace(/\.$/, '');
    if (name.length === 0)
        throw endpointError('host is empty');
    if (name.length > 253)
        throw endpointError('host is longer than 253 characters');
    for (const label of name.split('.')) {
        if (label.length === 0)
            throw endpointError(`host has an empty label in "${host}"`);
        if (label.length > 63)
            throw endpointError(`host label "${label}" is longer than 63 characters`);
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
            throw endpointError(`invalid host label "${label}"`);
        }
    }
    return name;
}
/** Validate and canonicalise `host:port` / `[ipv6]:port` for an ENDPOINT RR. */
export function canonicalEndpoint(value) {
    if (typeof value !== 'string')
        throw endpointError('value must be a string');
    const input = value.trim();
    if (input === '')
        throw endpointError('value is empty');
    if (/\s/.test(input))
        throw endpointError(`whitespace is not allowed in "${value}"`);
    let host;
    let portText;
    if (input.startsWith('[')) {
        const close = input.indexOf(']');
        if (close < 2)
            throw endpointError(`missing IPv6 address in "${value}"`);
        if (input[close + 1] !== ':')
            throw endpointError('IPv6 endpoint must look like [address]:port');
        host = input.slice(1, close);
        portText = input.slice(close + 2);
        if (portText.includes(':'))
            throw endpointError('too many colons in endpoint');
        host = `[${decodeAAAA(validateAAAA(host))}]`;
    }
    else {
        const first = input.indexOf(':');
        const last = input.lastIndexOf(':');
        if (first < 0)
            throw endpointError('missing ":port"');
        if (first !== last)
            throw endpointError('IPv6 addresses must be bracketed: [address]:port');
        host = input.slice(0, last);
        portText = input.slice(last + 1);
        if (host.length === 0)
            throw endpointError('host is empty');
        if (host.includes('[') || host.includes(']'))
            throw endpointError('unexpected bracket in host');
        if (/^[\d.]+$/.test(host)) {
            if (!isIPv4(host))
                throw endpointError(`invalid IPv4 address "${host}"`);
            host = decodeA(validateA(host));
        }
        else {
            host = canonicalEndpointHostname(host);
        }
    }
    if (!/^\d{1,5}$/.test(portText))
        throw endpointError(`port is not a number in "${value}"`);
    const port = Number(portText);
    if (port < 1 || port > 65535)
        throw endpointError(`port ${port} is outside 1-65535`);
    return `${host}:${port}`;
}
/** Decode rdata into the canonical text form used in the zone database. */
export function decodeRdata(rr, message) {
    const { type, rdata } = rr;
    // Name fields inside rdata may use compression pointers against the message.
    const nameAt = (offset) => {
        if (message === undefined) {
            const decoded = decodeName(rdata, offset, rdata.length);
            return { name: decoded.name, nextOffset: decoded.nextOffset };
        }
        const rdataOffset = rr.rdataOffset ?? 0;
        const decoded = decodeName(message, rdataOffset + offset, message.length);
        // decodeName reports an absolute message offset; callers index into rdata.
        return { name: decoded.name, nextOffset: decoded.nextOffset - rdataOffset };
    };
    switch (type) {
        case DNSType.A:
            return decodeA(rdata);
        case DNSType.AAAA:
            return decodeAAAA(rdata);
        case DNSType.CNAME:
        case DNSType.NS:
        case DNSType.PTR:
            return nameAt(0).name;
        case DNSType.MX: {
            const preference = u16(rdata, 0);
            return `${preference} ${nameAt(2).name}`;
        }
        case DNSType.SOA: {
            const mname = nameAt(0);
            const rname = nameAt(mname.nextOffset);
            const pos = rname.nextOffset;
            const serial = u32(rdata, pos);
            const refresh = u32(rdata, pos + 4);
            const retry = u32(rdata, pos + 8);
            const expire = u32(rdata, pos + 12);
            const minimum = u32(rdata, pos + 16);
            return `${mname.name} ${rname.name} ${serial} ${refresh} ${retry} ${expire} ${minimum}`;
        }
        case DNSType.TXT: {
            const parts = [];
            let pos = 0;
            while (pos < rdata.length) {
                const len = rdata[pos];
                pos += 1;
                if (pos + len > rdata.length)
                    throw new RangeError('decodeRdata: TXT chunk exceeds rdata');
                parts.push(new TextDecoder().decode(rdata.subarray(pos, pos + len)));
                pos += len;
            }
            return parts.join('');
        }
        case DNSType.SRV: {
            const priority = u16(rdata, 0);
            const weight = u16(rdata, 2);
            const port = u16(rdata, 4);
            return `${priority} ${weight} ${port} ${nameAt(6).name}`;
        }
        case DNSType.NAPTR: {
            let pos = 0;
            const order = u16(rdata, pos);
            pos += 2;
            const preference = u16(rdata, pos);
            pos += 2;
            const fields = [];
            for (let i = 0; i < 3; i++) {
                const len = u8(rdata, pos);
                pos += 1;
                if (pos + len > rdata.length)
                    throw new RangeError('decodeRdata: NAPTR field exceeds rdata');
                fields.push(new TextDecoder().decode(rdata.subarray(pos, pos + len)));
                pos += len;
            }
            const replacement = nameAt(pos).name;
            const [flags, service, regexp] = fields.map((f) => `"${f}"`);
            return `${order} ${preference} ${flags} ${service} ${regexp} ${replacement}`;
        }
        case DNSType.CAA: {
            if (rdata.length < 2)
                throw new RangeError('decodeRdata: CAA rdata too short');
            const flags = u8(rdata, 0);
            const tagLength = u8(rdata, 1);
            if (2 + tagLength > rdata.length)
                throw new RangeError('decodeRdata: CAA tag exceeds rdata');
            const tag = new TextDecoder().decode(rdata.subarray(2, 2 + tagLength));
            const value = new TextDecoder().decode(rdata.subarray(2 + tagLength));
            return `${flags} ${tag} ${value}`;
        }
        case DNSType.ENDPOINT:
            return canonicalEndpoint(new TextDecoder().decode(rdata));
        default:
            return `<unknown type ${type}>`;
    }
}
/** Encode canonical text rdata into wire bytes. */
export function encodeRdata(record) {
    const { type } = record;
    const value = record.value ?? '';
    switch (type) {
        case DNSType.A:
            return validateA(value);
        case DNSType.AAAA:
            return validateAAAA(value);
        case DNSType.CNAME:
        case DNSType.NS:
        case DNSType.PTR:
            return encodeName(value);
        case DNSType.MX: {
            const [first, second] = requireTokens(value, 2, 'MX');
            // Canonical order is "preference target"; tolerate "target preference".
            const [preference, target] = /^\d+$/.test(first) ? [first, second] : [second, first];
            return concat([u16Bytes(wireNumber(preference, 'MX preference')), encodeName(target)]);
        }
        case DNSType.SOA: {
            const [mname, rname, serial, refresh, retry, expire, minimum] = requireTokens(value, 7, 'SOA');
            return concat([
                encodeName(mname),
                encodeName(rname),
                u32Bytes(wireNumber(serial, 'SOA serial')),
                u32Bytes(wireNumber(refresh, 'SOA refresh')),
                u32Bytes(wireNumber(retry, 'SOA retry')),
                u32Bytes(wireNumber(expire, 'SOA expire')),
                u32Bytes(wireNumber(minimum, 'SOA minimum')),
            ]);
        }
        case DNSType.TXT: {
            const bytes = new TextEncoder().encode(value);
            if (bytes.length === 0)
                return new Uint8Array([0]);
            const chunks = [];
            for (let pos = 0; pos < bytes.length; pos += 255) {
                const slice = bytes.subarray(pos, Math.min(pos + 255, bytes.length));
                chunks.push(new Uint8Array([slice.length]), slice);
            }
            return concat(chunks);
        }
        case DNSType.SRV: {
            const [priority, weight, port, target] = requireTokens(value, 4, 'SRV');
            return concat([
                u16Bytes(wireNumber(priority, 'SRV priority')),
                u16Bytes(wireNumber(weight, 'SRV weight')),
                u16Bytes(wireNumber(port, 'SRV port')),
                encodeName(target),
            ]);
        }
        case DNSType.NAPTR: {
            const [order, preference, flags, service, regexp, replacement] = requireTokens(value, 6, 'NAPTR');
            return concat([
                u16Bytes(wireNumber(order, 'NAPTR order')),
                u16Bytes(wireNumber(preference, 'NAPTR preference')),
                encodeCharString(flags, 'NAPTR flags'),
                encodeCharString(service, 'NAPTR service'),
                encodeCharString(regexp, 'NAPTR regexp'),
                encodeName(replacement),
            ]);
        }
        case DNSType.CAA: {
            const tokens = tokenize(value);
            if (tokens.length < 2)
                throw new Error(`CAA: expected "<flags> <tag> [value]", got "${value}"`);
            const flags = wireNumber(tokens[0], 'CAA flags');
            if (flags > 255)
                throw new Error('CAA flags: must fit in one byte');
            const tag = new TextEncoder().encode(tokens[1]);
            if (tag.length === 0 || tag.length > 255)
                throw new Error('CAA tag: length must be 1-255');
            const caaValue = new TextEncoder().encode(tokens.slice(2).join(' '));
            return concat([new Uint8Array([flags, tag.length]), tag, caaValue]);
        }
        case DNSType.ENDPOINT: {
            const bytes = new TextEncoder().encode(canonicalEndpoint(value));
            if (bytes.length > 0xffff)
                throw endpointError('rdata is longer than 65535 bytes');
            return bytes;
        }
        default:
            throw new Error(`encodeRdata: unsupported record type ${type}`);
    }
}
function encodeCharString(value, field) {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > 255)
        throw new Error(`${field}: longer than 255 bytes`);
    return concat([new Uint8Array([bytes.length]), bytes]);
}
export function validateA(ip) {
    const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m)
        throw new Error(`validateA: invalid IPv4 "${ip}"`);
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    for (const o of octets) {
        if (o < 0 || o > 255)
            throw new Error(`validateA: octet out of range in "${ip}"`);
    }
    return new Uint8Array(octets);
}
export function isIPv4(value) {
    try {
        validateA(value);
        return true;
    }
    catch {
        return false;
    }
}
export function validateAAAA(ip) {
    const addr = ip.trim().toLowerCase();
    if (addr === '::')
        return new Uint8Array(16);
    const doubleColons = addr.split('::').length - 1;
    if (doubleColons > 1)
        throw new Error('validateAAAA: more than one "::"');
    const parseGroups = (part) => {
        if (part === '')
            return [];
        return part.split(':').map((group) => {
            if (!/^[0-9a-f]{1,4}$/.test(group))
                throw new Error(`validateAAAA: invalid group "${group}"`);
            return parseInt(group, 16);
        });
    };
    let groups;
    if (doubleColons === 1) {
        const [left, right] = addr.split('::');
        const leftGroups = parseGroups(left);
        const rightGroups = parseGroups(right);
        const missing = 8 - leftGroups.length - rightGroups.length;
        if (missing < 1)
            throw new Error('validateAAAA: too many groups for "::"');
        groups = [...leftGroups, ...new Array(missing).fill(0), ...rightGroups];
    }
    else {
        groups = parseGroups(addr);
        if (groups.length !== 8)
            throw new Error('validateAAAA: expected 8 groups');
    }
    const out = new Uint8Array(16);
    groups.forEach((group, i) => {
        out[i * 2] = (group >>> 8) & 0xff;
        out[i * 2 + 1] = group & 0xff;
    });
    return out;
}
/** Decode 4 rdata bytes into dotted-decimal IPv4. */
export function decodeA(rdata) {
    if (rdata.length !== 4)
        throw new RangeError('decodeA: expected 4 bytes');
    return `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
}
/** Decode 16 rdata bytes into a compressed IPv6 string. */
export function decodeAAAA(rdata) {
    if (rdata.length !== 16)
        throw new RangeError('decodeAAAA: expected 16 bytes');
    const groups = [];
    for (let i = 0; i < 8; i++)
        groups.push((rdata[i * 2] << 8) | rdata[i * 2 + 1]);
    // Find the longest run of zero groups (>= 2) for "::" compression.
    let bestStart = -1;
    let bestLength = 0;
    for (let i = 0; i < 8;) {
        if (groups[i] !== 0) {
            i++;
            continue;
        }
        let j = i;
        while (j < 8 && groups[j] === 0)
            j++;
        if (j - i > bestLength) {
            bestStart = i;
            bestLength = j - i;
        }
        i = j;
    }
    const hex = groups.map((g) => g.toString(16));
    if (bestLength < 2)
        return hex.join(':');
    const left = hex.slice(0, bestStart).join(':');
    const right = hex.slice(bestStart + bestLength).join(':');
    return `${left}::${right}`;
}
export function decodeMessage(buf) {
    if (buf.length < 12)
        throw new RangeError('decodeMessage: too short for a DNS header');
    const id = u16(buf, 0);
    const flags = parseFlags(u16(buf, 2));
    const qdcount = u16(buf, 4);
    const ancount = u16(buf, 6);
    const nscount = u16(buf, 8);
    const arcount = u16(buf, 10);
    const end = buf.length;
    let off = 12;
    const questions = [];
    for (let i = 0; i < qdcount; i++) {
        const decoded = decodeQuestion(buf, off, end);
        questions.push(decoded.question);
        off = decoded.nextOffset;
    }
    const answers = [];
    for (let i = 0; i < ancount; i++) {
        const decoded = decodeRR(buf, off, end);
        answers.push(decoded.rr);
        off = decoded.nextOffset;
    }
    const authorities = [];
    for (let i = 0; i < nscount; i++) {
        const decoded = decodeRR(buf, off, end);
        authorities.push(decoded.rr);
        off = decoded.nextOffset;
    }
    const additionals = [];
    for (let i = 0; i < arcount; i++) {
        const decoded = decodeRR(buf, off, end);
        additionals.push(decoded.rr);
        off = decoded.nextOffset;
    }
    return {
        header: { id, flags, qdcount, ancount, nscount, arcount },
        questions,
        answers,
        authorities,
        additionals,
    };
}
/**
 * Validate rdata text and return its canonical form (names absolute and
 * lower-case, numeric fields re-serialised). Throws on invalid input.
 */
export function canonicalizeRdata(type, value) {
    const rdata = encodeRdata({ type, value });
    return decodeRdata({ name: '.', type, class: 1, ttl: 0, rdlength: rdata.length, rdata });
}
/** Build a single-question recursive query (used by tests and tools). */
export function buildQuery(id, question) {
    return encodeMessage({
        header: {
            id,
            flags: {
                qr: false,
                opcode: 0,
                aa: false,
                tc: false,
                rd: true,
                ra: false,
                ad: false,
                cd: false,
                rcode: 0,
            },
            qdcount: 1,
            ancount: 0,
            nscount: 0,
            arcount: 0,
        },
        questions: [question],
        answers: [],
        authorities: [],
        additionals: [],
    });
}
/** Serialise a message; section counts are derived from the arrays. */
export function encodeMessage(msg) {
    const header = new Uint8Array(12);
    header.set(u16Bytes(msg.header.id), 0);
    header.set(u16Bytes(flagsToWire(msg.header.flags)), 2);
    header.set(u16Bytes(msg.questions.length), 4);
    header.set(u16Bytes(msg.answers.length), 6);
    header.set(u16Bytes(msg.authorities.length), 8);
    header.set(u16Bytes(msg.additionals.length), 10);
    const parts = [header];
    for (const q of msg.questions) {
        parts.push(encodeName(q.name), u16Bytes(q.qtype), u16Bytes(q.qclass));
    }
    for (const section of [msg.answers, msg.authorities, msg.additionals]) {
        for (const rr of section) {
            if (rr.rdata.length > 0xffff)
                throw new RangeError(`encodeMessage: rdata too long for ${rr.name}`);
            parts.push(encodeName(rr.name), u16Bytes(rr.type), u16Bytes(rr.class), u32Bytes(rr.ttl), u16Bytes(rr.rdata.length), rr.rdata);
        }
    }
    return Buffer.concat(parts);
}
//# sourceMappingURL=packet.js.map