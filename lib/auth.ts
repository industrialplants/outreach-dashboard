import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "crypto";
import { ADMIN_TOKEN } from "./db";

// ---------- Password hashing (scrypt, no external dependency) ----------
// Stored format: "<saltHex>:<hashHex>"

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  // Lengths can differ if `stored` is malformed; guard before timingSafeEqual,
  // which throws on mismatched buffer lengths rather than returning false.
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// ---------- Signed session cookie ----------
// A client's session is just "<clientToken>.<expiryMs>.<hmac>", HMAC-signed so
// it can't be forged or edited client-side. No server-side session storage
// needed. Falls back to deriving a secret from ADMIN_TOKEN if SESSION_SECRET
// isn't set — works out of the box, but setting a dedicated SESSION_SECRET in
// Vercel's env vars is the more correct long-term setup.
const SESSION_SECRET = process.env.SESSION_SECRET ?? `${ADMIN_TOKEN}::session-fallback`;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const SESSION_COOKIE = "ip_session";

function sign(value: string): string {
  return createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

export function createSessionToken(clientToken: string): string {
  const expires = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${clientToken}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

// Returns the client_token if the session is valid and not expired, else null.
export function verifySessionToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [clientToken, expiresStr, signature] = parts;
  const payload = `${clientToken}.${expiresStr}`;
  const expected = sign(payload);
  // Constant-time compare of hex strings of equal length.
  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || Date.now() > expires) return null;
  return clientToken;
}
