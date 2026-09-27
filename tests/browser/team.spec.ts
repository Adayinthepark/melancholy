import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { readFileSync } from "node:fs";
const origin = "http://127.0.0.1:3017";
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
async function invited(browser: Browser, owner: BrowserContext, name: string) {
  const invite = await owner.request.post(origin + "/api/chat/invitations", {
    headers: { Origin: origin },
  });
  expect(invite.status()).toBe(201);
  const { url } = await invite.json();
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.goto(url);
  await page.getByLabel("Display name", { exact: true }).fill(name);
  const handle = "u" + Date.now() + Math.floor(Math.random() * 1000);
  await page.getByLabel("Username", { exact: true }).fill(handle);
  await page
    .getByLabel("Password", { exact: true })
    .fill("a secure browser test password");
  await page
    .getByRole("button", { name: "Join workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Search workspace", exact: true }),
  ).toBeVisible();
  return { context, page, handle, name };
}
async function submit(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
test("members collaborate in private channels, threads, DMs and groups", async ({
  browser,
  page,
  context,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.request.post(origin + "/api/login", {
    headers: { Origin: origin },
    data: { key },
  });
  await page.goto("/");
  const suffix = Date.now(),
    alice = await invited(browser, context, "Alice " + suffix),
    bob = await invited(browser, context, "Bob " + suffix);
  alice.page.on("pageerror", (e) => errors.push(e.message));
  bob.page.on("pageerror", (e) => errors.push(e.message));
  await page.reload();
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  const name = "private-" + suffix;
  await page.getByLabel("Channel name").fill(name);
  await page.getByLabel("Visibility").click();
  await page
    .getByRole("option", { name: "Private — invited members", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button")
    .filter({ hasText: alice.name })
    .click();
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(page.locator(".team-heading")).toContainText(name);
  await submit(page, "Private **project notes** @" + alice.handle + " ready.");
  await expect(
    alice.page.locator(".team-room-link").filter({ hasText: name }),
  ).toBeVisible();
  await expect(
    bob.page.locator(".team-room-link").filter({ hasText: name }),
  ).toHaveCount(0);
  await alice.page.locator(".team-room-link").filter({ hasText: name }).click();
  await expect(alice.page.locator(".markdown strong")).toHaveText(
    "project notes",
  );
  const ownerRoot = page
    .locator(".team-channel .chat-row")
    .filter({ hasText: "project notes" });
  await ownerRoot.hover();
  await ownerRoot
    .getByRole("button", { name: "Reply in thread", exact: true })
    .click();
  await page.getByLabel("Thread reply").fill("A separate thread reply.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(
    alice.page.getByRole("button", { name: "1 reply", exact: true }),
  ).toBeVisible();
  const aliceRoot = alice.page
    .locator(".chat-row")
    .filter({ hasText: "project notes" });
  await aliceRoot.hover();
  await aliceRoot
    .getByRole("button", { name: "Add reaction", exact: true })
    .click();
  await alice.page.getByRole("button", { name: "👍", exact: true }).click();
  await expect(
    aliceRoot.getByRole("button", { name: "👍 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await ownerRoot.hover();
  await ownerRoot
    .getByRole("button", { name: "Message actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Edit message", exact: true })
    .click();
  await page
    .getByLabel("Message text")
    .fill("Edited project notes @" + alice.handle + " ready.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(alice.page.locator(".markdown")).toContainText(
    "Edited project notes",
  );
  await page.locator(".team-channel input[type=file]").setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.locator(".composer-files")).toContainText("tiny.png");
  await submit(page, "Image for review");
  await expect(
    alice.page.getByRole("img", { name: "tiny.png", exact: true }),
  ).toBeVisible();
  await alice.page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  await alice.page.getByPlaceholder("Search messages…").fill("Edited project");
  await alice.page
    .getByRole("option")
    .filter({ hasText: "Edited project notes" })
    .click();
  await expect(
    alice.page.getByRole("region", { name: "Thread", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New message", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button")
    .filter({ hasText: alice.name })
    .click();
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  await expect(page.locator(".team-heading")).toContainText(alice.name);
  await submit(page, "Direct conversation check");
  await expect(page.locator(".markdown")).toHaveText(
    "Direct conversation check",
  );
  await page.getByRole("button", { name: "New message", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button")
    .filter({ hasText: alice.name })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button")
    .filter({ hasText: bob.name })
    .click();
  await page.getByLabel("Group name (optional)").fill("Planning " + suffix);
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  await expect(page.locator(".team-heading")).toContainText(
    "Planning " + suffix,
  );
  await submit(page, "Group hello @" + bob.handle + " ready.");
  const bobGroup = bob.page
    .locator(".team-room-link")
    .filter({ hasText: "Planning " + suffix });
  await expect(bobGroup.locator("[data-slot=badge]")).toHaveText("1");
  await bobGroup.click();
  await expect(bob.page.locator(".markdown")).toContainText("Group hello");
  await expect(bobGroup.locator("[data-slot=badge]")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".markdown")).toContainText("Group hello");
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("melancholy", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
  await alice.context.close();
  await bob.context.close();
});

test("owner creates a bot, scopes a webhook and revokes delivery", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await context.request.post(origin + "/api/login", {
    headers: { Origin: origin },
    data: { key },
  });
  const suffix = Date.now(),
    name = "releases-" + suffix,
    botName = "Release bot " + suffix;
  const room = await context.request.post(origin + "/api/chat/rooms", {
    headers: { Origin: origin },
    data: { name },
  });
  const { id } = await room.json();
  await page.goto("/?room=" + id);
  async function settings() {
    await page
      .getByRole("button", { name: "Workspace menu", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Integrations", exact: true }).click();
  }
  await settings();
  await page.getByLabel("Bot name", { exact: true }).fill(botName);
  await page
    .getByLabel("Bot username", { exact: true })
    .fill("release-" + suffix);
  await page.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect(page.getByLabel("Bot name", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Conversation members", exact: true })
    .click();
  await page.getByLabel("Add member or bot", { exact: true }).click();
  await page.getByRole("option").filter({ hasText: botName }).click();
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .locator(".person-row")
      .filter({ hasText: botName }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await settings();
  await page.getByLabel("Credential", { exact: true }).click();
  await page
    .getByRole("option", { name: "Incoming webhook", exact: true })
    .click();
  await page.getByLabel("Conversation", { exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
  await page
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  const credential = page.getByLabel("New credential", { exact: true });
  await expect(credential).toBeVisible();
  const hook = await credential.inputValue();
  expect(hook).toContain("/api/hooks/");
  await page.keyboard.press("Escape");
  const delivery = await context.request.post(hook, {
    data: { text: "Release 1.0 is ready." },
  });
  expect(delivery.status()).toBe(201);
  await expect(
    page.locator(".chat-row").filter({ hasText: "Release 1.0 is ready." }),
  ).toContainText(botName);
  await settings();
  await page
    .getByRole("dialog")
    .locator(".person-row")
    .filter({ hasText: botName })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .locator(".person-row")
      .filter({ hasText: botName }),
  ).toHaveCount(0);
  expect(
    (
      await context.request.post(hook, { data: { text: "Must not arrive" } })
    ).status(),
  ).toBe(401);
});
