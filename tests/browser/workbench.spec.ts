import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const origin = "http://127.0.0.1:3017";
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
test.beforeEach(async ({ context }) => {
  await context.request.post("/api/login", {
    headers: { Origin: origin },
    data: { key },
  });
});
test("optimistic sends appear immediately in italics and retry with the same message ID", async ({
  page,
  context,
}) => {
  const created = await context.request.post("/api/chat/rooms", {
    headers: { Origin: origin },
    data: { name: "sending-" + Date.now() },
  });
  const { id } = await created.json();
  await page.goto("/?room=" + id);
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const requests: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chat/rooms/" + id + "/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requests.push(route.request().postDataJSON().id);
    if (requests.length === 1) {
      await barrier;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("Message", { exact: true }).fill("Pending message");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const row = page.locator(".chat-row").filter({ hasText: "Pending message" });
  await expect(row).toBeVisible();
  await expect(row.locator(".markdown")).toHaveCSS("font-style", "italic");
  await expect(row).not.toContainText("Sending");
  await expect(page.locator(".agent-progress")).not.toContainText("Sending");
  release();
  await row.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(row).not.toContainText("Sending");
  await expect(row.locator(".markdown")).toHaveCSS("font-style", "normal");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
  await page.reload();
  await expect(
    page.locator(".chat-row").filter({ hasText: "Pending message" }),
  ).toHaveCount(1);
});
test("profile, Inter, named mentions, server rename and focused thread work across layouts", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const headers = { Origin: origin };
  const before = await (
    await context.request.get("/api/chat/workspace")
  ).json();
  const newHandle = "owner" + Date.now();
  const agentName = "Focus agent " + Date.now();
  const renamedServer = agentName + " renamed";
  const server = await (
    await context.request.post("/api/servers", {
      headers,
      data: { name: agentName, runtime: "codex" },
    })
  ).json();
  const { id } = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: "focus-" + Date.now(), members: [server.id] },
    })
  ).json();
  try {
    await page.goto("/?room=" + id);
    await page
      .getByRole("button", { name: "Account menu", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
    await page.getByLabel("Your username").fill(newHandle);
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Workspace owner");
    await page
      .getByRole("button", { name: "Save profile", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await (await context.request.get("/api/chat/workspace")).json()).me
            .handle,
      )
      .toBe(newHandle);
    await page.getByLabel("Upload avatar").setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect(page.locator(".profile-avatar-control img")).toBeVisible();
    await expect(
      page.locator(".profile-avatar-control [data-slot=avatar]"),
    ).toHaveCSS("border-radius", "6px");
    await page.keyboard.press("Escape");
    await page
      .getByLabel("Message", { exact: true })
      .fill("Hello @" + newHandle + " and `@literal`");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const row = page
      .locator(".team-channel .chat-row")
      .filter({ hasText: "Hello" });
    await expect(row.locator(".mention-name")).toHaveText("@Workspace owner");
    await expect(row.locator(".chat-avatar img")).toBeVisible();
    expect(
      await page.evaluate(async () => {
        await document.fonts.load('14px "Inter Variable"');
        return document.fonts.check('14px "Inter Variable"');
      }),
    ).toBe(true);
    await expect(page.locator("body")).toHaveCSS(
      "font-family",
      /Inter Variable/,
    );
    await row.hover();
    await row
      .getByRole("button", { name: "Reply in thread", exact: true })
      .click();
    await page.getByLabel("Auto trigger", { exact: true }).click();
    await page.getByRole("option", { name: agentName, exact: true }).click();
    await page
      .getByRole("link", { name: "Open thread page", exact: true })
      .click();
    await expect(page).toHaveURL(/\/thread\//);
    await expect(page.getByLabel("Thread reply")).toBeVisible();
    await expect(page.locator(".team-sidebar")).toBeHidden();
    await expect(page.locator(".thread-auto")).toContainText(agentName);
    await page.screenshot({
      path: "/tmp/melancholy-thread-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Dark theme", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "/tmp/melancholy-thread-mobile.png",
      fullPage: true,
    });
    await page.getByLabel("Auto trigger", { exact: true }).click();
    await page.getByRole("option", { name: "Off", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole("link", { name: "Back to channel", exact: true })
      .click();
    await page.goto("/settings/workspace/servers");
    await page
      .getByRole("button", { name: "Rename " + agentName, exact: true })
      .click();
    await page.getByLabel("Rename server", { exact: true }).fill(renamedServer);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Rename " + renamedServer,
        exact: true,
      }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.request.patch("/api/chat/profile", {
      headers,
      data: { name: before.me.name, handle: before.me.handle },
    });
    await context.request.delete("/api/chat/avatar", { headers });
  }
});
test("GitHub issues can be edited and linked to a real workspace thread", async ({
  page,
  context,
}) => {
  const { id } = await (
    await context.request.post("/api/chat/rooms", {
      headers: { Origin: origin },
      data: { name: "issues-" + Date.now() },
    })
  ).json();
  const repo = {
    id: "repo-test",
    room_id: id,
    integration_id: "conn",
    full_name: "example/project",
    approved: 1,
    url: "https://github.com/example/project",
  };
  let issue = {
    number: 14,
    title: "Tighten thread layout",
    body: "Keep the conversation readable.",
    state: "open",
    html_url: "https://github.com/example/project/issues/14",
    labels: [{ name: "ui" }],
    assignees: [{ login: "octo" }],
    user: { login: "octo" },
    created_at: new Date().toISOString(),
  };
  const comments: any[] = [];
  let linked = "";
  await page.route("**/api/chat/connections", (r) =>
    r.fulfill({ json: { connections: [] } }),
  );
  await page.route("**/api/chat/rooms/" + id + "/connections", (r) =>
    r.fulfill({ json: { connections: [] } }),
  );
  await page.route("**/api/chat/rooms/" + id + "/repositories", (r) =>
    r.fulfill({ json: { repositories: [repo] } }),
  );
  await page.route("**/api/chat/repositories/repo-test/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith("/threads")) {
      linked = r.request().postDataJSON().rootId;
      return r.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/comments")) {
      if (r.request().method() === "POST")
        comments.push({
          id: 1,
          body: r.request().postDataJSON().body,
          user: { login: "octo" },
        });
      return r.fulfill({ json: comments });
    }
    if (r.request().method() === "PATCH")
      issue = { ...issue, ...r.request().postDataJSON() };
    return r.fulfill({
      json: path.endsWith("/14") ? issue : { issues: [issue], hasMore: false },
    });
  });
  await page.goto("/?room=" + id);
  await page
    .getByRole("button", { name: "Repositories and issues", exact: true })
    .click();
  await page
    .getByRole("button")
    .filter({ hasText: "Tighten thread layout" })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Keep the conversation readable.",
  );
  await page.screenshot({ path: "/tmp/melancholy-issues.png", fullPage: true });
  await page.getByRole("button", { name: "Close issue", exact: true }).click();
  expect(issue.state).toBe("closed");
  await page
    .getByRole("button", { name: "Work in thread", exact: true })
    .click();
  await expect(page.getByLabel("Thread reply")).toBeVisible();
  expect(linked).toBeTruthy();
  const message = await (
    await context.request.get("/api/chat/messages/" + linked)
  ).json();
  expect(message.message.text).toContain("example/project #14");
});
