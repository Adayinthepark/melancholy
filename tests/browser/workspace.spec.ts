import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();

test("one-use link signs in and clears the ticket from the address bar", async ({
  page,
  request,
}) => {
  await request.post("/api/login", {
    headers: { Origin: "http://127.0.0.1:3017" },
    data: { key },
  });
  const created = await request.post("/api/login-links", {
    headers: { Origin: "http://127.0.0.1:3017" },
  });
  expect(created.status()).toBe(201);
  const { url } = await created.json();
  await page.goto(url);
  await expect(
    page.getByRole("button", { name: "Search workspace", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
});

test("owner login, channel creation, queued messages, cancellation, and responsive navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/legacy");
  await page
    .getByRole("button", { name: "Use workspace key", exact: true })
    .click();
  await page.getByLabel("Workspace key").fill(key);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  const name = `test-${Date.now()}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(page.locator(".channel-title")).toHaveText(name);
  await page
    .getByRole("button", { name: "Connect a server", exact: true })
    .click();
  await page.getByLabel("Server name").fill(name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Connect server", exact: true })
    .click();
  await expect(page.getByText("Save as", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Select agent", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: name }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("A message that must survive a refresh.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("Waiting for server", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop task", exact: true }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".markdown")).toHaveText(
    "A message that must survive a refresh.",
  );
  await page
    .getByRole("button", { name: "Search workspace", exact: true })
    .click();
  await page.getByPlaceholder("Search threads and messages…").fill("survive");
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");
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
});
