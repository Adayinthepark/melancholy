import { safeCredentialName } from "./environment-policy.mjs";
const allowed = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "MELANCHOLY_API_TOKEN",
  "MELANCHOLY_URL",
  "MELANCHOLY_ROOM_ID",
]);
export function agentEnvironment(inherited, approved) {
  const result = { ...inherited };
  for (const name of [
    ...allowed,
    "MELANCHOLY_TOKEN",
    "CF_API_TOKEN",
    "CF_API_KEY",
    "CF_EMAIL",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ])
    delete result[name];
  for (const [name, value] of Object.entries(approved || {})) {
    if (
      (allowed.has(name) || safeCredentialName(name)) &&
      typeof value === "string" &&
      !value.includes("\0")
    )
      result[name] = value;
  }
  return result;
}
export function redactor(environment) {
  const secrets = Object.entries(environment || {})
    .filter(
      ([name, value]) =>
        ((allowed.has(name) && /TOKEN$/.test(name)) ||
          safeCredentialName(name)) &&
        typeof value === "string" &&
        value.length >= 1,
    )
    .flatMap(([, v]) => [
      v,
      ...v
        .split(/\r?\n/)
        .filter((line) => line.length >= 4 && !/^-----/.test(line)),
    ])
    .sort((a, b) => b.length - a.length);
  function redact(value) {
    if (typeof value === "string") {
      for (const secret of secrets)
        value = value.replaceAll(secret, "[redacted]");
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          ["type", "status", "id", "sessionId", "runtime", "model"].includes(k)
            ? v
            : redact(v),
        ]),
      );
    return value;
  }
  return redact;
}
