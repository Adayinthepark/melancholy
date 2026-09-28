import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  credentialProviders,
  providerPresets,
  safeCredentialName,
} from "../lib/credentials";
import { ChatError } from "./team-auth";
import { seal, unseal } from "./credential-crypto";
export type Credential = {
  id: string;
  provider: (typeof credentialProviders)[number];
  name: string;
  identity: string;
  secret: string;
  env_keys: string;
  created_at: number;
  updated_at: number;
};
export const credentialColumns =
  "id,provider,name,identity,env_keys,created_at,updated_at";
export const credentialInput = z.object({
  provider: z.enum(credentialProviders),
  name: z.string().trim().min(1).max(60),
  fields: z
    .array(
      z.object({
        name: z
          .string()
          .refine(
            safeCredentialName,
            "Use a service-prefixed credential name, such as ASC_PRIVATE_KEY.",
          ),
        value: z
          .string()
          .min(1)
          .max(16384)
          .refine((v) => !v.includes("\0"), "NUL characters are not allowed."),
      }),
    )
    .min(1)
    .max(20),
});
export function validateCredential(value: unknown) {
  const input = credentialInput.parse(value);
  const names = input.fields.map((f) => f.name);
  if (new Set(names).size !== names.length)
    throw new ChatError(400, "Environment variable names must be unique.");
  if (input.provider !== "custom") {
    const preset = providerPresets[input.provider];
    if (
      !names.includes(preset.key) ||
      names.some((n) => n !== preset.key && n !== preset.baseKey)
    )
      throw new ChatError(
        400,
        "Use the environment variables for this provider.",
      );
    const base = input.fields.find((f) => f.name === preset.baseKey)?.value;
    if (base) {
      let u: URL;
      try {
        u = new URL(base);
      } catch {
        throw new ChatError(400, "Enter an HTTPS API base URL.");
      }
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        throw new ChatError(
          400,
          "Enter an HTTPS API base URL without credentials, query or fragment.",
        );
    }
  }
  return input;
}
export async function saveCredential(
  value: unknown,
  ownerId: string,
  id?: string,
) {
  const input = validateCredential(value);
  if (id) {
    const old = await env.DB.prepare("SELECT * FROM credentials WHERE id=?")
      .bind(id)
      .first<Credential>();
    if (!old) throw new ChatError(404, "Credential not found.");
    if (
      old.provider !== input.provider ||
      JSON.stringify(JSON.parse(old.env_keys).sort()) !==
        JSON.stringify(input.fields.map((f) => f.name).sort())
    )
      throw new ChatError(
        400,
        "Replacing a credential must keep its provider and environment variable names. Create a new credential to change them.",
      );
  }
  const credentialId = id || crypto.randomUUID();
  const values = Object.fromEntries(input.fields.map((f) => [f.name, f.value]));
  const encrypted = await seal(JSON.stringify(values), credentialId);
  const keys = JSON.stringify(Object.keys(values));
  const identity = providerPresets[input.provider].label;
  await env.DB.prepare(
    "INSERT INTO credentials (id,provider,name,identity,secret,env_keys,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,secret=excluded.secret,updated_at=excluded.updated_at",
  )
    .bind(
      credentialId,
      input.provider,
      input.name,
      identity,
      encrypted,
      keys,
      ownerId,
      Date.now(),
      Date.now(),
    )
    .run();
  return {
    id: credentialId,
    provider: input.provider,
    name: input.name,
    identity,
    env_keys: keys,
  };
}
export async function credentialEnvironment(roomId: string) {
  const rows = await env.DB.prepare(
    "SELECT c.* FROM credentials c JOIN room_credentials r ON r.credential_id=c.id WHERE r.room_id=? AND r.agent_enabled=1 ORDER BY c.id",
  )
    .bind(roomId)
    .all<Credential>();
  const result: Record<string, string> = {};
  for (const row of rows.results) {
    const fields = JSON.parse(await unseal(row)) as Record<string, string>;
    for (const [name, value] of Object.entries(fields)) {
      if (!safeCredentialName(name) || typeof value !== "string")
        throw new ChatError(503, "Invalid credential configuration.");
      if (name in result)
        throw new ChatError(
          409,
          "Conflicting channel credentials. Enable only one value per environment variable.",
        );
      result[name] = value;
    }
  }
  return result;
}
export async function grantCredential(
  roomId: string,
  id: string,
  enabled: boolean,
) {
  const c = await env.DB.prepare("SELECT env_keys FROM credentials WHERE id=?")
    .bind(id)
    .first<{ env_keys: string }>();
  if (!c) return false;
  if (enabled) {
    const rows = await env.DB.prepare(
      "SELECT c.env_keys FROM credentials c JOIN room_credentials r ON r.credential_id=c.id WHERE r.room_id=? AND r.agent_enabled=1 AND c.id!=?",
    )
      .bind(roomId, id)
      .all<{ env_keys: string }>();
    const names = new Set<string>(JSON.parse(c.env_keys));
    if (
      rows.results.some((r) =>
        (JSON.parse(r.env_keys) as string[]).some((n) => names.has(n)),
      )
    )
      throw new ChatError(
        409,
        "This channel already has a credential for these environment variables. Disable it first.",
      );
  }
  await env.DB.prepare(
    "INSERT INTO room_credentials VALUES (?,?,?) ON CONFLICT(room_id,credential_id) DO UPDATE SET agent_enabled=excluded.agent_enabled",
  )
    .bind(roomId, id, Number(enabled))
    .run();
  return true;
}
