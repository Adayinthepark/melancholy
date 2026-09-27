import { env } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import type { Identity } from "./team-auth";

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
export async function authenticate(request: Request): Promise<Identity | null> {
  const token = request.headers
    .get("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token || token.length !== 64) return null;
  const record = await env.DB.prepare(
    "SELECT p.id,p.handle,p.name,p.kind,p.role,p.active,p.server_id,s.expires_at FROM sessions s JOIN people p ON p.id=s.person_id WHERE s.token_hash=? AND s.expires_at>? AND p.active=1",
  )
    .bind(await hash(token), Date.now())
    .first<Identity & { expires_at: number }>();
  return record
    ? { ...record, expires: record.expires_at, sessionHash: await hash(token) }
    : null;
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
