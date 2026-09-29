import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const origin = "http://127.0.0.1:3017",
  headers = { Origin: origin };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
test("channel databases, JSON schemas, Notes sharing and external tokens on desktop and mobile", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.request.post("/api/login", { headers, data: { key } });
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: "data-ui-" + Date.now(), private: true, members: [] },
    })
  ).json();
  await page.goto("/?room=" + room.id);
  const tabs = page.getByRole("navigation", { name: "Channel sections" });
  await tabs.getByRole("button", { name: "Data", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Project", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Database collections" })
    .getByRole("button", { name: /notes/ })
    .click();
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Record JSON" })
    .fill(
      JSON.stringify({
        title: "Shared note",
        content: "This lives in the channel database.",
      }),
    );
  await page.getByRole("button", { name: "Save record", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await tabs.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: /Shared note/ }).click();
  await expect(
    page.getByText("This lives in the channel database.", { exact: true }),
  ).toBeVisible();
  await tabs.getByRole("button", { name: "Data", exact: true }).click();
  await page.getByRole("button", { name: "New database", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Database name", exact: true })
    .fill("Research");
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Project research findings");
  await page
    .getByRole("button", { name: "Create database", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Research", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Collection schema JSON" })
    .fill(
      JSON.stringify({
        name: "findings",
        description: "Useful findings",
        fields: {
          title: { type: "string", required: true },
          source: { type: "string" },
        },
      }),
    );
  await page.getByRole("button", { name: "Save schema", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "findings", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Record JSON" })
    .fill(
      JSON.stringify({ title: "Durable state", source: "Cloudflare docs" }),
    );
  await page.getByRole("button", { name: "Save record", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".database-records")).toContainText(
    "Durable state",
  );
  await page.getByRole("button", { name: "Edit record", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Record JSON" })
    .fill(
      JSON.stringify({ title: "Updated finding", source: "Cloudflare docs" }),
    );
  await page.getByRole("button", { name: "Save record", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".database-history")).toContainText(
    "Durable state",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "API access", exact: true }).click();
  await page.getByRole("textbox", { name: "Token name" }).fill("Automation");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const token = await page
    .getByRole("textbox", { name: "New database API token" })
    .inputValue();
  expect(token).toMatch(/^mdb_/);
  const dbs = await (
    await context.request.get(`/api/data/v1/channels/${room.id}/databases`)
  ).json();
  const database = dbs.databases.find((d: any) => d.name === "Research");
  const dataUrl = `/api/data/v1/databases/${database.id}/collections/findings/records`;
  const external = await context.request.get(dataUrl, {
    headers: { Authorization: "Bearer " + token },
  });
  expect(external.status()).toBe(200);
  expect((await external.json()).records[0].data.title).toBe("Updated finding");
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Revoke", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await context.request.get(dataUrl, {
        headers: { Authorization: "Bearer " + token },
      })
    ).status(),
  ).toBe(401);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Research", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/channel-database-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "/tmp/channel-database-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Dark theme" }).click();
  await page.screenshot({
    path: "/tmp/channel-database-dark.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
