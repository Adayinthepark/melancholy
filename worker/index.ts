import handler from "vinext/server/fetch-handler";
import { handleApi } from "./api";
export { Conversation } from "./conversation";
export { Connector } from "./connector";

export default {
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
