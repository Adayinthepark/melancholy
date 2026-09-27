import { env } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import type { Person } from "../lib/chat";
import { hash, secret } from "./auth";
export type Identity = Person & {
  expires: number;
  sessionHash?: string;
  tokenId?: string;
  roomScope?: string | null;
};
export const publicPerson = "id,handle,name,kind,role,active,server_id";
export class ChatError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function passwordHash(
  password: string,
  salt = secret(),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  return (
    salt +
    ":" +
    Array.from(new Uint8Array(bits), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export async function verifyPassword(password: string, encoded: string) {
  const actual = await passwordHash(password, encoded.split(":")[0]);
  const a = new TextEncoder().encode(actual),
    b = new TextEncoder().encode(encoded);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function bearerIdentity(
  request: Request,
  allowConnector = false,
): Promise<Identity | null> {
  const token = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return null;
  const tokenHash = await hash(token);
  const bot = await env.DB.prepare(
    `SELECT p.*,t.id AS tokenId,t.room_id AS roomScope FROM bot_tokens t JOIN people p ON p.id=t.bot_id WHERE t.token_hash=? AND t.kind='api' AND p.active=1`,
  )
    .bind(tokenHash)
    .first<Person & { tokenId: string; roomScope: string | null }>();
  if (bot) return { ...bot, expires: Date.now() + 60000 };
  if (!allowConnector) return null;
  const connector = await env.DB.prepare(
    "SELECT p.* FROM people p JOIN servers s ON s.id=p.server_id WHERE s.token_hash=? AND p.active=1",
  )
    .bind(tokenHash)
    .first<Person>();
  return connector ? { ...connector, expires: Date.now() + 60000 } : null;
}
export async function canReadRoom(id: string, who: Person): Promise<boolean> {
  const room = await env.DB.prepare(
    "SELECT r.private,r.kind,EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=r.id AND m.person_id=?) AS joined FROM rooms r WHERE r.id=?",
  )
    .bind(who.id, id)
    .first<{ private: number; kind: string; joined: number }>();
  return (
    !!room &&
    (!!room.joined ||
      (who.kind === "human" && room.kind === "channel" && !room.private))
  );
}
export async function requireRoom(id: string, who: Identity, write = false) {
  if (who.roomScope && who.roomScope !== id)
    throw new ChatError(404, "Conversation not found.");
  if (!(await canReadRoom(id, who)))
    throw new ChatError(404, "Conversation not found.");
  if (
    write &&
    !(await env.DB.prepare(
      "SELECT 1 FROM room_members WHERE room_id=? AND person_id=?",
    )
      .bind(id, who.id)
      .first())
  )
    throw new ChatError(403, "Join this channel before posting.");
}
