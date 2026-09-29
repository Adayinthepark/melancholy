import { env } from "cloudflare:workers";
import type { Person } from "../lib/chat";
import { ChatError } from "./team-auth";
import { workspaceOverview } from "./casual";
import { connection, providerRequest, unseal } from "./integrations";
export async function integrationHealth(who: Person, id: string) {
  const overview = await workspaceOverview(who);
  const item = overview.integrations.find((i) => i.id === id);
  if (!item) throw new ChatError(404, "Integration not found.");
  if (item.provider !== "github" && item.provider !== "cloudflare")
    return {
      id,
      status: "configured",
      checkedAt: Date.now(),
      detail:
        "Credential is saved. No paid model call or custom service request was made.",
    };
  const c = await connection(id);
  try {
    const result = (await providerRequest(
      c.provider,
      await unseal(c),
      c.provider === "github" ? "/user" : "/user/tokens/verify",
    )) as { success?: boolean; result?: { status?: string }; login?: string };
    return {
      id,
      provider: c.provider,
      status:
        c.provider === "github" ||
        (result.success && result.result?.status === "active")
          ? "reachable"
          : "verification_failed",
      identity: result.login || c.identity,
      checkedAt: Date.now(),
      detail:
        "Checks authentication only; individual repositories, Workers and operations can require additional permissions.",
    };
  } catch (e) {
    if (!(e instanceof ChatError)) throw e;
    return {
      id,
      status: "unavailable",
      checkedAt: Date.now(),
      detail: e.message,
    };
  }
}
