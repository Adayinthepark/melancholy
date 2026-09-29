import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const origin = "http://127.0.0.1:3017";
const headers = { Origin: origin };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
test("workspace settings are separate from profiles and manage encrypted credentials across layouts", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await context.request.post("/api/login", { headers, data: { key } });
  const before = await (
    await context.request.get("/api/chat/workspace")
  ).json();
  const roomName = "credentials-" + Date.now();
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: roomName },
    })
  ).json();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const credentialName = "Signing key " + Date.now();
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Account menu", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Profile settings");
    await expect(
      page.getByLabel("Display name", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog").getByText("Integrations", { exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Account menu", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Workspace", exact: true })
      .click();
    await expect(page).toHaveURL(/\/settings\/workspace$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByLabel("Workspace name", { exact: true })
      .fill("Studio workspace");
    await page
      .getByLabel("Description", { exact: true })
      .fill("Shared project workspace");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.locator(".workspace-brand")).toContainText(
      "Studio workspace",
    );
    await page.reload();
    await expect(
      page.getByLabel("Workspace name", { exact: true }),
    ).toHaveValue("Studio workspace");
    await page
      .getByRole("link", { name: "Custom credentials", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Custom credentials", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add credential", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Use App Store Connect fields",
        exact: true,
      })
      .click();
    await page
      .getByLabel("Credential name", { exact: true })
      .fill(credentialName);
    await page.getByLabel("Value 1", { exact: true }).fill("asc-key-123");
    await page.getByLabel("Value 2", { exact: true }).fill("asc-issuer-456");
    await page
      .getByLabel("Load value 3 from file", { exact: true })
      .setInputFiles({
        name: "AuthKey_test.p8",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "-----BEGIN PRIVATE KEY-----\nprivate-signing-material\n-----END PRIVATE KEY-----",
        ),
      });
    await expect(page.getByLabel("Value 3", { exact: true })).toContainText(
      "private-signing-material",
    );
    await page
      .getByRole("button", { name: "Save credential", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const row = page
      .locator(".credential-row")
      .filter({ hasText: credentialName });
    await expect(row).toContainText("ASC_PRIVATE_KEY");
    const listing = await (
      await context.request.get("/api/chat/connections")
    ).text();
    expect(listing).not.toContain("private-signing-material");
    expect(listing).not.toContain("asc-issuer-456");
    await row
      .getByRole("button", { name: "Channel access", exact: true })
      .click();
    const grant = page
      .locator(".credential-grant")
      .filter({ hasText: roomName });
    await grant.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(
      grant.getByRole("button", { name: "Enabled", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: "Replace", exact: true }).click();
    await expect(page.getByLabel("Value 1", { exact: true })).toHaveValue("");
    await page.getByLabel("Value 1", { exact: true }).fill("replaced-key");
    await page.getByLabel("Value 2", { exact: true }).fill("replaced-issuer");
    await page
      .getByLabel("Value 3", { exact: true })
      .fill("replaced-private-key");
    await page
      .getByRole("button", { name: "Replace credential", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({
      path: "/tmp/melancholy-settings-custom-desktop.png",
      fullPage: true,
    });
    await page.getByRole("link", { name: "LLM keys", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "LLM keys", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add credential", exact: true })
      .click();
    await page.getByLabel("Provider", { exact: true }).click();
    await page.getByRole("option", { name: "Kimi", exact: true }).click();
    await expect(page.getByLabel("API base URL", { exact: true })).toHaveValue(
      "https://api.moonshot.ai/v1",
    );
    await page
      .getByLabel("Credential name", { exact: true })
      .fill("Kimi " + credentialName);
    await page
      .getByLabel("API key", { exact: true })
      .fill("test-kimi-private-key");
    await page
      .getByRole("button", { name: "Save credential", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page
        .locator(".credential-row")
        .filter({ hasText: "Kimi " + credentialName }),
    ).toContainText("MOONSHOT_API_KEY");
    await page
      .getByRole("button", { name: "Toggle theme", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: "LLM keys", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "/tmp/melancholy-settings-llm-mobile.png",
      fullPage: true,
    });
    for (const section of [
      "cloudflare",
      "github",
      "servers",
      "bots",
      "members",
      "usage",
    ]) {
      await page.goto("/settings/workspace/" + section);
      await expect(
        page.locator(".workspace-settings-content h1"),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.goto("/settings/workspace/custom");
    await page
      .locator(".credential-row")
      .filter({ hasText: credentialName })
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove credential", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.locator(".credential-row").filter({ hasText: credentialName }),
    ).toHaveCount(0);
    await page.goto("/?room=" + room.id);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(".team-sidebar .workspace-brand").waitFor();
    expect(
      await page
        .locator(".team-sidebar")
        .evaluate((e) => getComputedStyle(e).paddingTop),
    ).toBe("0px");
    expect(errors).toEqual([]);
  } finally {
    await context.request.patch("/api/chat/settings", {
      headers,
      data: { name: before.name, description: before.description || "" },
    });
    const list = await (
      await context.request.get("/api/chat/connections")
    ).json();
    for (const c of list.connections.filter((c: { name: string }) =>
      c.name.includes(credentialName),
    ))
      await context.request.delete("/api/chat/connections/" + c.id, {
        headers,
      });
  }
});
test("members can edit their profile but cannot open workspace administration", async ({
  page,
  context,
}) => {
  await context.request.post("/api/login", { headers, data: { key } });
  const invite = await (
    await context.request.post("/api/chat/invitations", { headers })
  ).json();
  const ticket = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
    "invite",
  );
  await context.clearCookies();
  await context.request.post("/api/join", {
    headers,
    data: {
      ticket,
      name: "Settings member",
      handle: "settings" + Date.now(),
      password: "member-password-at-least-12",
    },
  });
  await page.goto("/settings/workspace/custom");
  await expect(
    page.getByText("Only the workspace owner can manage these settings."),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Back to workspace", exact: true })
    .click();
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Settings member",
  );
  expect((await context.request.get("/api/chat/connections")).status()).toBe(
    403,
  );
});
