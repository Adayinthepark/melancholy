import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const origin = "http://127.0.0.1:3017";
const headers = { Origin: origin };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
test("creates and configures a cloud agent without a server on desktop and mobile", async ({
  page,
  context,
}) => {
  await context.request.post("/api/login", { headers, data: { key } });
  const label = "Cloud key " + Date.now();
  const credential = await (
    await context.request.post("/api/chat/connections", {
      headers,
      data: {
        provider: "deepseek",
        name: label,
        fields: [
          { name: "DEEPSEEK_API_KEY", value: "browser-test-placeholder" },
        ],
      },
    })
  ).json();
  const name = "Cloud helper " + Date.now();
  await page.goto("/settings/workspace/bots");
  await page.getByLabel("Bot name", { exact: true }).fill(name);
  await page.getByLabel("Run on", { exact: true }).click();
  await page
    .getByRole("option", {
      name: "Cloudflare · built-in Pi (experimental)",
      exact: true,
    })
    .click();
  await page.getByLabel("LLM key", { exact: true }).click();
  await page
    .getByRole("option", { name: label + " · deepseek", exact: true })
    .click();
  await page.getByLabel("Model ID", { exact: true }).fill("test-model");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Read the project instructions and verify changes.");
  await page.getByRole("button", { name: "Create bot", exact: true }).click();
  const row = page.locator(".person-row").filter({ hasText: name });
  await expect(row).toContainText("Cloudflare · Pi");
  await row.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue(
    "test-model",
  );
  await page
    .getByLabel("Maximum model steps per task", { exact: true })
    .fill("12");
  const savedResponse = page.waitForResponse(
    (r) =>
      r.url().includes("/api/chat/cloud-bots/") &&
      r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save bot", exact: true }).click();
  const saved = await savedResponse;
  expect(saved.request().postDataJSON().maxSteps).toBe(12);
  expect(saved.status()).toBe(200);
  await expect(
    page.getByRole("button", { name: "Create bot", exact: true }),
  ).toBeVisible();
  await row.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(
    page.getByLabel("Maximum model steps per task", { exact: true }),
  ).toHaveValue("12");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel("Model ID", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByLabel("Model ID", { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByLabel("Model ID", { exact: true })).toBeInViewport();
    await page.screenshot({
      path: "/tmp/melancholy-cloud-agent-" + width + ".png",
    });
  }
  const configs = await (
    await context.request.get("/api/chat/cloud-bots")
  ).json();
  const bot = configs.bots.find(
    (c: { credential_id: string }) => c.credential_id === credential.id,
  );
  expect(bot.max_steps).toBe(12);
  await context.request.delete("/api/chat/people/" + bot.bot_id, { headers });
  await context.request.delete("/api/chat/connections/" + credential.id, {
    headers,
  });
});
