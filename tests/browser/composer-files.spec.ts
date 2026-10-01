import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
const origin = "http://127.0.0.1:3017";
const headers = { Origin: origin };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();

test.beforeEach(async ({ context }) => {
  await context.request.post("/api/login", { headers, data: { key } });
});

async function transfer(
  page: Page,
  files: { name: string; text?: string; size?: number }[],
) {
  return page.evaluateHandle((files) => {
    const data = new DataTransfer();
    for (const file of files)
      data.items.add(
        new File(
          [
            file.size
              ? new Uint8Array(file.size)
              : file.text || "Upload contents",
          ],
          file.name,
          { type: "text/plain" },
        ),
      );
    return data;
  }, files);
}
async function drop(
  page: Page,
  target: Locator,
  files: { name: string; size?: number }[],
) {
  const dataTransfer = await transfer(page, files);
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
}

test("file drops attach to the correct channel or thread, stay as drafts and preserve text dragging", async ({
  page,
  context,
}) => {
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: "drop-target-" + Date.now() },
    })
  ).json();
  const root = (
    await (
      await context.request.post(`/api/chat/rooms/${room.id}/messages`, {
        headers,
        data: { text: "Upload discussion", id: crypto.randomUUID() },
      })
    ).json()
  ).message;
  await page.goto(`/?room=${room.id}&thread=${root.id}`);
  const channel = page.locator(".team-channel"),
    thread = page.locator(".team-thread");
  await expect(
    thread.getByLabel("Thread reply", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Markdown supported", { exact: true }),
  ).toHaveCount(0);
  await channel.getByLabel("Message", { exact: true }).fill("Keep this draft");
  const dataTransfer = await transfer(page, [
    { name: "channel.txt", text: "Channel file" },
  ]);
  await channel
    .locator(".chat-scroll")
    .dispatchEvent("dragenter", { dataTransfer });
  await expect(channel.getByText("Drop files to attach")).toBeVisible();
  await expect(thread.getByText("Drop files to attach")).toHaveCount(0);
  await channel
    .locator("textarea")
    .dispatchEvent("dragenter", { dataTransfer });
  await channel
    .locator("textarea")
    .dispatchEvent("dragleave", { dataTransfer });
  await expect(channel.getByText("Drop files to attach")).toBeVisible();
  for (const dark of [false, true]) {
    await page.evaluate(
      (d) => document.documentElement.classList.toggle("dark", d),
      dark,
    );
    await page.screenshot({ path: `/tmp/melancholy-file-drop-${dark}.png` });
  }
  await channel.locator(".chat-scroll").dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  await expect(channel.getByText("Drop files to attach")).toHaveCount(0);
  await expect(channel.locator(".composer-files")).toContainText("channel.txt");
  await expect(thread.locator(".composer-files")).toHaveCount(0);
  await expect(channel.getByLabel("Message", { exact: true })).toHaveValue(
    "Keep this draft",
  );
  // Uploading alone must not publish a message or trigger an agent.
  const before = await (
    await context.request.get(`/api/chat/rooms/${room.id}/messages`)
  ).json();
  expect(before.messages).toHaveLength(1);
  await channel
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    channel.locator(".chat-row").filter({ hasText: "channel.txt" }),
  ).toBeVisible();

  const plainDrop = await thread.locator("textarea").evaluate((el) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "https://example.com");
    const event = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(plainDrop).toBe(false);
  await expect(page.getByText("Drop files to attach")).toHaveCount(0);
  await drop(page, thread.locator(".chat-scroll"), [{ name: "thread.csv" }]);
  await expect(thread.locator(".composer-files")).toContainText("thread.csv");
  await expect(channel.locator(".composer-files")).toHaveCount(0);
  await thread.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(
    thread.locator(".chat-row").filter({ hasText: "thread.csv" }),
  ).toBeVisible();
  const replies = await (
    await context.request.get(
      `/api/chat/rooms/${room.id}/messages?parent=${root.id}`,
    )
  ).json();
  expect(replies.messages).toHaveLength(1);
  expect(replies.messages[0].attachments[0].name).toBe("thread.csv");
  expect(
    await (
      await context.request.get(
        `/api/files/${replies.messages[0].attachments[0].id}`,
      )
    ).text(),
  ).toBe("Upload contents");
  await page.reload();
  await expect(
    thread.locator(".chat-row").filter({ hasText: "thread.csv" }),
  ).toBeVisible();
});

test("file drops enforce limits, guard concurrent batches and retain successes after a failed upload", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: "drop-limits-" + Date.now() },
    })
  ).json();
  await page.goto(`/?room=${room.id}`);
  const composer = page.locator(".team-channel .chat-composer");
  await expect(composer.getByLabel("Message", { exact: true })).toBeVisible();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploads = 0;
  await page.route("**/api/chat/files?room=*", async (route) => {
    uploads++;
    if (uploads === 1) await barrier;
    if (route.request().postData()?.includes('filename="broken.txt"'))
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Upload temporarily unavailable" }),
      });
    else await route.continue();
  });
  await drop(page, composer, [
    { name: "first.txt" },
    { name: "broken.txt" },
    { name: "last.txt" },
    { name: "large.txt", size: 10 * 1024 * 1024 + 1 },
  ]);
  await expect(
    composer.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await drop(page, composer, [{ name: "concurrent.txt" }]);
  await expect(
    page.getByText("Please wait for the current upload to finish."),
  ).toBeVisible();
  release();
  await expect(composer.locator(".composer-files")).toContainText("first.txt");
  await expect(composer.locator(".composer-files")).toContainText("last.txt");
  await expect(
    page.getByText("broken.txt: Upload temporarily unavailable"),
  ).toBeVisible();
  await expect(
    page.getByText("large.txt: Files must be 10 MB or smaller."),
  ).toBeVisible();
  await expect(
    composer.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  expect(uploads).toBe(3);
  await drop(
    page,
    composer,
    Array.from({ length: 9 }, (_, i) => ({ name: `extra-${i}.txt` })),
  );
  await expect(
    page.getByText("You can attach up to 8 files per message."),
  ).toBeVisible();
  await expect(composer.getByRole("button", { name: /^Remove / })).toHaveCount(
    8,
  );
  await expect(
    composer.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  expect(uploads).toBe(9);
  await composer
    .getByRole("button", { name: "Remove first.txt", exact: true })
    .click();
  await composer
    .getByLabel("Upload files", { exact: true })
    .setInputFiles({
      name: "picker.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Picker file"),
    });
  await expect(composer.locator(".composer-files")).toContainText("picker.txt");
  await expect(composer.getByRole("button", { name: /^Remove / })).toHaveCount(
    8,
  );
});
