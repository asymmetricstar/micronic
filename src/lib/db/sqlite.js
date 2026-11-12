/**
 * SQLite persistence layer built on Node's built-in `node:sqlite` module.
 *
 * Why node:sqlite (not better-sqlite3):
 *   - Node 26 ships SQLite 3.54 synchronously in-process.
 *   - No native compilation => no MSBuild / Visual Studio dependency.
 *   - API is close enough (prepared statements, positional params).
 *
 * The connection is created once and reused. Migrations run on open.
 */
import { DatabaseSync } from 'node:sqlite';
/**
 * Thin wrapper around node:sqlite that owns the connection and runs the
 * schema migrations. Never throws to the caller on open failure; the caller
 * is responsible for handling a null return (see index.ts / app bootstrap).
 */
export class Sqlite {
    db;
    path;
    constructor(path) {
        if (typeof path !== 'string' || path.length === 0) {
            throw new TypeError('Sqlite: path must be a non-empty string');
        }
        this.path = path;
        this.db = new DatabaseSync(path);
        this.migrate();
    }
    /** Run schema migrations idempotently. */
    migrate() {
        // Enforce the ON DELETE CASCADE rules (zones -> records, users -> tokens).
        this.db.exec('PRAGMA foreign_keys = ON;');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        username    TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'dns',
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS zones (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL UNIQUE,
        master_ip    TEXT NOT NULL,
        soa_serial   INTEGER NOT NULL DEFAULT 1,
        soa_refresh  INTEGER NOT NULL DEFAULT 7200,
        soa_retry    INTEGER NOT NULL DEFAULT 3600,
        soa_expire   INTEGER NOT NULL DEFAULT 604800,
        soa_minimum  INTEGER NOT NULL DEFAULT 300,
        soa_mname    TEXT NOT NULL DEFAULT 'ns1.example.com',
        soa_rname    TEXT NOT NULL DEFAULT 'admin.example.com',
        owner_user_id INTEGER,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id      INTEGER NOT NULL,
        name         TEXT NOT NULL,
        type         INTEGER NOT NULL,
        rclass       INTEGER NOT NULL DEFAULT 1,
        ttl          INTEGER NOT NULL DEFAULT 300,
        rdata        TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        -- An RRset may hold several values (e.g. two A records), so identity
        -- is (name, type, rdata) rather than (name, type).
        UNIQUE(zone_id, name, type, rdata),
        FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE
      );

      -- Server settings edited from the console (config set ...). The
      -- environment only seeds the initial row; afterwards this table wins.
      CREATE TABLE IF NOT EXISTS settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      -- Bearer tokens for the HTTP API. Only the SHA-256 hash is stored; the
      -- plaintext token is returned once by POST /api/v1/auth/login.
      CREATE TABLE IF NOT EXISTS api_tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        label        TEXT NOT NULL DEFAULT 'api',
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_records_zone ON records(zone_id);
      CREATE INDEX IF NOT EXISTS idx_records_zone_name_type ON records(zone_id, name, type);
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_tokens_expires ON api_tokens(expires_at);
    `);
        // Enable WAL for better concurrency where supported by node:sqlite.
        try {
            this.db.exec('PRAGMA journal_mode = WAL;');
        }
        catch {
            // WAL may be unsupported by the bundled SQLite; ignore.
        }
    }
    close() {
        this.db.close();
    }
    /**
     * Run a prepared statement with positional parameters.
     *
     * node:sqlite's StatementSync.run() only accepts spread positional
     * arguments (a single array does not match its overloads), so we wrap it
     * here. Returns the result row; use `result.lastInsertRowid` for inserts.
     */
    run(stmt, params) {
        return stmt.run(...params);
    }
}
//# sourceMappingURL=sqlite.js.map