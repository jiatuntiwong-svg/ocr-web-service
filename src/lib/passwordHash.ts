// PBKDF2 password hashing using Web Crypto (works on Cloudflare Workers — bcrypt
// requires node:crypto which Workers don't have).
//
// Storage format: `pbkdf2$<iterations>$<salt_b64>$<hash_b64>`
// The `pbkdf2$` prefix is also our legacy-vs-hashed sentinel: any stored value
// without it is treated as plaintext, verified by direct compare, and rewritten
// as a real hash on the next successful login.

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = "pbkdf2$";

function b64encode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

function b64decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function derive(password: string, salt: Uint8Array, iters: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iters },
        key,
        KEY_BYTES * 8,
    );
    return new Uint8Array(bits);
}

export async function hashPassword(plain: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const hash = await derive(plain, salt, ITERATIONS);
    return `${PREFIX}${ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export function isHashed(stored: string | null | undefined): boolean {
    return typeof stored === "string" && stored.startsWith(PREFIX);
}

export async function verifyPassword(plain: string, stored: string | null | undefined): Promise<boolean> {
    if (!stored) return false;
    if (!isHashed(stored)) {
        return timingSafeEqualStr(plain, stored);
    }
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const iters = parseInt(parts[1], 10);
    if (!Number.isFinite(iters) || iters <= 0) return false;
    let salt: Uint8Array;
    let expected: Uint8Array;
    try {
        salt = b64decode(parts[2]);
        expected = b64decode(parts[3]);
    } catch {
        return false;
    }
    const actual = await derive(plain, salt, iters);
    return timingSafeEqualBytes(actual, expected);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

function timingSafeEqualStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
