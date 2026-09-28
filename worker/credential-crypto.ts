import { env } from "cloudflare:workers";
import { ChatError } from "./team-auth";
async function key() {
  const value = env.INTEGRATIONS_KEY;
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new ChatError(
      503,
      "Connections are not configured on this installation.",
    );
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(value.match(/../g)!, (x) => parseInt(x, 16)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(token: string, id: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
    await key(),
    new TextEncoder().encode(token),
  );
  return JSON.stringify({
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(data)),
  });
}
export async function unseal(record: { id: string; secret: string }) {
  const s = JSON.parse(record.secret);
  const value = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(s.iv),
      additionalData: new TextEncoder().encode(record.id),
    },
    await key(),
    new Uint8Array(s.data),
  );
  return new TextDecoder().decode(value);
}
