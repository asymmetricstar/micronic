/**
 * Zone + record manager: CRUD backed by SQLite. The resolver reads through
 * this; the NIC API writes through this. All methods return a value or throw
 * a descriptive Error (never silently undefined), so callers can react.
 */
import { canonicalizeRdata } from '../dns/packet.js';
/**
 * Canonical database form for zone and record names: lower-case, no trailing
 * dot. The root name normalises to "" and is never a valid zone name here.
 */
export function canonicalName(name) {
    if (typeof name !== 'string')
        throw new TypeError('Name must be a string');
    const trimmed = name.trim().toLowerCase();
    if (trimmed === '' || trimmed === '.')
        return '';
    return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}
/** Turn a relative record name ("www", "@", "*") into an absolute one. */
export function qualifyName(input, zoneName) {
    const name = canonicalName(input);
    const zone = canonicalName(zoneName);
    if (name === '' || name === '@')
        return zone;
    if (name === '*' || name === '*.' + zone)
        return '*.' + zone;
    if (name === zone || name.endsWith('.' + zone))
        return name;
    return `${name}.${zone}`;
}
function assertValidName(name, field) {
    if (name.length === 0)
        throw new Error(`${field}: empty name`);
    if (name.length > 253)
        throw new Error(`${field}: name longer than 253 characters`);
    for (const label of name.split('.')) {
        if (label.length === 0)
            throw new Error(`${field}: empty label in "${name}"`);
        if (label !== '*' && Buffer.byteLength(label) > 63) {
            throw new Error(`${field}: label "${label}" longer than 63 bytes`);
        }
    }
}
function now() {
    return Date.now();
}
/**
 * SOA serial default: YYYYMMDD00 (fits the 32-bit SOA field, sorts by date).
 * Date.now() would overflow the wire format's uint32 and break negative answers.
 */
function defaultSerial() {
    const date = new Date();
    const ymd = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
    return Number(ymd) * 100;
}
export class ZoneManager {
    db;
    constructor(db) {
        this.db = db;
    }
    // ----------------------------- zones --------------------------------------
    createZone(input, ownerId) {
        const name = this.normalizeZoneName(input.name);
        if (typeof input.masterIp !== 'string' || input.masterIp.length === 0) {
            throw new Error('createZone: masterIp is required');
        }
        const soa = {
            mname: input.soa?.mname ?? name,
            rname: input.soa?.rname ?? 'admin.' + name,
            serial: input.soa?.serial ?? defaultSerial(),
            refresh: input.soa?.refresh ?? 7200,
            retry: input.soa?.retry ?? 3600,
            expire: input.soa?.expire ?? 604800,
            minimum: input.soa?.minimum ?? 300,
        };
        const ts = now();
        const ins = this.db.db.prepare('INSERT INTO zones (name, master_ip, soa_serial, soa_refresh, soa_retry, soa_expire, soa_minimum, soa_mname, soa_rname, owner_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
        const id = this.db.run(ins, [
            name,
            input.masterIp,
            soa.serial,
            soa.refresh,
            soa.retry,
            soa.expire,
            soa.minimum,
            soa.mname,
            soa.rname,
            ownerId,
            ts,
            ts,
        ]).lastInsertRowid;
        const zone = this.getZoneById(id);
        if (!zone)
            throw new Error('createZone: database returned no row after insert');
        return zone;
    }
    getZoneById(id) {
        const row = this.db.db.prepare('SELECT * FROM zones WHERE id = ?').get(id);
        if (!row)
            return undefined;
        return this.rowToZone(row);
    }
    getZoneByName(name) {
        const row = this.db.db.prepare('SELECT * FROM zones WHERE name = ?').get(name);
        if (!row)
            return undefined;
        return this.rowToZone(row);
    }
    listZones() {
        const rows = this.db.db.prepare('SELECT * FROM zones ORDER BY name').all();
        return rows.map((r) => this.rowToZone(r));
    }
    /** Find the zone that is the longest suffix match for a query name. */
    findZoneFor(name) {
        const canonical = canonicalName(name);
        if (canonical === '')
            return undefined;
        const labels = canonical.split('.');
        for (let i = 0; i < labels.length; i++) {
            const zone = this.getZoneByName(labels.slice(i).join('.'));
            if (zone)
                return zone;
        }
        return undefined;
    }
    updateZone(id, patch) {
        const existing = this.getZoneById(id);
        if (!existing)
            throw new Error(`updateZone: zone ${id} not found`);
        const updated = {};
        let rename;
        if (patch.name !== undefined) {
            const to = this.normalizeZoneName(patch.name);
            this.assertUniqueZone(to, id);
            if (to !== existing.name)
                rename = { from: existing.name, to };
            updated.name = to;
        }
        if (patch.masterIp !== undefined)
            updated.masterIp = patch.masterIp;
        if (patch.soa !== undefined) {
            const s = patch.soa;
            if (s.serial !== undefined)
                updated.soa_serial = s.serial;
            if (s.refresh !== undefined)
                updated.soa_refresh = s.refresh;
            if (s.retry !== undefined)
                updated.soa_retry = s.retry;
            if (s.expire !== undefined)
                updated.soa_expire = s.expire;
            if (s.minimum !== undefined)
                updated.soa_minimum = s.minimum;
            if (s.mname !== undefined)
                updated.soa_mname = s.mname;
            if (s.rname !== undefined)
                updated.soa_rname = s.rname;
        }
        if (Object.keys(updated).length === 0)
            return existing;
        const fields = [];
        const values = [];
        for (const [k, v] of Object.entries(updated)) {
            fields.push(`${k} = ?`);
            values.push(v);
        }
        values.push(id);
        this.db.db.exec('BEGIN');
        try {
            this.db.run(this.db.db.prepare(`UPDATE zones SET ${fields.join(', ')} WHERE id = ?`), values);
            if (rename) {
                // Records are stored fully qualified, so a zone rename must re-root them.
                const stmt = this.db.db.prepare('UPDATE records SET name = ?, updated_at = ? WHERE id = ?');
                for (const record of this.listRecords(id)) {
                    const relative = record.name === rename.from
                        ? '@'
                        : record.name.endsWith('.' + rename.from)
                            ? record.name.slice(0, -(rename.from.length + 1))
                            : undefined;
                    if (relative === undefined)
                        continue;
                    this.db.run(stmt, [qualifyName(relative, rename.to), now(), record.id]);
                }
            }
            this.db.db.exec('COMMIT');
        }
        catch (err) {
            this.db.db.exec('ROLLBACK');
            throw err;
        }
        const row = this.db.db.prepare('SELECT * FROM zones WHERE id = ?').get(id);
        return this.rowToZone(row);
    }
    deleteZone(id) {
        const existing = this.getZoneById(id);
        if (!existing)
            throw new Error(`deleteZone: zone ${id} not found`);
        this.db.db.prepare('DELETE FROM zones WHERE id = ?').run(id);
    }
    // ----------------------------- records ------------------------------------
    createRecord(input, ownerId) {
        if (!Number.isInteger(input.zoneId))
            throw new Error('createRecord: zoneId must be an integer');
        const zone = this.getZoneById(input.zoneId);
        if (!zone)
            throw new Error(`createRecord: zone ${input.zoneId} not found`);
        const name = qualifyName(input.name, zone.name);
        assertValidName(name, 'createRecord');
        const rdata = canonicalizeRdata(input.type, input.rdata);
        const ts = now();
        const ins = this.db.db.prepare('INSERT INTO records (zone_id, name, type, rclass, ttl, rdata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
        const id = this.db.run(ins, [
            input.zoneId,
            name,
            input.type,
            1,
            input.ttl ?? 300,
            rdata,
            ts,
            ts,
        ]).lastInsertRowid;
        const record = this.getRecordById(id);
        if (!record)
            throw new Error('createRecord: database returned no row after insert');
        return record;
    }
    getRecordById(id) {
        const row = this.db.db.prepare('SELECT * FROM records WHERE id = ?').get(id);
        if (!row)
            return undefined;
        return this.rowToRecord(row);
    }
    getRecordBy(zoneId, name, type) {
        const row = this.db.db
            .prepare('SELECT * FROM records WHERE zone_id = ? AND name = ? AND type = ?')
            .get(zoneId, name, type);
        if (!row)
            return undefined;
        return this.rowToRecord(row);
    }
    listRecords(zoneId) {
        const sql = zoneId === undefined ? 'SELECT * FROM records ORDER BY zone_id, name, type' : 'SELECT * FROM records WHERE zone_id = ? ORDER BY name, type';
        const stmt = this.db.db.prepare(sql);
        const rows = zoneId === undefined ? stmt.all() : stmt.all(zoneId);
        return rows.map((r) => this.rowToRecord(r));
    }
    updateRecord(id, patch) {
        const existing = this.getRecordById(id);
        if (!existing)
            throw new Error(`updateRecord: record ${id} not found`);
        const zone = this.getZoneById(existing.zoneId);
        if (!zone)
            throw new Error(`updateRecord: zone ${existing.zoneId} not found`);
        const fields = [];
        const values = [];
        if (patch.name !== undefined) {
            const name = qualifyName(patch.name, zone.name);
            assertValidName(name, 'updateRecord');
            fields.push('name = ?');
            values.push(name);
        }
        const nextType = patch.type ?? existing.type;
        if (patch.type !== undefined) {
            fields.push('type = ?');
            values.push(patch.type);
        }
        if (patch.rdata !== undefined || patch.type !== undefined) {
            fields.push('rdata = ?');
            values.push(canonicalizeRdata(nextType, patch.rdata ?? existing.rdata));
        }
        if (patch.ttl !== undefined) {
            fields.push('ttl = ?');
            values.push(patch.ttl);
        }
        if (fields.length === 0)
            return existing;
        fields.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        this.db.run(this.db.db.prepare(`UPDATE records SET ${fields.join(', ')} WHERE id = ?`), values);
        const row = this.db.db.prepare('SELECT * FROM records WHERE id = ?').get(id);
        return this.rowToRecord(row);
    }
    deleteRecord(id) {
        const existing = this.getRecordById(id);
        if (!existing)
            throw new Error(`deleteRecord: record ${id} not found`);
        this.db.db.prepare('DELETE FROM records WHERE id = ?').run(id);
    }
    // ----------------------------- helpers ------------------------------------
    rowToZone(row) {
        const soa = row.soa_mname;
        return {
            id: row.id,
            name: row.name,
            masterIp: row.master_ip,
            soa: {
                mname: row.soa_mname,
                rname: row.soa_rname,
                serial: row.soa_serial,
                refresh: row.soa_refresh,
                retry: row.soa_retry,
                expire: row.soa_expire,
                minimum: row.soa_minimum,
            },
            ownerId: row.owner_user_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
    rowToRecord(row) {
        return {
            id: row.id,
            zoneId: row.zone_id,
            name: row.name,
            type: row.type,
            rclass: row.rclass,
            ttl: row.ttl,
            rdata: row.rdata,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
    assertUniqueZone(name, exceptId) {
        const row = this.db.db.prepare('SELECT id FROM zones WHERE name = ? AND id != ?').get(name, exceptId);
        if (row)
            throw new Error(`Zone name "${name}" is already in use`);
    }
    normalizeZoneName(name) {
        if (typeof name !== 'string')
            throw new TypeError('Zone name must be a string');
        const canonical = canonicalName(name);
        assertValidName(canonical, 'zone name');
        return canonical;
    }
}
//# sourceMappingURL=manager.js.map