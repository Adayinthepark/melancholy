import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type { Job } from "../../lib/protocol";
const headers = { Origin: "http://127.0.0.1:3017" };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
const markdown =
  "# Research findings\n\nRead **directly in chat**.\n\n| Tool | Result |\n|---|---|\n| Reader | Works |\n\n```js\n" +
  "const example = 'a long line'; ".repeat(20) +
  "\n```\n\n<script>window.previewXss = true</script>\n\n[Unsafe](javascript:alert(1))\n";

test("Markdown attachments render in chat and Files, download unchanged and recheck deleted files", async ({
  page,
  context,
}) => {
  await context.request.post("/api/login", { headers, data: { key } });
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: "markdown-" + Date.now() },
    })
  ).json();
  const upload = await context.request.post("/api/chat/files?room=" + room.id, {
    headers,
    multipart: {
      file: {
        name: "调研报告.MD",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(markdown),
      },
    },
  });
  expect(upload.status()).toBe(201);
  const file = await upload.json();
  const sent = await (
    await context.request.post(`/api/chat/rooms/${room.id}/messages`, {
      headers,
      data: { text: "Read the report", attachments: [file.id] },
    })
  ).json();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?room=" + room.id);
  const trigger = page.getByRole("button", {
    name: "Open 调研报告.MD",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "调研报告.MD", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "Research findings" }),
  ).toBeVisible();
  await expect(dialog.locator("table")).toContainText("Reader");
  await expect(dialog.locator("strong")).toHaveText("directly in chat");
  expect(await page.evaluate(() => (window as any).previewXss)).toBeUndefined();
  await expect(dialog.locator('a[href^="javascript:"]')).toHaveCount(0);
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Download original" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("调研报告.MD");
  expect(readFileSync((await download.path())!, "utf8")).toBe(markdown);
  for (const width of [1280, 390])
    for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        (d) => document.documentElement.classList.toggle("dark", d),
        dark,
      );
      await page.screenshot({
        path: `/tmp/markdown-preview-${width}-${dark}.png`,
        animations: "disabled",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const box = await dialog.boundingBox();
      expect(box!.width).toBeLessThan(width);
    }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page
    .getByRole("navigation", { name: "Channel sections" })
    .getByRole("button", { name: "Files", exact: true })
    .click();
  const filesTrigger = page
    .getByRole("region", { name: "Channel files" })
    .getByRole("button", { name: "Open 调研报告.MD" });
  await filesTrigger.click();
  await expect(
    dialog.getByRole("heading", { name: "Research findings" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.route("**/api/files/" + file.id, (route) =>
    route.fulfill({ status: 503 }),
  );
  await filesTrigger.click();
  await expect(dialog.getByRole("alert")).toContainText("Could not load");
  await page.unroute("**/api/files/" + file.id);
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Research findings" }),
  ).toBeVisible();
  // Pause workspace refresh so the stale card remains to exercise an actual denied read.
  await page.route("**/api/chat/rooms/*/files", (route) => route.abort());
  await context.request.delete("/api/chat/messages/" + sent.message.id, {
    headers,
  });
  await page.keyboard.press("Escape");
  await filesTrigger.click();
  await expect(dialog.getByRole("alert")).toContainText("no longer available");
  await expect(
    dialog.getByRole("heading", { name: "Research findings" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an agent Markdown delivery in a DM opens as a readable document", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await context.request.post("/api/login", { headers, data: { key } });
  const server = await (
    await context.request.post("/api/servers", {
      headers,
      data: { name: "Markdown fixture " + Date.now(), runtime: "codex" },
    })
  ).json();
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { kind: "dm", members: [server.id] },
    })
  ).json();
  const ws = new WebSocket("ws://127.0.0.1:3017/api/connector", {
    headers: { Authorization: "Bearer " + server.token },
  });
  let job: Job | undefined;
  const packets: any[] = [];
  ws.on("message", (raw) => {
    const p = JSON.parse(String(raw));
    packets.push(p);
    if (p.type === "run") job = p.job;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        hostname: "local-test",
        cwd: "/fixture",
        active: [],
      }),
    );
    await expect.poll(() => packets.some((p) => p.type === "ready")).toBe(true);
    await context.request.post(`/api/chat/rooms/${room.id}/messages`, {
      headers,
      data: { text: "Prepare a report" },
    });
    await expect.poll(() => !!job).toBe(true);
    let seq = 0;
    const emit = async (event: unknown) => {
      const n = ++seq;
      ws.send(JSON.stringify({ type: "event", jobId: job!.id, seq: n, event }));
      await expect
        .poll(() => packets.some((p) => p.type === "ack" && p.seq === n))
        .toBe(true);
    };
    await emit({ type: "started", sessionId: "markdown-preview-session" });
    const response = await context.request.post(
      "/api/connector/artifacts?" +
        new URLSearchParams({
          threadId: job!.threadId,
          runId: job!.id,
          name: "Research.md",
        }),
      {
        headers: {
          Authorization: "Bearer " + server.token,
          "Content-Type": "application/octet-stream",
        },
        data: markdown,
      },
    );
    expect(response.status()).toBe(200);
    const artifact = await response.json();
    expect(artifact.file).toBeTruthy();
    expect(artifact.noteId).toBeFalsy();
    await emit({ type: "artifact", artifact });
    await emit({ type: "completed" });
    await page.goto("/?room=" + room.id);
    await page.getByRole("button", { name: "Open Research.md" }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Research findings" }),
    ).toBeVisible();
  } finally {
    ws.close();
    await context.request.delete("/api/servers/" + server.id, { headers });
  }
});
