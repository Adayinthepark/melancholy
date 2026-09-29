import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type { AgentEvent, Job } from "../../lib/protocol";
const origin = "http://127.0.0.1:3017",
  headers = { Origin: origin };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();

test("real connector transport interleaves actions, persists deliveries and round-trips a questionnaire", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await context.request.post("/api/login", { headers, data: { key } });
  const server = await (
    await context.request.post("/api/servers", {
      headers,
      data: { name: "Delivery fixture " + Date.now(), runtime: "codex" },
    })
  ).json();
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: "delivery-" + Date.now(), members: [server.id] },
    })
  ).json();
  // Membership is explicit; room creation may ignore channel member suggestions.
  await context.request.post(`/api/chat/rooms/${room.id}/members`, {
    headers,
    data: { personId: server.id },
  });
  let job: Job | undefined,
    seq = 0;
  const packets: any[] = [];
  let ws!: WebSocket;
  async function connect(active: string[] = []) {
    ws = new WebSocket("ws://127.0.0.1:3017/api/connector", {
      headers: { Authorization: "Bearer " + server.token },
    });
    ws.on("message", (raw) => {
      const packet = JSON.parse(String(raw));
      packets.push(packet);
      if (packet.type === "run") job = packet.job;
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        hostname: "local-test",
        cwd: "/fixture",
        active,
      }),
    );
    await expect.poll(() => packets.some((p) => p.type === "ready")).toBe(true);
  }
  async function emit(event: AgentEvent) {
    const n = ++seq;
    ws.send(JSON.stringify({ type: "event", jobId: job!.id, seq: n, event }));
    await expect
      .poll(() => packets.some((p) => p.type === "ack" && p.seq === n))
      .toBe(true);
  }
  try {
    await connect();
    const person = (
      await (await context.request.get("/api/chat/workspace")).json()
    ).people.find((p: any) => p.id === server.id);
    const sent = await context.request.post(
      `/api/chat/rooms/${room.id}/messages`,
      {
        headers,
        data: {
          id: crypto.randomUUID(),
          text: `@${person.handle} Prepare the report`,
        },
      },
    );
    expect(sent.status()).toBe(201);
    const root = (await sent.json()).message;
    await expect.poll(() => !!job).toBe(true);
    await emit({ type: "started", sessionId: "local-fixture-session" });
    await emit({
      type: "text",
      id: "intro",
      text: "I will inspect the project first.",
    });
    await emit({
      type: "activity",
      id: "read",
      title: "Read project files",
      detail: "README.md",
      status: "completed",
    });
    await emit({
      type: "text",
      id: "plan",
      text: "Choose the report format before I continue.",
    });
    await emit({
      type: "interaction",
      interaction: {
        id: "codex:question",
        kind: "question",
        title: "Report preferences",
        detail: "",
        state: "pending",
        questions: [
          {
            id: "format",
            title: "Which report format?",
            options: [
              { label: "Markdown", description: "Save as a document" },
              { label: "PDF", description: "Downloadable file" },
            ],
            freeform: true,
          },
          {
            id: "audience",
            title: "Who is it for?",
            options: [],
            freeform: true,
          },
        ],
      },
    });
    await page.goto(`/?room=${room.id}&thread=${root.id}`);
    const row = page
      .locator(".chat-row[data-message-id]")
      .filter({ has: page.locator('[data-agent-part="interaction"]') });
    await expect(
      row.getByText("Which report format?", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    expect(
      await row
        .locator("[data-agent-part]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-agent-part")),
        ),
    ).toEqual(["text", "activity", "text", "interaction"]);
    await row.getByRole("radio", { name: /Markdown/ }).check();
    await row.getByRole("button", { name: "Next", exact: true }).click();
    await row
      .getByRole("textbox", { name: "Your answer: Who is it for?" })
      .fill("Project maintainers");
    // Disconnect the server while the answer is submitted; the durable outbox must retain it.
    ws.close();
    await row.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect(
      row.getByText("Sending answer to the agent…", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      row.getByText("Sending answer to the agent…", { exact: true }),
    ).toBeVisible();
    packets.length = 0;
    await connect([job!.id]);
    await expect
      .poll(() => packets.find((p) => p.type === "respond")?.response)
      .toEqual({
        answers: { format: ["Markdown"], audience: ["Project maintainers"] },
      });
    await emit({ type: "interaction_resolved", id: "codex:question" });
    await expect(row.getByText("Answer sent", { exact: true })).toBeVisible();
    await emit({
      type: "interaction",
      interaction: {
        id: "codex:approval",
        kind: "approval",
        title: "Approve command",
        detail: "npm test",
        questions: [],
        state: "pending",
      },
    });
    const approval = row.getByRole("region", { name: "Approve command" });
    await expect(
      approval.getByRole("radio", { name: /Allow once/ }),
    ).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await approval.scrollIntoViewIfNeeded();
      await page.screenshot({
        animations: "disabled",
        path: `/tmp/melancholy-agent-questionnaire-${width}.png`,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Dark theme", exact: true }).click();
    await page.screenshot({
      animations: "disabled",
      path: "/tmp/melancholy-agent-questionnaire-dark.png",
    });
    await page
      .getByRole("button", { name: "Light theme", exact: true })
      .click();
    await approval.getByRole("radio", { name: /Decline/ }).check();
    await approval
      .getByRole("button", { name: "Send answer", exact: true })
      .click();
    await expect
      .poll(
        () =>
          packets.find(
            (p) => p.type === "respond" && p.interactionId === "codex:approval",
          )?.response,
      )
      .toEqual({ decision: "decline" });
    await emit({
      type: "interaction_resolved",
      id: "codex:approval",
      outcome: "answered",
    });
    await expect(row.getByText("Declined", { exact: true })).toBeVisible();
    const upload = async (name: string, data: string) => {
      const response = await context.request.post(
        "/api/connector/artifacts?" +
          new URLSearchParams({
            threadId: job!.threadId,
            runId: job!.id,
            name,
          }),
        {
          headers: {
            Authorization: "Bearer " + server.token,
            "Content-Type": "application/octet-stream",
          },
          data,
        },
      );
      expect(response.status()).toBe(200);
      return response.json();
    };
    const note = await upload(
      "findings.md",
      "# Project findings\n\nThis document is saved in Notes.",
    );
    await emit({ type: "artifact", artifact: note });
    const file = await upload("data.csv", "name,count\nfiles,3\n");
    await emit({ type: "artifact", artifact: file });
    await emit({
      type: "text",
      id: "final",
      text: "The report and data are ready.",
    });
    await emit({ type: "completed" });
    await expect(
      row.getByText("The report and data are ready.", { exact: true }),
    ).toBeVisible();
    await row.getByRole("button", { name: /findings.md/ }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Project findings", exact: true })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole("dialog")
        .getByText("This document is saved in Notes.", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row.getByRole("link", { name: /data.csv/ })).toHaveCount(1);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(
        row.getByText("The report and data are ready.", { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: `/tmp/melancholy-agent-delivery-${width}.png`,
      });
    }
  } finally {
    ws!?.close();
    await context.request.delete("/api/servers/" + server.id, { headers });
  }
});

test("the connector process collects actual generated files before completing its task", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const { mkdtemp, mkdir, copyFile, chmod, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const fixture = await mkdtemp(join(tmpdir(), "melancholy-connector-e2e-"));
  await mkdir(join(fixture, "bin"));
  await copyFile(
    "tests/fixtures/codex-app-server.mjs",
    join(fixture, "bin", "codex"),
  );
  await chmod(join(fixture, "bin", "codex"), 0o755);
  await context.request.post("/api/login", { headers, data: { key } });
  const server = await (
    await context.request.post("/api/servers", {
      headers,
      data: { name: "Process fixture " + Date.now(), runtime: "codex" },
    })
  ).json();
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: "process-" + Date.now(), members: [server.id] },
    })
  ).json();
  const child = spawn(
    process.execPath,
    [
      resolve("packages/connector/bin.mjs"),
      "--url",
      origin,
      "--runtime",
      "codex",
      "--cwd",
      fixture,
      "--state-dir",
      join(fixture, "state"),
      "--timeout",
      "45",
    ],
    {
      env: {
        ...process.env,
        PATH: join(fixture, "bin") + ":" + process.env.PATH,
        MELANCHOLY_TOKEN: server.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let connected = false;
  child.stdout.on("data", (chunk) => {
    if (String(chunk).includes("Connected to")) connected = true;
  });
  child.stderr.resume();
  try {
    await expect.poll(() => connected).toBe(true);
    const person = (
      await (await context.request.get("/api/chat/workspace")).json()
    ).people.find((p: any) => p.id === server.id);
    const response = await context.request.post(
      `/api/chat/rooms/${room.id}/messages`,
      {
        headers,
        data: {
          id: crypto.randomUUID(),
          text: `@${person.handle} Produce documents`,
        },
      },
    );
    const root = (await response.json()).message;
    await page.goto(`/?room=${room.id}&thread=${root.id}`);
    const approval = page.getByRole("region", { name: "Approve command" });
    await expect(approval).toBeVisible({ timeout: 20000 });
    await approval.getByRole("radio", { name: /Decline/ }).check();
    await approval
      .getByRole("button", { name: "Send answer", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /generated.md/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /generated.csv/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop task" })).toHaveCount(
      0,
    );
    const notes = await (
      await context.request.get(`/api/chat/rooms/${room.id}/notes`)
    ).json();
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0].content).toContain("Durable document output.");
    const files = await (
      await context.request.get(`/api/chat/rooms/${room.id}/files`)
    ).json();
    expect(files.files).toHaveLength(1);
    const downloaded = await context.request.get(
      "/api/files/" + files.files[0].id,
    );
    expect(await downloaded.text()).toBe("name,value\nfixture,42\n");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 7000).unref();
    });
    await context.request.delete("/api/servers/" + server.id, { headers });
    await rm(fixture, { recursive: true, force: true });
  }
});
