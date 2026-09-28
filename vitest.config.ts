import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { webcrypto } from "node:crypto";
export default defineConfig(async () => {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const key = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = await webcrypto.subtle.exportKey("raw", pair.publicKey);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./tests/wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations("./migrations"),
            VAPID_PUBLIC_KEY: Buffer.from(publicKey).toString("base64url"),
            VAPID_PRIVATE_KEY: key.d!,
            VAPID_SUBJECT: "https://push.test",
          },
        },
      }),
    ],
    test: { include: ["tests/*.test.ts"] },
  };
});
