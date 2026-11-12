/**
 * Authoritative DNS server: UDP (RFC 1035 4.2.1) + TCP (4.2.2) on the same
 * port. The request handler is a pure function of the query bytes, so it can
 * be unit-tested without opening sockets.
 */
import dgram from 'node:dgram';
import net from 'node:net';
import { decodeMessage, encodeMessage, u16, } from '../lib/dns/packet.js';
import { resolveQuestion } from '../lib/dns/resolver.js';
import { DNSType } from '../lib/dns/constants.js';
const RCODE_VALUE = {
    NOERROR: 0,
    FORMERR: 1,
    SERVFAIL: 2,
    NXDOMAIN: 3,
    NOTIMP: 4,
    REFUSED: 5,
};
const DEFAULT_UDP_PAYLOAD = 512;
const MAX_UDP_PAYLOAD = 4096;
const TCP_MAX_MESSAGE = 65535;
export class DnsServer {
    zones;
    host;
    port;
    ttl;
    log;
    udp;
    tcp;
    tcpSockets = new Set();
    started = false;
    constructor(options) {
        this.zones = options.zones;
        this.host = options.host ?? '127.0.0.1';
        this.port = options.port ?? 5354;
        this.ttl = options.ttl ?? 300;
        this.log = options.logger ?? ((line) => console.log(line));
    }
    /** Open UDP, then TCP on the same (possibly OS-assigned) port. */
    async start() {
        if (this.started)
            throw new Error('DnsServer: already started');
        const udp = dgram.createSocket('udp4');
        udp.on('message', (msg, rinfo) => {
            const response = this.handleQuery(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
            if (!response)
                return;
            udp.send(response, rinfo.port, rinfo.address, (err) => {
                if (err)
                    this.log(`[dns] udp send to ${rinfo.address}:${rinfo.port} failed: ${err.message}`);
            });
        });
        udp.on('error', (err) => this.log(`[dns] udp socket error: ${err.message}`));
        await new Promise((resolve, reject) => {
            const onError = (err) => {
                udp.close();
                reject(err);
            };
            udp.once('error', onError);
            udp.bind(this.port, this.host, () => {
                udp.off('error', onError);
                resolve();
            });
        });
        const address = udp.address();
        const boundPort = typeof address === 'object' ? address.port : this.port;
        this.udp = udp;
        const tcp = net.createServer((socket) => this.handleTcpConnection(socket));
        tcp.on('error', (err) => this.log(`[dns] tcp server error: ${err.message}`));
        await new Promise((resolve, reject) => {
            tcp.once('error', reject);
            tcp.listen(boundPort, this.host, () => {
                tcp.off('error', reject);
                resolve();
            });
        });
        this.tcp = tcp;
        this.started = true;
        return { host: this.host, port: boundPort };
    }
    async stop() {
        for (const socket of this.tcpSockets)
            socket.destroy();
        this.tcpSockets.clear();
        const tcp = this.tcp;
        this.tcp = undefined;
        if (tcp) {
            await new Promise((resolve) => tcp.close(() => resolve()));
        }
        const udp = this.udp;
        this.udp = undefined;
        if (udp) {
            await new Promise((resolve) => udp.close(() => resolve()));
        }
        this.started = false;
    }
    /**
     * Build the wire response for one query. Returns undefined for packets that
     * must be ignored (responses, or garbage too short to carry an id).
     */
    handleQuery(buf) {
        if (buf.length < 12)
            return undefined;
        let query;
        try {
            query = decodeMessage(buf);
        }
        catch {
            return this.errorResponse(u16(buf, 0), 1 /* FORMERR */);
        }
        // Never answer a response.
        if (query.header.flags.qr)
            return undefined;
        if (query.header.flags.opcode !== 0) {
            return this.errorResponse(query.header.id, RCODE_VALUE.NOTIMP, query);
        }
        if (query.questions.length !== 1) {
            return this.errorResponse(query.header.id, RCODE_VALUE.FORMERR, query);
        }
        const question = query.questions[0];
        let resolution;
        try {
            resolution = resolveQuestion(this.zones, question, { ttl: this.ttl });
        }
        catch (err) {
            this.log(`[dns] ${question.name} ${question.qtype} -> SERVFAIL: ${err.message}`);
            return this.errorResponse(query.header.id, RCODE_VALUE.SERVFAIL, query);
        }
        const maxUdp = udpPayloadSize(query);
        const flags = {
            qr: true,
            opcode: query.header.flags.opcode,
            aa: resolution.zone !== undefined,
            tc: false,
            rd: query.header.flags.rd,
            ra: false,
            ad: false,
            cd: query.header.flags.cd,
            rcode: RCODE_VALUE[resolution.rcode],
        };
        this.log(`[dns] ${question.name} ${question.qtype} -> ${resolution.rcode} ` +
            `(${resolution.answers.length} answers, zone=${resolution.zone?.name ?? '-'})`);
        const response = {
            header: {
                id: query.header.id,
                flags,
                qdcount: 1,
                ancount: resolution.answers.length,
                nscount: resolution.authority.length,
                arcount: resolution.additionals.length,
            },
            questions: [question],
            answers: resolution.answers,
            authorities: resolution.authority,
            additionals: [...resolution.additionals, ...optRecord(query, maxUdp)],
        };
        const encoded = encodeMessage(response);
        if (encoded.length <= maxUdp)
            return encoded;
        // Too large for this transport: retry without answers, set TC so the
        // client retries over TCP.
        const truncated = encodeMessage({
            ...response,
            answers: [],
            header: { ...response.header, flags: { ...flags, tc: true } },
        });
        return truncated;
    }
    errorResponse(id, rcode, query) {
        return encodeMessage({
            header: {
                id,
                flags: {
                    qr: true,
                    opcode: query?.header.flags.opcode ?? 0,
                    aa: false,
                    tc: false,
                    rd: query?.header.flags.rd ?? false,
                    ra: false,
                    ad: false,
                    cd: false,
                    rcode,
                },
                qdcount: query?.questions.length ?? 0,
                ancount: 0,
                nscount: 0,
                arcount: 0,
            },
            questions: query?.questions ?? [],
            answers: [],
            authorities: [],
            additionals: [],
        });
    }
    handleTcpConnection(socket) {
        this.tcpSockets.add(socket);
        let buffered = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.length >= 2) {
                const length = buffered.readUInt16BE(0);
                if (length === 0 || length > TCP_MAX_MESSAGE) {
                    socket.destroy();
                    return;
                }
                if (buffered.length < 2 + length)
                    return;
                const message = buffered.subarray(2, 2 + length);
                buffered = buffered.subarray(2 + length);
                const response = this.handleQuery(new Uint8Array(message));
                if (!response)
                    continue;
                const framed = Buffer.allocUnsafe(2 + response.length);
                framed.writeUInt16BE(response.length, 0);
                Buffer.from(response).copy(framed, 2);
                socket.write(framed);
            }
        });
        socket.on('error', () => socket.destroy());
        socket.on('close', () => this.tcpSockets.delete(socket));
        socket.setTimeout(30_000, () => socket.destroy());
    }
}
/** EDNS0 client payload size, clamped to what we are willing to emit. */
function udpPayloadSize(query) {
    const opt = query.additionals.find((rr) => rr.type === DNSType.OPT);
    if (!opt)
        return DEFAULT_UDP_PAYLOAD;
    return Math.min(Math.max(opt.class, DEFAULT_UDP_PAYLOAD), MAX_UDP_PAYLOAD);
}
/** Mirror the client's OPT record (empty rdata, our payload size). */
function optRecord(query, payloadSize) {
    const opt = query.additionals.find((rr) => rr.type === DNSType.OPT);
    if (!opt)
        return [];
    return [
        {
            name: '.',
            type: DNSType.OPT,
            class: payloadSize,
            ttl: 0, // extended RCODE 0, version 0, no flags
            rdlength: 0,
            rdata: new Uint8Array(0),
        },
    ];
}
//# sourceMappingURL=dns-server.js.map