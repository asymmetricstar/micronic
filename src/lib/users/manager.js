/**
 * User manager: CRUD + authentication. Passwords are stored as salted scrypt
 * hashes (see users/types.js). Role-based access is enforced by the caller.
 */
import { hashPassword, verifyPassword } from './types.js';
export class UserManager {
    db;
    constructor(db) {
        this.db = db;
    }
    createUser(input) {
        const username = this.assertUsername(input.username);
        if (typeof input.password !== 'string' || input.password.length === 0) {
            throw new Error('createUser: password required');
        }
        const role = input.role ?? 'dns';
        if (!['admin', 'dns', 'none'].includes(role)) {
            throw new Error(`createUser: invalid role "${role}"`);
        }
        const ts = Date.now();
        const ins = this.db.db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)');
        const id = this.db.run(ins, [username, hashPassword(input.password), role, ts]).lastInsertRowid;
        const user = this.getUserById(id);
        if (!user)
            throw new Error('createUser: database returned no row after insert');
        return user;
    }
    getUserById(id) {
        const row = this.db.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!row)
            return undefined;
        return this.rowToUser(row);
    }
    getUserByName(username) {
        const row = this.db.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!row)
            return undefined;
        return this.rowToUser(row);
    }
    listUsers() {
        const rows = this.db.db.prepare('SELECT * FROM users ORDER BY id').all();
        return rows.map((r) => this.rowToUser(r));
    }
    updateUser(id, patch) {
        const existing = this.getUserById(id);
        if (!existing)
            throw new Error(`updateUser: user ${id} not found`);
        const fields = [];
        const values = [];
        if (patch.username !== undefined) {
            fields.push('username = ?');
            values.push(this.assertUsername(patch.username));
        }
        if (patch.password !== undefined) {
            if (typeof patch.password !== 'string' || patch.password.length === 0) {
                throw new Error('updateUser: password required');
            }
            fields.push('password_hash = ?');
            values.push(hashPassword(patch.password));
        }
        if (patch.role !== undefined) {
            if (!['admin', 'dns', 'none'].includes(patch.role)) {
                throw new Error(`updateUser: invalid role "${patch.role}"`);
            }
            fields.push('role = ?');
            values.push(patch.role);
        }
        if (fields.length === 0)
            return existing;
        values.push(id);
        this.db.run(this.db.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`), values);
        const row = this.db.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        return this.rowToUser(row);
    }
    deleteUser(id) {
        const existing = this.getUserById(id);
        if (!existing)
            throw new Error(`deleteUser: user ${id} not found`);
        this.db.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    /** Authenticate a username/password pair. Returns the user or undefined. */
    authenticate(username, password) {
        if (typeof username !== 'string' || typeof password !== 'string')
            return undefined;
        const user = this.getUserByName(username);
        if (!user)
            return undefined;
        if (verifyPassword(password, user.passwordHash))
            return user;
        return undefined;
    }
    canManageZones(user) {
        return user?.role === 'admin' || user?.role === 'dns';
    }
    assertUsername(username) {
        if (typeof username !== 'string')
            throw new TypeError('Username must be a string');
        const trimmed = username.trim().toLowerCase();
        if (trimmed.length < 3 || trimmed.length > 64) {
            throw new Error('Username must be 3-64 characters');
        }
        if (!/^[a-z0-9_-]+$/.test(trimmed)) {
            throw new Error('Username may only contain a-z, 0-9, _ and -');
        }
        return trimmed;
    }
    rowToUser(row) {
        return {
            id: row.id,
            username: row.username,
            passwordHash: row.password_hash,
            role: row.role,
            createdAt: row.created_at,
        };
    }
}
//# sourceMappingURL=manager.js.map