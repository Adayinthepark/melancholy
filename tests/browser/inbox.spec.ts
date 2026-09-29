import { test, expect, type BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";
const headers = { Origin: "http://127.0.0.1:3017" };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
async function invite(owner: BrowserContext, member: BrowserContext) {
  const invitation = await (
    await owner.request.post("/api/chat/invitations", { headers })
  ).json();
  const ticket = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get(
    "invite",
  );
  const handle = "reader" + Date.now();
  expect(
    (
      await member.request.post("/api/join", {
        headers,
        data: {
          ticket,
          handle,
          name: "Inbox reader",
          password: "a long inbox test password",
        },
      })
    ).status(),
  ).toBe(201);
  return (await (await member.request.get("/api/chat/workspace")).json()).me;
}
async function send(
  context: BrowserContext,
  room: string,
  text: string,
  parentId?: string,
) {
  const response = await context.request.post(
    `/api/chat/rooms/${room}/messages`,
    { headers, data: { text, parentId } },
  );
  expect(response.status()).toBe(201);
  return (await response.json()).message;
}
async function unread(context: BrowserContext, id: string) {
  return (
    await (await context.request.get("/api/chat/workspace")).json()
  ).rooms.find((r: any) => r.id === id).unread;
}
test("Inbox preserves unread messages, filters mentions and opens the exact thread", async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(90000);
  await context.request.post("/api/login", { headers, data: { key } });
  const member = await browser.newContext({ baseURL: headers.Origin });
  const person = await invite(context, member),
    reader = await member.newPage();
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: {
        name: "inbox-" + Date.now(),
        private: true,
        members: [person.id],
      },
    })
  ).json();
  const root = await send(member, room.id, "Original thread");
  await reader.goto("/?room=" + room.id);
  await reader
    .getByRole("navigation", { name: "Channel sections" })
    .getByRole("button", { name: "Notes", exact: true })
    .click();
  const update = await send(
    context,
    room.id,
    `Release is ready <@${person.id}>`,
  );
  const reply = await send(
    context,
    room.id,
    `Please review the thread <@${person.id}>`,
    root.id,
  );
  await reader.waitForTimeout(1400);
  expect(await unread(member, room.id)).toBe(2);
  await reader.getByRole("button", { name: /^Inbox/ }).click();
  const cards = reader.locator(".inbox-message");
  await expect(cards).toHaveCount(2);
  await reader.waitForTimeout(1000);
  expect(await unread(member, room.id)).toBe(2);
  await cards
    .filter({ hasText: "Release is ready" })
    .getByRole("button", { name: "Mark as read", exact: true })
    .click();
  await expect(cards).toHaveCount(1);
  expect(await unread(member, room.id)).toBe(1);
  await reader.getByRole("tab", { name: "Mentions", exact: true }).click();
  await expect(cards).toHaveCount(2);
  await expect(
    cards
      .filter({ hasText: "Release is ready" })
      .getByText("Unread", { exact: true }),
  ).toHaveCount(0);
  for (const width of [1280, 390]) {
    await reader.setViewportSize({ width, height: 900 });
    for (const dark of [false, true]) {
      await reader.evaluate(
        (value) => document.documentElement.classList.toggle("dark", value),
        dark,
      );
      await reader.screenshot({
        path: `/tmp/melancholy-inbox-${width}-${dark}.png`,
        animations: "disabled",
      });
      expect(
        await reader.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  await cards
    .filter({ hasText: "Please review the thread" })
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  await expect(
    reader.locator(".team-thread .message-highlight .markdown"),
  ).toContainText("Please review the thread");
  await expect.poll(() => unread(member, room.id)).toBe(0);
  // Read positions are persisted on the account.
  await page.goto("/?view=inbox");
  const persisted = await member.request.get(`/api/chat/messages/${reply.id}`);
  expect((await persisted.json()).message.unread).toBe(false);
  expect(
    (await (await member.request.get(`/api/chat/messages/${update.id}`)).json())
      .message.unread,
  ).toBe(false);
  await member.close();
});

test("opening a long channel only reads visible messages and read-all uses the inbox snapshot", async ({
  browser,
  context,
}) => {
  test.setTimeout(90000);
  await context.request.post("/api/login", { headers, data: { key } });
  const member = await browser.newContext({ baseURL: headers.Origin });
  const person = await invite(context, member),
    reader = await member.newPage();
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: {
        name: "visible-" + Date.now(),
        private: true,
        members: [person.id],
      },
    })
  ).json();
  for (let i = 0; i < 22; i++)
    await send(
      context,
      room.id,
      `Update ${i}\n\n` + "A detailed project update. ".repeat(20),
    );
  await reader.goto("/?room=" + room.id);
  await reader.bringToFront();
  await expect(reader.locator(".chat-row")).toHaveCount(22);
  await expect.poll(() => unread(member, room.id)).toBeLessThan(22);
  expect(await unread(member, room.id)).toBeGreaterThan(0);
  await reader.getByRole("button", { name: /^Inbox/ }).click();
  await expect(reader.locator(".inbox-message").first()).toBeVisible();
  await reader
    .getByRole("button", { name: "Mark all as read", exact: true })
    .click();
  await expect(
    reader.getByText("You’re all caught up", { exact: true }),
  ).toBeVisible();
  expect(await unread(member, room.id)).toBe(0);
  await reader.reload();
  await expect(
    reader.getByText("You’re all caught up", { exact: true }),
  ).toBeVisible();
  await member.close();
});

test("an inbox link finds a reply older than the latest history page", async ({
  browser,
  context,
}) => {
  test.setTimeout(120000);
  await context.request.post("/api/login", { headers, data: { key } });
  const member = await browser.newContext({ baseURL: headers.Origin });
  const person = await invite(context, member),
    reader = await member.newPage();
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: {
        name: "old-reply-" + Date.now(),
        private: true,
        members: [person.id],
      },
    })
  ).json();
  const root = await send(member, room.id, "History thread");
  const target = await send(
    context,
    room.id,
    `The original decision <@${person.id}>`,
    root.id,
  );
  for (let i = 0; i < 105; i++)
    await send(context, room.id, "Later reply " + i, root.id);
  await reader.goto("/?view=inbox");
  await reader.getByRole("tab", { name: "Mentions", exact: true }).click();
  await reader
    .locator(".inbox-message")
    .filter({ hasText: "The original decision" })
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  const highlighted = reader.locator(
    `.team-thread .message-highlight article[data-message-id="${target.id}"]`,
  );
  await expect(highlighted).toBeInViewport();
  await expect(highlighted).toContainText("The original decision");
  await reader
    .getByRole("button", { name: "Back to latest messages", exact: true })
    .click();
  await expect(
    reader
      .locator(".team-thread .markdown")
      .filter({ hasText: "Later reply 104" }),
  ).toBeVisible();
  await member.close();
});
