/**
 * REST API for zone records, authenticated with per-user Bearer tokens:
 *
 *   POST /api/v1/auth/login          username + password -> token
 *   GET  /api/v1/auth/me             current user
 *   POST /api/v1/auth/logout         revoke the presented token
 *   GET  /api/v1/health              liveness (no auth)
 *   GET  /api/v1/zones               zones with record counts
 *   GET  /api/v1/resolve?name=...    ENDPOINT lookup (host:port)
 *   GET  /api/v1/zones/:zone         one zone
 *   GET  /api/v1/zones/:zone/records list (optional ?name= &type=)
 *   POST /api/v1/zones/:zone/records create
 *   GET/PATCH/DELETE .../records/:id read, edit, delete
 *
 * Reads need any signed-in user; writes need the admin or dns role. The API
 * binds to the configured host and `api_port`; keep it on loopback or put a
 * TLS reverse proxy in front of it, since Bearer tokens travel in the header.
 */
import http from 'node:http';
import { DNSType, isSupportedType } from '../lib/dns/constants.js';
import { canonicalName, qualifyName } from '../lib/zones/manager.js';
import { typeLabel } from '../lib/zones/types.js';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TTL = 86_400;
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_WINDOW_MS = 60_000;
const TYPE_NAMES = {
    A: DNSType.A,
    NS: DNSType.NS,
    CNAME: DNSType.CNAME,
    PTR: DNSType.PTR,
    MX: DNSType.MX,
    TXT: DNSType.TXT,
    AAAA: DNSType.AAAA,
    SRV: DNSType.SRV,
    NAPTR: DNSType.NAPTR,
    CAA: DNSType.CAA,
    ENDPOINT: DNSType.ENDPOINT,
};
export class ApiError extends Error {
    status;
    code;
    headers;
    constructor(status, code, message, headers = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.headers = headers;
        this.name = 'ApiError';
    }
}
function publicUser(user) {
    return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}
function zoneJson(zone, records) {
    return {
        id: zone.id,
        name: zone.name,
        masterIp: zone.masterIp,
        soa: zone.soa,
        records,
        createdAt: zone.createdAt,
        updatedAt: zone.updatedAt,
    };
}
function recordJson(record, zone) {
    return {
        id: record.id,
        zone: zone.name,
        name: record.name,
        type: typeLabel(record.type),
        ttl: record.ttl,
        rdata: record.rdata,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}
function badRequest(message) {
    return new ApiError(400, 'invalid_request', message);
}
function requireString(value, field, allowEmpty = false) {
    if (typeof value !== 'string')
        throw badRequest(`"${field}" must be a string`);
    if (!allowEmpty && value.trim() === '')
        throw badRequest(`"${field}" is required`);
    return value;
}
function parseType(value) {
    let type;
    if (typeof value === 'number' && Number.isInteger(value)) {
        type = value;
    }
    else if (typeof value === 'string') {
        const text = value.trim().toUpperCase();
        type = TYPE_NAMES[text] ?? (/^\d+$/.test(text) ? Number(text) : undefined);
    }
    if (type === undefined || !Number.isInteger(type) || !isSupportedType(type)) {
        throw badRequest('"type" must be one of A, AAAA, CNAME, NS, PTR, MX, TXT, SRV, NAPTR, CAA, ENDPOINT');
    }
    if (type === DNSType.SOA) {
        throw badRequest('the SOA record is managed by the zone and cannot be edited over the API');
    }
    return type;
}
function parseTtl(value) {
    const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value.trim())
            ? Number(value)
            : NaN;
    if (!Number.isInteger(number) || number < 1 || number > MAX_TTL) {
        throw badRequest(`"ttl" must be a whole number between 1 and ${MAX_TTL}`);
    }
    return number;
}
function parseId(value) {
    if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw badRequest('record id must be a positive integer');
    }
    return Number(value);
}
export class ApiServer {
    zones;
    users;
    tokens;
    host;
    port;
    defaultTtl;
    version;
    dns;
    log;
    failedLogins = new Map();
    server;
    started = false;
    constructor(options) {
        this.zones = options.zones;
        this.users = options.users;
        this.tokens = options.tokens;
        this.host = options.host ?? '127.0.0.1';
        this.port = options.port ?? 8080;
        this.defaultTtl = options.ttl ?? 300;
        this.version = options.version ?? '0.0.0';
        this.dns = options.dns ?? null;
        this.log = options.logger ?? (() => { });
    }
    async start() {
        if (this.started)
            throw new Error('ApiServer: already started');
        const server = http.createServer((req, res) => {
            void this.handle(req, res);
        });
        server.on('clientError', (_error, socket) => {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        });
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                server.close();
                reject(error);
            };
            server.once('error', onError);
            server.listen(this.port, this.host, () => {
                server.off('error', onError);
                resolve();
            });
        });
        const address = server.address();
        this.server = server;
        this.started = true;
        return { host: this.host, port: address?.port ?? this.port };
    }
    async stop() {
        const server = this.server;
        this.server = undefined;
        this.started = false;
        if (!server)
            return;
        await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
        });
    }
    async handle(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
            await this.route(req, res);
        }
        catch (error) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            if (error instanceof ApiError) {
                this.sendError(res, error);
                return;
            }
            this.log(`[api] ${req.method} ${req.url} -> 500: ${error.message}`);
            this.sendError(res, new ApiError(500, 'internal_error', 'unexpected server error'));
        }
    }
    sendError(res, error) {
        const headers = { ...error.headers };
        if (error.status === 401)
            headers['WWW-Authenticate'] = 'Bearer realm="micronic"';
        this.sendJson(res, error.status, { error: { code: error.code, message: error.message } }, headers);
    }
    sendJson(res, status, payload, headers = {}) {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            ...headers,
        });
        res.end(body);
    }
    async route(req, res) {
        const method = req.method ?? 'GET';
        let url;
        try {
            url = new URL(req.url ?? '/', 'http://localhost');
        }
        catch {
            throw badRequest('invalid request URL');
        }
        let parts;
        try {
            parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
        }
        catch {
            throw badRequest('invalid path encoding');
        }
        if (parts[0] !== 'api' || parts[1] !== 'v1') {
            throw new ApiError(404, 'not_found', 'no such endpoint');
        }
        const rest = parts.slice(2);
        if (rest.length === 0)
            throw new ApiError(404, 'not_found', 'no such endpoint');
        if (rest.length === 1 && rest[0] === 'health') {
            this.requireMethod(req, ['GET']);
            this.sendJson(res, 200, {
                status: 'ok',
                version: this.version,
                time: Date.now(),
                dns: this.dns,
            });
            return;
        }
        if (rest.length === 2 && rest[0] === 'auth' && rest[1] === 'login') {
            this.requireMethod(req, ['POST']);
            await this.login(req, res);
            return;
        }
        const auth = this.requireAuth(req);
        if (rest.length === 2 && rest[0] === 'auth' && rest[1] === 'me') {
            this.requireMethod(req, ['GET']);
            this.sendJson(res, 200, { user: publicUser(auth.user) });
            return;
        }
        if (rest.length === 2 && rest[0] === 'auth' && rest[1] === 'logout') {
            this.requireMethod(req, ['POST']);
            this.tokens.revoke(auth.token);
            res.writeHead(204);
            res.end();
            return;
        }
        // Convenience for clients that do not speak the private ENDPOINT RR type:
        // the DNS data is public, but keep the API consistent with /zones and
        // require a signed-in user.
        if (rest.length === 1 && rest[0] === 'resolve') {
            this.requireMethod(req, ['GET']);
            this.resolveEndpoint(res, url);
            return;
        }
        if (rest[0] !== 'zones')
            throw new ApiError(404, 'not_found', 'no such endpoint');
        if (rest.length === 1) {
            this.requireMethod(req, ['GET']);
            const zones = this.zones.listZones().map((zone) => zoneJson(zone, this.zones.listRecords(zone.id).length));
            this.sendJson(res, 200, { zones });
            return;
        }
        const zone = this.zone(rest[1]);
        if (rest.length === 2) {
            this.requireMethod(req, ['GET']);
            this.sendJson(res, 200, { zone: zoneJson(zone, this.zones.listRecords(zone.id).length) });
            return;
        }
        if (rest[2] !== 'records')
            throw new ApiError(404, 'not_found', 'no such endpoint');
        if (rest.length === 3) {
            this.requireMethod(req, ['GET', 'POST']);
            if (method === 'GET')
                return this.listRecords(res, zone, url);
            this.requireManager(auth.user);
            return this.createRecord(req, res, zone);
        }
        if (rest.length === 4) {
            this.requireMethod(req, ['GET', 'PATCH', 'DELETE']);
            const id = parseId(rest[3]);
            const record = this.record(zone, id);
            if (method === 'GET') {
                this.sendJson(res, 200, { record: recordJson(record, zone) });
                return;
            }
            this.requireManager(auth.user);
            if (method === 'PATCH')
                return this.updateRecord(req, res, zone, record);
            this.zones.deleteRecord(record.id);
            res.writeHead(204);
            res.end();
            return;
        }
        throw new ApiError(404, 'not_found', 'no such endpoint');
    }
    async login(req, res) {
        const body = await this.readBody(req);
        const username = requireString(body.username, 'username').trim().toLowerCase();
        const password = requireString(body.password, 'password');
        const key = req.socket.remoteAddress ?? 'unknown';
        this.assertLoginAllowed(key);
        const user = this.users.authenticate(username, password);
        if (!user) {
            this.noteLoginFailure(key);
            throw new ApiError(401, 'invalid_credentials', 'username or password is incorrect');
        }
        this.failedLogins.delete(key);
        const issued = this.tokens.issue(user.id, { label: 'login' });
        this.sendJson(res, 200, {
            token: issued.token,
            tokenType: 'Bearer',
            expiresAt: issued.expiresAt,
            user: publicUser(user),
        });
    }
    listRecords(res, zone, url) {
        let records = this.zones.listRecords(zone.id);
        const name = url.searchParams.get('name');
        if (name !== null && name.trim() !== '') {
            const fqdn = qualifyName(name, zone.name);
            records = records.filter((record) => record.name === fqdn);
        }
        const type = url.searchParams.get('type');
        if (type !== null && type.trim() !== '') {
            const wanted = parseType(type);
            records = records.filter((record) => record.type === wanted);
        }
        this.sendJson(res, 200, {
            zone: zoneJson(zone, this.zones.listRecords(zone.id).length),
            records: records.map((record) => recordJson(record, zone)),
            count: records.length,
        });
    }
    resolveEndpoint(res, url) {
        const requested = url.searchParams.get('name');
        if (requested === null || requested.trim() === '') {
            throw badRequest('"name" query parameter is required');
        }
        const name = canonicalName(requested);
        if (name === '')
            throw badRequest('"name" must be a DNS name');
        const zone = this.zones.findZoneFor(name);
        if (!zone)
            throw new ApiError(404, 'name_not_found', `${name} is not inside a zone served here`);
        const matches = this.zones
            .listRecords(zone.id)
            .filter((record) => record.name === name && record.type === DNSType.ENDPOINT);
        if (matches.length === 0) {
            throw new ApiError(404, 'endpoint_not_found', `no ENDPOINT record for ${name}`);
        }
        this.sendJson(res, 200, {
            name,
            zone: zone.name,
            endpoint: matches[0].rdata,
            endpoints: matches.map((record) => record.rdata),
            ttl: matches[0].ttl,
        });
    }
    async createRecord(req, res, zone) {
        const body = await this.readBody(req);
        const name = requireString(body.name, 'name').trim();
        const type = parseType(body.type);
        const rdata = requireString(body.rdata, 'rdata', true);
        const ttl = body.ttl === undefined ? this.defaultTtl : parseTtl(body.ttl);
        let record;
        try {
            record = this.zones.createRecord({ zoneId: zone.id, name, type, rdata, ttl }, null);
        }
        catch (error) {
            throw this.recordError(error);
        }
        this.sendJson(res, 201, { record: recordJson(record, zone) }, { Location: `/api/v1/zones/${encodeURIComponent(zone.name)}/records/${record.id}` });
    }
    async updateRecord(req, res, zone, record) {
        const body = await this.readBody(req);
        const patch = {};
        if ('name' in body)
            patch.name = requireString(body.name, 'name').trim();
        if ('type' in body)
            patch.type = parseType(body.type);
        if ('rdata' in body)
            patch.rdata = requireString(body.rdata, 'rdata', true);
        if ('ttl' in body)
            patch.ttl = parseTtl(body.ttl);
        if (Object.keys(patch).length === 0) {
            throw badRequest('provide at least one of name, type, rdata or ttl');
        }
        let updated;
        try {
            updated = this.zones.updateRecord(record.id, patch);
        }
        catch (error) {
            throw this.recordError(error);
        }
        this.sendJson(res, 200, { record: recordJson(updated, zone) });
    }
    recordError(error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('UNIQUE constraint failed')) {
            return new ApiError(409, 'duplicate_record', 'that name/type/value already exists in the zone');
        }
        return new ApiError(400, 'invalid_record', message);
    }
    zone(name) {
        const canonical = canonicalName(name);
        if (canonical === '')
            throw badRequest('zone name is required');
        const zone = this.zones.getZoneByName(canonical);
        if (!zone)
            throw new ApiError(404, 'zone_not_found', `no zone named "${name}"`);
        return zone;
    }
    record(zone, id) {
        const record = this.zones.getRecordById(id);
        if (!record || record.zoneId !== zone.id) {
            throw new ApiError(404, 'record_not_found', `no record #${id} in ${zone.name}`);
        }
        return record;
    }
    requireMethod(req, allowed) {
        if (!allowed.includes(req.method ?? 'GET')) {
            throw new ApiError(405, 'method_not_allowed', `use ${allowed.join(' or ')}`, {
                Allow: allowed.join(', '),
            });
        }
    }
    requireAuth(req) {
        const header = req.headers.authorization;
        const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header.trim());
        if (!match) {
            throw new ApiError(401, 'unauthorized', 'send "Authorization: Bearer <token>"');
        }
        const token = match[1];
        const userId = this.tokens.verify(token);
        if (userId === undefined) {
            throw new ApiError(401, 'unauthorized', 'the token is invalid or expired');
        }
        const user = this.users.getUserById(userId);
        if (!user)
            throw new ApiError(401, 'unauthorized', 'the token owner no longer exists');
        return { user, token };
    }
    requireManager(user) {
        if (!this.users.canManageZones(user)) {
            throw new ApiError(403, 'forbidden', `@${user.username} has role "${user.role}"; writing records needs admin or dns`);
        }
    }
    async readBody(req) {
        const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
            throw new ApiError(415, 'unsupported_media_type', 'send Content-Type: application/json');
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > MAX_BODY_BYTES) {
                throw new ApiError(413, 'payload_too_large', `body must be at most ${MAX_BODY_BYTES} bytes`, {
                    Connection: 'close',
                });
            }
            chunks.push(buffer);
        }
        if (size === 0)
            throw badRequest('request body is required');
        let parsed;
        try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            throw badRequest('request body is not valid JSON');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw badRequest('request body must be a JSON object');
        }
        return parsed;
    }
    assertLoginAllowed(key) {
        const entry = this.failedLogins.get(key);
        if (!entry)
            return;
        if (Date.now() >= entry.resetAt) {
            this.failedLogins.delete(key);
            return;
        }
        if (entry.count >= LOGIN_FAILURE_LIMIT) {
            throw new ApiError(429, 'too_many_attempts', 'too many failed logins; try again in a minute');
        }
    }
    noteLoginFailure(key) {
        const now = Date.now();
        const entry = this.failedLogins.get(key);
        if (!entry || now >= entry.resetAt) {
            this.failedLogins.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
            return;
        }
        entry.count += 1;
    }
}
//# sourceMappingURL=http-api.js.map