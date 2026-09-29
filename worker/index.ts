export { ChannelDatabase } from "./channel-database";
import { runChannelTimers } from "./channel-timers";
export { CloudAgent, WorkspaceServiceProxy } from "./cloud-agent";
import handler from "vinext/server/fetch-handler";
import { handleApi } from "./api";
import { recoverAgentRequests } from "./agent-recovery";
import { maintainPush } from "./push";
export { Conversation } from "./conversation";
export { Connector } from "./connector";
export { Inbox } from "./inbox";
export { ChatDispatcher } from "./chat-dispatcher";

export default {
  async scheduled(_controller: ScheduledController, env: Cloudflare.Env) {
    await Promise.all([
      recoverAgentRequests(env),
      maintainPush(env),
      runChannelTimers(),
    ]);
  },
  async fetch(
    request: Request,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/"))
      return handleApi(request);
    const response = await handler.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
