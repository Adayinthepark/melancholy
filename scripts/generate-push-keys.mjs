import { webcrypto } from "node:crypto";
const subject = process.argv[2];
if (!subject || !/^(mailto:|https:\/\/)/.test(subject)) {
  throw new Error(
    "Usage: node scripts/generate-push-keys.mjs https://your-workspace.example",
  );
}
const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const privateKey = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const publicKey = await webcrypto.subtle.exportKey("raw", pair.publicKey);
process.stdout.write(
  JSON.stringify(
    {
      VAPID_PUBLIC_KEY: Buffer.from(publicKey).toString("base64url"),
      VAPID_PRIVATE_KEY: privateKey.d,
      VAPID_SUBJECT: subject,
    },
    null,
    2,
  ) + "\n",
);
