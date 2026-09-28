import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const headers = { Origin: "http://127.0.0.1:3017" };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
test.beforeEach(async ({ context }) => {
  await context.request.post("/api/login", { headers, data: { key } });
});

test("settings retain their shell during slow navigation and align people across layouts", async ({
  page,
}) => {
  const workspace = gate(),
    servers = gate(),
    credentials = gate();
  await page.route("**/api/chat/workspace", async (route) => {
    await workspace.wait;
    await route.continue();
  });
  await page.route("**/api/workspace", async (route) => {
    await servers.wait;
    await route.continue();
  });
  await page.route("**/api/chat/connections", async (route) => {
    await credentials.wait;
    await route.continue();
  });
  try {
    await page.goto("/settings/workspace/members", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("navigation", { name: "Workspace settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Loading settings", exact: true }),
    ).toBeVisible();
    workspace.release();
    await expect(page.locator(".person-details").first()).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const row = page.locator(".person-row").first();
      const avatar = await row.locator(".person-avatar").boundingBox();
      const details = await row.locator(".person-details").boundingBox();
      expect(
        Math.abs(details!.x - avatar!.x - avatar!.width - 12),
      ).toBeLessThan(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      (window as any).__settingsNav = document.querySelector(
        ".workspace-settings-nav",
      );
    });
    await page.getByRole("link", { name: "Servers", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Servers", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Loading settings", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as any).__settingsNav ===
          document.querySelector(".workspace-settings-nav"),
      ),
    ).toBe(true);
    await page.getByRole("link", { name: "GitHub", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "GitHub", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Loading settings", exact: true }),
    ).toBeVisible();
    servers.release();
    await expect(page.locator(".server-row")).toHaveCount(0);
    credentials.release();
    await expect(
      page.getByRole("status", { name: "Loading settings", exact: true }),
    ).toHaveCount(0);
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "Servers", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(page.locator(".person-details").first()).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as any).__settingsNav ===
          document.querySelector(".workspace-settings-nav"),
      ),
    ).toBe(true);
  } finally {
    workspace.release();
    servers.release();
    credentials.release();
  }
});

test("usage shows scoped loading and recovers from a failed request", async ({
  page,
}) => {
  const usage = gate();
  let requests = 0;
  await page.route("**/api/chat/usage?*", async (route) => {
    await usage.wait;
    if (++requests === 1)
      await route.fulfill({
        status: 503,
        json: { error: "Usage unavailable" },
      });
    else await route.continue();
  });
  try {
    await page.goto("/settings/workspace/usage");
    await expect(
      page.getByRole("status", { name: "Loading settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No usage reported yet.", { exact: true }),
    ).toHaveCount(0);
    usage.release();
    await expect(page.getByRole("alert")).toContainText("Usage unavailable");
    await expect(page.locator(".workspace-settings-nav")).toBeVisible();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("status", { name: "Loading settings", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".usage-totals strong").first()).toBeVisible();
  } finally {
    usage.release();
  }
});

test("slow and stale thread requests never clear the channel or replace the active thread", async ({
  page,
  context,
}) => {
  const { id } = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: "loading-" + Date.now() },
    })
  ).json();
  for (const text of ["First thread", "Second thread"])
    await context.request.post(`/api/chat/rooms/${id}/messages`, {
      headers,
      data: { text },
    });
  const { messages } = await (
    await context.request.get(`/api/chat/rooms/${id}/messages`)
  ).json();
  const first = messages.find(
    (m: { text: string }) => m.text === "First thread",
  ).id;
  const barrier = gate();
  await page.route(`**/api/chat/messages/${first}`, async (route) => {
    await barrier.wait;
    await route.continue();
  });
  await page.route(
    `**/api/chat/rooms/${id}/messages?parent=${first}`,
    async (route) => {
      await barrier.wait;
      await route.continue();
    },
  );
  try {
    await page.goto("/?room=" + id);
    const channel = page.getByRole("region", {
      name: "Channel messages",
      exact: true,
    });
    const row = channel
      .locator(".chat-row")
      .filter({ hasText: "First thread" });
    await row.hover();
    await row
      .getByRole("button", { name: "Reply in thread", exact: true })
      .click();
    await expect(
      page
        .locator(".team-thread")
        .getByRole("status", { name: "Loading messages" }),
    ).toBeVisible();
    await expect(row).toBeVisible();
    await expect(
      channel.getByRole("status", { name: "Loading messages" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(row).toBeVisible();
    const second = channel
      .locator(".chat-row")
      .filter({ hasText: "Second thread" });
    await second.hover();
    await second
      .getByRole("button", { name: "Reply in thread", exact: true })
      .click();
    await expect(page.locator(".team-thread .markdown")).toHaveText(
      "Second thread",
    );
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/api/chat/messages/" + first),
    );
    barrier.release();
    await response;
    await expect(page.locator(".team-thread .markdown")).toHaveText(
      "Second thread",
    );
    await expect(channel.locator(".chat-row")).toHaveCount(2);
  } finally {
    barrier.release();
  }
});
