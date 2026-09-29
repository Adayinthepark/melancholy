import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
const headers = { Origin: "http://127.0.0.1:3017" };
for (const mode of ["desktop", "phone", "reduced"] as const) {
  test(`thread motion preserves the channel, draft and focus on ${mode}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({
      width: mode === "phone" ? 390 : 1440,
      height: 950,
    });
    await page.emulateMedia({
      reducedMotion: mode === "reduced" ? "reduce" : "no-preference",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.request.post("/api/login", { headers, data: { key } });
    const { id } = await (
      await context.request.post("/api/chat/rooms", {
        headers,
        data: { name: `motion-${mode}-${Date.now()}` },
      })
    ).json();
    for (const text of ["First motion thread", "Second motion thread"])
      await context.request.post(`/api/chat/rooms/${id}/messages`, {
        headers,
        data: { text },
      });
    await page.goto("/?room=" + id);
    await page
      .getByLabel("Message", { exact: true })
      .fill("Keep this channel draft");
    await page.evaluate(() => {
      (window as any).__channel = document.querySelector(".team-channel");
    });
    const first = page
      .locator(".team-channel .chat-row")
      .filter({ hasText: "First motion thread" });
    await first.hover();
    const trigger = first.getByRole("button", {
      name: "Reply in thread",
      exact: true,
    });
    await trigger.focus();
    const samples = await trigger.evaluate(async (button) => {
      (button as HTMLButtonElement).click();
      const widths: number[] = [];
      for (let i = 0; i < 25; i++) {
        await new Promise(requestAnimationFrame);
        widths.push(
          document.querySelector(".thread-panel-frame")?.getBoundingClientRect()
            .width || 0,
        );
      }
      return widths;
    });
    await expect(page.locator(".team-thread .markdown")).toHaveText(
      "First motion thread",
    );
    const target = await page
      .locator(".thread-panel-frame")
      .evaluate((e) => e.getBoundingClientRect().width);
    let savedWidth = target;
    if (mode === "desktop") {
      const divider = page.getByRole("separator", { name: "Resize thread" });
      await expect(divider).toBeVisible();
      const box = (await divider.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      const resized = await page
        .locator(".thread-panel-frame")
        .evaluate((e) => e.getBoundingClientRect().width);
      expect(resized).toBeGreaterThan(target + 80);
      await divider.focus();
      await page.keyboard.press("ArrowRight");
      expect(
        await page
          .locator(".thread-panel-frame")
          .evaluate((e) => e.getBoundingClientRect().width),
      ).toBeLessThan(resized);
      savedWidth = await page
        .locator(".thread-panel-frame")
        .evaluate((e) => e.getBoundingClientRect().width);
      await page.getByLabel("Thread reply").focus();
    }
    if (mode === "reduced")
      expect(
        samples.every((width) => width === 0 || Math.abs(width - target) < 1),
      ).toBe(true);
    await expect(page.getByLabel("Thread reply")).toBeFocused();
    await page.screenshot({
      path: `/tmp/melancholy-motion-${mode}.png`,
      animations: "disabled",
    });
    await page.getByLabel("Thread reply").press("Escape");
    await expect(page.locator(".thread-panel-frame")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Keep this channel draft",
    );
    expect(
      await page.evaluate(
        () =>
          (window as any).__channel === document.querySelector(".team-channel"),
      ),
    ).toBe(true);
    // Reopen while closing; a pending exit must not unmount the new selection.
    await trigger.click();
    if (mode === "desktop")
      await expect
        .poll(async () =>
          Math.abs(
            (await page
              .locator(".thread-panel-frame")
              .evaluate((e) => e.getBoundingClientRect().width)) - savedWidth,
          ),
        )
        .toBeLessThan(2);
    await expect(
      page.getByRole("button", { name: "Close thread", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      (
        document.querySelector(
          '[aria-label="Close thread"]',
        ) as HTMLButtonElement
      ).click();
      requestAnimationFrame(() =>
        (
          document.querySelectorAll(
            '.team-channel [aria-label="Reply in thread"]',
          )[1] as HTMLButtonElement
        ).click(),
      );
    });
    await expect(page.locator(".team-thread .markdown")).toHaveText(
      "Second motion thread",
    );
    await expect(page.locator(".thread-panel-frame")).toHaveAttribute(
      "data-present",
      "true",
    );
    await page
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(page.locator(".thread-panel-frame")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (mode === "desktop") {
      await page.reload();
      await first.hover();
      await trigger.click();
      await expect
        .poll(async () =>
          Math.abs(
            (await page
              .locator(".thread-panel-frame")
              .evaluate((e) => e.getBoundingClientRect().width)) - savedWidth,
          ),
        )
        .toBeLessThan(2);
    }
    expect(errors).toEqual([]);
  });
}
test("credential instructions are available beside the list and inside the form", async ({
  page,
  context,
}) => {
  await context.request.post("/api/login", { headers, data: { key } });
  await page.setViewportSize({ width: 390, height: 950 });
  for (const provider of ["github", "cloudflare"]) {
    await page.goto("/settings/workspace/" + provider);
    await page
      .locator(".credential-guide [data-slot=accordion-trigger]")
      .click();
    const guide = page.locator(".credential-guide");
    await expect(guide).toContainText(
      provider === "github" ? "Issues: Read and write" : "D1: Edit",
    );
    await expect(guide).toContainText("Channel access");
    await expect(
      guide.getByRole("link", { name: "Full setup and troubleshooting guide" }),
    ).toHaveAttribute("href", new RegExp(`docs/credentials.md#${provider}$`));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/melancholy-guide-${provider}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Add credential", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("link", { name: "Setup guide" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
