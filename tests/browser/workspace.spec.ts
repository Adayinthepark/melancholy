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

test("retired workspace has no page or settings entry", async ({
  page,
  request,
}) => {
  await request.post("/api/login", {
    headers: { Origin: "http://127.0.0.1:3017" },
    data: { key },
  });
  await page.context().addCookies((await request.storageState()).cookies);
  const response = await page.goto("/legacy");
  expect(response?.status()).toBe(404);
  await page.goto("/settings/workspace/bots");
  await expect(
    page.getByRole("heading", { name: "Bots", exact: true }),
  ).toBeVisible();
  await expect(page.locator('a[href="/legacy"]')).toHaveCount(0);
});
