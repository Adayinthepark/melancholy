import { DurableObject } from "cloudflare:workers";
type SocketIdentity = { sessionHash: string; expires: number };
export class Inbox extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Upgrade required", { status: 426 });
    const sessionHash = request.headers.get("x-session-hash"),
      expires = Number(request.headers.get("x-session-expires"));
    if (!sessionHash || !Number.isFinite(expires) || expires <= Date.now())
      return new Response("Unauthorized", { status: 401 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ sessionHash, expires });
    pair[1].send(JSON.stringify({ type: "ready" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async notify(roomId: string) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as SocketIdentity;
      if (
        a.expires <= Date.now() ||
        !(await this.env.DB.prepare(
          "SELECT 1 FROM sessions s JOIN people p ON p.id=s.person_id WHERE s.token_hash=? AND s.expires_at>? AND p.active=1",
        )
          .bind(a.sessionHash, Date.now())
          .first())
      ) {
        ws.close(1008, "Session expired");
        continue;
      }
      try {
        ws.send(JSON.stringify({ type: "changed", roomId }));
      } catch {
        ws.close(1011, "Reconnect");
      }
    }
  }
  closeSession(hash: string) {
    for (const ws of this.ctx.getWebSockets())
      if ((ws.deserializeAttachment() as SocketIdentity).sessionHash === hash)
        ws.close(1008, "Signed out");
  }
  closeAll() {
    for (const ws of this.ctx.getWebSockets()) ws.close(1008, "Access removed");
  }
  async allowLogin() {
    const current = await this.ctx.storage.get<{
      start: number;
      count: number;
    }>("attempts");
    const next =
      current && Date.now() - current.start < 60000
        ? { ...current, count: current.count + 1 }
        : { start: Date.now(), count: 1 };
    await this.ctx.storage.put("attempts", next);
    return next.count <= 30;
  }
  webSocketMessage(ws: WebSocket) {
    ws.close(1008, "Read-only connection");
  }
  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code);
  }
}
