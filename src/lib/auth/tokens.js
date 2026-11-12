/**
 * API tokens: opaque random bearer strings whose SHA-256 hash is stored in
 * SQLite. The plaintext token is returned exactly once (login); every request
 * hashes the presented value and looks it up, so a database leak does not hand
 * out working credentials.
 */
import { createHash, randomBytes } from 'node:crypto';
/** Tokens are valid for 30 days unless the caller asks for another TTL. */
export const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Avoid a write on every request; first use and then once a minute is enough. */
const TOUCH_INTERVAL_MS = 60_000;
const TOKEN_PREFIX = 'mn_';
export function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
export class TokenManager {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Mint a token for a user and return the plaintext value once. */
    issue(userId, options = {}) {
        if (!Number.isInteger(userId) || userId <= 0) {
            throw new Error('TokenManager.issue: userId must be a positive integer');
        }
        const ttlMs = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
            throw new Error('TokenManager.issue: ttlMs must be a positive number');
        }
        const label = (options.label ?? 'api').trim().slice(0, 64) || 'api';
        const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
        const now = Date.now();
        const expiresAt = now + Math.floor(ttlMs);
        const stmt = this.db.db.prepare('INSERT INTO api_tokens (user_id, token_hash, label, created_at, expires_at, last_used_at) VALUES (?,?,?,?,?,NULL)');
        const tokenId = this.db.run(stmt, [userId, hashToken(token), label, now, expiresAt])
            .lastInsertRowid;
        return { token, tokenId, expiresAt };
    }
    /**
     * Return the user id for a valid token, or undefined. Expired rows are
     * removed lazily, which keeps the table small without a background job.
     */
    verify(token) {
        if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX))
            return undefined;
        const row = this.db.db
            .prepare('SELECT id, user_id, expires_at, last_used_at FROM api_tokens WHERE token_hash = ?')
            .get(hashToken(token));
        if (!row)
            return undefined;
        const now = Date.now();
        if (Number(row.expires_at) <= now) {
            this.db.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(row.id);
            return undefined;
        }
        const lastUsed = row.last_used_at === null ? undefined : Number(row.last_used_at);
        if (lastUsed === undefined || now - lastUsed > TOUCH_INTERVAL_MS) {
            this.db.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
        }
        return row.user_id;
    }
    /** Revoke one token; true when a row was removed. */
    revoke(token) {
        if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX))
            return false;
        const result = this.db.run(this.db.db.prepare('DELETE FROM api_tokens WHERE token_hash = ?'), [
            hashToken(token),
        ]);
        return Number(result.changes) > 0;
    }
    /** Revoke every token a user holds (password change, account removal, ...). */
    revokeAllForUser(userId) {
        if (!Number.isInteger(userId))
            return 0;
        const result = this.db.run(this.db.db.prepare('DELETE FROM api_tokens WHERE user_id = ?'), [userId]);
        return Number(result.changes);
    }
}
//# sourceMappingURL=tokens.js.map