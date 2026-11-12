/**
 * User + role model for multi-user / access control.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
/** Password hashing helpers (built-in scrypt, no external dep). */
export function hashPassword(password, salt = randomSalt()) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('hashPassword: password required');
    }
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt' || !parts[1] || !parts[2]) {
        return false;
    }
    const candidate = scryptSync(password, parts[1], 64).toString('hex');
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(parts[2], 'hex');
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(a, b);
}
function randomSalt() {
    return randomBytes(16).toString('hex');
}
//# sourceMappingURL=types.js.map