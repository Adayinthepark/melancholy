import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type { AgentEvent, Job } from "../../lib/protocol";
const origin = "http://127.0.0.1:3017",
  headers = { Origin: origin };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();

test("sending, queued follow-ups, running and waiting remain visible and recover on reload", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.request.post("/api/login", { headers, data: { key } });
  const name = "Progress agent " + Date.now();
  const server = await (
    await context.request.post("/api/servers", {
      headers,
      data: { name, runtime: "codex" },
    })
  ).json();
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { kind: "dm", name: "", members: [server.id] },
    })
  ).json();
  let ws: WebSocket | undefined;
  const jobs: Job[] = [],
    packets: any[] = [];
  let seq = 0;
  async function emit(event: AgentEvent) {
    const n = ++seq,
      job = jobs.at(-1)!;
    ws!.send(JSON.stringify({ type: "event", jobId: job.id, seq: n, event }));
    await expect
      .poll(() =>
        packets.some(
          (p) => p.type === "ack" && p.jobId === job.id && p.seq === n,
        ),
      )
      .toBe(true);
  }
  try {
    await page.goto("/?room=" + room.id);
    const progress = page.locator(".team-channel .agent-progress");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/chat/rooms/${room.id}/messages`, async (route) => {
      if (route.request().method() === "POST") await barrier;
      await route.continue();
    });
    await page.getByLabel("Message", { exact: true }).fill("Start the work");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(progress).toContainText("Sending message…");
    release();
    await expect(progress).toContainText(name);
    await expect(progress).toContainText("Waiting to start…");
    ws = new WebSocket("ws://127.0.0.1:3017/api/connector", {
      headers: { Authorization: "Bearer " + server.token },
    });
    ws.on("message", (raw) => {
      const packet = JSON.parse(String(raw));
      packets.push(packet);
      if (packet.type === "run" && !jobs.some((j) => j.id === packet.job.id))
        jobs.push(packet.job);
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        hostname: "local-test",
        cwd: "/fixture",
        active: [],
      }),
    );
    await expect.poll(() => jobs.length).toBe(1);
    await emit({ type: "started", sessionId: "progress-session" });
    await expect(progress).toContainText("Working…");
    await emit({
      type: "text",
      text: "Investigating the requested work.\n\n".repeat(40),
    });
    await emit({
      type: "activity",
      id: "read",
      title: "Read the project",
      detail: "Checking files",
      status: "running",
    });
    await page
      .getByLabel("Message", { exact: true })
      .fill("Then check the follow-up");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(progress).toContainText("Queued…");
    await expect(progress).toContainText("Working…");
    await page.reload();
    await expect(progress).toContainText("Queued…");
    await expect(progress).toContainText("Working…");
    await expect(progress.locator(".agent-progress-row")).toHaveCount(2);
    await page
      .locator(".team-channel [data-slot=message-scroller-viewport]")
      .evaluate((el) => (el.scrollTop = 0));
    await expect(progress).toBeInViewport();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const dark of [false, true]) {
        await page.evaluate(
          (value) => document.documentElement.classList.toggle("dark", value),
          dark,
        );
        await expect(progress).toBeInViewport();
        await page.screenshot({
          path: `/tmp/melancholy-agent-progress-${width}-${dark}.png`,
          animations: "disabled",
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(progress.locator('[data-state="running"] > svg')).toHaveCSS(
      "animation-name",
      "none",
    );
    await emit({
      type: "interaction",
      interaction: {
        id: "question",
        kind: "question",
        title: "Next step",
        detail: "",
        state: "pending",
        questions: [
          { id: "next", title: "Continue?", options: [], freeform: true },
        ],
      },
    });
    await expect(progress).toContainText("Waiting for input");
    await expect(progress).toContainText("Queued…");
    await page.reload();
    await expect(progress).toContainText("Waiting for input");
    await emit({ type: "completed" });
    await expect.poll(() => jobs.length, { timeout: 15000 }).toBe(2);
    seq = 0;
    await emit({ type: "started", sessionId: "progress-session" });
    await expect(progress.locator(".agent-progress-row")).toHaveCount(1);
    await expect(progress).toContainText("Working…");
    await progress
      .getByRole("button", { name: `Stop ${name} task`, exact: true })
      .click();
    await expect(progress).toBeHidden();
    await expect(
      page.locator(".chat-row").getByText("Stopped", { exact: true }),
    ).toBeVisible();
    // A thread reply with Auto trigger off is delivered without claiming work.
    await page.setViewportSize({ width: 1280, height: 844 });
    const root = page
      .locator(".chat-row")
      .filter({ hasText: "Start the work" });
    await root.hover();
    await root
      .getByRole("button", { name: "Reply in thread", exact: true })
      .click();
    await page
      .getByLabel("Thread reply", { exact: true })
      .fill("Just a thread comment");
    await page
      .locator(".team-thread")
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await expect(
      page.getByText(
        "Message sent. Mention an agent or enable Auto trigger to get an agent reply.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.locator(".team-thread .agent-progress")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    ws?.close();
    await context.request.delete("/api/servers/" + server.id, { headers });
  }
});
