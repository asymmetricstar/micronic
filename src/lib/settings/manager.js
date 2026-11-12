/**
 * Server settings persisted in SQLite as key/value rows.
 *
 * The environment seeds the initial values on the first start; after that the
 * database is the source of truth, so `config set` changes take effect in every
 * later run (and in the current shell, because the app reads through here).
 */
/** Settings the console exposes. Everything else is read-through only. */
export const SETTING_KEYS = ['host', 'port', 'ttl', 'register', 'api', 'api_port'];
export class SettingsManager {
    db;
    constructor(db) {
        this.db = db;
    }
    get(key) {
        const row = this.db.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row === undefined ? undefined : row.value;
    }
    /** A numeric setting, falling back when it is missing or unreadable. */
    number(key, fallback) {
        const raw = this.get(key);
        if (raw === undefined)
            return fallback;
        const value = Number(raw);
        return Number.isFinite(value) ? value : fallback;
    }
    /** A boolean setting stored as on/off, falling back when unreadable. */
    bool(key, fallback) {
        const raw = this.get(key);
        if (raw === undefined)
            return fallback;
        const value = raw.trim().toLowerCase();
        if (['on', 'true', '1', 'yes', 'enabled'].includes(value))
            return true;
        if (['off', 'false', '0', 'no', 'disabled'].includes(value))
            return false;
        return fallback;
    }
    set(key, value) {
        if (typeof key !== 'string' || key.trim() === '')
            throw new Error('settings: key required');
        if (typeof value !== 'string' || value.trim() === '')
            throw new Error('settings: value required');
        this.db.run(this.db.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`), [key.trim(), value.trim(), Date.now()]);
    }
    /** Insert only when the key is absent; true when a row was created. */
    seed(key, value) {
        const result = this.db.run(this.db.db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?,?,?)'), [key, value, Date.now()]);
        return Number(result.changes) > 0;
    }
    remove(key) {
        this.db.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    }
    list() {
        const rows = this.db.db.prepare('SELECT * FROM settings ORDER BY key').all();
        return rows.map((row) => ({
            key: row.key,
            value: row.value,
            updatedAt: row.updated_at,
        }));
    }
}
//# sourceMappingURL=manager.js.map