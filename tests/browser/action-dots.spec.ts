import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { AgentPart } from "../../lib/agent-parts";

const origin = "http://127.0.0.1:3017";
const headers = { Origin: origin };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();

test.use({ hasTouch: true, serviceWorkers: "block" });
test("action dots stay horizontal in phone threads and wrap only at the available width", async ({
  page,
  context,
  browserName,
}) => {
  test.setTimeout(60000);
  await context.request.post("/api/login", { headers, data: { key } });
  const room = await (
    await context.request.post("/api/chat/rooms", {
      headers,
      data: { name: `dots-${browserName}-${Date.now()}` },
    })
  ).json();
  const root = (
    await (
      await context.request.post(`/api/chat/rooms/${room.id}/messages`, {
        headers,
        data: { text: "Review the layout" },
      })
    ).json()
  ).message;
  const reply = (
    await (
      await context.request.post(`/api/chat/rooms/${room.id}/messages`, {
        headers,
        data: { text: "Layout progress", parentId: root.id },
      })
    ).json()
  ).message;
  const parts: AgentPart[] = [];
  for (const count of [1, 10, 100]) {
    parts.push({
      type: "text",
      id: `text-${count}`,
      text: `Checking ${count} steps.`,
    });
    for (let i = 0; i < count; i++)
      parts.push({
        type: "activity",
        id: `step-${count}-${i}`,
        title: `Step ${count}-${i}`,
        detail: "Operation output",
        status: i === 1 ? "failed" : "completed",
      });
  }
  parts.push({ type: "text", id: "last", text: "Layout review complete." });
  // Local rendering fixture; no model task or production conversation is changed.
  await page.route(`**/api/chat/rooms/${room.id}/messages*`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.messages = data.messages.map((m: { id: string }) =>
      m.id === reply.id ? { ...m, parts, run_status: "completed" } : m,
    );
    await route.fulfill({ response, json: data });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/thread/${root.id}`);
  const row = page.locator(
    `.team-thread .chat-row[data-message-id="${reply.id}"]`,
  );
  const triggers = row.locator(".agent-actions-trigger");
  await expect(triggers).toHaveCount(3);
  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect
      .poll(async () => (await row.boundingBox())!.width)
      .toBeLessThanOrEqual(width);
    const groups = await triggers.evaluateAll((nodes) =>
      nodes.map((button) => {
        const box = button.getBoundingClientRect();
        const dots = Array.from(
          button.querySelectorAll(".agent-action-dot"),
          (dot) => {
            const r = dot.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              right: r.right,
              width: r.width,
              height: r.height,
            };
          },
        );
        return { left: box.x, right: box.right, height: box.height, dots };
      }),
    );
    for (const group of groups) {
      for (const dot of group.dots) {
        expect(dot.width).toBe(8);
        expect(dot.height).toBe(8);
        expect(dot.x).toBeGreaterThanOrEqual(group.left - 1);
        expect(dot.right).toBeLessThanOrEqual(group.right + 1);
      }
    }
    expect(groups[0].height).toBe(16);
    expect(groups[1].height).toBe(16);
    expect(new Set(groups[1].dots.map((d) => d.y)).size).toBe(1);
    expect(groups[1].dots[1].x).toBeGreaterThan(groups[1].dots[0].x);
    expect(groups[1].dots[1].x).toBeLessThan(groups[1].dots[0].right);
    expect(groups[2].height).toBeLessThanOrEqual(36);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const dark of [false, true]) {
    await page.evaluate(
      (d) => document.documentElement.classList.toggle("dark", d),
      dark,
    );
    await triggers.nth(1).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/action-dots-${browserName}-${dark}.png`,
      animations: "disabled",
    });
  }
  await triggers.nth(1).tap();
  const dialog = page.getByRole("dialog", { name: "Action details" });
  await expect(dialog.locator("details")).toHaveCount(10);
  await dialog.locator("summary").nth(1).tap();
  await expect(dialog.locator("details[open] pre")).toContainText(
    "Operation output",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).tap();
  await expect(dialog).toHaveCount(0);
  // The same indicators also render in the phone's overlay thread layout.
  await page.goto(`/?room=${room.id}&thread=${root.id}`);
  await expect(triggers).toHaveCount(3);
  await expect
    .poll(async () => (await triggers.nth(1).boundingBox())!.height)
    .toBe(16);
});
