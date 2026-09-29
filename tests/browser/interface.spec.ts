import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const headers = { Origin: "http://127.0.0.1:3017" };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();

test("bot avatars preview, persist across surfaces and can be removed", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await context.request.post("/api/login", { headers, data: { key } });
  const name = "Avatar " + Date.now();
  const bot = await (
    await context.request.post("/api/chat/bots", {
      headers,
      data: { name, handle: "avatar" + Date.now() },
    })
  ).json();
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { kind: "dm", members: [bot.id] },
    })
  ).json();
  await page.goto("/settings/workspace/bots");
  await page
    .getByRole("button", { name: "Change avatar for " + name, exact: true })
    .click();
  await page.getByLabel("Avatar image").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByAltText("New bot avatar preview")).toBeVisible();
  await page.getByRole("button", { name: "Save avatar", exact: true }).click();
  await expect(
    page.getByText("Bot avatar updated.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".person-row").filter({ hasText: name }).getByAltText(name),
  ).toBeVisible();
  await page.goto("/?room=" + room.id);
  await expect(page.locator(".team-sidebar").getByAltText(name)).toBeVisible();
  await expect(page.locator(".team-account > button")).toHaveCount(1);
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Profile", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/settings/workspace/bots");
  await page
    .getByRole("button", { name: "Change avatar for " + name, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove avatar", exact: true })
    .click();
  await expect(
    page.locator(".person-row").filter({ hasText: name }).locator("img"),
  ).toHaveCount(0);
});

test("Markdown formatting and history survive preview and channel tab switches", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(document, "startViewTransition", {
      value: undefined,
    }),
  );
  await context.request.post("/api/login", { headers, data: { key } });
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: "editor-" + Date.now() },
    })
  ).json();
  await page.goto("/?room=" + room.id);
  const tabs = page.getByRole("navigation", { name: "Channel sections" });
  await tabs.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Round trip");
  const editor = page.getByRole("textbox", { name: "Content · Markdown" });
  await editor.fill(
    "Keep [source](https://example.com)\n\n- [x] Done\n\n```js\nconst a = 1;\n```",
  );
  await editor.press("ControlOrMeta+Home");
  await editor.press("ControlOrMeta+Shift+End");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(editor).toContainText("**Keep");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(editor).not.toContainText("**Keep");
  await tabs.getByRole("button", { name: "Chat", exact: true }).click();
  await tabs.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByText("Note saved.", { exact: true })).toBeVisible();
  const result = await (
    await context.request.get(`/api/chat/rooms/${room.id}/notes`)
  ).json();
  expect(result.notes[0].content).toBe(
    "Keep [source](https://example.com)\n\n- [x] Done\n\n```js\nconst a = 1;\n```",
  );
});
