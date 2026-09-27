import { env } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";

export const COOKIE = "melancholy_session";
export const SESSION_AGE = 60 * 60 * 24 * 30;
export async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function keyMatches(value: string): Promise<boolean> {
  if (!env.WORKSPACE_KEY || env.WORKSPACE_KEY.length < 32 || value.length > 256)
    return false;
  const [a, b] = await Promise.all([hash(value), hash(env.WORKSPACE_KEY)]);
  return timingSafeEqual(
    new TextEncoder().encode(a),
    new TextEncoder().encode(b),
  );
}
export async function authenticate(
  request: Request,
): Promise<{ expires: number } | null> {
  const token = request.headers
    .get("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token || token.length !== 64) return null;
  const record = await env.DB.prepare(
    "SELECT expires_at FROM sessions WHERE token_hash=? AND expires_at>?",
  )
    .bind(await hash(token), Date.now())
    .first<{ expires_at: number }>();
  return record ? { expires: record.expires_at } : null;
}
export function checkOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !!origin && origin === new URL(request.url).origin;
}
export function sessionCookie(
  request: Request,
  token: string,
  age = SESSION_AGE,
): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
